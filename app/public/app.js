import { renderTex, diffHtml } from "./tex-render.js";
import { wordDiff } from "../shared/worddiff.mjs";
import { icon } from "./icons.js";
import { api, onEvent, openPdf, exportState } from "./transport.mjs";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem("mr." + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem("mr." + k, JSON.stringify(v)); } catch {} } };

let P = null, A = null, C = {}, env = { macros: {}, bib: {}, labels: {}, katex: false };
let activeId = null, agentsInfo = null, thread = [], order = [];
let filter = store.get("filter", "all"), query = "";
const view = { mode: store.get("mode", "compare"), hide: store.get("hide", false), src: store.get("src", false), ai: store.get("ai", true), changes: store.get("changes", false), theme: store.get("theme", "auto"), drawer: store.get("drawer", true) };
const openEd = new Set(), forceCard = new Set(), collapsed = new Set(), timers = {};
let blockEls = [], unitBlock = {}, renderToken = 0, pumpAll = null;

const R = (s) => renderTex(s, env);
const debounce = (k, fn, ms) => { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); };
const cssId = (id) => CSS.escape(id);
function scrollToEl(el, where = "center", behavior = "smooth") {
  const art = $("#article"); const top = el.getBoundingClientRect().top - art.getBoundingClientRect().top + art.scrollTop;
  art.scrollTo({ top: where === "center" ? Math.max(0, top - (art.clientHeight - el.offsetHeight) / 2) : Math.max(0, top - 16), behavior });
}

// ---------- chrome ----------
function toast(msg, label, fn, ms = 6000) {
  const s = $("#snack"); s.hidden = false; s.innerHTML = `<span>${esc(msg)}</span>${label ? `<button id="snackBtn">${esc(label)}</button>` : ""}`;
  if (label) $("#snackBtn").onclick = () => { s.hidden = true; fn?.(); };
  clearTimeout(timers.snack); timers.snack = setTimeout(() => (s.hidden = true), ms);
}
let lastSaved = null;
function setSave(state) { const el = $("#saveStatus"); el.classList.toggle("err", state === "error"); el.textContent = state === "saving" ? "Saving…" : state === "error" ? "Save failed" : lastSaved ? "Saved " + new Date(lastSaved).toLocaleTimeString() : "Saved"; }
async function afterMutation() {
  setSave("saving");
  setTimeout(async () => {
    try { const s = await api("GET", "/status"); lastSaved = s.saved.at || lastSaved; setSave(s.saved.error ? "error" : "saved"); P.counts = s.counts; renderProgress(); if (s.changed.length) banner(`These files changed outside the tool: ${s.changed.join(", ")}.`); }
    catch { setSave("error"); }
  }, 450);
}
function banner(msg) {
  $("#bannerHost")?.remove(); if (!msg) return;
  const b = document.createElement("div"); b.id = "bannerHost"; b.className = "banner"; b.innerHTML = `<span>${esc(msg)}</span><span class="spacer"></span><button class="btn tonal sm" data-act="rescan">Rescan sources</button><button class="btn text sm" data-act="dismiss">Dismiss</button>`;
  $("#doc").prepend(b);
}
function setTheme() { const t = view.theme; if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = t; $("#btnTheme").innerHTML = icon(t === "dark" ? "dark" : "light"); $("#btnTheme").title = "Theme: " + t + " (click to change)"; }
function initChrome() {
  $("#btnMenu").innerHTML = icon("menu"); $("#btnPreview").innerHTML = icon("pdf"); $("#btnState").innerHTML = icon("tune"); $("#btnAi").innerHTML = icon("ai"); $("#icSearch").innerHTML = icon("search");
  $("#prevPending").innerHTML = icon("prev") + " Previous"; $("#nextPending").innerHTML = "Next pending " + icon("next");
  $("#hideHl").checked = view.hide; $("#srcMode").checked = view.src; $("#changesOnly").checked = view.changes;
  document.body.classList.toggle("nohl", view.hide); setTheme(); applyPanels(); markMode();
  document.addEventListener("pointerdown", (e) => { const b = e.target.closest(".btn,.icon-btn,.seg button"); if (!b || b.disabled) return; const r = b.getBoundingClientRect(); const s = document.createElement("span"); const d = Math.max(r.width, r.height); s.className = "ripple"; s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`; b.appendChild(s); setTimeout(() => s.remove(), 600); });
  document.addEventListener("click", (e) => { const a = e.target.closest('a[href^="/api/build/"][target="_blank"]'); if (!a) return; e.preventDefault(); openPdf(a.getAttribute("href")); });
}
function applyPanels() { $("#drawer").classList.toggle("closed", !view.drawer); $("#ai").classList.toggle("closed", !view.ai); $("#btnAi").classList.toggle("on", view.ai); }
function markMode() { $$(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === view.mode)); }

// ---------- boot ----------
async function boot() {
  initChrome();
  await loadProject(); await loadAgents(); await loadArticle();
  renderAi();
  const first = order.find((id) => ["pending", "stale"].includes(C[id].status)) || order[0];
  const saved = store.get("cur:" + P.id, null);
  const start = order.includes(saved) ? saved : first;
  if (start) { await setActive(start); if (saved && start === saved) goto(start, "auto"); }
  onEvent(async (ev) => {
    if (ev.type === "chat" && ev.unitId === activeId) { thread = await api("GET", `/units/${activeId}/chat`); renderThread(); }
    if (ev.type === "build") renderPreviewModal(true);
  });
  window.addEventListener("focus", afterMutation); setInterval(afterMutation, 20000); afterMutation();
}
async function loadProject() {
  P = await api("GET", "/project");
  env = { macros: P.macros, bib: P.bib, labels: P.labels, katex: P.katex };
  $("#paperName").textContent = P.name;
  const b = P.baseline; $("#baselinePill").textContent = b.short ? `Git baseline ${b.short}${b.moved ? " · HEAD moved" : ""}` : "No Git baseline";
  $("#baselinePill").title = b.hash ? `${b.hash}\n${b.subject}\nFrozen ${b.frozenAt}` : "";
  if (P.note) toast(P.note);
  renderProgress(); renderAuthorControls();
}
const authorLabel = (a) => (a.name && a.name !== a.id ? `${a.name} (${a.id})` : a.id);
function authorOptions(current) {
  const list = P?.changesAuthors || [];
  const opts = [`<option value=""${current ? "" : " selected"}>Default (no author id)</option>`];
  for (const a of list) opts.push(`<option value="${esc(a.id)}"${a.id === current ? " selected" : ""}>${esc(authorLabel(a))}</option>`);
  if (current && !list.some((a) => a.id === current)) opts.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
  return opts.join("");
}
function renderAuthorControls() {
  const host = $("#authorPick"); if (!host) return;
  const show = !!(P && P.changesPackage);
  host.hidden = !show;
  if (!show) return;
  const top = $("#changesAuthorTop");
  if (top) { top.innerHTML = authorOptions(P.changesAuthor || ""); top.value = P.changesAuthor || ""; }
}
async function setChangesAuthor(id) {
  try {
    const settings = await api("PUT", "/settings", { changesAuthor: id });
    P.settings = settings; P.changesAuthor = settings.changesAuthor || "";
    renderAuthorControls();
    const sel = $("#changesAuthorState");
    if (sel) { sel.innerHTML = authorOptions(P.changesAuthor); sel.value = P.changesAuthor; }
    toast(P.changesAuthor ? `Tracked-changes author: ${P.changesAuthor}` : "Tracked-changes author: default");
  } catch (e) { toast(e.message); }
}
function renderProgress() { const c = P.counts; const done = c.decided + c.applied; $("#progFill").style.width = c.total ? (100 * done) / c.total + "%" : "0"; $("#progText").textContent = `${done} of ${c.total} decided`; }
async function loadAgents(refresh) { agentsInfo = await api("GET", "/agents" + (refresh ? "?refresh=1" : "")); }
async function loadArticle() {
  A = await api("GET", "/article"); C = A.cards;
  order = []; unitBlock = {};
  A.blocks.forEach((b, i) => { for (const id of unitsOf(b)) { order.push(id); unitBlock[id] = i; } });
  for (const id of A.orphans || []) order.push(id);
  renderDoc(); renderOutline(); renderFilters();
}
const unitsOf = (b) => (b.t === "para" ? b.items.filter((x) => x.t === "unit").map((x) => x.id) : b.t === "aux" ? b.units : []);

// ---------- matching and filters ----------
const FILTERS = [["all", "All"], ["pending", "Pending"], ["decided", "Decided"], ["stale", "Re-review"], ["applied", "Applied"], ["edited", "Edited"], ["differs", "Differs from Git"]];
function cardMatch(c) {
  if (!c) return false;
  if (filter === "edited" && !(c.original.edited || c.proposed.edited)) return false;
  if (filter === "differs" && !["differs", "missing", "ambiguous", "loose"].includes(c.provenance)) return false;
  if (["pending", "decided", "stale", "applied", "detached"].includes(filter) && c.status !== filter) return false;
  if (query && !(c.original.text + " " + c.proposed.text).toLowerCase().includes(query.toLowerCase())) return false;
  return true;
}
const filtering = () => filter !== "all" || !!query;
function renderFilters() { $("#filters").innerHTML = FILTERS.map(([k, l]) => `<button class="chip ${filter === k ? "on" : ""}" data-filter="${k}">${l}</button>`).join(""); }

// ---------- article ----------
function renderDoc() {
  const token = ++renderToken; const doc = $("#doc"); const anchor = firstVisibleBlock();
  doc.innerHTML = ""; blockEls = [];
  const queue = []; let i = 0;
  while (i < A.blocks.length) {
    const b = A.blocks[i];
    if (b.t !== "heading" && hiddenBlock(b)) { const from = i; while (i < A.blocks.length && A.blocks[i].t !== "heading" && hiddenBlock(A.blocks[i])) i++; queue.push({ gap: [from, i] }); continue; }
    queue.push({ i }); i++;
  }
  let k = 0;
  const one = () => { const q = queue[k++]; doc.appendChild(q.gap ? gapEl(q.gap) : blockEl(q.i)); };
  const pump = () => {
    if (token !== renderToken) return;
    const stop = Math.min(queue.length, k + 14);
    while (k < stop) one();
    if (k < queue.length) setTimeout(pump, 0); else finish();
  };
  const finish = () => { highlightActive(); if (anchor != null && blockEls[anchor]) scrollToEl(blockEls[anchor], "start", "instant"); updateSpy(); };
  pumpAll = () => { if (token !== renderToken) return; while (k < queue.length) one(); if (k >= queue.length) finish(); };
  pump();
}
function hiddenBlock(b) {
  const ids = unitsOf(b);
  if (filtering()) return !ids.some((id) => cardMatch(C[id]));
  if (view.changes) return ids.length === 0;
  return false;
}
function gapEl(range) {
  const d = document.createElement("div"); d.className = "gap"; d._range = range; const n = range[1] - range[0];
  d.textContent = `${n} paragraph${n === 1 ? "" : "s"} without matches · click to show`;
  d.onclick = () => { const frag = document.createDocumentFragment(); for (let j = range[0]; j < range[1]; j++) frag.appendChild(blockEl(j)); d.replaceWith(frag); };
  return d;
}
function firstVisibleBlock() { for (let j = 0; j < blockEls.length; j++) { const el = blockEls[j]; if (el && el.isConnected && el.getBoundingClientRect().bottom > 120) return j; } return null; }

function blockEl(i) {
  const b = A.blocks[i]; let el;
  if (b.t === "heading") {
    el = document.createElement("h2"); el.className = `h l${Math.min(b.level || 1, 4)}`; el.id = "h-" + b.idx; el.dataset.h = b.idx; el.innerHTML = R(b.title);
  } else if (b.t === "aux") {
    el = document.createElement("details"); el.className = "aux";
    el.innerHTML = `<summary>${icon(b.kind === "Table" ? "db" : "folder")}<b>${esc(b.kind)}</b><span>${esc(b.caption || "Read-only LaTeX block").slice(0, 140)}</span><span class="spacer"></span><span class="small">${esc(b.file)}:${b.line}</span></summary>${b.units.length ? '<div class="cards"></div>' : ""}<pre>${esc(b.src)}</pre>`;
    const host = $(".cards", el); if (host) for (const id of b.units) host.appendChild(unitNode(id));
    if (b.units.length) el.open = true;
  } else {
    el = document.createElement("section"); el.className = "para";
    let html = "";
    const flush = () => { if (html) { const p = document.createElement("p"); p.className = "run"; p.innerHTML = html; el.appendChild(p); html = ""; } };
    for (const it of b.items) {
      if (it.t === "text") html += it.pieces.map((p) => (p.start != null ? `<span class="sent" data-f="${esc(b.file)}" data-s="${p.start}" data-e="${p.end}" data-sha="${b.fileSha}">${R(p.text)}</span>` : R(p.text))).join("");
      else { const n = unitNode(it.id); if (n.tagName === "ARTICLE") { flush(); el.appendChild(n); } else html += n.outerHTML; }
    }
    flush();
  }
  el.dataset.i = i; blockEls[i] = el; return el;
}
function unitNode(id) {
  const c = C[id];
  if (!c) { const s = document.createElement("span"); s.textContent = "[missing unit]"; return s; }
  const card = (view.mode === "compare" && (!filtering() || cardMatch(c))) || forceCard.has(id);
  if (card && !collapsed.has(id)) return cardEl(id);
  const s = document.createElement("span"); s.className = `u-inline st-${c.status}${collapsed.has(id) ? " collapsed" : ""}`; s.dataset.id = id; s.dataset.unit = id;
  s.innerHTML = R(finalText(c)) || "<i>(removed)</i>";
  s.title = collapsed.has(id)
    ? `Collapsed · ${c.status}${c.decision ? " · " + c.decision.choice : ""}. Click to expand`
    : `${c.status}${c.decision ? " · " + c.decision.choice : ""}. Click to compare`;
  return s;
}
const finalText = (c) => (c.status === "applied" && c.applied ? c.applied.text : c.decision && ["decided", "stale"].includes(c.status) ? c.decision.text : c.proposed.text);

// ---------- card ----------
function cardEl(id) {
  const el = document.createElement("article"); el.className = "ucard"; el.id = "u-" + id; el.dataset.id = id; el.dataset.unit = id;
  el.innerHTML = `<header class="c-head"></header><div class="c-cmp"></div><div class="c-custom" hidden></div><footer class="c-act"></footer><div class="c-edit"></div>`;
  fillCard(el); return el;
}
const provPill = (c) => ({ exact: ["ok", "Verbatim in Git"], loose: ["ok", "In Git (spacing differs)"], differs: ["warn", "Differs from Git"], ambiguous: ["warn", "Several Git matches"], missing: ["warn", "Not in Git"], new: ["pri", "New text"], none: ["", "No Git baseline"] }[c.provenance] || ["", c.provenance]);
function fillCard(el) {
  const id = el.dataset.id, c = C[id]; if (!c) return;
  el.className = `ucard st-${c.status}${activeId === id ? " active" : ""}${openEd.has(id) ? " editing" : ""}`;
  const [pc, pl] = provPill(c);
  const sp = { pending: ["", "Pending"], decided: ["ok", "Using " + (c.choice || "")], stale: ["bad", "Re-review"], applied: ["pri", "Applied"], detached: ["", "Detached"] }[c.status];
  $(".c-head", el).innerHTML = `<span class="pill ${sp[0]}">${c.status === "decided" ? icon("check") : c.status === "stale" ? icon("warn") : ""}${esc(sp[1])}</span>
    <span class="pill">${{ replace: "Replacement", add: "Addition", delete: "Deletion", manual: "Unmarked text" }[c.kind]}</span>
    <span class="pill ${pc}" title="${esc(c.baseline?.note || "")}">${esc(pl)}</span>
    ${c.original.edited ? '<span class="pill warn">original edited</span>' : ""}${c.proposed.edited ? '<span class="pill warn">proposed edited</span>' : ""}${c.comments.length ? `<span class="pill">${icon("comment")}${c.comments.length}</span>` : ""}
    <span class="loc">${esc(c.file)}:${c.line ?? "?"}</span>${c.sourceChangedInfo ? '<button class="btn tonal sm" data-act="takesource">Source changed. Use it</button>' : ""}
    <button class="icon-btn sm" data-act="collapse" title="Collapse this change" aria-label="Collapse this change">${icon("collapse")}</button>`;
  const ops = wordDiff(c.original.text, c.proposed.text);
  const col = (k) => {
    const x = c[k], isO = k === "original", empty = !x.text.trim();
    const body = empty ? `<div class="read empty">${isO ? "No previous text. This is an addition." : "Text removed in this revision."}</div>` : view.src ? `<div class="mono">${esc(x.text)}</div>` : `<div class="read">${diffHtml(ops, isO ? "del" : "ins", env, view.hide)}</div>`;
    const chosen = c.decision?.choice === k && ["decided", "stale"].includes(c.status);
    return `<div class="col ${isO ? "orig" : "prop"}${chosen ? " chosen" : ""}"><div class="lbl">${isO ? "Original wording" : "Proposed wording"}${x.edited ? '<span class="pill warn">edited</span>' : ""}${chosen ? `<span class="pill pri">${icon("check")}chosen</span>` : ""}</div>${body}</div>`;
  };
  $(".c-cmp", el).innerHTML = col("original") + col("proposed");
  const cu = $(".c-custom", el); const showCustom = c.decision?.choice === "custom" || c.custom.touched;
  cu.hidden = !showCustom; if (showCustom) cu.innerHTML = `<div class="lbl small"><b>Custom final wording</b>${c.decision?.choice === "custom" ? " · chosen" : ""}</div><div class="read">${view.src ? esc(c.custom.text) : R(c.custom.text)}</div>`;
  const ch = c.decision?.choice, ok = !["applied", "detached"].includes(c.status), dec = c.status === "decided";
  $(".c-act", el).innerHTML = `
    <button class="btn tonal ${ch === "original" && dec ? "chosen" : ""}" data-act="use" data-k="original" ${ok ? "" : "disabled"}>${ch === "original" && dec ? icon("check") : ""}Use original</button>
    <button class="btn tonal ${ch === "proposed" && dec ? "chosen" : ""}" data-act="use" data-k="proposed" ${ok ? "" : "disabled"}>${ch === "proposed" && dec ? icon("check") : ""}Use proposed</button>
    <button class="btn tonal ${ch === "custom" && dec ? "chosen" : ""}" data-act="custom" ${ok ? "" : "disabled"}>${ch === "custom" && dec ? icon("check") : ""}Custom…</button>
    <span class="sp"></span>
    <button class="btn text sm" data-act="pending" ${c.decision && ok ? "" : "disabled"}>Leave pending</button>
    <button class="icon-btn sm" data-act="undodec" title="Undo last decision" ${c.canUndoDecision ? "" : "disabled"}>${icon("undo")}</button>
    <button class="icon-btn sm ${openEd.has(id) ? "on" : ""}" data-act="edit" title="Edit both wordings">${icon("edit")}</button>
    <button class="icon-btn sm ${activeId === id && view.ai ? "on" : ""}" data-act="ai" title="Ask an AI about this unit">${icon("ai")}</button>`;
  if (openEd.has(id)) fillEditor(el);
}
function fillEditor(el) {
  const id = el.dataset.id, c = C[id], host = $(".c-edit", el);
  const tb = (k, label) => {
    const x = c[k];
    return `<b>${label}</b>${k !== "custom" ? (x.edited ? '<span class="pill warn">edited, not the Git text</span>' : '<span class="pill">as imported</span>') : ""}<span class="spacer"></span>
      <button class="icon-btn sm" data-act="undo" data-k="${k}" title="Undo" ${x.canUndo ? "" : "disabled"}>${icon("undo")}</button>
      <button class="icon-btn sm" data-act="redo" data-k="${k}" title="Redo" ${x.canRedo ? "" : "disabled"}>${icon("redo")}</button>
      <button class="icon-btn sm" data-act="restore" data-k="${k}" title="Restore the imported text" ${k !== "custom" && x.edited ? "" : "disabled"}>${icon("restore")}</button>`;
  };
  if (!host.dataset.built) {
    host.dataset.built = "1";
    host.innerHTML = `<div class="ed-grid"><div class="ed" data-k="original"><div class="tb"></div><textarea class="tx" data-edit="original" spellcheck="true" aria-label="Original wording"></textarea></div>
      <div class="ed" data-k="proposed"><div class="tb"></div><textarea class="tx" data-edit="proposed" spellcheck="true" aria-label="Proposed wording"></textarea></div></div>
      <div class="ed" data-k="custom" style="margin-top:12px"><div class="tb"></div><div class="rowf small" style="margin-bottom:4px"><button class="btn text sm" data-act="seedcustom" data-k="original">Start from original</button><button class="btn text sm" data-act="seedcustom" data-k="proposed">Start from proposed</button><span class="spacer"></span><button class="btn tonal sm" data-act="use" data-k="custom">Use custom wording</button></div>
      <textarea class="tx" data-edit="custom" style="min-height:80px" spellcheck="true" aria-label="Custom final wording"></textarea></div><div class="base-host"></div>`;
  }
  $$(".ed", host).forEach((ed) => { const k = ed.dataset.k; $(".tb", ed).innerHTML = tb(k, { original: "Original wording", proposed: "Proposed wording", custom: "Custom final wording" }[k]); const ta = $("textarea", ed); if (document.activeElement !== ta && ta.value !== c[k].text) ta.value = c[k].text; });
  const b = c.baseline;
  $(".base-host", host).innerHTML = b ? `<details class="base" ${["differs", "ambiguous", "missing"].includes(b.status) ? "open" : ""}><summary>Git baseline (read-only) · ${esc(provPill(c)[1])} ${b.file ? `· ${esc(b.file)}:${b.line} at ${esc(c.baselineCommit)}` : ""}</summary><p class="small muted">${esc(b.note || "")}</p>${b.text ? (view.src ? `<div class="mono">${esc(b.text)}</div>` : `<div class="read">${diffHtml(wordDiff(b.text, c.original.text), "del", env, view.hide)}</div><div class="small muted">Highlights show where the Git text differs from the original wording above.</div>`) : ""}</details>` : "";
}
function refreshUnit(id) {
  $$(`[data-unit="${cssId(id)}"]`).forEach((el) => {
    if (el.classList.contains("ucard") && !collapsed.has(id)) fillCard(el);
    else el.replaceWith(unitNode(id));
  });
  renderOutline(); renderProgress();
}
function setCard(id, d) { C[id] = d; refreshUnit(id); if (id === activeId) renderAiHead(); }

// ---------- outline and navigation ----------
function renderOutline() {
  if (!A) return;
  const per = {}; let h = -1;
  A.blocks.forEach((b) => { if (b.t === "heading") { h = b.idx; per[h] ||= { p: 0, n: 0 }; } else for (const id of unitsOf(b)) { const k = (per[h] ||= { p: 0, n: 0 }); k.n++; if (["pending", "stale"].includes(C[id]?.status)) k.p++; } });
  $("#outline").innerHTML = A.headings.map((x) => { const k = per[x.idx] || { p: 0, n: 0 }; return `<div class="o-item l${Math.min(x.level || 1, 3)}" data-h="${x.idx}"><span class="t">${esc(x.title)}</span>${k.n ? `<span class="badge-n ${k.p ? "" : "done"}">${k.p ? k.p : "✓"}</span>` : ""}</div>`; }).join("");
  updateSpy();
}
function updateSpy() {
  let cur = null;
  for (const e of $$(".h")) { if (e.getBoundingClientRect().top <= 140) cur = e.dataset.h; else break; }
  $$(".o-item").forEach((o) => o.classList.toggle("cur", o.dataset.h === cur));
}
let spyTick = false; $("#article").addEventListener("scroll", () => { if (spyTick) return; spyTick = true; setTimeout(() => { spyTick = false; updateSpy(); }, 80); });
function findUnitEl(id) { return $(`#u-${cssId(id)}`) || $(`[data-unit="${cssId(id)}"]`); }
function goto(id, behavior = "smooth") {
  pumpAll?.();
  let el = findUnitEl(id);
  if (!el) { const bi = unitBlock[id]; const gap = $$(".gap").find((g) => g._range && g._range[0] <= bi && bi < g._range[1]); if (gap) { gap.click(); el = findUnitEl(id); } }
  if (!el) { toast("That unit is hidden by the current filter."); return; }
  scrollToEl(el, "center", behavior); setActive(id);
}
function stepPending(dir) {
  const ids = order.filter((id) => ["pending", "stale"].includes(C[id]?.status));
  if (!ids.length) return toast("Nothing left to decide.");
  const pos = order.indexOf(activeId);
  const seq = dir > 0 ? order.slice(pos + 1).concat(order.slice(0, pos + 1)) : order.slice(0, Math.max(pos, 0)).reverse().concat(order.slice(Math.max(pos, 0)).reverse());
  goto(seq.find((id) => ids.includes(id) && id !== activeId) || ids[0]);
}

// ---------- delegated events ----------
document.addEventListener("change", async (e) => {
  if (e.target.id === "changesAuthorTop" || e.target.id === "changesAuthorState") await setChangesAuthor(e.target.value);
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.matches?.("textarea[data-edit]")) {
    const id = t.closest(".ucard").dataset.id, k = t.dataset.edit;
    debounce("e" + id + k, async () => {
      try { setSave("saving"); setCard(id, await api("PUT", `/units/${id}/candidate/${k}`, { text: t.value, baseVersion: C[id][k].versionId })); afterMutation(); }
      catch (er) { if (er.status === 409) { toast("This wording changed elsewhere. Reloaded the latest."); setCard(id, await api("GET", `/units/${id}`)); t.value = C[id][k].text; } else toast("Save failed: " + er.message); }
    }, 600);
  }
  if (t.id === "search") debounce("q", () => { query = t.value.trim(); renderDoc(); }, 250);
});
async function run(id, fn, undoLabel) {
  try { setSave("saving"); const d = await fn(); setCard(id, d); afterMutation(); if (undoLabel) toast(undoLabel, "Undo", () => undoDecision(id)); }
  catch (e) { toast(e.message); }
}
function undoDecision(id) {
  return run(id, async () => {
    const d = await api("POST", `/units/${id}/decision/undo`);
    collapsed.delete(id); forceCard.add(id);
    return d;
  });
}
document.addEventListener("click", async (e) => {
  const t = e.target;
  const pop = $("#pop"); if (!pop.hidden && !t.closest("#pop")) pop.hidden = true;
  const f = t.closest("[data-filter]"); if (f) { filter = f.dataset.filter; store.set("filter", filter); renderFilters(); renderDoc(); return; }
  const o = t.closest(".o-item"); if (o) { pumpAll?.(); { const h = $("#h-" + o.dataset.h); if (h) scrollToEl(h, "start"); } if (innerWidth <= 1000) { view.drawer = false; applyPanels(); } return; }
  const sent = t.closest(".sent");
  if (sent) {
    const r = sent.getBoundingClientRect(); pop.hidden = false; pop.style.left = Math.min(r.left, innerWidth - 260) + "px"; pop.style.top = Math.min(r.bottom + 6, innerHeight - 60) + "px";
    pop.innerHTML = `<button class="btn tonal sm" id="popGo">${icon("edit")}Review this sentence</button>`;
    $("#popGo").onclick = async () => { pop.hidden = true; try { const r2 = await api("POST", "/units/manual", { file: sent.dataset.f, fileSha: sent.dataset.sha, start: +sent.dataset.s, end: +sent.dataset.e }); await loadProject(); await loadArticle(); goto(r2.id, "auto"); } catch (er) { toast(er.message); } };
    return;
  }
  const inl = t.closest(".u-inline"); if (inl) { const id = inl.dataset.id; collapsed.delete(id); forceCard.add(id); inl.replaceWith(unitNode(id)); setActive(id); return; }
  const card = t.closest(".ucard"); if (card && !t.closest("button,textarea,a,summary") && card.dataset.id !== activeId) setActive(card.dataset.id);
  const b = t.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, k = b.dataset.k, id = b.closest(".ucard")?.dataset.id;
  if (id && id !== activeId) setActive(id);
  const acts = {
    use: () => run(id, async () => {
      const d = await api("PUT", `/units/${id}/decision`, { choice: k });
      collapsed.add(id); forceCard.delete(id);
      return d;
    }, `Decided: ${k} wording for this unit`),
    custom: () => { if (!C[id].custom.touched && !C[id].decision) { openEd.add(id); fillCard(findUnitEl(id)); $(`#u-${cssId(id)} textarea[data-edit=custom]`)?.focus(); } else run(id, () => api("PUT", `/units/${id}/decision`, { choice: "custom" }), "Decided: custom wording"); },
    pending: () => run(id, () => api("PUT", `/units/${id}/decision`, { choice: "pending" })),
    undodec: () => undoDecision(id),
    collapse: () => { collapsed.add(id); forceCard.delete(id); refreshUnit(id); },
    undo: () => run(id, () => api("POST", `/units/${id}/candidate/${k}/undo`)),
    redo: () => run(id, () => api("POST", `/units/${id}/candidate/${k}/redo`)),
    restore: () => run(id, () => api("POST", `/units/${id}/candidate/${k}/restore`)),
    takesource: () => run(id, () => api("POST", `/units/${id}/take-source`)),
    seedcustom: () => run(id, () => api("PUT", `/units/${id}/candidate/custom`, { text: C[id][k].text })),
    edit: () => { openEd.has(id) ? openEd.delete(id) : openEd.add(id); const el = findUnitEl(id); fillCard(el); if (openEd.has(id)) $("textarea[data-edit=proposed]", el)?.focus(); },
    ai: () => { view.ai = true; store.set("ai", true); applyPanels(); refreshUnit(id); $("#aiText")?.focus(); },
    rescan: async () => { await api("POST", "/rescan"); await loadProject(); await loadArticle(); },
    dismiss: () => banner(""),
    close: () => closeModal(),
  };
  acts[a]?.();
});
$(".seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-mode]"); if (!b) return; view.mode = b.dataset.mode; store.set("mode", view.mode); forceCard.clear(); markMode(); renderDoc(); });
$("#hideHl").onchange = (e) => { view.hide = e.target.checked; store.set("hide", view.hide); document.body.classList.toggle("nohl", view.hide); renderDoc(); renderThread(); };
$("#srcMode").onchange = (e) => { view.src = e.target.checked; store.set("src", view.src); renderDoc(); };
$("#changesOnly").onchange = (e) => { view.changes = e.target.checked; store.set("changes", view.changes); renderDoc(); };
$("#btnMenu").onclick = () => { view.drawer = !view.drawer; store.set("drawer", view.drawer); applyPanels(); };
$("#btnAi").onclick = () => { view.ai = !view.ai; store.set("ai", view.ai); applyPanels(); };
$("#btnTheme").onclick = () => { view.theme = { auto: "light", light: "dark", dark: "auto" }[view.theme]; store.set("theme", view.theme); setTheme(); };
$("#btnApply").onclick = () => openApply(); $("#btnPreview").onclick = () => renderPreviewModal(); $("#btnState").onclick = () => openState();
$("#prevPending").onclick = () => stepPending(-1); $("#nextPending").onclick = () => stepPending(1);
document.addEventListener("keydown", (e) => {
  const typing = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === "Escape") { closeModal(); $("#pop").hidden = true; }
  if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); stepPending(1); }
  if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); stepPending(-1); }
  if (!typing && !e.ctrlKey && !e.metaKey && $("#modal").hidden) { if (e.key === "j") stepPending(1); if (e.key === "k") stepPending(-1); if (e.key === "/") { e.preventDefault(); $("#search").focus(); } }
});

function highlightActive() { $$(".ucard.active").forEach((e) => e.classList.remove("active")); if (activeId) $(`#u-${cssId(activeId)}`)?.classList.add("active"); }
async function setActive(id) {
  if (!C[id]) return; activeId = id; store.set("cur:" + P.id, id); highlightActive(); renderAiHead();
  thread = await api("GET", `/units/${id}/chat`).catch(() => []); renderThread();
}

// ---------- modals ----------
function openModal(html) { $("#modalBody").innerHTML = html; $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; $("#modalBody").innerHTML = ""; }
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

async function openApply(mode = "clean") {
  openModal(`<h2>Apply reviewed changes</h2><p class="muted">Computing preview…</p>`);
  try {
    const p = await api("POST", "/apply/preview", { mode });
    const patches = p.patches.map((x) => `<div class="patch"><div class="small muted">${esc(x.file)}:${x.line} · decision: ${esc(x.choice)}</div><div class="small muted">Source now</div><div class="mono del">${esc(x.before)}</div><div class="small muted">Source after applying</div><div class="mono ins">${x.text ? esc(x.text) : "(text removed)"}</div></div>`).join("") || `<p class="muted">No decided units to apply yet.</p>`;
    openModal(`<h2>Apply reviewed changes</h2>
      <div class="rowf" style="gap:16px;flex-wrap:wrap"><label><input type="radio" name="mode" value="clean" ${mode === "clean" ? "checked" : ""}> Clean text (markup removed for decided units)</label>
      <label><input type="radio" name="mode" value="tracked" ${mode === "tracked" ? "checked" : ""}> Tracked (regenerate \\replaced against the Git baseline)</label></div>
      <p class="small muted">Only decided units are written. ${p.skipped.pending} pending and ${p.skipped.stale} to re-review keep their source and markup. Files touched: ${p.files.map((f) => esc(f.rel)).join(", ") || "none"}. A checkpoint is saved first.</p>
      ${p.conflicts.length ? `<div class="banner">${p.conflicts.map((c) => esc(c.unitId + ": " + c.reason)).join("<br>")}</div>` : ""}${patches}
      <p class="rowf" style="margin-top:16px"><button class="btn filled" data-apply="${p.token}" ${p.patches.length ? "" : "disabled"}>Apply ${p.patches.length} change${p.patches.length === 1 ? "" : "s"}</button><button class="btn text" data-act="close">Cancel</button><span class="spacer"></span><button class="btn tonal" id="btnCheckpoints">Checkpoints and undo</button></p>`);
    $$('input[name="mode"]').forEach((r) => (r.onchange = () => openApply(r.value)));
    $("[data-apply]")?.addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try { await api("POST", "/apply", { token: ev.target.dataset.apply }); closeModal(); toast("Applied. A checkpoint was saved.", "Checkpoints", openCheckpoints, 10000); await loadProject(); await loadArticle(); }
      catch (er) { closeModal(); toast(er.message); }
    });
    $("#btnCheckpoints")?.addEventListener("click", openCheckpoints);
  } catch (e) { openModal(`<h2>Apply reviewed changes</h2><p>${esc(e.message)}</p><button class="btn tonal" data-act="close">Close</button>`); }
}
async function openCheckpoints() {
  const list = await api("GET", "/checkpoints");
  openModal(`<h2>Checkpoints</h2><table class="t"><tr><th>When</th><th>Units</th><th>Files</th><th></th></tr>${list.map((c) => `<tr><td>${esc(c.ts)}</td><td>${c.units.length}</td><td>${esc(Object.keys(c.files).join(", "))}</td><td>${c.undone ? "undone" : `<button class="btn tonal sm" data-undo="${c.id}">Undo this application</button>`}</td></tr>`).join("") || "<tr><td colspan=4 class=muted>None yet.</td></tr>"}</table><p><button class="btn text" data-act="close">Close</button></p>`);
  $$("[data-undo]").forEach((b) => (b.onclick = async () => {
    const done = async () => { closeModal(); toast("Restored the files from the checkpoint."); await loadProject(); await loadArticle(); };
    try { await api("POST", `/checkpoints/${b.dataset.undo}/undo`, {}); await done(); }
    catch (e) { if (e.status === 409 && confirm(e.message + "\n\nRestore anyway and discard the newer edits to those files?")) { await api("POST", `/checkpoints/${b.dataset.undo}/undo`, { force: true }); await done(); } else if (e.status !== 409) toast(e.message); }
  }));
}
const jobs = {};
function renderPreviewModal(onlyIfOpen) {
  if (onlyIfOpen && $("#modal").hidden) return;
  const rows = Object.values(jobs).map((j) => `<tr><td>${j.view}</td><td>${j.source === "decisions" ? "with my decisions" : "current files"}</td><td>${j.status === "running" ? '<span class="spin"></span> building…' : j.status === "done" ? `<a href="${j.pdf}" target="_blank">open PDF</a> · ${j.pages ?? "?"} pages` : '<span class="pill bad">failed</span>'}</td>
    <td class="small">${j.status !== "running" ? `undefined refs ${(j.undefinedRefs || []).length}, cites ${(j.undefinedCites || []).length}${(j.undefinedRefs || []).length ? " (" + esc(j.undefinedRefs.join(", ")) + ")" : ""}${j.errors?.length ? "<br>" + esc(j.errors.join(" ")) : ""}${j.error ? "<br>" + esc(j.error) : ""}` : ""}</td></tr>`).join("");
  openModal(`<h2>PDF previews</h2><p class="small muted">Built in the tool's own staging folder with latexmk. Nothing is written to the paper folder.</p>
    <div class="rowf" style="flex-wrap:wrap"><button class="btn tonal" data-build="tracked:working">Tracked, current files</button><button class="btn tonal" data-build="clean:working" ${P.cleanSwitch ? "" : "disabled"}>Clean, current files</button>
    <button class="btn tonal" data-build="tracked:decisions">Tracked, with my decisions</button><button class="btn tonal" data-build="clean:decisions" ${P.cleanSwitch ? "" : "disabled"}>Clean, with my decisions</button></div>
    <table class="t" style="margin-top:12px"><tr><th>View</th><th>Source</th><th>Result</th><th>Log</th></tr>${rows}</table><p><button class="btn text" data-act="close">Close</button></p>`);
  $$("[data-build]").forEach((b) => (b.onclick = async () => { const [v, s] = b.dataset.build.split(":"); const j = await api("POST", "/build", { view: v, source: s }); jobs[j.id] = j; renderPreviewModal(); poll(j.id); }));
}
async function poll(id) { const j = await api("GET", `/build/${id}`); jobs[id] = j; if (j.status === "running") setTimeout(() => poll(id), 2000); else renderPreviewModal(true); }
function openState() {
  openModal(`<h2>Review state</h2>
    ${P.changesPackage ? `<p class="rowf" style="flex-wrap:wrap;gap:8px;align-items:flex-end"><label class="field" style="min-width:260px"><span>Tracked-changes author</span><select id="changesAuthorState" class="sel">${authorOptions(P.changesAuthor)}</select></label><span class="small muted">Defined by <code>\\definechangesauthor</code> in the paper.</span></p>` : ""}
    <p class="small muted">Review state lives in the tool's own folder, outside the paper. Export it to move a review to another machine.</p>
    <p class="rowf" style="flex-wrap:wrap;gap:12px"><button class="btn tonal" id="btnExport">Export review state</button><label class="btn tonal">Import<input type="file" id="importFile" accept=".json" hidden></label><label class="small"><input type="checkbox" id="importReplace"> replace existing decisions</label></p>
    <p class="rowf" style="flex-wrap:wrap;gap:12px"><button class="btn tonal" id="btnInstr">Writing instructions…</button><button class="btn tonal" id="btnRebase" ${P.baseline.moved ? "" : "disabled"} title="Freeze a new baseline at the current Git HEAD">Re-freeze baseline at HEAD</button></p>
    <p class="small muted">Project ${esc(P.id)}. Snapshot: ${P.snapshot ? P.snapshot.files + " files, " + P.snapshot.ts : "none"}.</p><p><button class="btn text" data-act="close">Close</button></p>`);
  $("#btnExport").onclick = () => exportState();
  $("#importFile").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const r = await api("POST", "/import", { data: JSON.parse(await f.text()), replace: $("#importReplace").checked }); closeModal(); toast(`Imported ${r.imported} units.`); await loadArticle(); } catch (er) { toast(er.message); } };
  $("#btnInstr").onclick = openInstructions;
  $("#btnRebase").onclick = async () => { if (confirm("Freeze a new baseline at the current HEAD? Git matching is recomputed.")) { await api("POST", "/baseline/rebase"); closeModal(); await loadProject(); await loadArticle(); } };
}
async function openInstructions() {
  const i = await api("GET", "/instructions");
  openModal(`<h2>Writing instructions for the AI</h2><p class="small muted">Sent with every question. They apply to this paper only. Paper-specific rules belong here, not in the tool.</p><textarea class="tx" id="instrText" style="min-height:300px">${esc(i.text)}</textarea><p class="rowf" style="margin-top:12px"><button class="btn filled" id="saveInstr">Save</button><button class="btn text" data-act="close">Cancel</button></p>`);
  $("#saveInstr").onclick = async () => { await api("PUT", "/instructions", { text: $("#instrText").value }); closeModal(); toast("Instructions saved."); };
}

// ---------- AI panel ----------
const QUICK = ["Keep the original meaning, but split this into two sentences.", "I prefer the original explanation. Make only its last clause clearer.", "Combine the first sentence on the left with the second on the right.", "Why was this revised? Does the proposed wording change the claim?", "Check this passage for ambiguity, unsupported claims and repeated wording."];
const curAgent = () => $("#aiAgent")?.value;
function modelOptions(agentId) {
  const a = agentsInfo.agents.find((x) => x.id === agentId); const list = [...(a?.models || [{ id: "", label: "Default" }])];
  const chosen = store.get("model:" + agentId, agentsInfo.defaultModels?.[agentId] ?? "");
  if (chosen && !list.some((m) => m.id === chosen)) list.push({ id: chosen, label: chosen + " (custom)" });
  return `${list.map((m) => `<option value="${esc(m.id)}" ${m.id === chosen ? "selected" : ""}>${esc(m.label)}</option>`).join("")}<option value="__custom">Other model name…</option>`;
}
function renderAi() {
  const ai = $("#ai"); if (!agentsInfo) return;
  const sel = store.get("agent", agentsInfo.defaultAgent || (agentsInfo.agents.find((a) => a.usable) || {}).id);
  const opts = agentsInfo.agents.map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""} ${a.usable ? "" : "disabled"}>${esc(a.label)}${a.usable ? (a.status === "verified" ? "" : " (not verified)") : a.found ? " (unavailable)" : " (not installed)"}</option>`).join("");
  ai.innerHTML = `<div class="ai-top"><div class="ttl">${icon("ai")} Ask an AI</div><div class="unit" id="aiUnit"></div>
      <div class="rowf"><select class="sel" id="aiAgent" aria-label="Agent">${opts}</select><select class="sel" id="aiModel" aria-label="Model">${modelOptions(sel)}</select></div>
      <div class="small muted" id="aiVia"></div>
      <div class="rowf small"><label><input type="checkbox" id="aiWide"> Whole manuscript</label><span class="spacer"></span><button class="btn text sm" id="aiDefault" title="Use this agent and model by default for every paper on this machine">Set as default</button><button class="btn text sm" id="aiRefresh">Re-detect</button><button class="btn text sm" id="aiInstr">Instructions</button></div></div>
    <div class="ai-body" id="aiBody"></div>
    <div class="ai-foot"><div class="quick" id="aiQuick">${QUICK.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div><textarea id="aiText" placeholder="Message to the agent about this unit. Ctrl+Enter sends."></textarea>
      <div class="rowf"><button class="btn filled" id="aiSend">${icon("send")}Send</button><button class="btn tonal" id="aiComment" title="Save as a comment without asking the agent">Add as comment</button></div></div>`;
  const syncVia = () => { const a = agentsInfo.agents.find((x) => x.id === $("#aiAgent").value); $("#aiVia").textContent = a ? `${a.via}${a.version ? " · " + a.version : ""}` : ""; };
  $("#aiAgent").onchange = (e) => { store.set("agent", e.target.value); $("#aiModel").innerHTML = modelOptions(e.target.value); syncVia(); };
  $("#aiModel").onchange = (e) => { let v = e.target.value; if (v === "__custom") { v = (prompt("Model name to pass to the agent:") || "").trim(); if (!v) { $("#aiModel").innerHTML = modelOptions(curAgent()); return; } } store.set("model:" + curAgent(), v); $("#aiModel").innerHTML = modelOptions(curAgent()); };
  $("#aiDefault").onclick = async () => { await api("PUT", "/settings", { defaultAgent: curAgent(), defaultModel: $("#aiModel").value }); agentsInfo.defaultAgent = curAgent(); agentsInfo.defaultModels = { ...(agentsInfo.defaultModels || {}), [curAgent()]: $("#aiModel").value }; toast("Saved as the shared default for this machine."); };
  $("#aiRefresh").onclick = async () => { await loadAgents(true); renderAi(); };
  $("#aiInstr").onclick = openInstructions; $("#aiSend").onclick = sendAi; $("#aiComment").onclick = addComment;
  $("#aiText").addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "Enter") sendAi(); });
  $("#aiQuick").onclick = (e) => { const b = e.target.closest("[data-q]"); if (b) { $("#aiText").value = b.dataset.q; $("#aiText").focus(); } };
  syncVia(); renderAiHead(); renderThread();
}
function renderAiHead() {
  const el = $("#aiUnit"); if (!el) return; const c = C[activeId];
  el.innerHTML = c ? `${esc(c.section)} · ${esc(c.file)}:${c.line ?? "?"}<br><i>${esc(c.preview)}</i>` : "Select a unit, or press the sparkle button on a card.";
}
async function sendAi() {
  const text = $("#aiText").value.trim(); if (!text || !activeId) return toast("Select a unit first.");
  if (!curAgent()) return toast("No usable agent. Run the doctor command to see what is missing.");
  try { await api("POST", `/units/${activeId}/chat`, { text, agent: curAgent(), model: $("#aiModel").value || undefined, wide: $("#aiWide").checked }); $("#aiText").value = ""; thread = await api("GET", `/units/${activeId}/chat`); renderThread(); } catch (e) { toast(e.message); }
}
async function addComment() {
  const text = $("#aiText").value.trim(); if (!text || !activeId) return;
  setCard(activeId, await api("POST", `/units/${activeId}/comments`, { author: "me", text })); $("#aiText").value = ""; renderThread();
}
const proseOf = (t) => esc(t).replace(/```proposal[^\n]*\n[\s\S]*?```/g, "<i>[proposal shown below]</i>");
function renderThread() {
  const body = $("#aiBody"); if (!body) return; const c = C[activeId];
  if (!c) { body.innerHTML = `<div class="muted small">Choose a unit to start. Replies and proposals stay with the unit. Ordinary chat never changes the manuscript.</div>`; return; }
  const comments = c.comments.map((x) => `<div class="comment ${x.author === "ai" ? "ai" : ""}"><b>${esc(x.author)}</b>: ${esc(x.text)} <button class="icon-btn sm" data-delc="${x.id}" title="Delete">${icon("close")}</button></div>`).join("");
  const msgs = thread.filter((m) => !m.superseded).map((m) => {
    if (m.role === "user") return `<div class="msg user"><div class="who">You</div>${esc(m.text)}</div>`;
    const st = m.status === "running" ? '<span class="spin"></span> answering…' : m.status === "error" ? '<span class="pill bad">failed</span>' : m.status === "cancelled" ? '<span class="pill">cancelled</span>' : "";
    const stale = m.stale || (m.sentRev && c.rev !== m.sentRev && m.status === "done");
    const props = (m.proposals || []).map((p, i) => proposalHtml(m, p, i)).join("");
    return `<div class="msg ${m.status === "error" ? "error" : ""} ${stale ? "stale" : ""}"><div class="who"><b>${esc(m.agent)}</b>${m.modelUsed || m.model ? " · " + esc(m.modelUsed || m.model) : ""} ${st}
      ${m.status === "running" ? `<button class="btn tonal sm" data-cancel="${m.id}">${icon("stop")}Cancel</button>` : ""}${m.status === "error" || m.status === "cancelled" ? `<button class="btn tonal sm" data-retry="${m.id}">${icon("refresh")}Retry</button>` : ""}</div>
      ${stale && m.status === "done" ? '<div class="small edited-note">The candidates changed after this question was sent.</div>' : ""}${m.error ? `<div class="small">${esc(m.error)}</div>` : ""}${proseOf(m.text)}${props}</div>`;
  }).join("");
  body.innerHTML = (comments ? `<div class="small muted">Comments</div>${comments}<hr style="border:0;border-top:1px solid var(--outline-soft)">` : "") + (msgs || '<div class="muted small">No conversation yet for this unit. Replies and proposals stay with the unit. Ordinary chat never changes the manuscript.</div>');
  body.scrollTop = body.scrollHeight;
  $$("[data-delc]", body).forEach((b) => (b.onclick = async () => { setCard(activeId, await api("DELETE", `/units/${activeId}/comments/${b.dataset.delc}`)); renderThread(); }));
  $$("[data-cancel]", body).forEach((b) => (b.onclick = () => api("POST", `/units/${activeId}/chat/${b.dataset.cancel}/cancel`)));
  $$("[data-retry]", body).forEach((b) => (b.onclick = async () => { await api("POST", `/units/${activeId}/chat/${b.dataset.retry}/retry`); thread = await api("GET", `/units/${activeId}/chat`); renderThread(); }));
  $$("[data-papply]", body).forEach((b) => (b.onclick = () => applyProposal(b)));
  $$("textarea[data-ptext]", body).forEach((t) => (t.oninput = () => { t.closest(".prop-card").querySelector(".read").innerHTML = diffHtml(wordDiff(C[activeId].proposed.text, t.value), "ins", env, view.hide); }));
}
function proposalHtml(m, p, i) {
  const c = C[activeId];
  return `<div class="prop-card" data-m="${m.id}" data-i="${i}"><div class="small muted">Proposal ${i + 1}${p.appliedTo ? ` · applied to ${p.appliedTo}` : ""} · highlights compare with the proposed wording</div>
    <textarea data-ptext>${esc(p.text)}</textarea><div class="read">${diffHtml(wordDiff(c.proposed.text, p.text), "ins", env, view.hide)}</div>
    <div class="btns">Apply to <button class="btn tonal sm" data-papply="original">Original</button><button class="btn tonal sm" data-papply="proposed">Proposed</button><button class="btn tonal sm" data-papply="custom">Custom final</button></div></div>`;
}
async function applyProposal(btn) {
  const card = btn.closest(".prop-card"); const text = card.querySelector("textarea").value; const target = btn.dataset.papply; const id = activeId;
  const go = async (force) => {
    try { const d = await api("POST", `/units/${id}/chat/${card.dataset.m}/proposal/${card.dataset.i}/apply`, { target, text, force }); setCard(id, d); thread = await api("GET", `/units/${id}/chat`); renderThread(); afterMutation(); toast(`Applied to the ${target} wording. The manuscript is unchanged until you apply decisions.`); }
    catch (e) { if (e.status === 409 && e.data?.stale) { if (confirm(e.message)) go(true); } else toast(e.message); }
  };
  go(false);
}

boot().catch((e) => { document.body.insertAdjacentHTML("afterbegin", `<div class="banner">Could not start: ${esc(e.message)}</div>`); });
