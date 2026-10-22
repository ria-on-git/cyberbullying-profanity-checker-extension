# CyberShield AI — Cyberbullying & Profanity Screening Extension

CyberShield AI is a browser extension with a local Flask API that screens visible webpage text for **potentially abusive language** and **profanity**. It can highlight suspicious text and save local detections, reports, and user-reviewed feedback.

> **Important:** A flag is a screening result, not proof that bullying occurred. Profanity and targeted abuse are separate signals. Reports are stored locally in the browser; saving one does not notify the website or its moderators.

## Contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [How detection works](#how-detection-works)
- [Dataset and labels](#dataset-and-labels)
- [Training methodology](#training-methodology)
- [Evaluation](#evaluation)
- [Requirements](#requirements)
- [Run locally on Windows](#run-locally-on-windows)
- [Load the extension in Chrome](#load-the-extension-in-chrome)
- [Run the demo pages](#run-the-demo-pages)
- [Test the API](#test-the-api)
- [Retraining the model](#retraining-the-model)
- [Feedback and data handling](#feedback-and-data-handling)
- [Limitations](#limitations)
- [Project structure](#project-structure)
- [Credits](#credits)

## Features

- Scans supported visible webpage text manually and as supported page content changes.
- Uses a machine-learning classifier to screen text for potential toxicity.
- Runs a separate profanity check; swearing is not automatically treated as bullying.
- Offers Relaxed, Balanced, and Strict screening sensitivity settings.
- Shows warnings and explanatory details for detections.
- Stores detections, reports, and reviewed/unreviewed feedback locally in the browser profile.
- Exports records as JSON for later review.
- Includes demo pages and tests for scanner behavior and decision-policy checks.
- Runs model inference locally through Flask. Text is sent to the local API at `127.0.0.1`, not a hosted prediction service.

## Tech stack

| Component | Technology | Purpose |
|---|---|---|
| Browser extension | JavaScript, HTML, CSS | Popup, page scanning, highlights, settings and records UI |
| Extension manifest | Chrome Manifest V3 | Permissions, popup, content script and background service worker |
| Backend API | Python, Flask | Local `/health` and `/predict` endpoints |
| Text features | scikit-learn TF-IDF | Converts text into word- and character-level numeric features |
| Toxicity classifier | LinearSVC | Scores text for potentially toxic language |
| Profanity rules | Python regular expressions and token matching | Detects a maintained list of profanity separately from ML |
| Model persistence | joblib | Saves and loads the fitted scikit-learn pipeline |
| Record storage | IndexedDB and `chrome.storage.local` | Stores extension records and settings in the browser |
| Tests | Python `unittest`, Node.js browser test harness | Tests policy, evaluation and scanner behavior |

## How detection works

### 1. Webpage text collection

The content script (`extension/content.js`) looks for supported visible text blocks. It avoids areas such as editable fields and navigation, and handles supported content that is added, edited or removed. It cannot scan every page or every type of embedded content.

### 2. Local API request

The extension background service worker (`extension/background.js`) sends text to Flask:

```http
POST http://127.0.0.1:5000/predict
Content-Type: application/json
```

Example request:

```json
{
  "texts": ["You are an idiot and nobody likes you"],
  "sensitivity": "balanced"
}
```

The API accepts a `texts` array (up to 50 strings per request, each up to 2,000 characters).

### 3. Toxicity screening: TF-IDF + LinearSVC

The trained pipeline uses two text representations:

- **Word TF-IDF, word n-grams 1–2:** represents individual words and adjacent two-word sequences.
- **Character-within-word TF-IDF, n-grams 2–5:** captures character patterns and can help with spelling variations.
- **LinearSVC:** learns a separating boundary between toxic and non-toxic training examples and returns a signed decision margin. The margin is **not a probability**.

The detector also applies an eligibility gate. Empty/unrecognised text and very short neutral labels can return `insufficient_information` instead of forcing a toxicity classification. Certain short insult/threat cues allow short text to be assessed. Explicit threat phrases such as “kill yourself” and “go die” receive a threshold cap.

### 4. Separate profanity rules

Profanity is not determined solely by the classifier. A separate rule-based check:

- Matches complete tokens rather than arbitrary substrings.
- Applies limited normalization for masked spellings (for example, `f*ck`) and repeated letters (for example, `fuuuck`).
- Includes selected common English profanity and romanised Hindi/Hinglish abuse terms.
- Reports matched terms separately from the ML toxicity decision.

A profanity-only result is not, by itself, proof of targeted abuse. The profanity list is rule-based and is not a separately trained model.

### 5. Sensitivity thresholds

The supplied model artifact stores these operating thresholds:

| Setting | Threshold | Intended trade-off |
|---|---:|---|
| Relaxed | `0.275` | Fewer false alarms; may miss more abusive examples |
| Balanced | `-0.200` | General balance between precision and recall |
| Strict | `-0.425` | More sensitive; may flag more harmless text |

These thresholds were selected using validation data, not the final test split. Lower thresholds generally make it easier to flag text. LinearSVC margins are not confidence percentages.

## Dataset and labels

The main training file is **`ml/dataset.csv`**. It contains two columns:

| Column | Meaning |
|---|---|
| `headline` | Text example used as model input |
| `label` | Source class: `-1` means toxic; `0` means non-toxic |

The training script maps source `-1` → toxic target `1`, and source `0` → non-toxic target `0`.

The bundled CSV has **18,148 rows** before cleaning: **11,661 toxic** and **6,487 non-toxic** examples. The original project/dataset are credited to [Chando0185](https://github.com/Chando0185). Check the upstream repository's license and attribution requirements before redistribution or reuse.

### Dataset cleaning

`ml/train_model.py` audits and normalizes examples before splitting:

1. Normalizes text for equivalence checking.
2. Removes duplicate/equivalent repetitions so the same normalized text does not leak between splits.
3. Excludes groups with conflicting labels rather than guessing a correct label.
4. Excludes empty-equivalent rows.
5. Keeps one representative per remaining equivalent-text group.

For the bundled training run, this leaves **17,023 retained examples**. The script records the audit, dataset SHA-256, software versions, split sizes and hashes of normalized examples in `backend/model/metrics.json` and `backend/model/split_manifest.json`.

### Adding more labelled data

Additional CSVs can be placed in `ml/extra/`. The training script supports extra datasets with `text,label` columns, where `1` means toxic and `0` means non-toxic. See [`ml/extra/README.md`](ml/extra/README.md). Specific files can be passed to the trainer with `--extra`.

Only add examples with reviewed, reliable labels. Do not treat an extension user's “Incorrect” click as an automatic opposite label.

## Training methodology

Training code: **`ml/train_model.py`**  
Optional Colab workflow: **`ml/train_on_colab.ipynb`**

The supplied pipeline was trained with this procedure:

1. **Prepare and audit data:** normalize examples, deduplicate equivalent text, exclude conflicting labels and empty text.
2. **Split data:** stratified, disjoint **60% train / 20% validation / 20% test** splits with random seed `42`.
3. **Fit TF-IDF correctly:** vocabulary and IDF are learned inside training folds during cross-validation and then from the training split only; validation/test text is not used to fit the vectorizer.
4. **Tune SVM regularization:** three-fold stratified cross-validation selects `svc__C` using F1. The supplied run selected `C = 1.0`.
5. **Select sensitivity thresholds:** validation data selects Relaxed, Balanced and Strict thresholds according to F0.5, F1 and F2 objectives respectively, with ordering constraints.
6. **Evaluate:** after fitting and policy selection, the held-out test split is evaluated and the results saved.
7. **Save artifacts:** the fitted pipeline is stored as `backend/model/toxicity_pipeline.joblib`; evaluation details and split hashes are saved beside it.

| Split | Examples |
|---|---:|
| Training | 10,213 |
| Validation | 3,405 |
| Test | 3,405 |
| **Total retained** | **17,023** |

The final test set has been used in the project's development/evaluation history to compare earlier versions, so it should not be presented as a completely new independent external benchmark.

## Evaluation

Detailed report: [`ml/EVALUATION.md`](ml/EVALUATION.md)  
Machine-readable metrics: [`backend/model/metrics.json`](backend/model/metrics.json)

On the supplied 3,405-example test split, the full toxicity policy at **Balanced** sensitivity reported:

| Metric | Result |
|---|---:|
| Precision | 0.9225 |
| Recall | 0.9483 |
| F1 score | 0.9353 |
| Non-toxic examples incorrectly flagged by toxicity policy | 168 / 1,295 |
| Non-toxic false-positive rate | 12.97% |

These results describe this dataset and split; they are not a guarantee of performance on arbitrary live websites. The combined UI warning can also be triggered by the separate profanity rule, so combined warnings should not be interpreted as toxicity-classifier accuracy. The project does not include an independent labelled profanity test set, so profanity precision/recall has not been established.

## Requirements

- Windows, macOS or Linux
- Python 3.10+ recommended; the recorded training run used Python 3.13.14
- Chromium-based browser with Manifest V3 support (Chrome/Edge)
- Python packages listed in `backend/requirements.txt`
- Node.js/npm only if you want to run the optional browser test harness

The saved scikit-learn model may require a compatible scikit-learn version. If loading the model fails, create a clean environment and retrain using your installed versions, or install the compatible version recorded in `backend/model/metrics.json`.

## Run locally on Windows

### 1. Extract the project

Extract the ZIP to a folder, for example:

```text
E:\cyberbullying-profanity-checker-extension\
```

Open Command Prompt in that folder. The project root should contain `backend`, `extension`, `ml`, `tests`, and `README.md`.

### 2. Create a virtual environment and install dependencies

```bat
py -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

If `py` is unavailable, try `python` instead.

### 3. Start Flask

From the project root:

```bat
python backend\app.py
```

Keep this terminal open. The API binds to `127.0.0.1:5000`.

Open **http://127.0.0.1:5000/health** to verify the backend. Expected response resembles:

```json
{
  "model": "TF-IDF (word+char) + LinearSVC",
  "status": "ok"
}
```

If the model file is missing or cannot be loaded, train it first as described under [Retraining the model](#retraining-the-model).

### 4. Load the extension in Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the project's **`extension`** folder (not the project root).
5. Keep Flask running and refresh webpages that were already open.
6. Visit a normal `http://` or `https://` webpage and click the extension icon to scan.

The popup intentionally disables scanning on unsupported URL schemes such as `file://`, browser-internal pages and extension pages. For local demo HTML files, use the local HTTP server instructions below rather than opening the file directly.

### 5. Run the demo pages over HTTP

Open a **second** Command Prompt in the project root and run:

```bat
python -m http.server 8000 --bind 127.0.0.1
```

Then open:

- **http://127.0.0.1:8000/demo.html** — dynamic scanner demo.
- **http://127.0.0.1:8000/records-demo.html** — records/detection demo.

Keep both terminals open: Flask on port 5000 and the static demo server on port 8000. Stop a server with `Ctrl+C`.

## Test the API

In a second Command Prompt, send a prediction request:

```bat
curl -X POST http://127.0.0.1:5000/predict -H "Content-Type: application/json" -d "{\"texts\":[\"You are an idiot and nobody likes you\"],\"sensitivity\":\"balanced\"}"
```

The response contains a `results` array with fields such as `flagged`, `toxic`, `profanity`, `matched_terms`, `assessment`, `margin`, `threshold` and `reason`.

Test the separate profanity rule:

```bat
curl -X POST http://127.0.0.1:5000/predict -H "Content-Type: application/json" -d "{\"texts\":[\"This is fucking bullshit\"],\"sensitivity\":\"balanced\"}"
```

Inspect `profanity` and `matched_terms` separately from `toxic`. A profanity warning is not necessarily a toxicity classification.

## Retraining the model

From the project root, with the virtual environment activated:

```bat
python ml\train_model.py
```

The trainer replaces the saved pipeline and writes evaluation/manifest files under `backend/model/`. Stop Flask before replacing the model, then restart it after training.

Optional Python tests:

```bat
python -m unittest discover -s tests -v
```

The optional browser test harness is in `tests/browser/`; see its README for Node.js setup and commands.

## Feedback and data handling

- Detections, reports and feedback are stored in the browser profile using IndexedDB; settings use `chrome.storage.local`.
- Records are not automatically uploaded to a remote service.
- **Incorrect** creates feedback for human review; it does not flip the original label or retrain the model.
- Toxicity and profanity labels can be reviewed independently. Only reviewed, explicitly labelled examples should be considered for future dataset curation.
- Export JSON and curate it manually before training. The trainer does not automatically import feedback exports.
- Each records view is capped at 200 unique records across sites. Export useful reviewed feedback before it is evicted.
- Load only trusted `.joblib` files; joblib/pickle artifacts can execute code when loaded.

## Limitations

- The model reflects the dataset's language, topics and annotation choices; it may misread sarcasm, quotations, reclaimed language, context, dialects and multilingual text.
- The supplied toxicity dataset is not a comprehensive cyberbullying dataset, and the profanity list is manually maintained.
- The model is not a probability estimator and does not prove intent, harassment or bullying.
- The extension scans supported visible page text, not every browser surface, image, video, canvas or inaccessible cross-origin frame.
- The API is configured for local use on `127.0.0.1`; do not expose it publicly without reviewing security and deployment settings.
- The included manifest targets Chromium Manifest V3. Firefox support may require manifest/background compatibility changes and testing.

## Project structure

```text
cyberbullying-profanity-checker-extension/
├── backend/
│   ├── app.py                       # Flask API
│   ├── detector.py                  # ML policy + profanity rules
│   ├── requirements.txt             # Python dependencies
│   └── model/
│       ├── toxicity_pipeline.joblib  # Trained TF-IDF + LinearSVC pipeline
│       ├── metrics.json              # Dataset audit and evaluation metrics
│       └── split_manifest.json       # Hashed split membership
├── extension/
│   ├── manifest.json                # Manifest V3 configuration
│   ├── background.js                # API bridge and record writes
│   ├── content.js                   # Webpage scanning/highlighting
│   ├── popup.html / popup.js        # Popup interface and actions
│   ├── popup.css                    # Popup styling
│   └── records.js                   # Local records and feedback handling
├── ml/
│   ├── dataset.csv                  # Main labelled dataset
│   ├── train_model.py               # Data cleaning, training and evaluation
│   ├── train_on_colab.ipynb         # Optional Colab workflow
│   ├── EVALUATION.md                # Detailed evaluation notes
│   └── extra/README.md              # Additional dataset format
├── tests/
│   ├── test_evaluation.py
│   ├── test_policy.py
│   └── browser/                     # Optional browser test harness
├── demo.html                        # Dynamic scanner demonstration
├── records-demo.html                # Records behavior demonstration
└── README.md
```

## Credits

The original project/dataset are credited to [Chando0185 on GitHub](https://github.com/Chando0185). This repository includes changes to the browser extension, local Flask integration, training/evaluation pipeline, decision policy, records/feedback handling and documentation. Review the upstream repository's license and include any required attribution when redistributing.

---

**Project purpose:** assist with screening potentially abusive webpage text for review. It is not a substitute for human judgement or a definitive determination that cyberbullying has occurred.
