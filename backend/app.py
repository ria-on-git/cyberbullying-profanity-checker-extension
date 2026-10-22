from flask import Flask, jsonify, request
try:
    from .detector import Detector, THRESHOLDS
except ImportError:
    from detector import Detector, THRESHOLDS

app = Flask(__name__)
detector = Detector()

@app.get('/health')
def health():
    return jsonify(status='ok', model='TF-IDF + LinearSVC')

@app.post('/predict')
def predict():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get('texts'), list):
        return jsonify(error='Expected JSON object with texts array'), 400
    texts = data['texts']
    if len(texts) > 50 or any(not isinstance(x, str) or len(x) > 2000 for x in texts):
        return jsonify(error='Maximum 50 strings of up to 2000 characters each'), 400
    sensitivity = data.get('sensitivity', 'balanced')
    if not isinstance(sensitivity, str) or sensitivity not in THRESHOLDS:
        return jsonify(error='Unknown sensitivity'), 400
    return jsonify(results=detector.analyze(texts, sensitivity))

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=False)
