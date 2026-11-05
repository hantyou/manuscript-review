// Turn saved decisions into minimal source patches, with checkpoints.
import { promises as fs } from "node:fs";
import path from "node:path";
import { flatten, norm } from "../shared/tex.mjs";
import { chosenText, statusOf, now, rid } from "./model.mjs";
import { encodeSource, readSource, sha1, sha256 } from "./scan.mjs";

export function replacementFor(u, mode, baseMatch) {
  const T = flatten((chosenText(u) ?? "").replace(/\r\n/g, "\n"), "new").trim();
  if (mode !== "tracked") return T;
  const B = (baseMatch?.status === "exact" ? baseMatch.text : u.imported.original).trim();
  if (norm(T) === norm(B)) return T;
  if (!B) return `\\added{${T}}`;
  if (!T) return `\\deleted{${B}}`;
  return `\\replaced{${T}}{${B}}`;
}

/** Apply sorted, non-overlapping edits to one file's text. */
export function applyEdits(text, edits, eol) {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    let { start, end } = e; let rep = e.text.replace(/\r\n/g, "\n");
    if (eol === "\r\n") rep = rep.replace(/\n/g, "\r\n");
    if (rep === "") { // do not leave a doubled space or a blank line behind
      const ls = out.lastIndexOf("\n", start - 1) + 1, le = (() => { const k = out.indexOf("\n", end); return k < 0 ? out.length : k; })();
      if (out.slice(ls, start).trim() === "" && out.slice(end, le).trim() === "") { start = ls; end = Math.min(out.length, le + 1); }
      else if (/[ \t]$/.test(out.slice(0, start)) && /^[ \t\r\n]/.test(out.slice(end))) start -= out.slice(0, start).match(/[ \t]+$/)[0].length;
    }
    out = out.slice(0, start) + rep + out.slice(end);
  }
  return out;
}

export function buildPlan(review, scan, matches, mode) {
  const byState = new Map(scan.units.concat(scan.manualUnits || []).map((s) => [s.stateId, s]));
  const patches = [], conflicts = [], skipped = { pending: 0, stale: 0, detached: 0 };
  const perFile = new Map();
  for (const u of Object.values(review.units)) {
    const st = statusOf(u);
    if (st === "pending") { skipped.pending++; continue; }
    if (st === "stale") { skipped.stale++; continue; }
    if (st === "detached") { if (u.decision) skipped.detached++; continue; }
    if (st !== "decided") continue;
    const su = byState.get(u.id);
    if (!su) { conflicts.push({ unitId: u.id, reason: "Passage no longer found in the source." }); continue; }
    if (u.decision.srcSha && su.srcSha !== u.decision.srcSha) { conflicts.push({ unitId: u.id, reason: "Source text changed after the decision. Review it again." }); continue; }
    const text = replacementFor(u, mode, matches?.[u.id]);
    const f = scan.files.get(su.file);
    patches.push({ unitId: u.id, file: su.file, start: su.start, end: su.end, line: su.line, before: f.text.slice(su.start, su.end), text, kind: u.kind, choice: u.decision.choice });
    if (!perFile.has(su.file)) perFile.set(su.file, []);
    perFile.get(su.file).push(patches[patches.length - 1]);
  }
  const files = [];
  for (const [rel, edits] of perFile) {
    edits.sort((a, b) => a.start - b.start);
    for (let i = 1; i < edits.length; i++) if (edits[i].start < edits[i - 1].end) throw new Error("Overlapping patches in " + rel);
    const f = scan.files.get(rel);
    if (!f.roundtrip) { for (const e of edits) conflicts.push({ unitId: e.unitId, reason: `${rel} is not valid UTF-8, so it is left untouched.` }); continue; }
    const after = applyEdits(f.text, edits, f.eol);
    files.push({ rel, shaBefore: f.sha, after, shaAfter: sha256(encodeSource(f, after)), changedBytes: Math.abs(after.length - f.text.length) });
  }
  const bad = new Set(conflicts.map((c) => c.unitId));
  const okFiles = files.filter((f) => !conflicts.some((c) => patches.find((p) => p.unitId === c.unitId && p.file === f.rel)));
  return { patches: patches.filter((p) => !bad.has(p.unitId)), conflicts, skipped, files: okFiles, mode,
    token: sha1(JSON.stringify([mode, okFiles.map((f) => [f.rel, f.shaBefore, f.shaAfter])])) };
}

export async function commitPlan(proj, scan, plan) {
  const dir = path.join(proj.stateDir, "checkpoints", now().replace(/[:.]/g, "-") + "_" + rid("c").slice(2, 6));
  await fs.mkdir(path.join(dir, "files"), { recursive: true });
  const manifest = { id: path.basename(dir), ts: now(), mode: plan.mode, units: plan.patches.map((p) => p.unitId), files: {}, undone: false };
  // Verify nothing changed since the preview, then save originals before writing.
  for (const f of plan.files) {
    const abs = path.join(proj.dir, f.rel);
    const cur = await readSource(abs);
    if (cur.sha !== f.shaBefore) throw Object.assign(new Error(`${f.rel} changed outside the tool after the preview. Nothing was written.`), { code: "STALE" });
  }
  for (const f of plan.files) {
    const abs = path.join(proj.dir, f.rel);
    await fs.mkdir(path.dirname(path.join(dir, "files", f.rel)), { recursive: true });
    await fs.copyFile(abs, path.join(dir, "files", f.rel));
    manifest.files[f.rel] = { before: f.shaBefore, after: f.shaAfter };
  }
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  for (const f of plan.files) {
    const abs = path.join(proj.dir, f.rel); const src = scan.files.get(f.rel);
    const tmp = abs + ".mr-tmp";
    await fs.writeFile(tmp, encodeSource(src, f.after));
    await fs.rename(tmp, abs);
  }
  return manifest;
}

export async function listCheckpoints(proj) {
  const base = path.join(proj.stateDir, "checkpoints");
  let names = []; try { names = await fs.readdir(base); } catch {}
  const out = [];
  for (const n of names.sort().reverse()) { try { out.push(JSON.parse(await fs.readFile(path.join(base, n, "manifest.json"), "utf8"))); } catch {} }
  return out;
}

export async function undoCheckpoint(proj, id, force = false) {
  const dir = path.join(proj.stateDir, "checkpoints", id);
  const m = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  if (m.undone) throw new Error("Checkpoint already undone.");
  const conflicts = [];
  for (const [rel, h] of Object.entries(m.files)) {
    const cur = await readSource(path.join(proj.dir, rel));
    if (cur.sha !== h.after) conflicts.push(rel);
  }
  if (conflicts.length && !force) throw Object.assign(new Error(`These files changed after the application: ${conflicts.join(", ")}. Nothing was restored.`), { code: "STALE", conflicts });
  for (const rel of Object.keys(m.files)) {
    const abs = path.join(proj.dir, rel), tmp = abs + ".mr-tmp";
    await fs.copyFile(path.join(dir, "files", rel), tmp); await fs.rename(tmp, abs);
  }
  m.undone = true; m.undoneAt = now();
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(m, null, 1));
  return m;
}
