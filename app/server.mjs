// Local HTTP server. Binds to 127.0.0.1 only and requires a per-launch token.
import http from "node:http";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { detectAgents } from "./core/agents.mjs";
import { watchSources } from "./core/watch.mjs";
import { configDir, readJson, writeJson } from "./core/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".pdf": "application/pdf" };

export async function startServer(session, { port = 0, token = crypto.randomBytes(16).toString("hex") } = {}) {
  const sse = new Set();
  session.on("event", (ev) => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const r of sse) r.write(line); });
  const katexDir = [
    path.join(HERE, "node_modules", "katex", "dist"),
    path.resolve(HERE, "..", "media", "katex"),
  ].find(existsSync) || null;

  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(b); };
  const body = async (req) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 64e6) throw Object.assign(new Error("Body too large"), { status: 413 }); chunks.push(c); } const t = Buffer.concat(chunks).toString("utf8"); return t ? JSON.parse(t) : {}; };

  async function api(req, res, url) {
    const p = url.pathname.replace(/^\/api/, ""); const m = req.method; const q = url.searchParams;
    let mm;
    const S = session;
    if (p === "/project" && m === "GET") return json(res, 200, { ...S.project(), ...(await S.bibAndLabels()), katex: !!katexDir });
    if (p === "/article" && m === "GET") return json(res, 200, S.article());
    if ((mm = p.match(/^\/tikz\/([a-f0-9]{6,40})\.svg$/)) && m === "GET") {
      try {
        const file = await S.renderTikz(mm[1]);
        const buf = await fs.readFile(file);
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "content-length": buf.length, "cache-control": "public, max-age=31536000, immutable" });
        return res.end(buf);
      } catch (e) { return json(res, e.status || 422, { error: e.message }); }
    }
    if (p === "/units" && m === "GET") return json(res, 200, Object.values(S.R.units).sort((a, b) => a.order - b.order).map((u) => S.summary(u)));
    if ((mm = p.match(/^\/units\/([^/]+)$/)) && m === "GET") return json(res, 200, S.detail(mm[1]));
    if (p === "/units/manual" && m === "POST") { const b = await body(req); const id = await S.createManual(b); return json(res, 200, { id }); }
    if ((mm = p.match(/^\/units\/([^/]+)\/candidate\/(original|proposed|custom)$/)) && m === "PUT") { const b = await body(req); return json(res, 200, S.editCandidate(mm[1], mm[2], b.text, b.baseVersion)); }
    if ((mm = p.match(/^\/units\/([^/]+)\/candidate\/(original|proposed|custom)\/(undo|redo|restore)$/)) && m === "POST") return json(res, 200, S.candAction(mm[1], mm[2], mm[3]));
    if ((mm = p.match(/^\/units\/([^/]+)\/decision$/)) && m === "PUT") { const b = await body(req); return json(res, 200, S.decide(mm[1], b.choice, b.custom)); }
    if ((mm = p.match(/^\/units\/([^/]+)\/decision\/undo$/)) && m === "POST") return json(res, 200, S.undoDecision(mm[1]));
    if (p === "/units/take-source-all" && m === "POST") return json(res, 200, S.takeSourceAll());
    if ((mm = p.match(/^\/units\/([^/]+)\/take-source$/)) && m === "POST") return json(res, 200, S.takeSource(mm[1]));
    if ((mm = p.match(/^\/units\/([^/]+)\/comments$/)) && m === "POST") { const b = await body(req); return json(res, 200, S.addComment(mm[1], b.author || "me", b.text)); }
    if ((mm = p.match(/^\/units\/([^/]+)\/comments\/([^/]+)$/)) && m === "DELETE") return json(res, 200, S.deleteComment(mm[1], mm[2]));
    if ((mm = p.match(/^\/units\/([^/]+)\/chat$/))) {
      if (m === "GET") return json(res, 200, S.thread(mm[1]));
      if (m === "POST") return json(res, 200, await S.send(mm[1], await body(req)));
    }
    if ((mm = p.match(/^\/units\/([^/]+)\/chat\/([^/]+)\/(cancel|retry)$/)) && m === "POST") {
      if (mm[3] === "cancel") { S.cancel(mm[2]); return json(res, 200, { ok: true }); }
      return json(res, 200, await S.retry(mm[1], mm[2]));
    }
    if ((mm = p.match(/^\/units\/([^/]+)\/chat\/([^/]+)\/proposal\/(\d+)\/apply$/)) && m === "POST") { const b = await body(req); return json(res, 200, S.applyProposal(mm[1], mm[2], +mm[3], b.target, b.text, !!b.force)); }
    if (p === "/agents" && m === "GET") { const cfg = readJson(path.join(configDir(), "local.json"), {}); return json(res, 200, { agents: await detectAgents(q.get("refresh") === "1"), defaultAgent: cfg.defaultAgent || null, defaultModels: cfg.models || {} }); }
    if (p === "/settings" && m === "PUT") {
      const b = await body(req);
      if (b.defaultAgent !== undefined || b.defaultModel !== undefined) {
        const f = path.join(configDir(), "local.json"); const cfg = readJson(f, {});
        if (b.defaultAgent !== undefined) cfg.defaultAgent = b.defaultAgent;
        if (b.defaultModel !== undefined) cfg.models = { ...(cfg.models || {}), [b.defaultAgent || cfg.defaultAgent]: String(b.defaultModel || "") };
        writeJson(f, cfg); delete b.defaultAgent; delete b.defaultModel;
      }
      return json(res, 200, S.setSettings(b));
    }
    if (p === "/instructions") {
      if (m === "GET") return json(res, 200, { text: S.instructions });
      if (m === "PUT") { await S.setInstructions((await body(req)).text || ""); return json(res, 200, { ok: true }); }
    }
    if (p === "/status" && m === "GET") return json(res, 200, { changed: await S.externalChanges(), saved: { at: S.review.savedAt, error: S.review.error }, counts: S.project().counts });
    if (p === "/rescan" && m === "POST") { await S.rescan(); return json(res, 200, S.project()); }
    if (p === "/baseline/rebase" && m === "POST") return json(res, 200, await S.rebaseBaseline());
    if (p === "/apply/preview" && m === "POST") { const b = await body(req); const plan = await S.plan(b.mode || "clean"); return json(res, 200, { ...plan, files: plan.files.map((f) => ({ rel: f.rel, shaBefore: f.shaBefore, shaAfter: f.shaAfter })), patches: plan.patches }); }
    if (p === "/apply" && m === "POST") return json(res, 200, await S.applyPlan((await body(req)).token));
    if (p === "/checkpoints" && m === "GET") return json(res, 200, await S.checkpoints());
    if ((mm = p.match(/^\/checkpoints\/([^/]+)\/undo$/)) && m === "POST") return json(res, 200, await S.undoApply(mm[1], !!(await body(req)).force));
    if (p === "/build" && m === "POST") { const b = await body(req); return json(res, 200, S.startBuild(b.view || "tracked", b.source || "working")); }
    if ((mm = p.match(/^\/build\/([^/]+)$/)) && m === "GET") { const j = S.jobs.get(mm[1]); return j ? json(res, 200, { ...j, pdf: j.pdf ? `/api/build/${j.id}/pdf` : null, dir: undefined }) : json(res, 404, { error: "Unknown build" }); }
    if ((mm = p.match(/^\/build\/([^/]+)\/pdf$/)) && m === "GET") {
      const j = S.jobs.get(mm[1]); if (!j?.pdf) return json(res, 404, { error: "No PDF" });
      const buf = await fs.readFile(j.pdf); res.writeHead(200, { "content-type": "application/pdf", "content-length": buf.length, "cache-control": "no-store" }); return res.end(buf);
    }
    if (p === "/export" && m === "GET") { const b = JSON.stringify(S.exportState(), null, 1); res.writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="${S.proj.id}-review-state.json"` }); return res.end(b); }
    if (p === "/import" && m === "POST") { const b = await body(req); return json(res, 200, S.importState(b.data, !!b.replace)); }
    if (p === "/events" && m === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": hi\n\n"); sse.add(res); req.on("close", () => sse.delete(res)); return;
    }
    return json(res, 404, { error: "Not found" });
  }

  async function serveFile(res, file) {
    try {
      const buf = await fs.readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" }); res.end(buf);
    } catch { res.writeHead(404); res.end("Not found"); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const host = (req.headers.host || "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") { res.writeHead(403); return res.end("Forbidden host"); }
      const cookies = Object.fromEntries((req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")));
      const queryToken = url.searchParams.get("t") === token;
      if (queryToken && !url.pathname.startsWith("/api")) {
        res.writeHead(302, { "set-cookie": `mr=${token}; HttpOnly; SameSite=Strict; Path=/`, location: url.pathname }); return res.end();
      }
      if (cookies.mr !== token && !queryToken) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("Open this tool with the link printed by the launcher."); }
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.headers["x-mr"] !== "1") return json(res, 403, { error: "Missing header" });
        return await api(req, res, url);
      }
      if (url.pathname === "/" || url.pathname === "/index.html") return serveFile(res, path.join(HERE, "public", "index.html"));
      const safe = (root, rel) => { const f = path.resolve(root, "." + path.sep + rel); return f.startsWith(path.resolve(root) + path.sep) ? f : null; };
      let f = null;
      if (url.pathname.startsWith("/shared/")) f = safe(path.join(HERE, "shared"), url.pathname.slice(8));
      else if (url.pathname.startsWith("/vendor/katex/") && katexDir) f = safe(katexDir, url.pathname.slice(14));
      else f = safe(path.join(HERE, "public"), url.pathname.slice(1));
      if (!f) { res.writeHead(403); return res.end(); }
      return serveFile(res, f);
    } catch (e) {
      const code = e.status || 500;
      if (!res.headersSent) json(res, code, { error: e.message, ...(e.stale ? { stale: true } : {}), ...(e.current ? { current: e.current } : {}), ...(e.conflicts ? { conflicts: e.conflicts } : {}) });
      else res.end();
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const actual = server.address().port;
  // Keep the open review in step with saves made in an editor.
  const watcher = watchSources(session);
  return { server, port: actual, token, url: `http://127.0.0.1:${actual}/?t=${token}`, close: () => new Promise((r) => { watcher.stop(); for (const c of sse) c.end(); server.close(r); server.closeAllConnections?.(); }) };
}
