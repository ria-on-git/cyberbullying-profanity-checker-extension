# CyberShield AI — Cyberbullying & Profanity Checker (Chrome Extension)

A Manifest V3 browser extension that scans visible text on webpages and highlights potentially toxic or profane content. Detection runs **entirely on your own machine**: the extension sends text snippets to a local Flask API (`127.0.0.1:5000`) which uses a TF-IDF + LinearSVC model plus a separate profanity rule.

> A warning is screening evidence, not proof of bullying. Saving a report is local only — it does **not** notify the website or its moderators.

---

## Features

- Scans visible page text (comments, posts, paragraphs) and highlights flagged blocks with a warning.
- Two independent checks: **ML toxicity** and **profanity** (including masked spellings like `f*ck`, stretched letters like `fuuuck`, and common romanised Hindi terms).
- Three sensitivity levels: **Relaxed**, **Balanced**, **Strict**.
- **Why?** button explains the decision (margin, threshold, matched profanity terms).
- Popup with three views: **Detections**, **Reports**, **Feedback** — all stored locally in IndexedDB, exportable as JSON.
- Mark wrong predictions as **Incorrect**, review them with human labels, and export reviewed feedback for later dataset curation.
- Handles dynamic pages (added/edited/removed content) and ignores forms, editable fields, navigation and hidden text.
- No cloud, no account, no telemetry.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Browser extension** | JavaScript (vanilla), Chrome Manifest V3, service worker (`background.js`), content script (`content.js`), popup (HTML/CSS/JS) |
| **Local storage** | IndexedDB (records, reports, feedback), `chrome.storage.local` (settings) |
| **UI isolation** | Closed Shadow DOM for in-page warnings |
| **Backend API** | Python 3, Flask (`/health`, `/predict`) |
| **Machine learning** | scikit-learn — word (1–2 gram) + character (`char_wb` 2–5 gram) **TF-IDF** → **LinearSVC**, `FeatureUnion`, `GridSearchCV` |
| **Data / model handling** | pandas, joblib (`toxicity_pipeline.joblib`) |
| **Training** | `ml/train_model.py` (local) or `ml/train_on_colab.ipynb` (Google Colab) |
| **Testing** | Python `unittest`; Playwright-core (Chromium) browser harness run with Node.js |
| **Dataset** | `ml/dataset.csv` — ~18k labelled texts (`-1` toxic, `0` non-toxic), credited to [Chando0185](https://github.com/Chando0185). Check the upstream license before redistributing. |

**Model results (v2, test set of 3,405 samples):** Raw SVM F1 ≈ 0.941; Balanced policy F1 ≈ 0.935. See [`ml/EVALUATION.md`](ml/EVALUATION.md) for full tables. These numbers do not guarantee accuracy on real websites.

---

## Project Structure

```
cyberbullying-profanity-checker-extension/
├── backend/
│   ├── app.py                  # Flask API
│   ├── detector.py             # Screening policy (ML + profanity rules)
│   ├── requirements.txt
│   └── model/                  # Trained pipeline, metrics, split manifest
├── extension/                  # Load this folder in the browser
│   ├── manifest.json
│   ├── background.js           # Service worker, API calls, IndexedDB writes
│   ├── content.js              # Page scanner and warning UI
│   ├── records.js              # IndexedDB record logic
│   └── popup.html / .css / .js
├── ml/
│   ├── train_model.py
│   ├── train_on_colab.ipynb
│   ├── dataset.csv
│   ├── extra/                  # Drop extra labelled CSVs here
│   └── EVALUATION.md
├── tests/                      # Python tests + browser harness
├── demo.html                   # Dynamic scanner demo page
└── records-demo.html           # Demo page for reports/feedback
```

---

## Prerequisites

- **Python 3.10+** (tested with Python 3.12 / 3.13)
- **A Chromium-based browser** with Manifest V3 support: Google Chrome, Microsoft Edge, or Brave
- **Node.js** — *optional*, only for the browser test harness

---

## How to Run

The extension has two parts that must both be running: the **local API** and the **loaded extension**.

### Step 1 — Start the backend API

#### macOS / Linux

```bash
cd cyberbullying-profanity-checker-extension

python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python backend/app.py
```

#### Windows (PowerShell)

```powershell
cd cyberbullying-profanity-checker-extension

python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
python backend\app.py
```

> If PowerShell blocks activation ("running scripts is disabled"), run this once and retry:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

#### Windows (Command Prompt)

```bat
cd cyberbullying-profanity-checker-extension

python -m venv .venv
.venv\Scripts\activate.bat
python -m pip install -r backend\requirements.txt
python backend\app.py
```

Verify the API is up by opening **http://127.0.0.1:5000/health** — you should see `{"model": "TF-IDF (word+char) + LinearSVC", "status": "ok"}`.

Keep this terminal open while using the extension.

> **Model error?** If you see a missing or incompatible model error (usually a scikit-learn version mismatch), retrain with your installed version:
> `python ml/train_model.py` then restart the API.

### Step 2 — Load the extension

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the **`extension`** folder.
4. Pin the extension and reload any pages that were already open.

This works the same on macOS and Windows.

### Step 3 — Try the demo (optional)

In a **second terminal** from the project root, with the virtual environment activated:

**macOS / Linux**
```bash
python -m http.server 8765 --bind 127.0.0.1
```

**Windows**
```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Open **http://127.0.0.1:8765/records-demo.html** (or `demo.html`) and click the extension icon → **Scan current page**.

---

## Using the Extension

1. Keep the local API running.
2. Browse to any `http`/`https` page. Flagged text is outlined with a warning.
3. On a warning:
   - **Why?** — see the ML assessment and profanity terms
   - **Report** — save a local record
   - **Incorrect** — save the prediction as feedback and dismiss it
   - **Ignore** — dismiss without saving
4. Open the popup to change **sensitivity**, view **Detections / Reports / Feedback**, switch between **Current site / All sites**, and **export** or **clear** records.

---

## Retraining the Model

```bash
# macOS / Linux
python ml/train_model.py

# Windows
python ml\train_model.py
```

- Add more data by placing CSVs with `text,label` columns (`1` toxic, `0` non-toxic) in `ml/extra/`, or pass them with `--extra file1.csv file2.csv`.
- For large datasets, use `ml/train_on_colab.ipynb`, then copy the downloaded `backend/model/` over the local one. The local scikit-learn version must match the one used for training.
- Restart the API after replacing the model.

---

## Running Tests

**Python tests** (from the project root):

```bash
# macOS / Linux
.venv/bin/python -m unittest discover -s tests -v

# Windows
.venv\Scripts\python -m unittest discover -s tests -v
```

**Browser tests** (optional, requires Node.js):

```bash
npm install --prefix tests/browser --no-audit --no-fund
node tests/browser_scanner.cjs
```

The harness defaults to macOS Brave. On Windows or other browsers, set `BROWSER_EXECUTABLE` to a Chromium executable that allows unpacked extensions, and `PYTHON` to your venv's Python:

```powershell
# Windows PowerShell example
$env:BROWSER_EXECUTABLE="C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
$env:PYTHON=".venv\Scripts\python.exe"
node tests/browser_scanner.cjs
```

See [`tests/browser/README.md`](tests/browser/README.md) for details.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `ModuleNotFoundError` | Activate the virtual environment and reinstall `backend/requirements.txt`. |
| Popup says "detection service unavailable" | Start the API and check `http://127.0.0.1:5000/health`. |
| Port 5000 already in use (common on **macOS**: AirPlay Receiver) | Turn off *System Settings → General → AirDrop & Handoff → AirPlay Receiver*, or change the port in `backend/app.py`, `extension/background.js` and `extension/manifest.json` together, then restart the API and reload the extension. |
| `python` not found on Windows | Reinstall Python and tick **Add Python to PATH**, or use `py -m venv .venv`. |
| Extension changes not showing | Click **Reload** on the extension card, then refresh open pages. |
| Records seem missing | Check the selected view, **Current site / All sites**, and browser profile. Each view keeps at most 200 records. |
| Model load / scikit-learn version error | Run `python ml/train_model.py` to rebuild the model for your environment. |

---

## Privacy

- Text snippets go only to `127.0.0.1:5000` on your machine.
- Records, reviews and settings stay in your browser profile; only full page **origins** are stored, not full URLs.
- Local storage is not encrypted and is not a backup — export what you want to keep.
- Only load trusted `.joblib` model files.

## Limitations

- Does not scan iframes, website-owned Shadow DOM, canvas text, Chrome internal pages, or text blocks longer than 1,000 characters.
- Casual profanity ("This shit is amazing"), sarcasm, quotations and slang can be misclassified.
- The ML model only understands Hinglish if trained on Hinglish data.
- Dataset bias and lack of context remain.
- No automatic moderation action is taken.
