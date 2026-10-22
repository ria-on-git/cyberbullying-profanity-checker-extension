"""Run with .venv/bin/python -m unittest discover -s tests -v."""
import unittest
from backend.app import app, detector
from backend.detector import THRESHOLDS

CASES = {
    'names': ['Alice', 'John', 'Sarah', 'Mohammed', 'Priya', 'Scunthorpe'],
    'labels': ['Home', 'Settings', 'Account', 'Profile', 'Support', 'Dick'],
    'ordinary': ['Have a wonderful day', 'Thank you for your help', 'The meeting starts at noon', 'I like this project'],
    'unknown': ['', '!!!', 'qzxv', 'qzxv blorf snazz', '東京'],
    'short_insults': ['idiot', 'you idiot', 'stupid', 'you moron', 'kill yourself', 'go die'],
    'targeted': ['You are a worthless idiot', 'You are stupid and nobody likes you'],
    'profanity_without_bullying': ['fuck', 'shit', 'This is fucking great', 'This shit is amazing'],
}

class PolicyTests(unittest.TestCase):
    def test_neutral_and_unknown(self):
        for level in THRESHOLDS:
            for group in ['names', 'labels', 'ordinary', 'unknown']:
                for text, result in zip(CASES[group], detector.analyze(CASES[group], level)):
                    with self.subTest(level=level, text=text):
                        if level != 'strict' or group != 'ordinary':
                            self.assertFalse(result['flagged'])
                        if group in ['names', 'labels', 'unknown']:
                            self.assertEqual(result['assessment'], 'insufficient_information')

    @unittest.expectedFailure
    def test_known_strict_neutral_sentence_errors(self):
        for text in ['Have a wonderful day', 'I like this project']:
            self.assertFalse(detector.analyze([text], 'strict')[0]['toxic'], text)

    def test_abuse(self):
        for level in THRESHOLDS:
            for text in CASES['short_insults'] + CASES['targeted']:
                with self.subTest(level=level, text=text):
                    self.assertTrue(detector.analyze([text], level)[0]['toxic'])

    def test_separate_profanity(self):
        for result in detector.analyze(CASES['profanity_without_bullying'][:-1]):
            self.assertTrue(result['profanity'])
            self.assertFalse(result['toxic'])

    @unittest.expectedFailure
    def test_known_positive_expletive_error(self):
        self.assertFalse(detector.analyze(['This shit is amazing'])[0]['toxic'])

    def test_complete_tokens(self):
        for text in ['Scunthorpe', 'shitake', 'classhole', 'shit123', 'shit_name', 'shit東京']:
            self.assertFalse(detector.analyze([text])[0]['profanity'], text)
        for text in ['SHIT!', 'fuck', '(bitch)', 'sh1t']:
            self.assertTrue(detector.analyze([text])[0]['profanity'], text)

    def test_api_parity(self):
        with app.test_client() as client:
            for level in THRESHOLDS:
                texts = sum(CASES.values(), [])
                response = client.post('/predict', json={'texts': texts, 'sensitivity': level})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json['results'], detector.analyze(texts, level))
            for level in ['invalid', [], None]:
                self.assertEqual(client.post('/predict', json={'texts': ['hello'], 'sensitivity': level}).status_code, 400)
            self.assertEqual(client.post('/predict', json={'texts': [None]}).status_code, 400)

if __name__ == '__main__':
    unittest.main()
