# Reproducible evaluation

Run from the repository root:

```bash
.venv/bin/python ml/train_model.py
.venv/bin/python -m unittest discover -s tests -v
```

Training replaces the model and metrics together in `backend/model/`. The fitted pipeline carries the selected thresholds so the API loads the model's own operating points. `metrics.json` records dataset SHA-256, dependency versions, seed, label audit, split sizes, validation selection, and final test results. `split_manifest.json` records normalized-text hashes and labels per split. A rerun is reproducible for the recorded data and software versions; it replays the same test, not a fresh independent experiment.

Labels are source -1 → toxic (1), 0 → non-toxic (0). There are 18,148 source rows: 11,661 toxic and 6,487 non-toxic. There are 1,080 extra exact duplicate rows and 1,121 extra equivalent rows (overlapping counts). Equivalent means the same ordered tokens after the vectorizer's lowercase, Unicode accent stripping, and word tokenization; case, punctuation, whitespace, accent variants and ignored one-character tokens therefore cannot leak across splits. This does not detect paraphrases or semantic equivalence.

All three conflicting-label groups (nine rows) and two empty-equivalent rows are excluded without guessing labels. Remaining equivalent texts are collapsed to one representative, leaving 17,023 samples. Seed 42 gives 10,213 training, 3,405 validation and 3,405 test samples. Hash manifests and tests verify uniqueness within and disjointness across splits. Deduplication inspects source labels but does not use held-out scores. Near duplicates/paraphrases and source domain bias remain limitations.

TF-IDF is fitted only inside training CV folds when selecting C, then refitted on the training split only. Three-fold stratified CV selects C by F1 from [0.25, 1, 2]. No validation or test text is used to fit vocabulary, IDF or SVM. The final model is not refitted on validation data. Validation chooses thresholds on the complete toxicity policy, including abstentions as missed toxic examples. The fixed margin grid is [-2, 3] in 0.025 steps. Balanced maximizes F1; Relaxed maximizes precision-weighted F0.5 subject to threshold >= Balanced; Strict maximizes recall-weighted F2 subject to threshold <= Balanced. Ties prefer higher thresholds. These objectives express preferences, not precision guarantees. Policy rules are frozen before this run. Test inference occurs only after all selection, once for final reporting; no parameters were changed in response to test results.

Selected thresholds: Relaxed 0.15, Balanced -0.15, Strict -0.40. An SVM margin is a signed decision score, **not a probability**. Negative thresholds permit more borderline scores but never override empty-vector or short-label abstention. Strict's neutral-sentence errors are an explicit consequence of its recall preference.

All matrices below have true rows [non-toxic, toxic] and predicted columns [negative, positive]. Policy binary metrics count insufficient-information outcomes as no toxicity flag; assessed-only metrics and three-way matrices are also saved so abstentions cannot disappear from the report. Each split has 1,295 non-toxic and 2,110 toxic examples.

## Validation results

| Result | Precision | Recall | F1 | Confusion matrix | Safe-text FP rate |
| --- | ---: | ---: | ---: | --- | ---: |
| Raw SVM, margin 0 | 0.9392 | 0.9147 | 0.9268 | [[1170, 125], [180, 1930]] | 9.65% |
| relaxed: raw SVM | 0.9565 | 0.8853 | 0.9195 | [[1210, 85], [242, 1868]] | 6.56% |
| relaxed: full toxicity policy | 0.9570 | 0.8758 | 0.9146 | [[1212, 83], [262, 1848]] | 6.41% |
| relaxed: combined UI warning | 0.9525 | 0.9128 | 0.9322 | [[1199, 96], [184, 1926]] | 7.41% |
| balanced: raw SVM | 0.9174 | 0.9427 | 0.9299 | [[1116, 179], [121, 1989]] | 13.82% |
| balanced: full toxicity policy | 0.9183 | 0.9327 | 0.9255 | [[1120, 175], [142, 1968]] | 13.51% |
| balanced: combined UI warning | 0.9170 | 0.9526 | 0.9344 | [[1113, 182], [100, 2010]] | 14.05% |
| strict: raw SVM | 0.8538 | 0.9796 | 0.9124 | [[941, 354], [43, 2067]] | 27.34% |
| strict: full toxicity policy | 0.8554 | 0.9697 | 0.9089 | [[949, 346], [64, 2046]] | 26.72% |
| strict: combined UI warning | 0.8550 | 0.9782 | 0.9125 | [[945, 350], [46, 2064]] | 27.03% |

Insufficient information: 38 (16 non-toxic, 22 toxic). Profanity rule flags 1167 (32 non-toxic, 1135 toxic).

Three-way policy matrices, columns [assessed negative, assessed positive, insufficient information]:

- relaxed: `[[1196, 83, 16], [240, 1848, 22]]`
- balanced: `[[1104, 175, 16], [120, 1968, 22]]`
- strict: `[[933, 346, 16], [42, 2046, 22]]`
## Test results

| Result | Precision | Recall | F1 | Confusion matrix | Safe-text FP rate |
| --- | ---: | ---: | ---: | --- | ---: |
| Raw SVM, margin 0 | 0.9413 | 0.9275 | 0.9344 | [[1173, 122], [153, 1957]] | 9.42% |
| relaxed: raw SVM | 0.9551 | 0.8967 | 0.9250 | [[1206, 89], [218, 1892]] | 6.87% |
| relaxed: full toxicity policy | 0.9545 | 0.8858 | 0.9189 | [[1206, 89], [241, 1869]] | 6.87% |
| relaxed: combined UI warning | 0.9505 | 0.9190 | 0.9345 | [[1194, 101], [171, 1939]] | 7.80% |
| balanced: raw SVM | 0.9201 | 0.9502 | 0.9349 | [[1121, 174], [105, 2005]] | 13.44% |
| balanced: full toxicity policy | 0.9201 | 0.9384 | 0.9291 | [[1123, 172], [130, 1980]] | 13.28% |
| balanced: combined UI warning | 0.9179 | 0.9536 | 0.9354 | [[1115, 180], [98, 2012]] | 13.90% |
| strict: raw SVM | 0.8603 | 0.9806 | 0.9165 | [[959, 336], [41, 2069]] | 25.95% |
| strict: full toxicity policy | 0.8602 | 0.9678 | 0.9108 | [[963, 332], [68, 2042]] | 25.64% |
| strict: combined UI warning | 0.8586 | 0.9730 | 0.9122 | [[957, 338], [57, 2053]] | 26.10% |

Insufficient information: 39 (12 non-toxic, 27 toxic). Profanity rule flags 1171 (39 non-toxic, 1132 toxic).

Three-way policy matrices, columns [assessed negative, assessed positive, insufficient information]:

- relaxed: `[[1194, 89, 12], [214, 1869, 27]]`
- balanced: `[[1111, 172, 12], [103, 1980, 27]]`
- strict: `[[951, 332, 12], [41, 2042, 27]]`

## Interpretation and remaining errors

The combined UI warning is toxicity **or** profanity. Its precision/recall above are agreement with toxicity labels, not profanity accuracy or proof of bullying. There is no independent profanity ground truth, so profanity precision/recall cannot be validly measured here. Profanity-only warnings on non-toxic text are expected product behavior and are reported separately from ML false positives.

On the final test set Relaxed trades 111 additional missed toxic examples for 83 fewer non-toxic flags compared with Balanced. Strict catches 62 more toxic examples than Balanced but adds 160 non-toxic flags. Balanced does not outperform the default raw SVM on test F1; thresholds were selected on validation rather than optimized after seeing this result. All results describe this deduplicated dataset, not guaranteed website accuracy. The test had already been explored with a previous artifact in project history; it is held out from this new fitting/selection procedure but is not a newly collected external benchmark.

Regression command currently runs 12 test methods: 10 pass and two are documented expected failures. Known contextual error: “This shit is amazing” still receives a toxicity flag. Strict flags neutral sentences including “Have a wonderful day” and “I like this project”; names, labels and unknown text remain protected by eligibility rules. The hand-written regression set is diagnostic and not a separate unbiased estimate of real-world performance. No model, policy or threshold was tuned using its new test-set scores. Live Chrome rendering was not re-tested for this evaluation change.
