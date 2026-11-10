import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchSources } from "../core/watch.mjs";
import { prepareProject } from "../core/open.mjs";
import { Session } from "../core/session.mjs";

process.env.MR_TOOLS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mr-sync-state-"));

function fakeSession({ changed = [], keep = false } = {}) {
  return {
    writing: false,
    calls: [],
    changed,
    scan: { files: new Map() },
    proj: { dir: os.tmpdir(), mainRel: "root.tex" },
    async externalChanges() { return this.changed; },
    async rescan(first, info) { this.calls.push({ first, info }); if (!keep) this.changed = []; },
  };
}

test("watchSources rescans once per external change and stays quiet otherwise", async () => {
  const s = fakeSession({ changed: ["root.tex"] });
  const w = watchSources(s, { intervalMs: 60000 });
  try {
    assert.equal(await w.tick(), true);
    assert.deepEqual(s.calls, [{ first: false, info: { auto: true, files: ["root.tex"] } }]);
    assert.equal(await w.tick(), false);
    assert.equal(s.calls.length, 1);
  } finally { w.stop(); }
});

test("watchSources skips a tick while the tool is writing the paper", async () => {
  const s = fakeSession({ changed: ["root.tex"] });
  const w = watchSources(s, { intervalMs: 60000 });
  try {
    s.writing = true;
    assert.equal(await w.tick(), false);
    assert.equal(s.calls.length, 0);
    s.writing = false;
    assert.equal(await w.tick(), true);
  } finally { w.stop(); }
});

test("watchSources notices bibliography and label files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mr-sync-bib-"));
  const s = fakeSession();
  s.proj = { dir, mainRel: "root.tex" };
  s.scan = { files: new Map([["root.tex", { text: String.raw`\bibliography{refs}` }]]) };
  await fs.writeFile(path.join(dir, "refs.bib"), "@article{a, title={One}}\n");
  const w = watchSources(s, { intervalMs: 60000 });
  try {
    assert.equal(await w.tick(), false, "the first look only records the baseline");
    await fs.writeFile(path.join(dir, "refs.bib"), "@article{a, title={Two}}\n");
    assert.equal(await w.tick(), true);
    assert.deepEqual(s.calls[0].info.files, ["refs.bib"]);
  } finally { w.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("watchSources runs on its own and stops", async () => {
  const s = fakeSession({ changed: ["root.tex"], keep: true });
  const w = watchSources(s, { intervalMs: 20 });
  await new Promise((r) => setTimeout(r, 150));
  w.stop();
  const n = s.calls.length;
  assert.ok(n >= 1, "the timer fired");
  assert.equal(s.calls[0].info.auto, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.calls.length, n, "nothing runs after stop()");
});

test("an external save is folded into an open session", async () => {
  const paper = path.join(process.env.MR_TOOLS_DIR, "paper");
  await fs.mkdir(paper, { recursive: true });
  const root = path.join(paper, "root.tex");
  const doc = (body) => `\\documentclass{article}\n\\begin{document}\n\\section{Method}\n${body}\n\\end{document}\n`;
  await fs.writeFile(root, doc("The original sentence."));

  const proj = await prepareProject({ dir: paper, main: "root.tex" });
  const session = new Session(proj, {});
  await session.init();
  const events = [];
  session.on("event", (e) => events.push(e));
  const w = watchSources(session, { intervalMs: 60000 });
  try {
    assert.equal(await w.tick(), false, "no change yet");
    await fs.writeFile(root, doc("The edited sentence."));
    assert.equal(await w.tick(), true);
    const scans = events.filter((e) => e.type === "scan" && e.auto);
    assert.equal(scans.length, 1);
    assert.deepEqual(scans[0].files, ["root.tex"]);
    assert.match([...session.scan.files.values()][0].text, /edited sentence/);
  } finally { w.stop(); }
});

test("takeSourceAll refreshes every unit whose source changed", async () => {
  const paper = path.join(process.env.MR_TOOLS_DIR, "paper-all");
  await fs.mkdir(paper, { recursive: true });
  const root = path.join(paper, "root.tex");
  const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  await fs.writeFile(root, doc(String.raw`A \replaced{new A}{old A} B. C \replaced{new C}{old C} D.`));
  const proj = await prepareProject({ dir: paper, main: "root.tex" });
  const session = new Session(proj, {});
  await session.init();
  try {
    assert.equal(Object.keys(session.R.units).length, 2);
    await fs.writeFile(root, doc(String.raw`A \replaced{new A v2}{old A} B. C \replaced{new C v2}{old C} D.`));
    await session.rescan();
    assert.equal(Object.values(session.R.units).filter((u) => u.sourceChanged).length, 2);
    const r = session.takeSourceAll();
    assert.equal(r.updated, 2);
    assert.ok(Object.values(session.R.units).every((u) => !u.sourceChanged));
    const proposed = Object.values(session.R.units).map((u) => session.detail(u.id).proposed.text).sort();
    assert.deepEqual(proposed, ["new A v2", "new C v2"]);
    assert.equal(session.takeSourceAll().updated, 0, "a second click has nothing left to do");
  } finally { session.review.flush(); }
});
