// Buttons in the .qmd editor title bar.
//
// Run Cells Above / Below / All: the Quarto extension registers quarto.runCellsAbove /
// runCellsBelow / runAllCells with a `commandPalette` menu contribution and nothing else, so
// there is no way to reach them but the palette. It does contribute other commands to
// `editor/title` -- insertCodeCell, preview -- so the bar itself is available; those three
// simply are not on it. These delegate rather than reimplement: declaring
// quarto.runCellsBelow in our own `contributes.commands` to attach an icon to it would collide
// with Quarto's own declaration of the same id, so we own ids of our own and forward.
//
// Run Plan: runs a named list of chunks in the R console with one click. The list lives in a
// plan file beside the notebook, `<notebook>.runplan.json`. The button is always on a .qmd and
// says so when there is no plan: gating it on a context key failed after a window reload,
// because the notebook was already the active editor when the extension activated and no
// editor-change event ever set the key. The chunk bodies are read from the notebook itself and
// sent to the console one at a time, so the notebook stays the definition of the analysis and
// this is only a way of running it.

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

// ---- run plans ---------------------------------------------------------------------------

function planPathFor(doc) {
  if (!doc || doc.uri.scheme !== "file" || !doc.fileName.endsWith(".qmd")) return null;
  return doc.fileName.slice(0, -".qmd".length) + PLAN_SUFFIX;
}

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
  return { qmd: raw.qmd, plans };
}

// A plan names its notebook. Refuse a plan written for a different file rather than run its
// chunk names against this one, where they could mean something else.
function checkNotebook(spec, fileName) {
  if (spec.qmd && path.basename(spec.qmd) !== path.basename(fileName)) {
    throw new Error(`the plan is for ${path.basename(spec.qmd)}, not ${path.basename(fileName)}.`);
  }
}

// The chunks a plan names, in the order the plan lists them. Every label must match exactly one
// closed chunk in the notebook.
function resolveSteps(plan, chunks) {
  const count = new Map();
  for (const c of chunks) count.set(c.label, (count.get(c.label) || 0) + 1);
  const known = new Map(chunks.map((c) => [c.label, c]));
  const missing = plan.chunks.filter((l) => !known.has(l));
  if (missing.length) {
    throw new Error(`not in this notebook: ${missing.join(", ")}. The plan is stale or the chunks were renamed.`);
  }
  const repeated = plan.chunks.filter((l) => count.get(l) > 1);
  if (repeated.length) {
    throw new Error(`more than one chunk in this notebook is labelled: ${[...new Set(repeated)].join(", ")}.`);
  }
  const open = plan.chunks.filter((l) => !known.get(l).closed);
  if (open.length) {
    throw new Error(`no closing fence for: ${open.join(", ")}.`);
  }
  return plan.chunks.map((l) => known.get(l));
}

// The line shown in the console before each chunk. A JSON string literal is a valid R string
// literal for the labels used here, quotes and backslashes included.
function banner(step, i, n) {
  return `message(${JSON.stringify(`---- run plan [${i + 1}/${n}]: ${step.label} ----`)})`;
}

// Sends the steps one at a time, in the order given, and stops at the first that fails.
// `exec(code, mode, focus)` must return a promise that settles when the console has finished
// that code and rejects if it raised an error. Chunks marked eval: false are sent like any
// other: a plan names them on purpose.
async function runSteps(steps, exec) {
  const done = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      await exec(banner(step, i, steps.length), "transient", i === 0);
      if (step.body.trim()) await exec(step.body, "non-interactive", false);
    } catch (e) {
      return { ok: false, done, failed: step.label, error: e, notRun: steps.slice(i + 1).map((s) => s.label) };
    }
    done.push(step.label);
  }
  return { ok: true, done, notRun: [] };
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

function acquirePositron() {
  const positron = typeof globalThis.acquirePositronApi === "function" ? globalThis.acquirePositronApi() : null;
  if (positron && positron.runtime && typeof positron.runtime.executeCode === "function") return positron;
  throw new Error("the Positron API is not available, so the plan cannot be sent to the R console. Is this Positron?");
}

let running = false;

async function runPlan() {
  if (running) {
    vscode.window.showWarningMessage("Run plan: a plan is already running.");
    return;
  }
  const ed = vscode.window.activeTextEditor;
  const doc = ed && ed.document;
  const planFile = planPathFor(doc);
  if (!planFile || !fs.existsSync(planFile)) {
    vscode.window.showInformationMessage("Run plan: no plan file beside this notebook (expected <notebook>.runplan.json).");
    return;
  }

  let spec, steps, positron;
  let plan;
  try {
    spec = readPlans(planFile);
    checkNotebook(spec, doc.fileName);
    plan = spec.plans[0];
    if (spec.plans.length > 1) {
      const pick = await vscode.window.showQuickPick(
        spec.plans.map((p) => ({ label: p.name, description: `${p.chunks.length} chunks`, detail: p.chunks.join(" → "), plan: p })),
        { placeHolder: "Which plan?" }
      );
      if (!pick) return;
      plan = pick.plan;
    }
    steps = resolveSteps(plan, chunksOf(doc.getText()));
    positron = acquirePositron();
  } catch (e) {
    vscode.window.showErrorMessage(`Run plan: ${e.message || e}`);
    return;
  }

  // Runs in the order the plan lists, so that is the order shown. Chunks marked eval: false
  // are flagged: they are the ones a render never runs, usually the slow or state-changing
  // steps.
  const detail = steps
    .map((c, i) => `${i + 1}. ${c.label}${c.evalOff ? "   (eval: false)" : ""}`)
    .join("\n") +
    (doc.isDirty ? "\n\nThe notebook has unsaved changes; it will be saved first, so that the file on disk matches what is run." : "");

  const go = doc.isDirty ? "Save and run" : "Run";
  const answer = await vscode.window.showInformationMessage(`Run "${plan.name}" in the R console?`, { modal: true, detail }, go);
  if (answer !== go) return;

  // The bodies come from the editor text, so running does not need the file on disk. It is
  // saved anyway: code in the notebook may read the notebook file, and a run whose source
  // exists only in an unsaved buffer leaves no record of what was run.
  if (doc.isDirty) {
    if (!(await doc.save())) {
      vscode.window.showErrorMessage("Run plan: the notebook could not be saved, so nothing was run.");
      return;
    }
    // Saving can change the text (format on save), so the chunks are read again.
    try {
      steps = resolveSteps(plan, chunksOf(doc.getText()));
    } catch (e) {
      vscode.window.showErrorMessage(`Run plan: ${e.message || e}`);
      return;
    }
  }

  running = true;
  try {
    const result = await runSteps(steps, positronExec(positron));
    if (result.ok) {
      vscode.window.showInformationMessage(`Run plan: "${plan.name}" finished (${result.done.length} chunks).`);
    } else {
      const why = (result.error && result.error.message) || String(result.error);
      const rest = result.notRun.length ? ` Not run: ${result.notRun.join(", ")}.` : "";
      vscode.window.showErrorMessage(`Run plan: stopped at "${result.failed}": ${why}${rest}`);
    }
  } finally {
    running = false;
  }
}

function activate(context) {
  for (const [ours, theirs] of Object.entries(DELEGATES)) {
    context.subscriptions.push(vscode.commands.registerCommand(ours, () => forward(theirs)));
  }
  context.subscriptions.push(vscode.commands.registerCommand("qmdRunButtons.runPlan", runPlan));
}

function deactivate() {}

module.exports = { activate, deactivate, chunksOf, readPlans, checkNotebook, resolveSteps, banner, runSteps, positronExec };
