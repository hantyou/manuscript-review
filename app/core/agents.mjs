// Adapters for locally installed AI agents. Each adapter states honestly what is
// verified. The prompt travels on stdin, never on the command line, and the
// agent runs in an isolated workspace with write tools switched off.
//
// To add an agent: add an entry to ADAPTERS with `command`, `args(opts)` and
// `parse(line, emit)`. Nothing else in the app switches on the agent id.
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
  gemini: { label: "Gemini CLI", command: "gemini", status: "unsupported", via: "Detected only. No adapter has been verified." },
  codebuddy: { label: "CodeBuddy", command: "codebuddy", status: "unsupported", via: "Detected only. No adapter has been verified." },
  agy: { label: "agy", command: "agy", status: "unsupported", via: "Detected only. No adapter has been verified." },
};

const cache = { at: 0, value: null };
const exec = (file, args, ms = 15000) => new Promise((res) => {
  execFile(file, args, { timeout: ms, windowsHide: true }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout || "") + String(stderr || "") }));
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
  const child = spawn(exe.file, args, { cwd, windowsHide: true, shell: !!exe.needsShell, stdio: ["pipe", "pipe", "pipe"] });
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
