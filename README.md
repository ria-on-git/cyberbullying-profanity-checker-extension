# CyberShield AI — local screening and reviewed feedback

CyberShield scans suitable visible webpage text with **word + character TF-IDF + LinearSVC** and a separate complete-token profanity rule. It highlights potential toxicity or profanity and keeps detections, local reports, and incorrect-prediction feedback in your browser profile. A result is screening evidence, not proof of bullying. **Saving a report does not notify the website or its moderators.**

The supplied dataset is `ml/dataset.csv`: `headline` is text, label `-1` means toxic and `0` means non-toxic. The original project/dataset are credited to [Chando0185](https://github.com/Chando0185); check the upstream license before redistribution.

## Setup and first run

Use Python with the packages in `backend/requirements.txt` and a Chromium browser supporting Manifest V3. The recorded Python checks used Python 3.13.14 and scikit-learn 1.9.1. npm is needed only for the optional browser test harness, not for running the extension.

From the project root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python backend/app.py
```

On Windows, activate with `.venv\Scripts\activate`. Check `http://127.0.0.1:5000/health`. If the model is missing or incompatible with your installed scikit-learn version, train it first with `python ml/train_model.py`, then start the API. Load only trusted joblib artifacts.

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension` directory. Reload pages already open. Keep the local API running during scanning.

For the demonstration, open another terminal in the project root:

```bash
.venv/bin/python -m http.server 8765 --bind 127.0.0.1
```

Open **http://127.0.0.1:8765/records-demo.html**. It contains harmless labels and names, unfamiliar vocabulary, safe comments, brief and targeted insults, and profanity without bullying. Its buttons duplicate and edit comments. Open two copies to try simultaneous local saves. `demo.html` provides additional dynamic scanner checks: add, edit, remove, hide/show, nested text, excluded forms/navigation/editors, and deliberately hostile page CSS.

## Scanning and decisions

- The API owns sensitivity decisions; the extension displays the returned decision rather than applying another margin threshold. The supplied retrained artifact uses Relaxed `0.275`, Balanced `-0.2`, Strict `-0.425`. Explicit threat phrases ("kill yourself", "go die") cap their effective threshold at `0.0`, and the returned `threshold` reflects that. Thresholds were selected on validation data: Relaxed favours precision (F0.5), Balanced balances precision/recall (F1), Strict favours recall (F2). An SVM margin is **not a probability**.
- Empty TF-IDF vectors and insufficient recognised text return `insufficient_information`, not an abuse classification. Short neutral labels cannot be classified from the SVM score alone. Brief insult/threat cues permit short messages to be assessed by the SVM; coverage is limited.
- Profanity is a separate result, matched as complete Unicode word tokens after limited leetspeak normalization, masked spellings (`f*ck`, `sh*t`) and stretched letters (`fuuuck`). The list includes some common romanised Hindi terms; the ML model only judges Hinglish context if you train it on Hinglish data. A profanity-only warning does not establish bullying. The ML classifier can still make contextual errors on casual profanity or quotations.
- The scanner queues affected visible leaf blocks, avoids forms, editable fields, navigation, hidden text, and its own UI, and handles added/edited/removed content. Full discovery occurs on initial/manual scans or settings changes; mutations inspect affected subtrees. Old responses cannot reapply warnings after edits or disabling. Original outline values/priorities are restored without overwriting subsequent page changes.
- Warnings use closed Shadow DOM. **Why?** shows the actual ML assessment, sensitivity/threshold, margin, and separate profanity terms. **Report** saves a local record. **Incorrect** saves unreviewed feedback and dismisses that warning. **Ignore** dismisses the warning without feedback.
- The popup distinguishes scanning, completion, no detections, disabled protection, and API unavailable. Sensitivity changes reevaluate existing text. Current warning counts and stored record counts are separate.

## Local detections, reports, and feedback

The popup has three independent views:

| View | What is saved | Actions |
| --- | --- | --- |
| Detections | Automatically saved warning snippets and original prediction snapshots | Save local report; mark incorrect; export; clear |
| Reports | Snippets explicitly saved with Report, including their prediction snapshot | Mark incorrect; export; clear |
| Feedback | Predictions explicitly contested with Incorrect/Mark prediction incorrect | Review; export all; export reviewed only; clear |

Choose **Current site** or **All sites**. Export and clear apply only to the selected view and scope. Clearing detections preserves reports and feedback; clearing reports preserves detections and feedback. Feedback has its own clear control. Local records remain accessible with All sites even on browser pages that cannot be scanned.

All writes go through the extension service worker into **IndexedDB transactions**. Concurrent saves from tabs/popups cannot overwrite another record through a read/modify/write race. Each view deduplicates by SHA-256 of site origin, Unicode/whitespace-normalized snippet, and toxicity/profanity decision. Rescans, repeated clicks and different tabs share one record when those fields match. Different decisions remain separate. Margin, timestamp and sensitivity alone do not create another record; the first saved prediction snapshot is retained. This is a record identity, not a count of how often abuse occurred.

Each view retains at most **200 unique records across all sites**. New unique saves evict the oldest committed record in that view. Text is limited to 2,000 characters (the scanner submits blocks up to 1,000), review notes to 1,000, and prediction fields are bounded. Reviewed feedback is also subject to retention: export it before it is evicted. Exports already downloaded are not deleted by clearing extension data.

Valid legacy `chrome.storage.local` history/reports/feedback arrays migrate once, with duplicate merging, into IndexedDB. Old arrays are removed only after the migration commits. Settings stay in `chrome.storage.local`. Legacy feedback starts unreviewed; missing historical decisions remain unknown. Malformed legacy records are skipped rather than invented. A cleared migrated record is not reimported on restart.

## Reviewing feedback and later dataset improvement

**Incorrect is a dispute, not an opposite label.** New feedback has `status: unreviewed`, `toxicityLabel: null`, and `profanityLabel: null`. The original model prediction is preserved.

In Feedback, choose human toxicity `Toxic`, `Non-toxic`, `Uncertain`, or leave it `Unlabelled`. Independently choose profanity `Present`, `Absent`, `Uncertain`, or `Unlabelled`. Add notes, tick **Reviewed by me**, and **Save review**. Unsaved draft notes are preserved during incoming record refreshes, but close the popup only after saving if you want them persisted. Two reviewers editing the same record use the last committed review; there is no review-history or merge workflow.

**Export this view** downloads JSON for the selected scope, including unreviewed records. **Export reviewed feedback** includes only explicitly reviewed records; it does not require or manufacture a binary toxicity label. Export schema version 1 includes the site/snippet, original `prediction`, explicit `review` fields, creation/review timestamps, and record identities.

For later improvement, a human must inspect reviewed exports, resolve ambiguous/context-dependent cases, and decide whether the text belongs in this dataset. Only reviewed examples explicitly labelled `toxic` or `non_toxic` are candidates for toxicity training (`-1` and `0` respectively in `ml/dataset.csv`). Null or `uncertain` labels must not be converted to an opposite class. Profanity labels are independent and must not be substituted for toxicity labels. Reconcile duplicates and label conflicts before adding any examples. **There is no automatic feedback import, label flipping, or retraining.** Export files are never read by the API or trainer unless you manually curate the source dataset.

## Adding datasets and training on Colab

Extra labelled data improves accuracy more than any algorithm change. Put CSVs with `text,label` columns (`1` toxic, `0` non-toxic) in `ml/extra/`; `python ml/train_model.py` merges them with `ml/dataset.csv`, deduplicates, splits and retrains (see `ml/extra/README.md`). Pass specific files with `--extra a.csv b.csv`.

For large datasets use `ml/train_on_colab.ipynb`: upload the project zip, add datasets with the `add_dataset` helper, train, then download `backend/model/` and copy it over the local `backend/model/`. The local scikit-learn version must match the one used for training (`pip install scikit-learn==<version>`), or retrain locally. Restart the API after replacing the model.

## Retraining and evaluation

Stop/restart the API around a model replacement. From the project root:

```bash
.venv/bin/python ml/train_model.py
.venv/bin/python backend/app.py
```

Training collapses model-equivalent duplicates, excludes conflicting labels and empty text, and creates disjoint stratified 60/20/20 training/validation/test splits. TF-IDF is fitted only in training CV folds and the training split. C is selected in training CV; sensitivity thresholds are selected on validation. The final test is evaluated after selection. The pipeline, thresholds, `metrics.json`, and hashed `split_manifest.json` are saved under `backend/model/`.

See [measured evaluation results and methodology](ml/EVALUATION.md) for raw SVM vs complete policy precision, recall, F1, confusion matrices, abstentions, and safe-text false positives. Profanity and combined UI-warning results are distinguished from ML toxicity. Strict has substantially more false positives; Balanced does not outperform default raw SVM test F1. These results do not guarantee website accuracy. Rerunning on the same data reuses the same test split, not a new independent benchmark.

After modifying the dataset, assess new evaluation results rather than retaining historical accuracy claims. Keep a separate external evaluation set if the original test has influenced development. Browser/model checks expose known errors, including positive expletive use and neutral sentences flagged at Strict.

## Reload after changes

1. After changing extension files, click **Reload** on the extension card in `chrome://extensions`.
2. Reload all open webpages using it; old content-script contexts do not upgrade automatically.
3. After changing Python code or replacing the model, stop the previous Flask process and restart `python backend/app.py` in the active environment.
4. Check `/health` and try **Scan current page**. Old API responses without the decision fields are rejected rather than displayed as contradictory warnings.

Reloading the same unpacked extension preserves IndexedDB records. Uninstalling it, clearing extension/site data, or using another profile can remove or separate them. Moving the unpacked extension folder can change its identity: export first.

## Tests and saved evidence

Python checks for the current model (word+char, v2): **13 passed, one documented expected failure** (casual profanity such as "This shit is amazing" scored as toxic). The 22-scenario browser harness result recorded under `tests/browser/artifacts/` was produced with the original v1 model and has **not been re-run** for v2; no extension JavaScript changed. Re-run it with the commands below on a machine with a compatible Chromium. Model-behaviour tests can legitimately fail after you add datasets; review the new model before changing a test.

Python regression checks:

```bash
.venv/bin/python -m unittest discover -s tests -v
```

Real browser tests (install the pinned test-only dependency once):

```bash
npm install --prefix tests/browser --no-audit --no-fund
node tests/browser_scanner.cjs
```

The harness defaults to installed macOS Brave because it permits unpacked extensions in headless mode. Override `BROWSER_EXECUTABLE` for a compatible Chromium executable. It starts isolated demo/API servers on ports 8766/5002, uses a temporary profile and extension copy, and leaves existing servers alone. It tests the actual toolbar popup and actual JSON downloads; synthetic storage fixtures test concurrency and retention, while scanner tests use real model responses. See [browser test instructions](tests/browser/README.md) for details, overrides and scope. [Machine-readable results](tests/browser/artifacts/results.json), screenshots, example exports, and server logs are saved in `tests/browser/artifacts/`.

## Privacy and limitations

Snippets are sent only to the local Flask service at `127.0.0.1:5000`. Records, reviews and settings remain in the current browser profile; they are not synchronized to an account or sent to websites, moderators, or a cloud training service. Stored records contain site origins, text, predictions, timestamps and optional human notes; they do not store full page URLs. A browser JSON download is the only export operation. Export files contain those snippets/notes and must be managed separately from extension storage. Local storage is not application-encrypted or a backup.

Chrome broad content-script access enables automatic scanning; inspect `extension/manifest.json`. Chrome internal pages, iframes, website-owned Shadow DOM, canvas text, media-query-only visibility changes, and text blocks longer than 1,000 characters are outside scanner coverage. Dataset bias, unfamiliar slang, quotations, sarcasm and lack of context remain limitations. The short-text gate misses some brief insults; profanity rules miss some obfuscations. No automatic moderation action is taken.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Missing Python module | Activate `.venv`; install `backend/requirements.txt`. |
| Missing/incompatible model | Train with your current environment, then restart Flask. Do not load an untrusted artifact. |
| Popup says detection service unavailable | Start/restart the current API; check `/health`. An older running server can return incompatible responses even if health is OK. |
| Port 5000 occupied / macOS AirPlay conflict | Identify the process before stopping it. If choosing another port, update `backend/app.py`, `extension/background.js`, and the manifest host permission together; restart API and reload extension/pages. |
| Extension changes do not appear | Reload the extension card, then reload every affected page. |
| Records seem missing | Check the selected view, Current site vs All sites, browser profile and extension identity. Each view has a 200-record limit; older records are evicted. |
| Save/export fails | Read the local action error in the warning/popup. Check disk/storage availability, download settings and profile policies; no record is reported saved before its transaction commits. |
| Clear did not delete another category or downloaded file | Clear is intentionally limited to the selected view/scope. Delete exports separately. |
| Incorrect did not change the prediction | Feedback is unreviewed data only. Save explicit human labels and curate examples manually before retraining. |
| Browser tests cannot load the extension | Use a Chromium executable that allows unpacked-extension loading; configure `BROWSER_EXECUTABLE`. Test ports 5002/8766 must be free. |
