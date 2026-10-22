# Scanner, local records, and popup browser checks

From the project root, install the test-only library and run:

```bash
npm install --prefix tests/browser --no-audit --no-fund
node tests/browser_scanner.cjs
```

The harness defaults to the installed macOS Brave executable because it supports loading unpacked extensions in headless mode. To use another Chromium executable that permits unpacked extensions:

```bash
BROWSER_EXECUTABLE='/path/to/browser' node tests/browser_scanner.cjs
```

Python defaults to `.venv/bin/python`; override with `PYTHON`. For a library installed outside the repository, set `PLAYWRIGHT_MODULE` to its absolute directory. The recorded run used:

```bash
node tests/browser_scanner.cjs /tmp/cybershield-browser/node_modules/playwright-core
```

The harness starts and stops its own current Flask API on `127.0.0.1:5002` and demo server on `127.0.0.1:8766`; use `TEST_API_PORT` and `TEST_DEMO_PORT` to choose other free ports. It leaves existing servers alone. Browser launch and local listening sockets may need sandbox approval.

It uses an isolated temporary profile and a temporary extension copy. Only that copy changes the API port, grants access to the demo origin (to substitute for the activeTab grant normally supplied by a toolbar click), and counts full-document discovery. The service worker records requests and can delay **real** API responses for race tests. Scanner model results are not mocked. Concurrency and retention checks also use clearly named synthetic storage fixtures; those are not training data or classifier accuracy cases. The actual toolbar popup is opened and controlled through Chrome DevTools Protocol; this is not a replacement popup rendered in an ordinary tab. Closed Shadow DOM is inspected through that same protocol.

The suite checks:

- Suitable visible leaf blocks; exclusions for forms, editable fields, navigation, CSS/attribute-hidden text, transparent ancestors, controls inside blocks, and extension UI.
- Closed Shadow DOM isolation from hostile website CSS; the Why toggle and distinct ML/profanity explanations.
- Incremental new content: exactly the new comment is sent; unrelated changes trigger no API call or full-document discovery.
- Text replacement, direct text-node edits, removal, hide/show, and moving a warned comment into a form and back.
- Sensitivity changes reevaluate existing text with the real API.
- Disabling during a delayed response removes warnings and prevents their return; edited and removed elements reject stale responses too.
- Restoring stylesheet and inline outlines, offsets, and `!important` priorities; preserving a subsequent page outline change.
- Popup loading, completion, no detections, disabled, actual API offline, retry, and reopening with current counts rather than historical detection totals.

The suite additionally checks legacy-array migration and deduplication without inventing labels; stable detection identities across rescans; 50 simultaneous unique report saves from two tabs; 20 attempts to save the same report yielding one new record; independent human toxicity/profanity review; preserving drafts during incoming saves; actual JSON downloads for all three views and reviewed-only feedback; transactional FIFO retention at 200 records per view; site-scoped versus all-site clearing without affecting other views; and the additional `records-demo.html` examples.

Recorded result: **22 browser scenarios passed**, including all of the prior scanner scenarios. The Python regression suite separately reports **10 passes and two expected failures** for known model errors. JavaScript syntax checks pass for `records.js`, `background.js`, `content.js`, `popup.js`, and this harness. Abrupt browser/process crashes and conflicting edits by two reviewers to the same feedback record were not fault-injected; IndexedDB transactions provide commit/rollback, and reviews use the last committed edit.

Results, server logs, example JSON exports, and screenshots are saved under `artifacts/`. `results.json` is the authoritative outcome; screenshots illustrate specific states and are not the assertions themselves. The local demo buttons also permit manual exploration after serving `demo.html` and loading the production `extension/` directory.

This verifies the local demo in headless Brave (Chromium 154). It does not establish compatibility with every website or browser. Iframes, website-owned Shadow DOM, canvas text, CSS-only visibility changes driven by media queries, and blocks longer than 1,000 characters remain outside this scanner's coverage. The detector's known contextual and Strict-sensitivity false positives remain; this change makes warnings reflect those decisions consistently rather than altering the model.
