import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTERS, startRun, parseProposals, openCodeCredentials, openCodeModels } from "../core/agents.mjs";

const oc = ADAPTERS.opencode;

/** Mirrors the emit object startRun hands to an adapter parser. */
function collector() {
  const out = { text: "", meta: [], error: null, final: null };
  return {
    out,
    emit: {
      text: (d, replace) => { out.text = replace ? (out.text ? out.text + "\n\n" + d : d) : out.text + d; },
      meta: (m) => out.meta.push(m),
      error: (m) => { out.error = m; },
      final: (t) => { out.final = t; },
    },
  };
}

// Shapes captured from `opencode auth list` on a signed-in machine (1.19.5).
const AUTH_SIGNED_IN = "\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n●  DeepSeek \x1b[90mapi\n│\n●  GitHub Copilot \x1b[90moauth\n│\n└  7 credentials\n";
const AUTH_NONE = "\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n└  0 credentials\n";

test("opencode credential count is read through the colour codes", () => {
  assert.equal(openCodeCredentials(AUTH_SIGNED_IN), 7);
  assert.equal(openCodeCredentials(AUTH_NONE), 0);
  assert.equal(openCodeCredentials(""), null);
  assert.equal(oc.authOk(AUTH_SIGNED_IN), true);
  assert.equal(oc.authOk(AUTH_NONE), false);
});

test("opencode model list keeps provider, nested ids and order", () => {
  const out = "opencode/beam-free\nalibaba-cn/kimi/kimi-k2.5\nollama/gemma4:26b\nnot a model\nopencode/beam-free\n";
  assert.deepEqual(openCodeModels(out), [
    { id: "opencode/beam-free", label: "beam-free", group: "opencode" },
    { id: "alibaba-cn/kimi/kimi-k2.5", label: "kimi/kimi-k2.5", group: "alibaba-cn" },
    { id: "ollama/gemma4:26b", label: "gemma4:26b", group: "ollama" },
  ]);
  assert.deepEqual(openCodeModels(""), []);
});

test("opencode runs the read-only plan agent with the model and work folder", () => {
  assert.deepEqual(oc.args({ cwd: "/tmp/work", model: "", readFiles: false }),
    ["run", "--format", "json", "--agent", "plan", "--dir", "/tmp/work"]);
  assert.deepEqual(oc.args({ cwd: "/tmp/work", model: "openrouter/anthropic/claude-sonnet-4-6", readFiles: false }),
    ["run", "--format", "json", "--agent", "plan", "--dir", "/tmp/work", "--model", "openrouter/anthropic/claude-sonnet-4-6"]);
});

test("opencode denies every tool, and only reading when files were copied in", () => {
  const strict = oc.env({ cwd: "/tmp/work", readFiles: false });
  assert.deepEqual(JSON.parse(strict.OPENCODE_PERMISSION), { "*": "deny" });
  assert.equal(strict.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(strict.OPENCODE_DB, ":memory:");
  assert.deepEqual(JSON.parse(oc.env({ cwd: "/tmp/work", readFiles: true }).OPENCODE_PERMISSION),
    { "*": "deny", read: "allow", glob: "allow", grep: "allow" });
});

test("opencode json events become reply text, model and errors", () => {
  const step = (extra = {}) => JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "ses_x", part: { type: "step-start", ...extra } });
  const text = (t) => JSON.stringify({ type: "text", timestamp: 1, sessionID: "ses_x", part: { type: "text", text: t } });
  const finish = (extra = {}) => JSON.stringify({ type: "step_finish", timestamp: 1, sessionID: "ses_x", part: { type: "step-finish", reason: "stop", tokens: { total: 10 }, ...extra } });

  const one = collector();
  for (const l of [step(), text("First answer."), finish({ providerID: "opencode-go", modelID: "deepseek-v4.1-flash" })]) oc.parse(l, one.emit);
  assert.equal(one.out.text, "First answer.");
  assert.deepEqual(one.out.meta, [{ model: "opencode-go/deepseek-v4.1-flash" }]);
  assert.equal(one.out.error, null);

  // Several steps (for example after a tool call) are kept as separate paragraphs.
  const two = collector();
  for (const l of [step(), text("Part one."), finish(), step(), text("Part two."), finish()]) oc.parse(l, two.emit);
  assert.equal(two.out.text, "Part one.\n\nPart two.");

  const bad = collector();
  oc.parse(JSON.stringify({ type: "error", timestamp: 1, sessionID: "ses_x", error: { name: "APIError", data: { message: "Cannot connect to API", isRetryable: true } } }), bad.emit);
  assert.equal(bad.out.error, "Cannot connect to API");
  const bare = collector();
  oc.parse(JSON.stringify({ type: "error", error: { name: "UnknownError" } }), bare.emit);
  assert.equal(bare.out.error, "UnknownError");

  // Non-JSON noise and events we do not use must be ignored quietly.
  const noise = collector();
  for (const l of ["\x1b[93m\x1b[1m! \x1b[0m agent \"plan\" not found.", "", JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", state: { status: "completed", output: "hi" } } })]) oc.parse(l, noise.emit);
  assert.equal(noise.out.text, "");
  assert.equal(noise.out.error, null);
});

test("opencode replies carry proposal blocks into the proposal flow", () => {
  const c = collector();
  oc.parse(JSON.stringify({ type: "text", part: { type: "text", text: "Two options:\n```proposal\nThe radar grid is sparse.\n```\nand\n```proposal\nRadar grids are sparse.\n```" } }), c.emit);
  assert.deepEqual(parseProposals(c.out.text), ["The radar grid is sparse.", "Radar grids are sparse."]);
});

test("opencode detection reports models and the configured default", async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push(args.join(" "));
    if (args[0] === "models") return { ok: true, out: "openrouter/anthropic/claude-sonnet-4-6\nopencode/beam-free\n", stdout: "openrouter/anthropic/claude-sonnet-4-6\nopencode/beam-free\n" };
    return { ok: true, out: '{"model":"opencode/beam-free","provider":{}}', stdout: '{"model":"opencode/beam-free","provider":{}}' };
  };
  const row = { models: oc.models, auth: "signed-in", usable: true, note: "" };
  await oc.detect({ row, exe: { file: "opencode", argv: [] }, exec });
  assert.deepEqual(calls, ["models", "debug config"]);
  assert.deepEqual(row.models.map((m) => m.id), ["", "openrouter/anthropic/claude-sonnet-4-6", "opencode/beam-free"]);
  assert.equal(row.models[0].label, "Default (configured: opencode/beam-free)");
  assert.equal(row.usable, true);
});

test("opencode stays usable without a sign-in while free models exist", async () => {
  const exec = async (file, args) => (args[0] === "models"
    ? { ok: true, out: "opencode/beam-free\n", stdout: "opencode/beam-free\n" }
    : { ok: true, out: "{}", stdout: "{}" });
  const row = { models: oc.models, auth: "not-signed-in", usable: false, note: "" };
  await oc.detect({ row, exe: { file: "opencode", argv: [] }, exec });
  assert.equal(row.usable, true);
  assert.match(row.note, /auth login/);
  assert.equal(row.models[0].label, "Default (the CLI's own choice)");

  const empty = { models: oc.models, auth: "not-signed-in", usable: false, note: "" };
  await oc.detect({ row: empty, exe: { file: "opencode", argv: [] }, exec: async () => ({ ok: true, out: "", stdout: "" }) });
  assert.equal(empty.usable, false);
  assert.equal(empty.models, oc.models);
});

test("opencode detection survives a CLI that answers nothing", async () => {
  const row = { models: oc.models, auth: "signed-in", usable: true, note: "" };
  await oc.detect({ row, exe: { file: "opencode", argv: [] }, exec: async () => { throw new Error("gone"); } });
  assert.equal(row.usable, true);
  assert.equal(row.models, oc.models);
});

const posix = process.platform !== "win32";

/** A stand-in `opencode` on PATH: records what it was given and replays canned events. */
async function fakeCli(mode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mr-agents-"));
  const proposal = "Second part with a proposal:\n```proposal\nKept wording.\n```";
  const events = mode === "multi" ? [
    { type: "step_start", part: { type: "step-start" } },
    { type: "text", part: { type: "text", text: "First part." } },
    { type: "step_finish", part: { type: "step-finish", reason: "tool-calls" } },
    { type: "text", part: { type: "text", text: proposal } },
    { type: "step_finish", part: { type: "step-finish", reason: "stop", providerID: "opencode-go", modelID: "deepseek-v4.1-flash" } },
  ] : mode === "error" ? [
    { type: "error", error: { name: "APIError", data: { message: "Cannot connect to API" } } },
  ] : [{ type: "text", part: { type: "text", text: "OK" } }];
  await fs.writeFile(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "$FAKE_DIR/argv"`,
    `printf '%s' "$OPENCODE_PERMISSION" > "$FAKE_DIR/permission"`,
    `cat > "$FAKE_DIR/stdin"`,
    `if [ "$FAKE_MODE" = hang ]; then exec sleep 30; fi`,
    `cat "$FAKE_DIR/events.jsonl"`,
    `if [ "$FAKE_MODE" = error ]; then exit 1; fi`,
    "exit 0",
    "",
  ].join("\n");
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "opencode"), script, { mode: 0o755 });
  return { dir, restore: installPath(bin, { FAKE_DIR: dir, FAKE_MODE: mode }) };
}

function installPath(bin, extraEnv) {
  const prevPath = process.env.PATH, prev = {};
  process.env.PATH = bin + path.delimiter + (process.env.PATH || "");
  for (const [k, v] of Object.entries(extraEnv)) { prev[k] = process.env[k]; process.env[k] = v; }
  return () => {
    process.env.PATH = prevPath;
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
}

test("startRun drives opencode over stdin and collects its events", { skip: !posix }, async () => {
  const { dir, restore } = await fakeCli("multi");
  try {
    const seen = [];
    const run = startRun({ agent: "opencode", prompt: "Synthetic prompt about a radar paragraph.", cwd: dir, model: "opencode-go/deepseek-v4.1-flash", onText: (t) => seen.push(t), onMeta: (m) => seen.push(m) });
    const r = await run.done;
    assert.equal(r.ok, true);
    assert.equal(r.text, "First part.\n\nSecond part with a proposal:\n```proposal\nKept wording.\n```");
    assert.deepEqual(parseProposals(r.text), ["Kept wording."]);
    assert.deepEqual(await fs.readFile(path.join(dir, "stdin"), "utf8"), "Synthetic prompt about a radar paragraph.");
    assert.deepEqual((await fs.readFile(path.join(dir, "argv"), "utf8")).trim().split("\n"),
      ["run", "--format", "json", "--agent", "plan", "--dir", dir, "--model", "opencode-go/deepseek-v4.1-flash"]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "permission"), "utf8")), { "*": "deny" });
    assert.deepEqual(seen.filter((x) => typeof x === "object"), [{ model: "opencode-go/deepseek-v4.1-flash" }]);
    assert.ok(seen.some((x) => x === "First part."), "streams the first part as it arrives");
  } finally { restore(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("startRun reports an opencode error event", { skip: !posix }, async () => {
  const { dir, restore } = await fakeCli("error");
  try {
    const r = await startRun({ agent: "opencode", prompt: "Synthetic prompt.", cwd: dir }).done;
    assert.equal(r.ok, false);
    assert.equal(r.error, "Cannot connect to API");
  } finally { restore(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("startRun cancels an opencode run", { skip: !posix }, async () => {
  const { dir, restore } = await fakeCli("hang");
  try {
    const run = startRun({ agent: "opencode", prompt: "Synthetic prompt.", cwd: dir });
    setTimeout(() => run.cancel(), 200);
    const r = await run.done;
    assert.equal(r.ok, false);
    assert.equal(r.cancelled, true);
    assert.equal(r.error, "Cancelled.");
  } finally { restore(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("startRun times an opencode run out", { skip: !posix }, async () => {
  const { dir, restore } = await fakeCli("hang");
  try {
    const r = await startRun({ agent: "opencode", prompt: "Synthetic prompt.", cwd: dir, timeoutMs: 400 }).done;
    assert.equal(r.ok, false);
    assert.equal(r.error, "Timed out.");
  } finally { restore(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("startRun refuses an agent without an adapter", () => {
  assert.throws(() => startRun({ agent: "gemini", prompt: "x", cwd: os.tmpdir() }), /No working adapter/);
  assert.throws(() => startRun({ agent: "nosuch", prompt: "x", cwd: os.tmpdir() }), /No working adapter/);
});
