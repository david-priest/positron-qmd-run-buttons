// Tests for the parts of Run Plan that do not need Positron: the chunk parser, plan reading
// and validation, and the sequencing of executions. `vscode` is stubbed, and the console is
// replaced by a fake executeCode. Run with `npm test`.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return { commands: {}, window: {}, workspace: {} };
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
