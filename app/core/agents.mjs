// Adapters for locally installed AI agents. Each adapter states honestly what is
// verified. The prompt travels on stdin, never on the command line, and the
// agent runs in an isolated workspace with write tools switched off.
//
// To add an agent: add an entry to ADAPTERS with `command`, `args(opts)` and
// `parse(line, emit)`, plus optional `env(opts)` and an async `detect({row, exe, exec})`
// that refines what detection reports. Nothing else in the app switches on the agent id.
import { spawn, execFile } from "node:child_process";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Find an executable on PATH. For npm .cmd shims, resolve the real target so no shell is needed. */
export function resolveExecutable(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, name + e);
    if (!existsSync(p)) continue;
    try { if (!(require_stat(p))) continue; } catch { continue; }
    if (/\.(cmd|bat)$/i.test(p)) {
      const txt = readFileSync(p, "utf8");
      const all = [...txt.matchAll(/"%~?dp0%?\\([^"]+\.(exe|js|mjs|cjs))"/gi)].filter((x) => existsSync(path.join(path.dirname(p), x[1])));
      const m = all[all.length - 1];
      if (m && /exe/i.test(m[2])) return { file: path.join(path.dirname(p), m[1]), argv: [], shim: p };
      // In a VS Code extension host process.execPath is VS Code, not Node.
      // Let the .cmd shim find Node itself through the shell.
      if (m && !process.versions.electron) return { file: process.execPath, argv: [path.join(path.dirname(p), m[1])], shim: p };
      return { file: p, argv: [], shim: p, needsShell: true };
    }
    return { file: p, argv: [] };
  }
  return null;
}
import { statSync } from "node:fs";
function require_stat(p) { return statSync(p).isFile(); }

const CLAUDE_ARGS = (o) => [
  "-p", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
  "--tools", o.readFiles ? "Read,Grep,Glob" : "",
  "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  ...(o.model ? ["--model", o.model] : []),
];

const stripAnsi = (s) => String(s || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/** `opencode auth list` ends with a "<n> credentials" summary; returns null when it cannot be read. */
export function openCodeCredentials(out) {
  const m = /([0-9]+)\s+credentials?\b/.exec(stripAnsi(out));
  return m ? Number(m[1]) : null;
}

/** `opencode models` prints one `provider/model` id per line. Ids may hold further slashes. */
export function openCodeModels(out) {
  const list = []; const seen = new Set();
  for (const line of stripAnsi(out).split("\n")) {
    const id = line.trim();
    if (!/^[\w.@-]+(?:\/[\w.:@-]+)+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const i = id.indexOf("/");
    list.push({ id, label: id.slice(i + 1), group: id.slice(0, i) });
  }
  return list;
}

// OpenCode gates every tool through its permission config, which this env var
// inlines. Nothing is allowed unless the paper was copied into the work folder.
const openCodePermission = (readFiles) => JSON.stringify(readFiles ? { "*": "deny", read: "allow", glob: "allow", grep: "allow" } : { "*": "deny" });

export const ADAPTERS = {
  claude: {
    label: "Claude Code", command: "claude", versionArgs: ["--version"], authArgs: ["auth", "status"],
    authOk: (out) => /"loggedIn"\s*:\s*true/.test(out),
    status: "verified", streaming: true,
    models: [
      { id: "", label: "Default (the CLI's own choice)" },
      { id: "opus", label: "Opus (latest alias)" }, { id: "sonnet", label: "Sonnet (latest alias)" }, { id: "haiku", label: "Haiku (latest alias, fastest)" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }, { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" }, { id: "claude-fable-5-1", label: "Claude Fable 5.1 (needs usage credits)" },
    ],
    via: "Claude Code CLI using its existing sign-in. The prompt is sent to Anthropic's hosted model.",
    args: CLAUDE_ARGS,
    parse(line, emit) {
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.type === "system" && j.subtype === "init" && j.model) emit.meta({ model: j.model });
      else if (j.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.text) emit.text(j.event.delta.text);
      else if (j.type === "result") { if (j.is_error) emit.error(j.result || "Claude reported an error."); else emit.final(j.result || ""); }
    },
  },
  codex: {
    label: "Codex CLI", command: "codex", versionArgs: ["--version"], authArgs: ["login", "status"],
    authOk: (out) => /logged in/i.test(out) && !/not logged in/i.test(out),
    status: "implemented", streaming: false,
    models: [{ id: "", label: "Default (from your Codex config)" }],
    via: "Codex CLI using its existing sign-in (prompt goes to OpenAI's hosted model). Adapter written from its documented flags. On the machine where it was tried, the configured model and every model name tried were rejected by the ChatGPT account, so no reply was obtained. Set a model your account supports in the model box.",
    args: (o) => ["exec", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "--json", "-C", o.cwd, ...(o.model ? ["-m", o.model] : []), "-"],
    parse(line, emit) {
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.type === "item.completed" && j.item?.type === "agent_message") emit.text(j.item.text || "", true);
      else if (j.type === "turn.failed" || j.type === "error") {
        let msg = j.error?.message || j.message || "Codex reported an error.";
        try { const e = JSON.parse(msg); msg = e.error?.message || msg; } catch {}
        emit.error(msg);
      }
    },
  },
  opencode: {
    label: "OpenCode", command: "opencode", versionArgs: ["--version"], authArgs: ["auth", "list"],
    authOk: (out) => (openCodeCredentials(out) || 0) > 0,
    status: "verified", streaming: false,
    models: [{ id: "", label: "Default (the CLI's own choice)" }],
    via: "OpenCode CLI using its own provider sign-ins; the prompt goes to the model you pick there. The run is read-only: the plan agent, an empty work folder, project config ignored, every tool denied and an in-memory session database, so no file is touched and no session is left in your OpenCode history.",
    args: (o) => ["run", "--format", "json", "--agent", "plan", "--dir", o.cwd, ...(o.model ? ["--model", o.model] : [])],
    env: (o) => ({ OPENCODE_PERMISSION: openCodePermission(o.readFiles), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DB: ":memory:" }),
    parse(line, emit) {
      let j; try { j = JSON.parse(line); } catch { return; }
      const p = j.part || {};
      if (j.type === "text" && p.text) emit.text(String(p.text), true);
      else if (j.type === "step_finish" && p.providerID && p.modelID) emit.meta({ model: `${p.providerID}/${p.modelID}` });
      else if (j.type === "error") {
        const e = j.error || {};
        emit.error((e.data && e.data.message) || e.message || e.name || "OpenCode reported an error.");
      }
    },
    /** Model list and configured default come from the CLI, so the choices match this machine. */
    async detect({ row, exe, exec }) {
      const probe = (args, ms) => exec(exe.file, [...exe.argv, ...args], ms).catch(() => ({ ok: false, out: "", stdout: "" }));
      const [m, cfg] = await Promise.all([probe(["models"], 30000), probe(["debug", "config"], 20000)]);
      const list = openCodeModels(m.out);
      let configured = "";
      try { configured = String(JSON.parse(cfg.stdout || "")?.model || ""); } catch {}
      if (list.length) {
        row.models = [{ id: "", label: configured ? `Default (configured: ${configured})` : "Default (the CLI's own choice)" }, ...list];
        if (configured && !list.some((x) => x.id === configured)) row.models.push({ id: configured, label: configured + " (configured)" });
      }
      if (row.auth !== "signed-in") {
        // OpenCode ships free models that need no sign-in, so a missing credential is not fatal.
        row.usable = list.length > 0;
        row.note = list.length
          ? "No provider sign-in found. Only models that need no credential will answer; sign in with `opencode auth login` for the rest."
          : "Not signed in and no model is available. Sign in from a terminal with `opencode auth login`.";
      }
    },
  },
  gemini: { label: "Gemini CLI", command: "gemini", status: "unsupported", via: "Detected only. No adapter has been verified." },
  codebuddy: { label: "CodeBuddy", command: "codebuddy", status: "unsupported", via: "Detected only. No adapter has been verified." },
  agy: { label: "agy", command: "agy", status: "unsupported", via: "Detected only. No adapter has been verified." },
};

const cache = { at: 0, value: null };
// Node throws EINVAL synchronously when a .cmd/.bat shim is spawned without a
// shell (CVE-2024-27980). That is exactly what the extension host gets on
// Windows, where npm CLIs resolve to their .cmd shim.
const shellFor = (file) => process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
const exec = (file, args, ms = 15000) => new Promise((res) => {
  const fail = () => res({ ok: false, out: "", stdout: "" });
  try {
    execFile(file, args, { timeout: ms, windowsHide: true, shell: shellFor(file) }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout || "") + String(stderr || ""), stdout: String(stdout || "") }));
  } catch { fail(); }
});

export async function detectAgents(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 60000) return cache.value;
  const list = [];
  for (const [id, a] of Object.entries(ADAPTERS)) {
    const exe = resolveExecutable(a.command);
    const row = { id, label: a.label, models: a.models || [{ id: "", label: "Default" }], status: a.status, via: a.via, streaming: !!a.streaming, found: !!exe, usable: false, version: null, auth: "unknown", note: "" };
    if (!exe) row.note = "Not found on PATH.";
    else if (a.status === "unsupported") row.note = "Found, but no adapter has been verified.";
    else {
      const v = await exec(exe.file, [...exe.argv, ...a.versionArgs]);
      row.version = v.out.trim().split("\n")[0] || null;
      if (a.authArgs) {
        const r = await exec(exe.file, [...exe.argv, ...a.authArgs]);
        row.auth = a.authOk(r.out) ? "signed-in" : "not-signed-in";
        if (row.auth !== "signed-in") row.note = "Not signed in. Sign in from a terminal with the tool's own login command.";
      }
      row.usable = row.auth === "signed-in";
      // A failed extra probe must not hide an agent that is installed.
      if (a.detect) { try { await a.detect({ row, exe, exec }); } catch {} }
    }
    list.push(row);
  }
  cache.at = Date.now(); cache.value = list;
  return list;
}

/**
 * Run one agent turn. Returns {cancel, done}. `done` resolves with
 * {ok, text, error}. `onText(delta, replace)` receives streamed text.
 */
export function startRun({ agent, prompt, cwd, model, readFiles, onText, onMeta, timeoutMs = 600000 }) {
  const a = ADAPTERS[agent];
  if (!a || a.status === "unsupported") throw new Error(`No working adapter for "${agent}".`);
  const exe = resolveExecutable(a.command);
  if (!exe) throw new Error(`${a.label} was not found on PATH.`);
  const args = [...exe.argv, ...a.args({ cwd, model, readFiles })];
  const spawnOpts = { cwd, windowsHide: true, shell: !!exe.needsShell || shellFor(exe.file), stdio: ["pipe", "pipe", "pipe"] };
  // An adapter may add env vars; the inherited environment stays intact.
  if (a.env) spawnOpts.env = { ...process.env, ...a.env({ cwd, model, readFiles }) };
  const child = spawn(exe.file, args, spawnOpts);
  let buf = "", text = "", err = "", finalText = null, errorText = null, cancelled = false;
  const emit = {
    text: (d, replace) => { text = replace ? (text ? text + "\n\n" + d : d) : text + d; onText?.(text); },
    final: (t) => { finalText = t; },
    error: (m) => { errorText = m; },
    meta: (m) => onMeta?.(m),
  };
  const feed = (chunk, flush = false) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n"); buf = flush ? "" : lines.pop();
    for (const l of flush ? lines.concat(buf ? [buf] : []) : lines) if (l.trim()) a.parse(l, emit);
  };
  child.stdout.on("data", (c) => feed(c));
  child.stderr.on("data", (c) => { err = (err + c.toString("utf8")).slice(-4000); });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { errorText = errorText || "Timed out."; kill(); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, text, error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer); feed("", true);
      if (cancelled) return resolve({ ok: false, cancelled: true, text, error: "Cancelled." });
      const out = finalText ?? text;
      if (errorText) return resolve({ ok: false, text: out, error: errorText });
      if (code !== 0 && !out) return resolve({ ok: false, text: out, error: (err.trim().split("\n").slice(-3).join(" ") || `Exited with code ${code}.`) });
      resolve({ ok: true, text: out });
    });
  });
  const kill = () => {
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
    else child.kill("SIGTERM");
  };
  return { cancel() { cancelled = true; kill(); }, done };
}

const fence = (s) => "```latex\n" + s + "\n```";

export function buildPrompt({ paper, instructions, paperNotes, unit, context, comments, history, message, manuscript }) {
  const parts = [];
  parts.push(`You are helping an author review wording revisions in a LaTeX journal manuscript ("${paper}"). Answer the author's message about one review unit.

Rules for this conversation:
- You are read-only. Do not try to edit files. The author decides what enters the manuscript.
- Reply in plain prose. When you propose replacement wording, put ONLY the replacement LaTeX source in one fenced block tagged \`proposal\`, for example:
\`\`\`proposal
Replacement sentence here.
\`\`\`
  Use one proposal block per alternative. Do not include \\added, \\deleted or \\replaced markup. Keep citations, references, math, and macros exactly unless the author asks otherwise.
- If the author only asks a question or wants discussion, do not include a proposal block.
- Do not change scientific claims, numbers, equations or notation as a side effect of editing language.`);
  if (instructions?.trim()) parts.push("## Writing instructions (from the author)\n" + instructions.trim());
  if (paperNotes?.trim()) parts.push("## Paper notes\n" + paperNotes.trim());
  parts.push(`## Review unit (${unit.section || "no section"}, ${unit.file}:${unit.line})
Original wording${unit.originalEdited ? " (edited by the author)" : ""}:
${fence(unit.original)}
Proposed wording${unit.proposedEdited ? " (edited by the author)" : ""}:
${fence(unit.proposed)}${unit.custom ? `\nCustom final wording so far:\n${fence(unit.custom)}` : ""}${unit.baseline ? `\nGit baseline text (read-only):\n${fence(unit.baseline)}` : ""}${unit.decision ? `\nCurrent decision: ${unit.decision}.` : ""}`);
  if (context) parts.push("## Surrounding paragraph (current reading)\n" + fence(context));
  if (comments?.length) parts.push("## Comments on this unit\n" + comments.map((c) => `- ${c.author}: ${c.text}`).join("\n"));
  if (manuscript) parts.push("## Wider manuscript (current reading, truncated)\n" + manuscript);
  if (history?.length) parts.push("## Earlier messages in this thread\n" + history.map((m) => `${m.role === "user" ? "Author" : m.agent || "Assistant"}: ${m.text}`).join("\n\n"));
  parts.push("## Author's message\n" + message);
  return parts.join("\n\n");
}

export function parseProposals(text) {
  const out = []; const re = /```proposal[^\n]*\n([\s\S]*?)```/g; let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/\s+$/, ""));
  return out;
}
