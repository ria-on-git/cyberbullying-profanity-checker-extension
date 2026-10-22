import unittest
import json
from pathlib import Path
from backend.detector import Detector
import numpy as np
import pandas as pd
from ml.train_model import prepare, choose_threshold, summarize


class EvaluationTests(unittest.TestCase):
    def test_saved_split_disjointness_and_thresholds(self):
        output = Path(__file__).resolve().parents[1] / 'backend/model'
        manifest = json.loads((output / 'split_manifest.json').read_text())
        metrics = json.loads((output / 'metrics.json').read_text())
        sets = {name: {row['key_sha256'] for row in rows} for name, rows in manifest.items()}
        for name, rows in manifest.items():
            self.assertEqual(len(rows), len(sets[name]))
            self.assertEqual(len(rows), metrics['split_sizes'][name])
        for a, b in [('train', 'validation'), ('train', 'test'), ('validation', 'test')]:
            self.assertTrue(sets[a].isdisjoint(sets[b]))
        self.assertEqual(Detector().thresholds, metrics['threshold_selection']['thresholds'])

    def test_equivalent_duplicates_and_conflicts(self):
        data = pd.DataFrame({'headline': ['Hello WORLD!', 'héllo world', 'bad person',
                                         'BAD person!', '', '!!!', 'unique sentence'],
                             'label': [0, 0, -1, 0, 0, 0, -1]})
        clean, audit = prepare(data)
        self.assertEqual(set(clean.key), {'hello world', 'unique sentence'})
        self.assertEqual(audit['conflicting_groups'], 1)
        self.assertEqual(audit['conflicting_rows'], 2)
        self.assertEqual(audit['empty_equivalent_rows'], 2)

    def test_unknown_labels_rejected(self):
        with self.assertRaises(ValueError):
            prepare(pd.DataFrame({'headline': ['x'], 'label': [1]}))

    def test_abstentions_count_as_missed_abuse(self):
        result = summarize([0, 1, 1], [False, True, False])
        self.assertEqual(result['confusion_matrix'], [[1, 0], [1, 1]])
        self.assertEqual(result['recall'], .5)

    def test_threshold_objectives_and_order(self):
        scores = np.array([-.5, .1, .2, .3, .4, .8])
        labels = np.array([0, 1, 0, 1, 0, 1])
        eligible = np.ones(6, dtype=bool)
        balanced = choose_threshold(scores, eligible, labels, 1)
        relaxed = choose_threshold(scores, eligible, labels, .5, lower=balanced)
        strict = choose_threshold(scores, eligible, labels, 2, upper=balanced)
        self.assertGreaterEqual(relaxed, balanced)
        self.assertLessEqual(strict, balanced)
        self.assertEqual(relaxed, .8)
        self.assertEqual(strict, .1)
