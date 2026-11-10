// API and event transport. In a VS Code webview messages go through the extension;
// in a normal browser the same UI talks to the loopback HTTP server.
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
export const inVSCode = !!vscode;

let nextId = 0;
const pending = new Map();
const listeners = new Set();

if (vscode) {
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "api-result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.body);
      else p.reject(Object.assign(new Error(m.body?.error || m.error || "Request failed"), { status: m.status, data: m.body }));
    } else if (m.type === "event") {
      for (const fn of listeners) { try { fn(m.event); } catch {} }
    }
  });
}

export async function api(method, url, body) {
  if (!vscode) {
    const r = await fetch("/api" + url, { method, headers: { "content-type": "application/json", "x-mr": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const jsonBody = (r.headers.get("content-type") || "").includes("application/json");
    const data = jsonBody ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) throw Object.assign(new Error((jsonBody && data.error) || data || r.statusText), { status: r.status, data });
    return data;
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    vscode.postMessage({ type: "api", id, method, url, body });
  });
}

export function onEvent(fn) {
  if (vscode) { listeners.add(fn); return () => listeners.delete(fn); }
  const es = new EventSource("/api/events");
  es.onmessage = (e) => { try { fn(JSON.parse(e.data)); } catch {} };
  return () => es.close();
}

export function openPdf(url) {
  if (vscode) vscode.postMessage({ type: "openPdf", url });
  else window.open(url, "_blank", "noopener");
}

export function exportState() {
  if (vscode) vscode.postMessage({ type: "exportState" });
  else window.location.href = "/api/export";
}
