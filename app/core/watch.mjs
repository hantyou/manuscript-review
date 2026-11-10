// Fold source edits made outside the tool into the open review.
//
// The paper is watched by hashing, not by platform file events: it costs a few
// small reads per tick, works on network filesystems and in Remote SSH, and it
// cannot miss a change that happened while no watcher was attached.
import { promises as fs } from "node:fs";
import path from "node:path";
import { maskComments } from "../shared/tex.mjs";
import { sha256 } from "./scan.mjs";

/** Files outside the .tex scan that still change the reading: bibliography and labels. */
async function sideFiles(session) {
  const rels = new Set();
  for (const f of session.scan?.files?.values() || []) {
    for (const m of maskComments(f.text).matchAll(/\\bibliography\s*\{([^}]*)\}/g)) {
      for (const name of m[1].split(",")) {
        const n = name.trim();
        if (n) rels.add(n.replace(/\.bib$/i, "") + ".bib");
      }
    }
  }
  const aux = session.proj?.mainRel?.replace(/\.tex$/i, ".aux");
  if (aux) rels.add(aux);
  const out = [];
  for (const rel of [...rels].sort()) {
    let sha = "";
    try { sha = sha256(await fs.readFile(path.join(session.proj.dir, rel))); } catch {}
    out.push({ rel, sha });
  }
  return out;
}

/**
 * Poll for external edits and rescan when something moved. `rescan` broadcasts
 * {type:"scan", auto:true, files}, which every client already receives.
 * Returns {tick, stop}; the timer is unref'd so it never holds a process open.
 */
export function watchSources(session, { intervalMs = 1500, onError } = {}) {
  let busy = false, side = null;
  const tick = async () => {
    if (busy || session.writing) return false;
    busy = true;
    try {
      const changed = await session.externalChanges();
      const now = await sideFiles(session);
      // The first look is the baseline, not a change.
      const moved = side === null ? [] : [...now].filter((x) => side.get(x.rel) !== x.sha).map((x) => x.rel);
      side = new Map(now.map((x) => [x.rel, x.sha]));
      if (!changed.length && !moved.length) return false;
      await session.rescan(false, { auto: true, files: [...new Set([...changed, ...moved])] });
      return true;
    } catch (e) { onError?.(e); return false; }
    finally { busy = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
