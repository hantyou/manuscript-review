// Review state: candidates with immutable imports, versions, decisions.
import crypto from "node:crypto";
import { norm } from "../shared/tex.mjs";
import { sha1 } from "./scan.mjs";

export const now = () => new Date().toISOString();
export const rid = (p = "x") => p + "_" + crypto.randomBytes(5).toString("hex");
const MAX_VERSIONS = 300;

export function newCandidate(text) {
  return { versions: [{ id: rid("v"), ts: now(), text, via: "import" }], head: 0 };
}
export const cur = (c) => c.versions[c.head];

export function setText(c, text, via = "edit") {
  if (cur(c).text === text) return false;
  c.versions.length = c.head + 1; // a new edit drops the redo tail
  c.versions.push({ id: rid("v"), ts: now(), text, via });
  if (c.versions.length > MAX_VERSIONS) c.versions.splice(1, c.versions.length - MAX_VERSIONS);
  c.head = c.versions.length - 1;
  return true;
}
export function undo(c) { if (c.head > 0) { c.head--; return true; } return false; }
export function redo(c) { if (c.head < c.versions.length - 1) { c.head++; return true; } return false; }

export function createUnit(su, scanOrderIdx) {
  return {
    id: su.id, kind: su.kind, file: su.file, present: true, applied: null, order: scanOrderIdx,
    imported: { original: su.orig, proposed: su.prop, srcText: su.srcText },
    original: newCandidate(su.orig), proposed: newCandidate(su.prop),
    custom: newCandidate(su.prop), customTouched: false,
    decision: null, decisionLog: [], comments: [], created: now(), srcSha: su.srcSha,
  };
}

export function unitRev(u) {
  return sha1([cur(u.original).id, cur(u.proposed).id, cur(u.custom).id].join("|")).slice(0, 12);
}

export function chosenText(u) {
  const d = u.decision; if (!d) return null;
  return cur(d.choice === "original" ? u.original : d.choice === "proposed" ? u.proposed : u.custom).text;
}

/** pending | decided | stale | applied | detached */
export function statusOf(u) {
  if (u.applied) return "applied";
  if (!u.present) return "detached";
  const d = u.decision; if (!d) return "pending";
  const c = u[d.choice]; if (!c) return "stale";
  return cur(c).id === d.versionId && sha1(cur(c).text) === d.textHash ? "decided" : "stale";
}

export function decide(u, choice) {
  if (choice === "pending") return reopen(u);
  if (!["original", "proposed", "custom"].includes(choice)) throw new Error("bad choice");
  if (choice === "custom") u.customTouched = true;
  const c = u[choice];
  u.decisionLog.push({ ts: now(), prev: u.decision, action: "set" });
  u.decision = { choice, versionId: cur(c).id, textHash: sha1(cur(c).text), ts: now() };
}
export function reopen(u) {
  if (!u.decision) return;
  u.decisionLog.push({ ts: now(), prev: u.decision, action: "reopen" });
  u.decision = null;
}
export function undoDecision(u) {
  const last = u.decisionLog.pop(); if (!last) return false;
  u.decision = last.prev; return true;
}

/** Merge a fresh scan into persistent state. Keeps ids and decisions stable. */
export function syncUnits(review, scan, manualScan = []) {
  const incoming = [...scan.units, ...manualScan];
  const byId = new Map(Object.values(review.units).map((u) => [u.id, u]));
  const claimed = new Set();
  const unclaimed = () => Object.values(review.units).filter((u) => !claimed.has(u.id) && !u.applied && u.kind !== "manual");
  const out = [];
  incoming.forEach((su, idx) => {
    let eu = byId.get(su.id);
    if (eu && claimed.has(eu.id)) eu = null;
    if (!eu && su.kind !== "manual") {
      const cand = unclaimed();
      const a = cand.filter((u) => norm(u.imported.original) === norm(su.orig));
      const b = cand.filter((u) => norm(u.imported.proposed) === norm(su.prop));
      eu = a.length === 1 ? a[0] : b.length === 1 ? b[0] : null;
    }
    if (!eu) { eu = createUnit(su, idx); review.units[eu.id] = eu; }
    claimed.add(eu.id);
    eu.present = true; eu.file = su.file; eu.order = idx; eu.srcSha = su.srcSha; eu.kind = su.kind;
    if (su.orig !== eu.imported.original || su.prop !== eu.imported.proposed) eu.sourceChanged = { original: su.orig, proposed: su.prop, srcText: su.srcText };
    else delete eu.sourceChanged;
    su.stateId = eu.id;
  });
  for (const u of Object.values(review.units)) if (!claimed.has(u.id)) { u.present = false; if (!u.applied) u.order = 1e9; }
  return incoming;
}

/** Replace a unit's candidates with the text now in the source. */
export function takeSource(u) {
  if (!u.sourceChanged) return false;
  const { original, proposed, srcText } = u.sourceChanged;
  setText(u.original, original, "source"); setText(u.proposed, proposed, "source");
  u.imported = { original, proposed, srcText };
  delete u.sourceChanged; return true;
}
