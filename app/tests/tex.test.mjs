import test from "node:test";
import assert from "node:assert/strict";
import { walk, flatten, maskComments, sentenceRanges, extractMacros, hasMarkup } from "../shared/tex.mjs";
import { wordDiff } from "../shared/worddiff.mjs";
import { applyEdits, replacementFor } from "../core/apply.mjs";
import { detectChangesPackage } from "../core/build.mjs";

const nodes = (s) => { const out = []; walk(s, (e) => e.type === "node" && out.push(e)); return out; };

test("finds replaced with nested braces, math, citations", () => {
  const s = String.raw`A \replaced{new $x_{i}^{2}$ \textbf{bold}~\cite{a,b}}{old \mbox{\cite{c}} $\{y\}$} B`;
  const n = nodes(s); assert.equal(n.length, 1);
  assert.equal(flatten(s, "new"), String.raw`A new $x_{i}^{2}$ \textbf{bold}~\cite{a,b} B`);
  assert.equal(flatten(s, "old"), String.raw`A old \mbox{\cite{c}} $\{y\}$ B`);
});

test("nested markup flattens without nested replaced in output", () => {
  const s = String.raw`\replaced{one \added{two} three}{one \deleted{zero} three}`;
  assert.equal(flatten(s, "new"), "one two three");
  assert.equal(flatten(s, "old"), "one zero three");
  assert.ok(!hasMarkup(flatten(s, "new")));
});

test("comments and escaped percent", () => {
  const s = String.raw`50\% % \added{hidden}
\added{shown}`;
  assert.equal(nodes(s).length, 1);
  assert.equal(maskComments(s).length, s.length);
});

test("macro definitions are not review units", () => {
  const s = String.raw`\DeclareRobustCommand{\added}[1]{\ifx{\color{g}#1}\fi}
\newcommand{\replaced}[2]{\deleted{#2}\added{#1}}
\def\deleted#1{}
Text \added{real}.`;
  const n = nodes(s); assert.equal(n.length, 1); assert.equal(s.slice(n[0].args[0][0], n[0].args[0][1]), "real");
});

test("unbalanced brace in comment does not break matching", () => {
  const s = String.raw`\replaced{a % } oops
b}{c}`;
  assert.equal(nodes(s).length, 1);
});

test("sentence ranges keep abbreviations and math together", () => {
  const r = sentenceRanges(String.raw`See Fig. 3 for $a.b$ results. Then we continue e.g. here. Last one.`);
  assert.equal(r.length, 3);
});

test("macro extraction skips presentation macros", () => {
  const m = extractMacros(String.raw`\newcommand{\vect}[1]{\mathbf{#1}} \newcommand{\hl}[1]{\colorbox{y}{#1}}`);
  assert.ok(m["\\vect"]); assert.equal(m["\\hl"], undefined);
});

test("word diff isolates a changed word and keeps whitespace neutral", () => {
  const ops = wordDiff("or its eight cells", "and its eight cells");
  assert.deepEqual(ops.filter((o) => o.t !== "eq").map((o) => [o.t, o.s]), [["del", "or"], ["ins", "and"]]);
});

test("applyEdits preserves CRLF and removes blank line on deletion", () => {
  const text = "a\r\nB \\added{x}\r\nc\r\n";
  const start = text.indexOf("\\added"), end = start + "\\added{x}".length;
  assert.equal(applyEdits(text, [{ start, end, text: "y\nz" }], "\r\n"), "a\r\nB y\r\nz\r\nc\r\n");
  const t2 = "a\r\n\\deleted{x}\r\nc\r\n"; const s2 = t2.indexOf("\\deleted");
  assert.equal(applyEdits(t2, [{ start: s2, end: s2 + 11, text: "" }], "\r\n"), "a\r\nc\r\n");
});

test("changes package optional author arguments are parsed and stripped", () => {
  const s = String.raw`A \added[id=alice]{new} B \deleted[id=bob]{old} C \replaced[id=carol,remark={note}]{new2}{old2} D`;
  const n = nodes(s); assert.equal(n.length, 3);
  assert.equal(flatten(s, "new"), "A new B C new2 D");
  assert.equal(flatten(s, "old"), "A B old C old2 D");
  assert.ok(hasMarkup(s));
});

test("changes package definition is skipped", () => {
  const s = String.raw`\definechangesauthor[name={Alice}, color=blue]{alice}
Text \added[id=alice]{real}.`;
  const n = nodes(s); assert.equal(n.length, 1);
  assert.ok(flatten(s, "new").endsWith("Text real."));
});

const unit = (original, proposed, importedOriginal = original) => ({
  decision: { choice: "proposed" },
  original: { versions: [{ text: original }], head: 0 },
  proposed: { versions: [{ text: proposed }], head: 0 },
  custom: { versions: [{ text: proposed }], head: 0 },
  imported: { original: importedOriginal },
});

test("tracked output uses changes package commands and author id", () => {
  const exact = { status: "exact", text: "old" };
  assert.equal(replacementFor(unit("old", "new"), "tracked", exact), "\\replaced{new}{old}");
  assert.equal(replacementFor(unit("old", "new"), "tracked", exact, "alice"), "\\replaced[id=alice]{new}{old}");
  assert.equal(replacementFor(unit("", "new", ""), "tracked", null, "alice"), "\\added[id=alice]{new}");
  assert.equal(replacementFor(unit("old", "", "old"), "tracked", null, "alice"), "\\deleted[id=alice]{old}");
  assert.equal(replacementFor(unit("old", "new"), "clean", exact, "alice"), "new");
});

test("clean builds detect the changes package", () => {
  const yes = { files: new Map([["main.tex", { text: "\\documentclass{article}\n\\usepackage[final]{changes}" }]]) };
  const no = { files: new Map([["main.tex", { text: "\\documentclass{article}" }]]) };
  assert.equal(detectChangesPackage(yes), true);
  assert.equal(detectChangesPackage(no), false);
});
