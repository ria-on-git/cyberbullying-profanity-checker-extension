"""Reproducible deduplicated train/validation/test evaluation; no test tuning."""
import argparse
import glob
import hashlib
import json
import platform
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import FeatureUnion
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import GridSearchCV, StratifiedKFold, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.detector import Detector

SEED = 42


def build_pipeline():
    """Word (1-2 gram) + character (2-5 gram) TF-IDF feeding a LinearSVC.

    Character n-grams recover obfuscated words (f*ck, sh1t, fuuuck), typos and
    romanised Hindi/Hinglish spellings that a word vocabulary has never seen.
    The detector reads the fitted word vectorizer through the name 'word'.
    """
    features = FeatureUnion([
        ('word', TfidfVectorizer(lowercase=True, strip_accents='unicode', ngram_range=(1, 2),
                                 min_df=2, max_features=80000, sublinear_tf=True)),
        ('char', TfidfVectorizer(lowercase=True, strip_accents='unicode', analyzer='char_wb',
                                 ngram_range=(2, 5), min_df=3, max_features=150000,
                                 sublinear_tf=True)),
    ])
    return Pipeline([('tfidf', features), ('svc', LinearSVC(random_state=SEED))])


def load_extra(paths):
    """Load extra labelled CSVs and convert them to the source format (-1 toxic, 0 non-toxic).

    Each file needs a text column (text or headline) and a label column where
    1 or -1 means toxic and 0 means non-toxic. Rows with other labels are rejected.
    """
    frames, hashes = [], {}
    for path in paths:
        raw = pd.read_csv(path)
        text_col = next((c for c in ('text', 'headline') if c in raw.columns), None)
        if text_col is None or 'label' not in raw.columns:
            raise ValueError(f'{path}: needs a text (or headline) column and a label column')
        label = raw['label'].map({1: -1, -1: -1, 0: 0})
        if label.isna().any():
            raise ValueError(f'{path}: labels must be 1/-1 (toxic) or 0 (non-toxic)')
        frames.append(pd.DataFrame({'headline': raw[text_col].fillna('').astype(str), 'label': label.astype(int)}))
        hashes[Path(path).name] = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    return frames, hashes


def prepare(data):
    """Collapse exact and model-equivalent token sequences; exclude conflicts."""
    labels = data['label'].map({-1: 1, 0: 0})
    if labels.isna().any():
        raise ValueError('Unexpected or missing dataset label')
    frame = pd.DataFrame({'text': data.headline.fillna('').astype(str), 'label': labels.astype(int)})
    analyzer = TfidfVectorizer(strip_accents='unicode').build_analyzer()
    frame['key'] = frame.text.map(lambda text: ' '.join(analyzer(text)))
    conflicts = set(frame.groupby('key').label.nunique().loc[lambda n: n > 1].index)
    excluded = frame.key.isin(conflicts) | frame.key.eq('')
    clean = frame.loc[~excluded].drop_duplicates('key').reset_index(drop=True)
    audit = {'input_rows': len(frame), 'source_labels': {'-1': 'toxic (1)', '0': 'non-toxic (0)'},
             'original_class_counts': frame.label.value_counts().sort_index().to_dict(),
             'exact_duplicate_extra_rows': int(frame.text.duplicated().sum()),
             'equivalent_duplicate_extra_rows': int(frame.key.duplicated().sum()),
             'conflicting_groups': len(conflicts), 'conflicting_rows': int(frame.key.isin(conflicts).sum()),
             'empty_equivalent_rows': int(frame.key.eq('').sum()), 'retained_rows': len(clean)}
    return clean, audit


def summarize(y, pred):
    y, pred = np.asarray(y), np.asarray(pred, dtype=bool)
    p, r, f, _ = precision_recall_fscore_support(y, pred, average='binary', zero_division=0)
    cm = confusion_matrix(y, pred, labels=[0, 1]).tolist()
    return dict(precision=float(p), recall=float(r), f1=float(f), confusion_matrix=cm,
                safe_text_false_positives=cm[0][1], safe_text_count=int((y == 0).sum()),
                safe_text_false_positive_rate=float(cm[0][1] / max(1, (y == 0).sum())))


def choose_threshold(scores, eligible, labels, beta, lower=-np.inf, upper=np.inf):
    # Fixed grid, declared before evaluation; ties prefer the higher threshold.
    best = None
    for threshold in np.arange(-2, 3.001, .025):
        threshold = round(float(threshold), 3)
        if not lower <= threshold <= upper:
            continue
        pred = eligible & (scores >= threshold)
        y = np.asarray(labels)
        tp = int(((y == 1) & pred).sum())
        fp = int(((y == 0) & pred).sum())
        fn = int(((y == 1) & ~pred).sum())
        objective = (1 + beta**2) * tp / max(1, (1 + beta**2) * tp + beta**2 * fn + fp)
        candidate = (objective, threshold)
        if best is None or candidate > best:
            best = candidate
    return best[1]


def evaluate(detector, frame):
    y = frame.label.to_numpy()
    base = detector.analyze(frame.text.tolist())
    scores = np.array([r['margin'] for r in base])
    eligible = np.array([r['ml_eligible'] for r in base])
    profanity = np.array([r['profanity'] for r in base])
    result = {'samples': len(frame), 'class_counts': frame.label.value_counts().sort_index().to_dict(),
              'raw_svm_default_zero': summarize(y, scores >= 0),
              'insufficient_information': {'total': int((~eligible).sum()),
                  'by_true_class': {str(c): int(((y == c) & ~eligible).sum()) for c in [0, 1]}},
              'sensitivities': {},
              'profanity_rule': {'flag_count': int(profanity.sum()),
                  'by_toxicity_label': {str(c): int(((y == c) & profanity).sum()) for c in [0, 1]},
                  'note': 'No profanity ground truth: toxicity labels cannot measure profanity accuracy.'}}
    for level, threshold in detector.thresholds.items():
        raw = scores >= threshold
        pred = eligible & raw
        # columns: assessed negative, assessed positive, insufficient information
        three_way = [[int(((y == c) & eligible & ~pred).sum()), int(((y == c) & pred).sum()),
                      int(((y == c) & ~eligible).sum())] for c in [0, 1]]
        result['sensitivities'][level] = {'threshold': threshold,
            'raw_classifier': summarize(y, raw), 'policy_toxicity': summarize(y, pred),
            'policy_three_way_confusion': three_way,
            'policy_assessed_only': summarize(y[eligible], pred[eligible]),
            'combined_ui_warning': summarize(y, pred | profanity)}
    return result


def main():
    parser = argparse.ArgumentParser(description='Train and evaluate the CyberShield toxicity model.')
    parser.add_argument('--extra', nargs='*', default=None,
                        help='Extra labelled CSVs (text,label). Default: every ml/extra/*.csv')
    args = parser.parse_args()
    data_path = ROOT / 'ml/dataset.csv'
    extra_paths = args.extra if args.extra is not None else sorted(glob.glob(str(ROOT / 'ml/extra/*.csv')))
    extra_frames, extra_hashes = load_extra(extra_paths)
    base = pd.read_csv(data_path)
    clean, audit = prepare(pd.concat([base] + extra_frames, ignore_index=True))
    audit['extra_files'] = list(extra_hashes)
    train, rest = train_test_split(clean, test_size=.4, random_state=SEED, stratify=clean.label)
    validation, test = train_test_split(rest, test_size=.5, random_state=SEED, stratify=rest.label)
    splits = {'train': train, 'validation': validation, 'test': test}
    for a, b in [('train', 'validation'), ('train', 'test'), ('validation', 'test')]:
        assert set(splits[a].key).isdisjoint(splits[b].key)
    search = GridSearchCV(build_pipeline(), {'svc__C': [.25, .5, 1.]}, scoring='f1',
        cv=StratifiedKFold(3, shuffle=True, random_state=SEED), n_jobs=1)
    search.fit(train.text, train.label)
    model = search.best_estimator_
    detector = Detector(pipeline=model)
    val = detector.analyze(validation.text.tolist())
    scores = np.array([r['margin'] for r in val])
    eligible = np.array([r['ml_eligible'] for r in val])
    balanced = choose_threshold(scores, eligible, validation.label, 1)
    thresholds = {'relaxed': choose_threshold(scores, eligible, validation.label, .5, lower=balanced),
                  'balanced': balanced,
                  'strict': choose_threshold(scores, eligible, validation.label, 2, upper=balanced)}
    model.cybershield_thresholds_ = thresholds
    detector = Detector(pipeline=model)
    report = {'dataset_sha256': hashlib.sha256(data_path.read_bytes()).hexdigest(),
        'extra_datasets_sha256': extra_hashes,
        'model': 'word 1-2gram + char_wb 2-5gram TF-IDF + LinearSVC',
        'seed': SEED, 'versions': {'python': platform.python_version(), 'sklearn': sklearn.__version__,
                                  'numpy': np.__version__, 'pandas': pd.__version__},
        'audit': audit, 'split_sizes': {name: len(frame) for name, frame in splits.items()},
        'best_params': search.best_params_, 'cv_training_f1': float(search.best_score_),
        'threshold_selection': {'source': 'validation only', 'grid': '[-2, 3] step 0.025',
            'objective': 'Policy F0.5 relaxed, F1 balanced, F2 strict; abstentions count as no toxicity flag; relaxed >= balanced >= strict; ties prefer higher threshold',
            'thresholds': thresholds},
        'metric_notes': 'Confusion rows true [non-toxic,toxic], columns predicted [negative,positive]. Abstentions count as negative in end-to-end metrics. Three-way columns [assessed negative,assessed positive,insufficient]. UI warning includes profanity and is not an abuse classification.',
        'validation': evaluate(detector, validation)}
    # First use of test texts by fitted model, after all model/policy selection.
    report['test'] = evaluate(detector, test)
    output = ROOT / 'backend/model'
    output.mkdir(parents=True, exist_ok=True)
    manifest = {name: [{'key_sha256': hashlib.sha256(row.key.encode()).hexdigest(), 'label': int(row.label)}
                       for row in frame.itertuples()] for name, frame in splits.items()}
    (output / 'split_manifest.json').write_text(json.dumps(manifest, indent=2))
    joblib.dump(model, output / 'toxicity_pipeline.joblib')
    (output / 'metrics.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'audit': audit, 'thresholds': thresholds, 'test': report['test']}, indent=2))


if __name__ == '__main__':
    main()
