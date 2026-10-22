"""Authoritative screening policy; consumers must use the returned decisions."""
import re
from pathlib import Path
import joblib

MODEL_FILE = Path(__file__).resolve().parent / 'model' / 'toxicity_pipeline.joblib'
# Keys are API modes; legacy fallback only. Retrained artifacts carry their thresholds.
THRESHOLDS = {'relaxed': 0.35, 'balanced': 0.15, 'strict': 0.0}
WORDS = {'fuck', 'fucking', 'shit', 'bitch', 'bastard', 'asshole', 'cunt'}
# Positive evidence for assessing brief insults, not a list of harmless exceptions.
SHORT_INSULTS = {'idiot', 'idiots', 'stupid', 'moron', 'morons', 'loser',
                 'losers', 'dumb', 'pathetic', 'worthless', 'asshole', 'bitch',
                 'bastard', 'cunt'}
SHORT_THREATS = {('kill', 'yourself'), ('go', 'die'), ('fuck', 'you')}
TOKEN = re.compile(r"\w+(?:['’]\w+)*", re.UNICODE)


class Detector:
    def __init__(self, pipeline=None, thresholds=None):
        if pipeline is None and not MODEL_FILE.is_file():
            raise FileNotFoundError(f'Model missing: {MODEL_FILE}. Run python ml/train_model.py first.')
        self.pipeline = pipeline if pipeline is not None else joblib.load(MODEL_FILE)
        self.thresholds = thresholds or getattr(self.pipeline, "cybershield_thresholds_", THRESHOLDS)
        self.vectorizer = self.pipeline.named_steps['tfidf']
        self.vocabulary = self.vectorizer.vocabulary_

    def analyze(self, texts, sensitivity='balanced'):
        if sensitivity not in self.thresholds:
            raise ValueError('Unknown sensitivity')
        if not texts:
            return []
        vectors = self.vectorizer.transform(texts)
        scores = self.pipeline.named_steps['svc'].decision_function(vectors)
        results = []
        for row, (text, score) in enumerate(zip(texts, scores)):
            tokens = self.vectorizer.build_tokenizer()(self.vectorizer.build_preprocessor()(text))
            recognised = {t for t in tokens if t in self.vocabulary}
            # Keep Unicode letters/digits and underscores within tokens: no substring
            # matches in Scunthorpe, shitake, shit123, or a non-Latin word.
            normalized = text.lower().translate(str.maketrans({'@': 'a', '0': 'o', '1': 'i', '$': 's', '3': 'e'}))
            complete_tokens = TOKEN.findall(normalized)
            terms = sorted(WORDS.intersection(complete_tokens))
            short_cue = bool(SHORT_INSULTS.intersection(complete_tokens)) or any(
                tuple(complete_tokens[i:i+2]) in SHORT_THREATS
                for i in range(len(complete_tokens)-1)
            )
            known_cue = short_cue and bool(recognised)
            eligible = vectors[row].nnz > 0 and (
                (len(tokens) >= 3 and len(recognised) >= 2) or known_cue
            )
            # Standalone expletives are profanity, not evidence of targeted abuse.
            profanity_only = bool(complete_tokens) and all(t in WORDS for t in complete_tokens)
            eligible = eligible and not profanity_only
            toxic = bool(eligible and score >= self.thresholds[sensitivity])
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
                                sensitivity=sensitivity, threshold=self.thresholds[sensitivity], policy_version=2))
        return results
