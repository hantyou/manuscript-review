// Build the review webview from the same public/index.html used by the browser UI.
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

function renderReviewHtml(webview, extensionUri, appRoot) {
  const index = fs.readFileSync(path.join(appRoot, "public", "index.html"), "utf8");
  const uri = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource} data:`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
  return index
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('href="/vendor/katex/katex.min.css"', `href="${uri("media", "katex", "katex.min.css")}"`)
    .replace('src="/vendor/katex/katex.min.js"', `src="${uri("media", "katex", "katex.min.js")}"`)
    .replace('href="/styles.css"', `href="${uri("app", "public", "styles.css")}"`)
    .replace('src="/app.js"', `src="${uri("app", "public", "app.js")}"`);
}

function renderPdfHtml(base64, title) {
  const csp = "default-src 'none'; object-src data:; frame-src data:; style-src 'unsafe-inline'";
  const safeTitle = String(title).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${safeTitle}</title></head>` +
    `<body style="margin:0;background:#222"><embed src="data:application/pdf;base64,${base64}" type="application/pdf" style="width:100vw;height:100vh"></body></html>`;
}

module.exports = { renderReviewHtml, renderPdfHtml };
