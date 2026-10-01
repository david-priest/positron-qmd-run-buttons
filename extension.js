// Buttons in the .qmd editor title bar, and a Run Plan button for Jupyter notebooks.
//
// Run Cells Above / Below / All: the Quarto extension registers quarto.runCellsAbove /
// runCellsBelow / runAllCells with a `commandPalette` menu contribution and nothing else, so
// there is no way to reach them but the palette. It does contribute other commands to
// `editor/title` -- insertCodeCell, preview -- so the bar itself is available; those three
// simply are not on it. These delegate rather than reimplement: declaring
// quarto.runCellsBelow in our own `contributes.commands` to attach an icon to it would collide
// with Quarto's own declaration of the same id, so we own ids of our own and forward.
//
// Run Plan: runs a named list of chunks or cells with one click. The list lives in a plan file
// beside the notebook, `<notebook>.runplan.json`. The button is always shown and says so when
// there is no plan: gating it on a context key failed after a window reload, because the
// notebook was already the active editor when the extension activated and no editor-change
// event ever set the key.
//
// For a .qmd, the chunk bodies are read from the editor and sent to the R console one at a
// time. For a .ipynb, the named cells are executed in place by the notebook's own kernel, one
// at a time. Either way the notebook stays the definition of the analysis and this is only a
// way of running it.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const DELEGATES = {
  "qmdRunButtons.runCellsAbove": "quarto.runCellsAbove",
  "qmdRunButtons.runCellsBelow": "quarto.runCellsBelow",
  "qmdRunButtons.runAllCells": "quarto.runAllCells",
};

const PLAN_SUFFIX = ".runplan.json";

async function forward(target) {
  const available = await vscode.commands.getCommands(true);
  if (!available.includes(target)) {
    // Says which command is missing rather than failing silently, because the likely cause is
    // the Quarto extension being disabled or having renamed the command in an update.
    vscode.window.showErrorMessage(
      `Quarto run buttons: '${target}' is not registered. Is the Quarto extension installed and enabled?`
    );
    return;
  }
  await vscode.commands.executeCommand(target);
}

// ---- plan files --------------------------------------------------------------------------

// <dir>/analysis.qmd and <dir>/analysis.ipynb both have <dir>/analysis.runplan.json.
function planPathForFile(fileName) {
  const m = fileName.match(/\.(qmd|ipynb)$/);
  return m ? fileName.slice(0, -m[0].length) + PLAN_SUFFIX : null;
}

function planPathFor(doc) {
  if (!doc || doc.uri.scheme !== "file" || !doc.fileName.endsWith(".qmd")) return null;
  return planPathForFile(doc.fileName);
}

function readPlans(planFile) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(planFile, "utf8"));
  } catch (e) {
    throw new Error(`${path.basename(planFile)} is not valid JSON: ${e.message}`);
  }
  const plans = raw && Array.isArray(raw.plans) ? raw.plans : null;
  if (!plans || !plans.length) throw new Error(`${path.basename(planFile)} has no "plans" list.`);
  for (const p of plans) {
    if (!p || typeof p.name !== "string" || !Array.isArray(p.chunks) || !p.chunks.length ||
        !p.chunks.every((c) => typeof c === "string")) {
      throw new Error(`${path.basename(planFile)}: every plan needs a "name" and a non-empty "chunks" list of labels.`);
    }
  }
  // "notebook" is the key for either kind of file; "qmd" is the older name for the same thing.
  return { notebook: raw.notebook, qmd: raw.qmd, plans };
}

// A plan names its notebook. Refuse a plan written for a different file rather than run its
// labels against this one, where they could mean something else.
function checkNotebook(spec, fileName) {
  for (const named of [spec.notebook, spec.qmd]) {
    if (named && path.basename(named) !== path.basename(fileName)) {
      throw new Error(`the plan is for ${path.basename(named)}, not ${path.basename(fileName)}.`);
    }
  }
}

// The chunks or cells a plan names, in the order the plan lists them. Every label must match
// exactly one closed chunk (or one code cell) in the notebook.
function resolveSteps(plan, chunks, noun = "chunk") {
  const count = new Map();
  for (const c of chunks) count.set(c.label, (count.get(c.label) || 0) + 1);
  const known = new Map(chunks.map((c) => [c.label, c]));
  const missing = plan.chunks.filter((l) => !known.has(l));
  if (missing.length) {
    throw new Error(`not in this notebook: ${missing.join(", ")}. The plan is stale or the ${noun}s were renamed.`);
  }
  const repeated = plan.chunks.filter((l) => count.get(l) > 1);
  if (repeated.length) {
    throw new Error(`more than one ${noun} in this notebook is labelled: ${[...new Set(repeated)].join(", ")}.`);
  }
  const open = plan.chunks.filter((l) => !known.get(l).closed);
  if (open.length) {
    throw new Error(`no closing fence for: ${open.join(", ")}.`);
  }
  return plan.chunks.map((l) => known.get(l));
}

// Runs the steps one at a time, in the order given, and stops at the first that fails.
// `runOne(step, i, n)` must return a promise that settles when the step has finished and
// rejects if it failed.
async function runInOrder(steps, runOne) {
  const done = [];
  for (let i = 0; i < steps.length; i++) {
    try {
      await runOne(steps[i], i, steps.length);
    } catch (e) {
      return { ok: false, done, failed: steps[i].label, error: e, notRun: steps.slice(i + 1).map((s) => s.label) };
    }
    done.push(steps[i].label);
  }
  return { ok: true, done, notRun: [] };
}

// ---- .qmd: chunks sent to the R console ------------------------------------------------

// The labelled R chunks of the notebook, in file order: label, whether it is eval: false, the
// 1-based line of its opening fence, its body, and whether the closing fence was found.
// Both header styles: ```{r label, eval = FALSE} and a bare ```{r} with #| label: / #| eval:.
// The body is the lines between the fences with the leading #| option lines removed.
function chunksOf(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^```\{r\b\s*(.*)\}\s*$/);
    if (!m) continue;
    let label = null;
    let evalOff = false;
    const header = m[1].replace(/^,\s*/, "").trim();
    if (header) {
      const parts = header.split(",").map((s) => s.trim());
      if (parts.length && !parts[0].includes("=")) label = parts.shift();
      for (const p of parts) if (/^eval\s*=\s*(FALSE|F)\s*$/.test(p)) evalOff = true;
    }
    let j = i + 1;
    for (; j < lines.length && lines[j].startsWith("#|"); j++) {
      const lm = lines[j].match(/^#\|\s*label:\s*(\S+)/);
      if (lm) label = lm[1];
      if (/^#\|\s*eval:\s*false\s*$/.test(lines[j])) evalOff = true;
    }
    let k = j;
    while (k < lines.length && !/^```\s*$/.test(lines[k])) k++;
    const closed = k < lines.length;
    if (label) out.push({ label, evalOff, line: i + 1, body: lines.slice(j, k).join("\n"), closed });
    i = k;
  }
  return out;
}

// The line shown in the console before each chunk. A JSON string literal is a valid R string
// literal for the labels used here, quotes and backslashes included.
function banner(step, i, n) {
  return `message(${JSON.stringify(`---- run plan [${i + 1}/${n}]: ${step.label} ----`)})`;
}

// Sends the chunks one at a time, in the order given, and stops at the first that fails.
// `exec(code, mode, focus)` must return a promise that settles when the console has finished
// that code and rejects if it raised an error. Chunks marked eval: false are sent like any
// other: a plan names them on purpose.
function runSteps(steps, exec) {
  return runInOrder(steps, async (step, i, n) => {
    await exec(banner(step, i, n), "transient", i === 0);
    if (step.body.trim()) await exec(step.body, "non-interactive", false);
  });
}

// One execution in the R console through Positron's API.
//
// allowIncomplete is true: with false, the console checks the code first and, if R reports it
// as anything but complete, parks it in the input box instead of running it, and the returned
// promise then never settles. With true a chunk that does not parse reaches R, which raises a
// syntax error, and that stops the plan like any other error.
//
// Not "interactive" mode: that mode prepends whatever is already typed in the console input.
//
// The returned promise resolves when the execution completes and rejects when the runtime
// reports an error or the execution is interrupted. The observer's onFailed is recorded as
// well, so a failure counts even if the promise were to resolve.
function positronExec(positron) {
  return async (code, mode, focus) => {
    let failure = null;
    const observer = { onFailed: (err) => { failure = err || new Error("the execution failed"); } };
    await positron.runtime.executeCode("r", code, focus, true, mode, "stop", observer);
    if (failure) throw failure;
  };
}

function positronApi() {
  return typeof globalThis.acquirePositronApi === "function" ? globalThis.acquirePositronApi() : null;
}

function acquirePositron() {
  const positron = positronApi();
  if (positron && positron.runtime && typeof positron.runtime.executeCode === "function") return positron;
  throw new Error("the Positron API is not available, so the plan cannot be sent to the R console. Is this Positron?");
}

// ---- .ipynb: cells executed by the notebook's kernel -----------------------------------

const CODE_CELL = 2; // vscode.NotebookCellKind.Code; Markup is 1.
const TAG_PREFIX = "label:";

// The name of a notebook cell, or null. Jupyter cells have no labels of their own, so two
// conventions are read:
//   1. a `#| label: name` line among the leading `#|` comment lines of the cell source, the
//      Quarto convention, which is a comment in both R and Python;
//   2. a cell tag of the form `label:name`.
// The comment wins when a cell has both. Tags are stored by the Jupyter serializer under
// cell.metadata.metadata.tags; cell.metadata.tags is read as well.
function cellLabel(cell) {
  let label = null;
  let via = null;
  let evalOff = false;
  for (const line of cell.document.getText().split(/\r?\n/)) {
    if (!line.startsWith("#|")) break;
    const lm = line.match(/^#\|\s*label:\s*(\S+)/);
    if (lm && !label) { label = lm[1]; via = "comment"; }
    if (/^#\|\s*eval:\s*false\s*$/.test(line)) evalOff = true;
  }
  if (!label) {
    const meta = cell.metadata || {};
    const tags = (meta.metadata && meta.metadata.tags) || meta.tags;
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (typeof t !== "string" || !t.startsWith(TAG_PREFIX)) continue;
        const name = t.slice(TAG_PREFIX.length).trim();
        if (name && !/\s/.test(name)) { label = name; via = "tag"; break; }
      }
    }
  }
  return { label, via, evalOff };
}

// The labelled code cells of a notebook, in notebook order. Markdown and raw cells are never
// included, whatever they contain, and neither is a code cell with no label.
function cellsOf(notebook) {
  const out = [];
  for (const cell of notebook.getCells()) {
    if (cell.kind !== CODE_CELL || cell.document.languageId === "raw") continue;
    const { label, via, evalOff } = cellLabel(cell);
    if (label) out.push({ label, via, evalOff, index: cell.index, cell, closed: true });
  }
  return out;
}

// The error a failed cell left in its outputs, if it can be read.
function cellErrorText(cell) {
  try {
    for (const output of cell.outputs || []) {
      for (const item of output.items || []) {
        if (item.mime !== "application/vnd.code.notebook.error") continue;
        const err = JSON.parse(Buffer.from(item.data).toString("utf8"));
        const text = [err.name, err.message].filter(Boolean).join(": ");
        if (text) return text;
      }
    }
  } catch (e) {
    // The summary alone decides success; the text is only for the notification.
  }
  return null;
}

// Executes one cell in place with the notebook's own kernel and waits for its result.
//
// Starting the cell: Positron's notebook editor is driven through positron.notebooks.runCells;
// when the notebook is open in the built-in notebook editor instead, that call fails with
// "No notebook found" and the `notebook.cell.execute` command is used. Both end in the same
// notebook execution service, and both resolve once the kernel has finished the request.
//
// The result: NotebookCell.executionSummary.success. It is cleared when an execution is
// created and set to true or false when the kernel completes the cell. A cell that never
// reports a boolean (no kernel was selected, or the kernel does not handle the cell's
// language) is treated as a failure after `graceMs`, so later cells are not run.
function notebookExec(notebook, positron, graceMs = 5000) {
  let via = null;
  const uri = notebook.uri;

  async function start(index) {
    const canPositron = positron && positron.notebooks && typeof positron.notebooks.runCells === "function";
    if (via !== "builtin" && canPositron) {
      try {
        await positron.notebooks.runCells(uri.toString(), [index]);
        via = "positron";
        return;
      } catch (e) {
        if (via === "positron" || !/No notebook found/i.test(String((e && e.message) || e))) throw e;
      }
    }
    via = "builtin";
    await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [{ start: index, end: index + 1 }], document: uri });
  }

  return async (step) => {
    const cell = step.cell;
    if (cell.index < 0) throw new Error("the cell is no longer in the notebook");
    const before = cell.executionSummary;
    let settle;
    const reported = new Promise((resolve) => { settle = resolve; });
    const sub = vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.uri.toString() !== uri.toString()) return;
      for (const change of e.cellChanges) {
        const s = change.executionSummary;
        if (change.cell.index === cell.index && s && typeof s.success === "boolean") settle(s.success);
      }
    });
    let timer;
    try {
      await start(cell.index);
      const waited = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), graceMs); });
      let success = await Promise.race([reported, waited]);
      if (success === undefined) {
        // No change event arrived. Accept the cell's own summary only if it is a new one.
        const now = cell.executionSummary;
        const fresh = now && now !== before && typeof now.success === "boolean" &&
          (!before || now.executionOrder !== before.executionOrder ||
           (now.timing && now.timing.endTime) !== (before.timing && before.timing.endTime));
        if (fresh) success = now.success;
      }
      if (success === undefined) {
        throw new Error("the cell did not report a result. Is a kernel selected for this notebook, and does it run this cell's language?");
      }
      if (!success) throw new Error(cellErrorText(cell) || "the cell raised an error");
    } finally {
      clearTimeout(timer);
      sub.dispose();
    }
  };
}

// ---- the command -------------------------------------------------------------------------

let running = false;

// One Run Plan click against a target: a .qmd text document or a .ipynb notebook document.
async function runPlanOn(target) {
  if (running) {
    vscode.window.showWarningMessage("Run plan: a plan is already running.");
    return;
  }
  const planFile = target.fileName ? planPathForFile(target.fileName) : null;
  if (!planFile || !fs.existsSync(planFile)) {
    vscode.window.showInformationMessage("Run plan: no plan file beside this notebook (expected <notebook>.runplan.json).");
    return;
  }

  let spec, steps, run;
  let plan;
  try {
    spec = readPlans(planFile);
    checkNotebook(spec, target.fileName);
    plan = spec.plans[0];
    if (spec.plans.length > 1) {
      const pick = await vscode.window.showQuickPick(
        spec.plans.map((p) => ({ label: p.name, description: `${p.chunks.length} ${target.noun}s`, detail: p.chunks.join(" → "), plan: p })),
        { placeHolder: "Which plan?" }
      );
      if (!pick) return;
      plan = pick.plan;
    }
    steps = resolveSteps(plan, target.items(), target.noun);
    run = target.prepare();
  } catch (e) {
    vscode.window.showErrorMessage(`Run plan: ${e.message || e}`);
    return;
  }

  // Runs in the order the plan lists, so that is the order shown. Steps marked eval: false
  // are flagged: they are the ones a render never runs, usually the slow or state-changing
  // steps.
  const dirty = target.isDirty();
  const detail = steps
    .map((c, i) => `${i + 1}. ${c.label}${c.evalOff ? "   (eval: false)" : ""}`)
    .join("\n") +
    (dirty ? "\n\nThe notebook has unsaved changes; it will be saved first, so that the file on disk matches what is run." : "");

  const go = dirty ? "Save and run" : "Run";
  const answer = await vscode.window.showInformationMessage(`Run "${plan.name}" ${target.where}?`, { modal: true, detail }, go);
  if (answer !== go) return;

  // Running does not need the file on disk: chunk bodies come from the editor text, and cells
  // are executed in place. It is saved anyway: code in the notebook may read the notebook
  // file, and a run whose source exists only in an unsaved buffer leaves no record of what
  // was run.
  if (dirty) {
    if (!(await target.save())) {
      vscode.window.showErrorMessage("Run plan: the notebook could not be saved, so nothing was run.");
      return;
    }
    // Saving can change the text (format on save), so the steps are read again.
    try {
      steps = resolveSteps(plan, target.items(), target.noun);
    } catch (e) {
      vscode.window.showErrorMessage(`Run plan: ${e.message || e}`);
      return;
    }
  }

  running = true;
  try {
    const result = await run(steps);
    if (result.ok) {
      vscode.window.showInformationMessage(`Run plan: "${plan.name}" finished (${result.done.length} ${target.noun}s).`);
    } else {
      const why = (result.error && result.error.message) || String(result.error);
      const stop = /[.!?]$/.test(why) ? "" : ".";
      const rest = result.notRun.length ? ` Not run: ${result.notRun.join(", ")}.` : "";
      vscode.window.showErrorMessage(`Run plan: stopped at "${result.failed}": ${why}${stop}${rest}`);
    }
  } finally {
    running = false;
  }
}

function qmdTarget(doc) {
  return {
    fileName: planPathFor(doc) ? doc.fileName : null,
    noun: "chunk",
    where: "in the R console",
    items: () => chunksOf(doc.getText()),
    isDirty: () => doc.isDirty,
    save: () => doc.save(),
    prepare: () => {
      const positron = acquirePositron();
      return (steps) => runSteps(steps, positronExec(positron));
    },
  };
}

function notebookTarget(notebook) {
  return {
    fileName: notebook.uri.scheme === "file" ? notebook.uri.fsPath : null,
    noun: "cell",
    where: "in this notebook's kernel",
    items: () => cellsOf(notebook),
    isDirty: () => notebook.isDirty,
    save: () => notebook.save(),
    prepare: () => {
      const positron = positronApi();
      return (steps) => runInOrder(steps, notebookExec(notebook, positron));
    },
  };
}

function isUri(x) {
  return !!x && typeof x === "object" && typeof x.scheme === "string" && typeof x.path === "string";
}

const isNotebookUri = (u) => isUri(u) && u.path.endsWith(".ipynb");

// The notebook the click was made in. The argument depends on where the button is: the editor
// title bar passes the file's Uri, the built-in notebook toolbar passes a context object that
// carries the notebook's Uri. From the command palette there is no argument, and the active
// editor is used.
async function notebookUriFor(arg) {
  if (isNotebookUri(arg)) return arg;
  if (arg && arg.notebookEditor && isNotebookUri(arg.notebookEditor.notebookUri)) return arg.notebookEditor.notebookUri;
  const ed = vscode.window.activeTextEditor;
  if (ed && planPathFor(ed.document)) return null; // a .qmd is the active editor
  const active = vscode.window.activeNotebookEditor;
  if (active && isNotebookUri(active.notebook.uri)) return active.notebook.uri;
  const groups = vscode.window.tabGroups;
  const tab = groups && groups.activeTabGroup && groups.activeTabGroup.activeTab;
  if (tab && tab.input && isNotebookUri(tab.input.uri)) return tab.input.uri;
  const positron = positronApi();
  if (positron && positron.notebooks && typeof positron.notebooks.getContext === "function") {
    try {
      const ctx = await positron.notebooks.getContext();
      if (ctx && typeof ctx.uri === "string" && /\.ipynb$/.test(ctx.uri)) return vscode.Uri.parse(ctx.uri);
    } catch (e) {
      // No Positron notebook is open.
    }
  }
  return null;
}

async function runPlan(arg) {
  let uri = null;
  try {
    uri = await notebookUriFor(arg);
  } catch (e) {
    uri = null;
  }
  if (!uri) {
    const ed = vscode.window.activeTextEditor;
    return runPlanOn(qmdTarget(ed && ed.document));
  }
  let notebook = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString());
  try {
    if (!notebook) notebook = await vscode.workspace.openNotebookDocument(uri);
  } catch (e) {
    vscode.window.showErrorMessage(`Run plan: the notebook could not be read: ${e.message || e}`);
    return;
  }
  return runPlanOn(notebookTarget(notebook));
}

function activate(context) {
  for (const [ours, theirs] of Object.entries(DELEGATES)) {
    context.subscriptions.push(vscode.commands.registerCommand(ours, () => forward(theirs)));
  }
  context.subscriptions.push(vscode.commands.registerCommand("qmdRunButtons.runPlan", runPlan));
}

function deactivate() {}

module.exports = {
  activate, deactivate,
  planPathForFile, readPlans, checkNotebook, resolveSteps, runInOrder,
  chunksOf, banner, runSteps, positronExec,
  cellLabel, cellsOf, notebookExec, runPlan,
};
