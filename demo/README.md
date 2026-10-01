# Run Plan demo

Three small notebooks for trying the Run Plan button by hand: one Quarto document and two Jupyter notebooks. Everything here is synthetic. Each chunk or cell prints a counter and its own label, nothing is written to disk, nothing uses the network, and each plan takes a second or two.

| Notebook | Plan file | Runs in |
|---|---|---|
| `analysis.qmd` | `analysis.runplan.json` | the R console |
| `analysis-r.ipynb` | `analysis-r.runplan.json` | the notebook's R kernel |
| `analysis-python.ipynb` | `analysis-python.runplan.json` | the notebook's Python kernel |

All three have the same five labelled steps, in this order in the file: `setup`, `save-checkpoint`, `summarise`, `load-data`, `fail-on-purpose`. That order is wrong on purpose: `save-checkpoint` needs the results of the two steps below it, so running the notebook top to bottom fails. `save-checkpoint` and `fail-on-purpose` are marked `eval: false` in the `.qmd`, and `fail-on-purpose` is marked `eval: false` in the notebooks.

In the Jupyter notebooks, `setup`, `summarise` and `fail-on-purpose` are named with a `#| label:` comment, and `save-checkpoint` and `load-data` are named with a `label:` cell tag. Each notebook also has a markdown cell, which a plan can never run.

## What to do

1. Install the extension (`../install.sh` from this folder, then reload the window) and open this folder's parent in Positron.
2. Open one of the notebooks.
3. Click the rocket button. For `analysis.qmd` it is in the editor title bar, after the three run buttons. For a `.ipynb` it is in the bar above the notebook.
4. A picker lists the two plans. Choose one.
5. A dialog lists the steps in the order they will run. Click Run.

For the Jupyter notebooks, select a kernel first if Positron has not chosen one. The notebooks state their language and do not name a kernel, so Positron should offer the R or Python interpreters it has found.

## Plan 1: "Out of notebook order"

The plan lists `setup`, `load-data`, `summarise`, `save-checkpoint`.

The confirmation dialog should read:

```
1. setup
2. load-data
3. summarise
4. save-checkpoint
```

with `(eval: false)` after `save-checkpoint` for `analysis.qmd` only.

Expected output, in this order:

```
[1] setup
[2] load-data
[3] summarise
total is 60
[4] save-checkpoint
checkpoint holds 3 rows and total 60
```

The Python notebook prints `3 values` in the last line where the R versions print `3 rows`. For `analysis.qmd` the lines appear in the R console, each chunk preceded by a banner such as `---- run plan [2/4]: load-data ----`. For the Jupyter notebooks each line appears under its own cell, so read the counters: the cell that is second in the notebook shows `[4]`, the third shows `[3]` and the fourth shows `[2]`. `fail-on-purpose` is not run.

A notification should then say that the plan finished, with 4 chunks or 4 cells.

## Plan 2: "Stops at the third chunk" (or "cell")

The plan lists `setup`, `load-data`, `fail-on-purpose`, `summarise`.

The confirmation dialog should flag `fail-on-purpose` with `(eval: false)`.

Expected output, in this order:

```
[1] setup
[2] load-data
[3] fail-on-purpose
```

followed by the error. In R this is `Error: this chunk stops on purpose` for `analysis.qmd` and `Error: this cell stops on purpose` for `analysis-r.ipynb`. In Python it is `RuntimeError: this cell stops on purpose`.

`summarise` must not run: there should be no `[4]` line and no `total is 60`. In the Jupyter notebooks the `summarise` cell should show no new output and no new execution count.

An error notification should then say that the plan stopped at `fail-on-purpose` and that `summarise` was not run.

## Other things worth trying

- Run a plan on a Jupyter notebook a second time. The first run leaves new outputs in the notebook, which count as unsaved changes, so the dialog should now say that the notebook will be saved first and its button should read "Save and run".
- Edit a notebook without saving, then click the button. The dialog should say that the notebook will be saved first, and its button should read "Save and run".
- Change `"notebook"` in a plan file to another file name. The plan should be refused.
- Change a label in a plan file to one the notebook does not have. The plan should be refused, naming the label.
- Give two cells the same label. A plan that names that label should be refused.
