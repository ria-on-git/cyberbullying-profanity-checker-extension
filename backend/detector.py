"""Authoritative screening policy; consumers must use the returned decisions."""
import re
from pathlib import Path
import joblib

MODEL_FILE = Path(__file__).resolve().parent / 'model' / 'toxicity_pipeline.joblib'
# Keys are API modes; legacy fallback only. Retrained artifacts carry their thresholds.
THRESHOLDS = {'relaxed': 0.35, 'balanced': 0.15, 'strict': 0.0}
WORDS = {'fuck', 'fucking', 'fucked', 'fucker', 'motherfucker', 'motherfucking', 'shit', 'bullshit',
         'dipshit', 'bitch', 'bastard', 'asshole', 'dumbass', 'jackass', 'cunt', 'whore', 'slut',
         'twat', 'wanker',
         # Common romanised Hindi (Hinglish) abuse; the ML model needs Hinglish training data to
         # judge these in context, so they are reported as profanity only.
         'madarchod', 'behenchod', 'bhenchod', 'chutiya', 'chutiye', 'gandu', 'harami',
         'haramkhor', 'bhosdike', 'bhosdika'}
# Masked spellings such as f*ck or sh*t (the tokenizer would otherwise split them at the symbol).
MASKED = {'f*ck': 'fuck', 'f**k': 'fuck', 'f*cking': 'fucking', 'f**king': 'fucking', 'sh*t': 'shit',
          'b*tch': 'bitch', 'a**hole': 'asshole', 'a*shole': 'asshole', 'c*nt': 'cunt'}
MASKED_RE = re.compile(r'(?<!\w)(?:' + '|'.join(re.escape(k) for k in sorted(MASKED, key=len, reverse=True)) + r')(?!\w)')
REPEAT_RE = re.compile(r'(.)\1{2,}')
# Positive evidence for assessing brief insults, not a list of harmless exceptions.
SHORT_INSULTS = {'idiot', 'idiots', 'stupid', 'moron', 'morons', 'loser',
                 'losers', 'dumb', 'pathetic', 'worthless', 'asshole', 'bitch',
                 'bastard', 'cunt'}
SHORT_THREATS = {('kill', 'yourself'), ('go', 'die'), ('fuck', 'you')}
THREAT_THRESHOLD_CAP = 0.0
TOKEN = re.compile(r"\w+(?:['’]\w+)*", re.UNICODE)


class Detector:
    def __init__(self, pipeline=None, thresholds=None):
        if pipeline is None and not MODEL_FILE.is_file():
            raise FileNotFoundError(f'Model missing: {MODEL_FILE}. Run python ml/train_model.py first.')
        self.pipeline = pipeline if pipeline is not None else joblib.load(MODEL_FILE)
        self.thresholds = thresholds or getattr(self.pipeline, "cybershield_thresholds_", THRESHOLDS)
        features = self.pipeline.named_steps['tfidf']
        # Word + character pipelines expose the word vectorizer as 'word'; the older single
        # TF-IDF pipeline is itself the word vectorizer. The word vocabulary drives the
        # "recognised words" eligibility gate; the full feature matrix drives the SVM score.
        self.features = features
        self.vectorizer = features.named_transformers['word'] if hasattr(features, 'named_transformers') else features
        self.vocabulary = self.vectorizer.vocabulary_

    def analyze(self, texts, sensitivity='balanced'):
        if sensitivity not in self.thresholds:
            raise ValueError('Unknown sensitivity')
        if not texts:
            return []
        vectors = self.features.transform(texts)
        scores = self.pipeline.named_steps['svc'].decision_function(vectors)
        results = []
        for row, (text, score) in enumerate(zip(texts, scores)):
            tokens = self.vectorizer.build_tokenizer()(self.vectorizer.build_preprocessor()(text))
            recognised = {t for t in tokens if t in self.vocabulary}
            # Keep Unicode letters/digits and underscores within tokens: no substring
            # matches in Scunthorpe, shitake, shit123, or a non-Latin word.
            normalized = MASKED_RE.sub(lambda m: MASKED[m.group(0)], text.lower())
            normalized = normalized.translate(str.maketrans({'@': 'a', '0': 'o', '1': 'i', '$': 's', '3': 'e'}))
            normalized = REPEAT_RE.sub(r'\1', normalized)  # fuuuck -> fuck
            complete_tokens = TOKEN.findall(normalized)
            terms = sorted(WORDS.intersection(complete_tokens))
            threat_cue = any(
                tuple(complete_tokens[i:i+2]) in SHORT_THREATS
                for i in range(len(complete_tokens)-1)
            )
            short_cue = bool(SHORT_INSULTS.intersection(complete_tokens)) or threat_cue
            known_cue = short_cue and bool(recognised)
            eligible = vectors[row].nnz > 0 and (
                (len(tokens) >= 3 and len(recognised) >= 2) or known_cue
            )
            # Standalone expletives are profanity, not evidence of targeted abuse.
            profanity_only = bool(complete_tokens) and all(t in WORDS for t in complete_tokens)
            eligible = eligible and not profanity_only
            # Explicit threats ("kill yourself", "go die") are never held back by a strict
            # precision threshold: their effective threshold is capped at the SVM's neutral point.
            threshold = min(self.thresholds[sensitivity], THREAT_THRESHOLD_CAP) if threat_cue else self.thresholds[sensitivity]
            toxic = bool(eligible and score >= threshold)
            assessment = 'potential_abuse' if toxic else ('not_flagged' if eligible else 'insufficient_information')
            reasons = []
            if toxic:
                reasons.append('Potential abusive language (ML screening)')
            if terms:
                reasons.append('Profanity term detected (not proof of bullying)')
            reason = '; '.join(reasons) or ('No flag' if eligible else 'Insufficient information')
            results.append(dict(toxic=toxic, margin=float(score), ml_eligible=bool(eligible),
                                assessment=assessment, recognised_words=len(recognised),
                                feature_count=int(vectors[row].nnz), profanity=bool(terms),
                                matched_terms=terms, flagged=bool(toxic or terms), reason=reason,
                                sensitivity=sensitivity, threshold=threshold, policy_version=2))
        return results
