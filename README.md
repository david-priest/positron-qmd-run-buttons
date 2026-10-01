# Quarto run buttons for Positron

A small Positron extension that adds four buttons to the editor title bar of `.qmd` notebooks: Run Cells Above, Run Cells Below, Run All Cells, and Run Plan.

Status: version 0.1.0. The first three buttons have been in regular use. For Run Plan, the interface has been verified by hand in Positron: the button appears in the `.qmd` title bar with the rocket icon, it reads the plan file beside the notebook, the confirmation dialog lists the chunks, and an eight-chunk plan that included chunks marked `eval: false` ran to completion in plan order. That check used an earlier build that ran the chunks differently. The execution path in this version, which sends each chunk body to the R console through Positron's API and stops at the first error, is covered by the automated tests in `test/` (parser, plan validation, sequencing against a stubbed console) and has not yet been exercised by clicking the button in a running Positron window.

## The buttons

| Button | Icon | What it does |
|---|---|---|
| Run Cells Above | `run-above` | Calls the Quarto extension's `quarto.runCellsAbove`. |
| Run Cells Below | `run-below` | Calls `quarto.runCellsBelow`. |
| Run All Cells | `run-all` | Calls `quarto.runAllCells`. |
| Run Plan | `rocket` | Reads `<notebook>.runplan.json` beside the notebook and runs the chunks it lists in the R console, in the order the plan lists them. |

The Quarto extension registers its three run commands for the command palette only. This extension puts them on the title bar, where they are one click away.

## Run Plan

A plan is a named, ordered list of chunk labels. It is useful when a set of chunks has to be run in a particular order and someone other than the person running them decides which: a collaborator, a script, or a coding agent that has edited the notebook and needs its owner to run specific steps. The sequence goes in a file and is run with one click after a confirmation.

### Plan file format

The plan file sits beside the notebook and takes its name: `analysis.qmd` has `analysis.runplan.json`.

```json
{
  "qmd": "analysis.qmd",
  "plans": [
    {
      "name": "Recluster and save",
      "chunks": ["setup", "load-data", "cluster", "save-checkpoint"]
    },
    {
      "name": "Reload only",
      "chunks": ["setup", "load-data"]
    }
  ]
}
```

- `qmd` (optional) is the file name of the notebook the plan was written for. If it is present and does not match the open notebook, the plan is refused.
- `plans` is a non-empty list. Each plan has a `name` and a non-empty `chunks` list of chunk labels. When the file holds more than one plan, a picker asks which to run.

A chunk's label is taken from either header style:

````
```{r load-data, eval = FALSE}
```

```{r}
#| label: load-data
#| eval: false
```
````

### What a click does

1. Reads the plan file. If there is none, a message says so and nothing else happens.
2. Checks every label in the plan against the notebook as it is in the editor. A label the notebook does not have, a label used by more than one chunk, or a chunk with no closing fence stops the run before it starts.
3. Shows a modal confirmation that lists the chunks in the order they will run, with chunks marked `eval: false` flagged.
4. Saves the notebook if it has unsaved changes. The button reads "Save and run" in that case.
5. For each chunk in turn, sends a one-line `message()` banner naming the chunk, then the chunk's body, to the R console, and waits for the console to finish before sending the next.
6. Stops at the first chunk that raises an error and reports which chunk failed and which were not run.

The body of a chunk is the text between its fences with the leading `#|` option lines removed.

### Behaviour worth knowing

- Chunks run in the order the plan lists them. Notebook order is ignored. A plan can therefore run a chunk that appears early in the notebook after one that appears later, for example a save step that sits above the step whose result it should save.
- Chunks marked `eval: false` are run when a plan names them. Those are usually the slow or state-changing steps that a render should skip, which are often exactly the ones a plan exists to run. The confirmation dialog flags them so that this is visible before anything runs.
- The notebook is saved before running. Bodies are read from the editor, so the run itself does not need the file on disk, but code in a notebook may read the notebook file, and saving keeps the file on disk the same as what was run.
- Code runs in the global environment of the R session attached to the console, exactly as if each chunk had been sent with Quarto's own run command. If no R session is running, Positron starts one.
- Chunk bodies appear in the console and in its history. Banners appear in the console only.
- Interrupting R during a plan counts as a failure of the current chunk, and the remaining chunks are not sent.

## Requirements

- Positron. The extension targets the VS Code extension API, but Run Plan uses Positron's own API (`positron.runtime.executeCode`) and reports an error in an editor that does not provide it. The API was read from Positron 2026.08.1; see Limitations.
- The Quarto extension, which Positron bundles. The first three buttons forward to its commands.
- An R session, for Run Plan.
- `node` on the PATH, for `install.sh` and the tests.

## Install

```bash
git clone https://github.com/david-priest/positron-qmd-run-buttons.git
cd positron-qmd-run-buttons
./install.sh
```

`install.sh` copies `package.json`, `extension.js` and `README.md` into `~/.positron/extensions/wing-lab.qmd-run-buttons-<version>/`. Reload afterwards with Developer: Reload Window from the command palette, or quit and reopen Positron.

```bash
./install.sh --check
```

`--check` reports whether the extension is installed and matches this checkout, and changes nothing. A Positron update can clear the extensions folder; if the buttons disappear, run `install.sh` again.

To update after pulling or editing, run `install.sh` again and reload. It overwrites in place.

## Tests

```bash
npm test
```

The tests have no dependencies. They stub the `vscode` module and replace the console with a fake `executeCode`, and cover the chunk parser (both header styles, option-line removal, line endings, unclosed chunks), plan file validation, plan-order sequencing, and stopping at the first failure.

## Design notes

**The run buttons delegate to Quarto's commands.** Declaring `quarto.runCellsBelow` in this extension's `contributes.commands` in order to attach an icon to it would collide with Quarto's own declaration of the same id. The extension therefore owns three ids of its own (`qmdRunButtons.*`) and forwards each with `executeCommand`. If the target command is not registered, because Quarto is disabled or has renamed the command, the button names the missing command.

**The buttons are in the `navigation` group.** That group is what places an `editor/title` item inline. Items in any other group go to the `…` overflow menu.

**Run Plan is always visible on a `.qmd`.** An earlier version showed the button only when a plan file existed, using a context key. After a window reload the notebook was already the active editor when the extension activated, no editor-change event fired, the key was never set, and the button stayed hidden. An always-visible button that says when there is no plan has no such state to get wrong.

**Run Plan has an icon.** Positron moves a title-bar item without an icon into the `…` overflow menu, even in the `navigation` group.

**Plan order is honoured.** The alternative, running the named chunks in notebook order, would make it impossible to express a sequence that differs from the notebook's layout, and the plan's author has already decided the order.

**Each chunk is a separate execution.** The extension waits for the promise returned by `executeCode` before sending the next chunk. That promise rejects when the R session reports an error, which is how the run stops. Code is sent with `allowIncomplete` set to true: with false, Positron's console holds code that R does not report as complete in the input box and never runs it, and the plan would wait indefinitely. With true, a chunk that does not parse reaches R, fails with a syntax error, and stops the plan. Chunk bodies use the `non-interactive` execution mode, because `interactive` mode prepends whatever is already typed in the console input.

## Limitations

- The execution path of Run Plan in this version has not been tested by hand in Positron; see Status.
- R chunks only. Chunks in other languages are not seen by the parser and cannot be named in a plan.
- The parser is line-based. It recognises fences that start at the beginning of a line with exactly three backticks, so chunks nested inside lists or callouts with indentation are not found.
- Only `eval = FALSE`, `eval = F` and `#| eval: false` are recognised as switching evaluation off. A conditional `eval` expression is not evaluated, and the chunk is not flagged. This affects only the flag in the dialog; the chunk runs either way.
- Other chunk options have no effect. A plan does not apply `fig.width`, `cache`, `echo` and so on.
- The behaviour of the returned promise and of `allowIncomplete` described above was confirmed by reading the code of one Positron release. Positron's API declaration documents the promise as resolving with the result and does not state that it rejects on error, so a later release could change this. The extension also records the `onFailed` callback of the execution observer, which the declaration does document.
- A plan cannot be cancelled from the editor once it has started. Interrupt R to stop it.
- macOS and Linux install script only. On Windows, copy the three files by hand into the equivalent extensions folder.

## Licence

MIT. See `LICENSE`.
