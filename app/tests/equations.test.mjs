import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { findEquations } from "../core/scan.mjs";
import { prepareProject } from "../core/open.mjs";
import { Session } from "../core/session.mjs";

process.env.MR_TOOLS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mr-eq-state-"));

test("findEquations finds display math, labels and skips comments", () => {
  const src = [
    "Line break: \\\\[2pt]",
    "\\begin{equation}\\label{equ:a}",
    "x = 1",
    "\\end{equation}",
    "% \\begin{equation}\\label{equ:b} y = 2 \\end{equation}",
    "\\[ z = 3 \\]",
    "$$ w = 4 $$",
  ].join("\n");
  const eqs = findEquations(src);
  assert.deepEqual(eqs.map((e) => e.label), ["equ:a", null, null]);
  assert.deepEqual(eqs.map((e) => e.env), ["equation", "\\[", "$$"]);
  assert.equal(src.slice(eqs[0].start, eqs[0].end), "\\begin{equation}\\label{equ:a}\nx = 1\n\\end{equation}");
});

test("an unlabelled equation stays in review when its body is edited", async () => {
  const paper = path.join(process.env.MR_TOOLS_DIR, "paper-eq-unlabelled");
  await fs.mkdir(paper, { recursive: true });
  const root = path.join(paper, "root.tex");
  const doc = (body) => `\\documentclass{article}\n\\begin{document}\nThe model is\n\\begin{equation}\n${body}\n\\end{equation}\nand the next paragraph.\n\\end{document}\n`;
  await fs.writeFile(root, doc("a = b"));

  const proj = await prepareProject({ dir: paper, main: "root.tex" });
  const session = new Session(proj, {});
  await session.init();
  try {
    const eq = session.scan.equations[0];
    const id = await session.createManual({ file: "root.tex", fileSha: session.scan.files.get("root.tex").sha, start: eq.start, end: eq.end });
    await fs.writeFile(root, doc("c = d"));
    await session.rescan();
    const u = session.R.units[id];
    assert.equal(u.present, true);
    assert.match(u.sourceChanged.proposed, /c = d/);
    assert.match(session.detail(id).original.text, /a = b/);
  } finally {
    session.review.flush();
  }
});

test("an equation can be put into review and keeps its baseline side", async () => {
  const paper = path.join(process.env.MR_TOOLS_DIR, "paper-eq");
  await fs.mkdir(paper, { recursive: true });
  const root = path.join(paper, "root.tex");
  const doc = (eq) => `\\documentclass{article}\n\\begin{document}\n\\section{Model}\nThe model is\n${eq}\nand the next paragraph.\n\\end{document}\n`;
  await fs.writeFile(root, doc("\\begin{equation}\\label{equ:m}\na = b\n\\end{equation}"));
  const git = (...args) => execFileSync("git", args, { cwd: paper, stdio: "ignore" });
  git("init");
  git("add", "root.tex");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "baseline");

  const proj = await prepareProject({ dir: paper, main: "root.tex" });
  const session = new Session(proj, {});
  await session.init();
  try {
    await fs.writeFile(root, doc("\\begin{equation}\\label{equ:m}\nc = d\n\\end{equation}"));
    await session.rescan();
    const scan = session.scan;
    const eq = scan.equations.find((e) => e.label === "equ:m");
    assert.ok(eq, "the changed equation is still found by label");

    const id = await session.createManual({ file: "root.tex", fileSha: scan.files.get("root.tex").sha, start: eq.start, end: eq.end });
    const d = session.detail(id);
    assert.equal(d.kind, "equation");
    assert.match(d.original.text, /a = b/);
    assert.match(d.proposed.text, /c = d/);
    assert.equal(d.provenance, "exact", "the old equation is matched in the baseline");

    session.decide(id, "proposed");
    const plan = await session.plan("tracked");
    assert.equal(plan.patches.length, 1);
    assert.match(plan.patches[0].text, /c = d/);
    assert.doesNotMatch(plan.patches[0].text, /\\replaced/);
    await session.applyPlan(plan.token);
    assert.ok(session.R.units[id].applied, "the unit is applied");
    assert.doesNotMatch(await fs.readFile(root, "utf8"), /\\replaced/);

    // A later edit reopens the equation instead of staying "applied".
    await fs.writeFile(root, doc("\\begin{equation}\\label{equ:m}\ne = f\n\\end{equation}"));
    await session.rescan();
    assert.equal(session.R.units[id].applied, null);
    assert.match(session.R.units[id].sourceChanged.proposed, /e = f/);
    assert.match(session.detail(id).original.text, /a = b/, "the baseline side is kept");
  } finally {
    session.review.flush();
  }
});
