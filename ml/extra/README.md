# Extra training datasets

Drop extra labelled CSV files here (or pass them with `--extra`). `python ml/train_model.py` loads every `ml/extra/*.csv` automatically.

Format: a `text` (or `headline`) column and a `label` column. `1` or `-1` = toxic, `0` = non-toxic.

```csv
text,label
you are a worthless idiot,1
have a nice day,0
```

Rows are lower-cased, deduplicated and conflict-checked together with `ml/dataset.csv`, then split 60/20/20 as before. Check each dataset's license before redistributing it.
