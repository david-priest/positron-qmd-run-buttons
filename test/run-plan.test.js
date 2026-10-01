// Tests for the parts of Run Plan that do not need Positron: the chunk parser, notebook cell
// naming, plan reading and validation, and the sequencing of executions. `vscode` is stubbed,
// the console is replaced by a fake executeCode, and notebooks by fake documents with a fake
// kernel. Run with `npm test`.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// The stub for the `vscode` module. Tests fill in the parts they need.
const vs = { commands: {}, window: {}, workspace: { notebookDocuments: [] }, Uri: { parse: (s) => ({ scheme: "file", path: s.replace(/^file:\/\//, ""), fsPath: s.replace(/^file:\/\//, ""), toString: () => s }) } };

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vs;
  return realLoad.call(this, request, ...rest);
};
const ext = require("../extension.js");

const NOTEBOOK = [
  "---",
  "title: analysis",
  "---",
  "",
  "Some prose.",
  "",
  "```{r setup}",
  "library(stats)",
  "x <- 1",
  "```",
  "",
  "```{r}",
  "#| label: load-data",
  "#| message: false",
  "d <- data.frame(a = 1:3)",
  "",
  "#| not an option line, it follows code",
  "summary(d)",
  "```",
  "",
  "```{r cluster, eval = FALSE, fig.width = 4}",
  "k <- kmeans(d, 2)",
  "```",
  "",
  "```{r}",
  "#| label: save-checkpoint",
  "#| eval: false",
  "saveRDS(d, tempfile())",
  "```",
  "",
  "```{r}",
  "unlabelled <- TRUE",
  "```",
  "",
  "```{python other}",
  "y = 2",
  "```",
  "",
  "```{r empty}",
  "```",
  "",
].join("\n");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("parser: labels in file order, both header styles, unlabelled and non-R chunks skipped", () => {
  const chunks = ext.chunksOf(NOTEBOOK);
  assert.deepStrictEqual(chunks.map((c) => c.label), ["setup", "load-data", "cluster", "save-checkpoint", "empty"]);
  assert.ok(chunks.every((c) => c.closed));
});

test("parser: eval = FALSE in the header and #| eval: false are both detected", () => {
  const by = Object.fromEntries(ext.chunksOf(NOTEBOOK).map((c) => [c.label, c]));
  assert.strictEqual(by["setup"].evalOff, false);
  assert.strictEqual(by["load-data"].evalOff, false);
  assert.strictEqual(by["cluster"].evalOff, true);
  assert.strictEqual(by["save-checkpoint"].evalOff, true);
});

test("parser: body is the lines between the fences, leading #| lines removed", () => {
  const by = Object.fromEntries(ext.chunksOf(NOTEBOOK).map((c) => [c.label, c]));
  assert.strictEqual(by["setup"].body, "library(stats)\nx <- 1");
  assert.strictEqual(by["load-data"].body, "d <- data.frame(a = 1:3)\n\n#| not an option line, it follows code\nsummary(d)");
  assert.strictEqual(by["cluster"].body, "k <- kmeans(d, 2)");
  assert.strictEqual(by["save-checkpoint"].body, "saveRDS(d, tempfile())");
  assert.strictEqual(by["empty"].body, "");
});

test("parser: CRLF line endings and the fence line number", () => {
  const chunks = ext.chunksOf(NOTEBOOK.replace(/\n/g, "\r\n"));
  assert.strictEqual(chunks[0].body, "library(stats)\nx <- 1");
  assert.strictEqual(chunks[0].line, 7);
});

test("parser: a chunk with no closing fence is reported as not closed", () => {
  const chunks = ext.chunksOf("```{r setup}\nx <- 1\n```\n\n```{r cluster}\nk <- 2\n");
  assert.deepStrictEqual(chunks.map((c) => [c.label, c.closed]), [["setup", true], ["cluster", false]]);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-plan-test-"));
const writePlan = (content) => {
  const f = path.join(tmp, "analysis.runplan.json");
  fs.writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content));
  return f;
};

test("plan file: a valid plan is read", () => {
  const spec = ext.readPlans(writePlan({ qmd: "analysis.qmd", plans: [{ name: "Recluster", chunks: ["setup", "cluster"] }] }));
  assert.strictEqual(spec.qmd, "analysis.qmd");
  assert.deepStrictEqual(spec.plans[0].chunks, ["setup", "cluster"]);
});

test("plan file: invalid JSON, no plans, and malformed plans are refused", () => {
  assert.throws(() => ext.readPlans(writePlan("{ not json")), /not valid JSON/);
  assert.throws(() => ext.readPlans(writePlan({ qmd: "analysis.qmd" })), /no "plans" list/);
  assert.throws(() => ext.readPlans(writePlan({ plans: [] })), /no "plans" list/);
  assert.throws(() => ext.readPlans(writePlan({ plans: [{ name: "x", chunks: [] }] })), /non-empty "chunks"/);
  assert.throws(() => ext.readPlans(writePlan({ plans: [{ chunks: ["setup"] }] })), /needs a "name"/);
  assert.throws(() => ext.readPlans(writePlan({ plans: [{ name: "x", chunks: ["setup", 3] }] })), /list of labels/);
});

test("validation: a plan naming another notebook is refused", () => {
  assert.throws(() => ext.checkNotebook({ qmd: "other.qmd" }, path.join(tmp, "analysis.qmd")), /plan is for other\.qmd, not analysis\.qmd/);
  assert.doesNotThrow(() => ext.checkNotebook({ qmd: "analysis.qmd" }, path.join(tmp, "analysis.qmd")));
  assert.doesNotThrow(() => ext.checkNotebook({}, path.join(tmp, "analysis.qmd")));
});

test("validation: unknown, duplicated and unclosed labels are refused", () => {
  const chunks = ext.chunksOf(NOTEBOOK);
  assert.throws(() => ext.resolveSteps({ name: "p", chunks: ["setup", "no-such-chunk"] }, chunks), /not in this notebook: no-such-chunk/);
  const dup = ext.chunksOf("```{r setup}\nx <- 1\n```\n```{r setup}\nx <- 2\n```\n");
  assert.throws(() => ext.resolveSteps({ name: "p", chunks: ["setup"] }, dup), /more than one chunk/);
  const open = ext.chunksOf("```{r setup}\nx <- 1\n");
  assert.throws(() => ext.resolveSteps({ name: "p", chunks: ["setup"] }, open), /no closing fence/);
});

test("validation: steps come back in plan order, not notebook order", () => {
  const steps = ext.resolveSteps({ name: "p", chunks: ["save-checkpoint", "setup", "cluster"] }, ext.chunksOf(NOTEBOOK));
  assert.deepStrictEqual(steps.map((s) => s.label), ["save-checkpoint", "setup", "cluster"]);
});

// A fake positron.runtime.executeCode that records what it is sent and fails on chosen code.
function fakePositron(failWhen) {
  const calls = [];
  const positron = {
    runtime: {
      executeCode(languageId, code, focus, allowIncomplete, mode, errorBehavior, observer) {
        calls.push({ languageId, code, focus, allowIncomplete, mode, errorBehavior });
        return new Promise((resolve, reject) => {
          setImmediate(() => {
            if (failWhen && failWhen(code)) {
              const err = new Error("object 'd' not found");
              if (observer && observer.onFailed) observer.onFailed(err);
              reject(err);
            } else {
              resolve({});
            }
          });
        });
      },
    },
  };
  return { positron, calls };
}

test("sequencing: banner then body for each chunk, in plan order, one at a time", async () => {
  const { positron, calls } = fakePositron(null);
  const steps = ext.resolveSteps({ name: "p", chunks: ["save-checkpoint", "setup", "cluster"] }, ext.chunksOf(NOTEBOOK));
  const result = await ext.runSteps(steps, ext.positronExec(positron));
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.done, ["save-checkpoint", "setup", "cluster"]);
  assert.deepStrictEqual(calls.map((c) => c.code), [
    'message("---- run plan [1/3]: save-checkpoint ----")',
    "saveRDS(d, tempfile())",
    'message("---- run plan [2/3]: setup ----")',
    "library(stats)\nx <- 1",
    'message("---- run plan [3/3]: cluster ----")',
    "k <- kmeans(d, 2)",
  ]);
  assert.deepStrictEqual(calls.map((c) => c.mode), ["transient", "non-interactive", "transient", "non-interactive", "transient", "non-interactive"]);
  assert.ok(calls.every((c) => c.languageId === "r" && c.allowIncomplete === true && c.errorBehavior === "stop"));
  assert.deepStrictEqual(calls.map((c) => c.focus), [true, false, false, false, false, false]);
});

test("sequencing: eval: false chunks named in a plan are sent", async () => {
  const { positron, calls } = fakePositron(null);
  const steps = ext.resolveSteps({ name: "p", chunks: ["cluster", "save-checkpoint"] }, ext.chunksOf(NOTEBOOK));
  assert.ok(steps.every((s) => s.evalOff));
  await ext.runSteps(steps, ext.positronExec(positron));
  assert.ok(calls.some((c) => c.code === "k <- kmeans(d, 2)"));
  assert.ok(calls.some((c) => c.code === "saveRDS(d, tempfile())"));
});

test("sequencing: the first failing chunk stops the run and later chunks are not sent", async () => {
  const { positron, calls } = fakePositron((code) => code.includes("summary(d)"));
  const steps = ext.resolveSteps({ name: "p", chunks: ["setup", "load-data", "cluster", "save-checkpoint"] }, ext.chunksOf(NOTEBOOK));
  const result = await ext.runSteps(steps, ext.positronExec(positron));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed, "load-data");
  assert.deepStrictEqual(result.done, ["setup"]);
  assert.deepStrictEqual(result.notRun, ["cluster", "save-checkpoint"]);
  assert.match(result.error.message, /not found/);
  assert.strictEqual(calls.length, 4);
  assert.ok(!calls.some((c) => c.code.includes("kmeans") || c.code.includes("saveRDS") || c.code.includes("cluster")));
});

test("sequencing: a failure reported only through the observer still stops the run", async () => {
  const calls = [];
  const positron = {
    runtime: {
      executeCode(languageId, code, focus, allowIncomplete, mode, errorBehavior, observer) {
        calls.push(code);
        if (code === "x <- 1") observer.onFailed(new Error("observer-only failure"));
        return Promise.resolve({});
      },
    },
  };
  const steps = ext.resolveSteps({ name: "p", chunks: ["a", "b"] }, ext.chunksOf("```{r a}\nx <- 1\n```\n```{r b}\ny <- 2\n```\n"));
  const result = await ext.runSteps(steps, ext.positronExec(positron));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed, "a");
  assert.ok(!calls.includes("y <- 2"));
});

test("sequencing: an empty chunk sends its banner and nothing else", async () => {
  const { positron, calls } = fakePositron(null);
  const steps = ext.resolveSteps({ name: "p", chunks: ["empty"] }, ext.chunksOf(NOTEBOOK));
  const result = await ext.runSteps(steps, ext.positronExec(positron));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 1);
});

test("banner: a label with quotes stays a valid string literal", () => {
  assert.strictEqual(ext.banner({ label: 'a"b' }, 0, 1), 'message("---- run plan [1/1]: a\\"b ----")');
});

// ---- notebooks -----------------------------------------------------------------------------

const MARKUP = 1;
const CODE = 2;

// A fake vscode.NotebookDocument. Each cell spec is { kind, source, tags, language }.
function fakeNotebook(file, specs) {
  const uri = { scheme: "file", path: file, fsPath: file, toString: () => "file://" + file };
  const notebook = { uri, notebookType: "jupyter-notebook", isDirty: false, save: async () => true };
  const cells = specs.map((s, index) => ({
    index,
    notebook,
    kind: s.kind === undefined ? CODE : s.kind,
    document: { getText: () => s.source, languageId: s.language || "python" },
    metadata: s.tags ? (s.flatTags ? { tags: s.tags } : { metadata: { tags: s.tags } }) : {},
    outputs: [],
    executionSummary: undefined,
  }));
  notebook.getCells = () => cells;
  notebook.cellAt = (i) => cells[i];
  return notebook;
}

// A fake kernel. Executing a cell clears its summary, then sets success and fires the change
// event, as the notebook execution service does. `outcome(cell)` returns true, false, or
// undefined for a cell that never reports a result.
function fakeKernel(notebook, outcome) {
  const listeners = new Set();
  const executed = [];
  vs.workspace.onDidChangeNotebookDocument = (fn) => {
    listeners.add(fn);
    return { dispose: () => listeners.delete(fn) };
  };
  const fire = (cell) => {
    for (const fn of [...listeners]) fn({ notebook, cellChanges: [{ cell, executionSummary: cell.executionSummary }] });
  };
  const execute = async (index) => {
    const cell = notebook.cellAt(index);
    executed.push(index);
    cell.executionSummary = { success: undefined };
    fire(cell);
    await new Promise((r) => setImmediate(r));
    const result = outcome ? outcome(cell) : true;
    if (result === undefined) return;
    cell.executionSummary = { success: result, executionOrder: executed.length, timing: { startTime: 1, endTime: 1 + executed.length } };
    if (!result) {
      const err = JSON.stringify({ name: "Error", message: "boom in cell " + index });
      cell.outputs = [{ items: [{ mime: "application/vnd.code.notebook.error", data: Buffer.from(err) }] }];
    }
    fire(cell);
  };
  return { execute, executed, listeners };
}

const NB_SPECS = [
  { kind: MARKUP, source: "#| label: setup\n# A heading that looks like a label" },
  { source: "#| label: setup\nx = 1" },
  { source: "y = 2", tags: ["parameters", "label:load-data"] },
  { source: "#| label: cluster\n#| eval: false\nk = 3", tags: ["label:ignored-tag"] },
  { source: "z = 4", tags: ["label:save-checkpoint"], flatTags: true },
  { source: "unlabelled = True", tags: ["hide-input"] },
  { source: "#| label: summarise\nprint(x)" },
];

test("notebook naming: by leading #| label comment and by label: tag", () => {
  const cells = ext.cellsOf(fakeNotebook("/nb/analysis.ipynb", NB_SPECS));
  assert.deepStrictEqual(cells.map((c) => [c.label, c.via, c.index]), [
    ["setup", "comment", 1],
    ["load-data", "tag", 2],
    ["cluster", "comment", 3],
    ["save-checkpoint", "tag", 4],
    ["summarise", "comment", 6],
  ]);
});

test("notebook naming: the comment takes precedence over a tag", () => {
  const nb = fakeNotebook("/nb/analysis.ipynb", NB_SPECS);
  assert.deepStrictEqual(ext.cellLabel(nb.cellAt(3)), { label: "cluster", via: "comment", evalOff: true });
});

test("notebook naming: tags without the label: prefix name nothing; a label after code is not a label", () => {
  const nb = fakeNotebook("/nb/analysis.ipynb", [
    { source: "a = 1", tags: ["setup", "parameters"] },
    { source: "a = 1\n#| label: late" },
    { source: "a = 1", tags: ["label:", "label:two words", "label:ok"] },
  ]);
  assert.strictEqual(ext.cellLabel(nb.cellAt(0)).label, null);
  assert.strictEqual(ext.cellLabel(nb.cellAt(1)).label, null);
  assert.strictEqual(ext.cellLabel(nb.cellAt(2)).label, "ok");
});

test("notebook naming: markdown cells and unlabelled cells are never listed", () => {
  const cells = ext.cellsOf(fakeNotebook("/nb/analysis.ipynb", NB_SPECS));
  assert.ok(!cells.some((c) => c.index === 0 || c.index === 5));
  assert.throws(
    () => ext.resolveSteps({ name: "p", chunks: ["heading"] }, ext.cellsOf(fakeNotebook("/nb/a.ipynb", [{ kind: MARKUP, source: "#| label: heading" }])), "cell"),
    /not in this notebook: heading/
  );
});

test("notebook validation: a label on more than one cell is refused", () => {
  const nb = fakeNotebook("/nb/analysis.ipynb", [
    { source: "#| label: setup\nx = 1" },
    { source: "x = 2", tags: ["label:setup"] },
  ]);
  assert.throws(() => ext.resolveSteps({ name: "p", chunks: ["setup"] }, ext.cellsOf(nb), "cell"), /more than one cell in this notebook is labelled: setup/);
});

test("plan file: the plan path and the notebook key work for .ipynb", () => {
  assert.strictEqual(ext.planPathForFile("/nb/analysis.ipynb"), "/nb/analysis.runplan.json");
  assert.strictEqual(ext.planPathForFile("/nb/analysis.qmd"), "/nb/analysis.runplan.json");
  assert.strictEqual(ext.planPathForFile("/nb/analysis.txt"), null);
  const spec = ext.readPlans(writePlan({ notebook: "analysis.ipynb", plans: [{ name: "p", chunks: ["setup"] }] }));
  assert.strictEqual(spec.notebook, "analysis.ipynb");
  assert.doesNotThrow(() => ext.checkNotebook(spec, "/nb/analysis.ipynb"));
  assert.throws(() => ext.checkNotebook(spec, "/nb/other.ipynb"), /plan is for analysis\.ipynb, not other\.ipynb/);
  assert.throws(() => ext.checkNotebook({ qmd: "analysis.qmd" }, "/nb/analysis.ipynb"), /plan is for analysis\.qmd/);
});

test("notebook sequencing: cells run in plan order, one at a time, through positron.notebooks.runCells", async () => {
  const nb = fakeNotebook("/nb/analysis.ipynb", NB_SPECS);
  const kernel = fakeKernel(nb, null);
  const calls = [];
  const positron = { notebooks: { runCells: async (uri, indices) => { calls.push([uri, indices]); for (const i of indices) await kernel.execute(i); } } };
  const steps = ext.resolveSteps({ name: "p", chunks: ["save-checkpoint", "setup", "cluster"] }, ext.cellsOf(nb), "cell");
  const result = await ext.runInOrder(steps, ext.notebookExec(nb, positron, 50));
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(kernel.executed, [4, 1, 3]);
  assert.deepStrictEqual(calls, [["file:///nb/analysis.ipynb", [4]], ["file:///nb/analysis.ipynb", [1]], ["file:///nb/analysis.ipynb", [3]]]);
  assert.strictEqual(kernel.listeners.size, 0);
});

test("notebook sequencing: the first failing cell stops the run and later cells are not executed", async () => {
  const nb = fakeNotebook("/nb/analysis.ipynb", NB_SPECS);
  const kernel = fakeKernel(nb, (cell) => cell.index !== 2);
  const positron = { notebooks: { runCells: async (uri, indices) => { for (const i of indices) await kernel.execute(i); } } };
  const steps = ext.resolveSteps({ name: "p", chunks: ["setup", "load-data", "cluster", "save-checkpoint"] }, ext.cellsOf(nb), "cell");
  const result = await ext.runInOrder(steps, ext.notebookExec(nb, positron, 50));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed, "load-data");
  assert.deepStrictEqual(result.done, ["setup"]);
  assert.deepStrictEqual(result.notRun, ["cluster", "save-checkpoint"]);
  assert.match(result.error.message, /boom in cell 2/);
  assert.deepStrictEqual(kernel.executed, [1, 2]);
});

test("notebook sequencing: the built-in editor is driven with notebook.cell.execute", async () => {
  const nb = fakeNotebook("/nb/analysis.ipynb", NB_SPECS);
  const kernel = fakeKernel(nb, null);
  const commands = [];
  vs.commands.executeCommand = async (id, arg) => { commands.push([id, arg.ranges, arg.document === nb.uri]); await kernel.execute(arg.ranges[0].start); };
  let positronCalls = 0;
  const positron = { notebooks: { runCells: async (uri) => { positronCalls++; throw new Error("No notebook found with URI: " + uri); } } };
  const steps = ext.resolveSteps({ name: "p", chunks: ["summarise", "setup"] }, ext.cellsOf(nb), "cell");
  const result = await ext.runInOrder(steps, ext.notebookExec(nb, positron, 50));
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(commands, [
    ["notebook.cell.execute", [{ start: 6, end: 7 }], true],
    ["notebook.cell.execute", [{ start: 1, end: 2 }], true],
  ]);
  assert.strictEqual(positronCalls, 1);
  // With no Positron API at all the command is used as well.
  const result2 = await ext.runInOrder(steps, ext.notebookExec(nb, null, 50));
  assert.strictEqual(result2.ok, true);
});

test("notebook sequencing: a cell that reports no result counts as a failure", async () => {
  const nb = fakeNotebook("/nb/analysis.ipynb", NB_SPECS);
  const kernel = fakeKernel(nb, (cell) => (cell.index === 1 ? undefined : true));
  const positron = { notebooks: { runCells: async (uri, indices) => { for (const i of indices) await kernel.execute(i); } } };
  const steps = ext.resolveSteps({ name: "p", chunks: ["setup", "load-data"] }, ext.cellsOf(nb), "cell");
  const result = await ext.runInOrder(steps, ext.notebookExec(nb, positron, 30));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed, "setup");
  assert.match(result.error.message, /did not report a result/);
  assert.deepStrictEqual(kernel.executed, [1]);
});

test("notebook sequencing: a stale success from an earlier run is not taken as this run's result", async () => {
  const nb = fakeNotebook("/nb/analysis.ipynb", NB_SPECS);
  nb.cellAt(1).executionSummary = { success: true, executionOrder: 7, timing: { startTime: 1, endTime: 2 } };
  vs.workspace.onDidChangeNotebookDocument = () => ({ dispose() {} });
  const positron = { notebooks: { runCells: async () => {} } }; // resolves without executing anything
  const steps = ext.resolveSteps({ name: "p", chunks: ["setup"] }, ext.cellsOf(nb), "cell");
  const result = await ext.runInOrder(steps, ext.notebookExec(nb, positron, 30));
  assert.strictEqual(result.ok, false);
});

// ---- the command, end to end ---------------------------------------------------------------

function stubWindow(answer) {
  const shown = { info: [], error: [], modal: [] };
  vs.window.activeTextEditor = undefined;
  vs.window.activeNotebookEditor = undefined;
  vs.window.tabGroups = undefined;
  vs.window.showInformationMessage = async (msg, opts, ...buttons) => {
    if (opts && opts.modal) { shown.modal.push({ msg, detail: opts.detail, buttons }); return answer === "accept" ? buttons[0] : undefined; }
    shown.info.push(msg);
  };
  vs.window.showErrorMessage = async (msg) => { shown.error.push(msg); };
  vs.window.showWarningMessage = async () => {};
  vs.window.showQuickPick = async (items) => items[items.length - 1];
  return shown;
}

test("command: a notebook plan is confirmed, run in plan order, and reported", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-plan-nb-"));
  const file = path.join(dir, "analysis.ipynb");
  fs.writeFileSync(path.join(dir, "analysis.runplan.json"), JSON.stringify({
    notebook: "analysis.ipynb",
    plans: [{ name: "First", chunks: ["setup"] }, { name: "Out of order", chunks: ["summarise", "cluster", "setup"] }],
  }));
  const nb = fakeNotebook(file, NB_SPECS);
  const kernel = fakeKernel(nb, null);
  vs.workspace.notebookDocuments = [nb];
  globalThis.acquirePositronApi = () => ({ notebooks: { runCells: async (uri, indices) => { for (const i of indices) await kernel.execute(i); } } });
  const shown = stubWindow("accept");
  await ext.runPlan(nb.uri);
  assert.strictEqual(shown.modal.length, 1);
  assert.match(shown.modal[0].msg, /Run "Out of order" in this notebook's kernel\?/);
  assert.strictEqual(shown.modal[0].detail, "1. summarise\n2. cluster   (eval: false)\n3. setup");
  assert.deepStrictEqual(shown.modal[0].buttons, ["Run"]);
  assert.deepStrictEqual(kernel.executed, [6, 3, 1]);
  assert.deepStrictEqual(shown.info, ['Run plan: "Out of order" finished (3 cells).']);
  assert.deepStrictEqual(shown.error, []);
});

test("command: declining the confirmation runs nothing; a plan for another notebook is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-plan-nb-"));
  const file = path.join(dir, "analysis.ipynb");
  const planFile = path.join(dir, "analysis.runplan.json");
  fs.writeFileSync(planFile, JSON.stringify({ notebook: "analysis.ipynb", plans: [{ name: "p", chunks: ["setup"] }] }));
  const nb = fakeNotebook(file, NB_SPECS);
  const kernel = fakeKernel(nb, null);
  vs.workspace.notebookDocuments = [nb];
  globalThis.acquirePositronApi = () => ({ notebooks: { runCells: async (uri, indices) => { for (const i of indices) await kernel.execute(i); } } });
  let shown = stubWindow("decline");
  await ext.runPlan({ notebookEditor: { notebookUri: nb.uri } });
  assert.strictEqual(shown.modal.length, 1);
  assert.deepStrictEqual(kernel.executed, []);
  fs.writeFileSync(planFile, JSON.stringify({ notebook: "other.ipynb", plans: [{ name: "p", chunks: ["setup"] }] }));
  shown = stubWindow("accept");
  await ext.runPlan(nb.uri);
  assert.match(shown.error[0], /the plan is for other\.ipynb, not analysis\.ipynb/);
  assert.deepStrictEqual(kernel.executed, []);
});

test("command: a failing notebook cell is reported with the cells not run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-plan-nb-"));
  const file = path.join(dir, "analysis.ipynb");
  fs.writeFileSync(path.join(dir, "analysis.runplan.json"), JSON.stringify({ plans: [{ name: "p", chunks: ["setup", "load-data", "summarise"] }] }));
  const nb = fakeNotebook(file, NB_SPECS);
  nb.isDirty = true;
  let saved = 0;
  nb.save = async () => { saved++; nb.isDirty = false; return true; };
  const kernel = fakeKernel(nb, (cell) => cell.index !== 2);
  vs.workspace.notebookDocuments = [nb];
  globalThis.acquirePositronApi = () => ({ notebooks: { runCells: async (uri, indices) => { for (const i of indices) await kernel.execute(i); } } });
  const shown = stubWindow("accept");
  await ext.runPlan(nb.uri);
  assert.deepStrictEqual(shown.modal[0].buttons, ["Save and run"]);
  assert.strictEqual(saved, 1);
  assert.deepStrictEqual(kernel.executed, [1, 2]);
  assert.deepStrictEqual(shown.error, ['Run plan: stopped at "load-data": Error: boom in cell 2. Not run: summarise.']);
});

test("command: a .qmd plan still runs through the R console", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-plan-qmd-"));
  const file = path.join(dir, "analysis.qmd");
  fs.writeFileSync(path.join(dir, "analysis.runplan.json"), JSON.stringify({ qmd: "analysis.qmd", plans: [{ name: "p", chunks: ["cluster", "setup"] }] }));
  const { positron, calls } = fakePositron(null);
  globalThis.acquirePositronApi = () => positron;
  const shown = stubWindow("accept");
  const uri = { scheme: "file", path: file, fsPath: file, toString: () => "file://" + file };
  vs.window.activeTextEditor = { document: { uri, fileName: file, isDirty: false, getText: () => NOTEBOOK, save: async () => true } };
  await ext.runPlan(uri);
  assert.match(shown.modal[0].msg, /Run "p" in the R console\?/);
  assert.strictEqual(shown.modal[0].detail, "1. cluster   (eval: false)\n2. setup");
  assert.deepStrictEqual(calls.map((c) => c.code), [
    'message("---- run plan [1/2]: cluster ----")',
    "k <- kmeans(d, 2)",
    'message("---- run plan [2/2]: setup ----")',
    "library(stats)\nx <- 1",
  ]);
  assert.deepStrictEqual(shown.info, ['Run plan: "p" finished (2 chunks).']);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${String(e && e.stack || e).split("\n").join("\n     ")}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
