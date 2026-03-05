const DEFAULT_DOMAIN_BLACKLIST = [
  "facebook.com/tr",
  "connect.facebook.net",
  "googleadservices.com/pagead",
  "googlesyndication.com",
  "px.ads.linkedin.com",
  "linkedin.com/collect",
  "analytics.tiktok.com",
  "business-api.tiktok.com",
  "tr.snapchat.com",
  "ct.pinterest.com",
  "bat.bing.com",
  "alb.reddit.com",
  "amazon-adsystem.com",
  "doubleclick.net",
  "scorecardresearch.com",
  "quantserve.com",
];

const DEFAULT_PATH_KEYWORDS = [
  "/pixel", "/track", "/tracking", "/collect", "/conversion", "/click", "/view",
  "/visit", "/hit", "/event",
  "tid=", "pixel_id=", "guid=", "cx=", "extid="
];

const els = {
  htmlInput: document.getElementById("htmlInput"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  clearBtn: document.getElementById("clearBtn"),

  ignoreNoscript: document.getElementById("ignoreNoscript"),
  ignoreHead: document.getElementById("ignoreHead"),
  enableSizeRule: document.getElementById("enableSizeRule"),
  enableDomainBlacklist: document.getElementById("enableDomainBlacklist"),
  enablePathKeywords: document.getElementById("enablePathKeywords"),
  enableParamCount: document.getElementById("enableParamCount"),

  summary: document.getElementById("summary"),
  resultsBody: document.getElementById("resultsBody"),

  copyJsonBtn: document.getElementById("copyJsonBtn"),
  downloadJsonBtn: document.getElementById("downloadJsonBtn"),
};

let lastJson = null;

function loadSample() {
  els.htmlInput.value = `<!doctype html>
<html>
<head>
  <img src="https://connect.facebook.net/en_US/fbevents.js" />
  <img src="https://www.googleadservices.com/pagead/conversion/123/?a=1&b=2&c=3" width="1" height="1" />
</head>
<body>
  <h1>Example</h1>

  <img src="https://example.com/images/hero.jpg" width="1200" height="600" />

  <noscript>
    <img src="https://facebook.com/tr?id=999&ev=PageView&noscript=1" width="1" height="1">
  </noscript>

  <img src="/pixel.gif?tid=abc&guid=def&cx=ghi" width="1" height="1" />
  <img src="https://cdn.example.com/logo.png" />
</body>
</html>`;
}

function safeParseUrl(url) {
  // Works with absolute URLs; also attempts base "https://example.invalid" for relative ones.
  try {
    return new URL(url);
  } catch {
    try {
      return new URL(url, "https://example.invalid");
    } catch {
      return null;
    }
  }
}

function getQueryParamCount(u) {
  try {
    // Count unique keys (URLSearchParams iterates keys, includes duplicates)
    const params = new URLSearchParams(u.search || "");
    const keys = new Set();
    for (const [k] of params) keys.add(k);
    return keys.size;
  } catch {
    return 0;
  }
}

function attrToInt(val) {
  if (val == null) return null;
  const s = String(val).trim().toLowerCase();
  // Accept "1", "1px", "0", "0px"
  const m = s.match(/^(\d+)/);
  if (!m) return null;
  return Number(m[1]);
}

function nodeIsInside(node, tagNameUpper) {
  let cur = node;
  while (cur) {
    if (cur.nodeType === 1 && cur.tagName === tagNameUpper) return true;
    cur = cur.parentNode;
  }
  return false;
}

function classifyImage(imgEl, settings) {
  const src = (imgEl.getAttribute("src") || "").trim();
  const reasons = [];
  const ctx = [];

  const inNoscript = nodeIsInside(imgEl, "NOSCRIPT");
  const inHead = nodeIsInside(imgEl, "HEAD");

  if (inNoscript) ctx.push("inside <noscript>");
  if (inHead) ctx.push("inside <head>");

  // Ignore options
  if (settings.ignoreNoscript && inNoscript) {
    return { ignored: true, src, classification: "ignored", reasons: ["ignored: <noscript>"], ctx };
  }
  if (settings.ignoreHead && inHead) {
    return { ignored: true, src, classification: "ignored", reasons: ["ignored: <head>"], ctx };
  }

  // Size rule (width AND height)
  if (settings.enableSizeRule) {
    const w = attrToInt(imgEl.getAttribute("width"));
    const h = attrToInt(imgEl.getAttribute("height"));
    if (w != null && h != null) {
      if ((w === 1 || w === 0) && (h === 1 || h === 0)) {
        reasons.push(`pixel size: width=${w} height=${h}`);
      }
    }
  }

  // URL rules
  const lower = src.toLowerCase();
  const u = safeParseUrl(src);

  if (settings.enableDomainBlacklist) {
    // For blacklist, match against hostname + pathname (or the full lower string as fallback)
    const hostPath = u ? `${u.hostname}${u.pathname}`.toLowerCase() : lower;
    for (const bad of DEFAULT_DOMAIN_BLACKLIST) {
      if (hostPath.includes(bad.toLowerCase()) || lower.includes(bad.toLowerCase())) {
        reasons.push(`domain blacklist match: ${bad}`);
        break;
      }
    }
  }

  if (settings.enablePathKeywords) {
    for (const kw of DEFAULT_PATH_KEYWORDS) {
      if (lower.includes(kw.toLowerCase())) {
        reasons.push(`keyword match: ${kw}`);
        break;
      }
    }
  }

  if (settings.enableParamCount && u) {
    const n = getQueryParamCount(u);
    if (n >= 3) reasons.push(`3+ query params: ${n}`);
  } else if (settings.enableParamCount && src.includes("?")) {
    // Fallback heuristic if URL parsing failed
    const query = src.split("?")[1] || "";
    const n = query.split("&").filter(Boolean).length;
    if (n >= 3) reasons.push(`3+ query params (fallback): ${n}`);
  }

  // Context-based tracking
  // If inside <noscript> or <head>, it’s very often tracking. We mark as tracking.
  if (inNoscript) reasons.push("placed in <noscript>");
  if (inHead) reasons.push("placed in <head>");

  // Decide classification:
  // - tracking: strong signals (any reason from blacklist/keyword/pixel size/noscript/head)
  // - suspicious: 3+ params only (if you want), or mild signals
  // Here: if reasons include only "3+ query params" and nothing else, label "suspicious".
  const strongSignals = reasons.filter(r =>
    !r.startsWith("3+ query params")
  );

  let classification = "normal";
  if (reasons.length > 0) {
    classification = strongSignals.length > 0 ? "tracking" : "suspicious";
  }

  return { ignored: false, src, classification, reasons, ctx };
}

function analyzeHtml(html, settings) {
  // Parse HTML into a detached document
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Collect ALL img elements (including those in <head> and <noscript> parsed structure)
  const imgs = Array.from(doc.querySelectorAll("img"));

  const results = [];
  for (const img of imgs) {
    const r = classifyImage(img, settings);
    if (!r.src) continue; // ignore empty src
    if (r.ignored) continue;
    results.push(r);
  }

  return results;
}

function renderResults(results) {
  els.resultsBody.innerHTML = "";

  const counts = {
    total: results.length,
    tracking: results.filter(r => r.classification === "tracking").length,
    suspicious: results.filter(r => r.classification === "suspicious").length,
    normal: results.filter(r => r.classification === "normal").length,
  };

  els.summary.textContent =
    `Collected ${counts.total} images — ` +
    `${counts.tracking} tracking, ${counts.suspicious} suspicious, ${counts.normal} normal.`;

  results.forEach((r, idx) => {
    const tr = document.createElement("tr");

    const badgeClass =
      r.classification === "tracking" ? "track" :
      r.classification === "suspicious" ? "suspicious" : "normal";

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td><span class="badge ${badgeClass}">${r.classification}</span></td>
      <td class="url">${escapeHtml(r.src)}</td>
      <td class="reasons">${escapeHtml(r.reasons.join("; ") || "-")}</td>
      <td class="ctx">${escapeHtml(r.ctx.join("; ") || "-")}</td>
    `;
    els.resultsBody.appendChild(tr);
  });

  // Save JSON for export
  lastJson = {
    generated_at: new Date().toISOString(),
    counts,
    results,
  };

  const enableExport = results.length > 0;
  els.copyJsonBtn.disabled = !enableExport;
  els.downloadJsonBtn.disabled = !enableExport;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getSettings() {
  return {
    ignoreNoscript: els.ignoreNoscript.checked,
    ignoreHead: els.ignoreHead.checked,
    enableSizeRule: els.enableSizeRule.checked,
    enableDomainBlacklist: els.enableDomainBlacklist.checked,
    enablePathKeywords: els.enablePathKeywords.checked,
    enableParamCount: els.enableParamCount.checked,
  };
}

async function copyJson() {
  if (!lastJson) return;
  await navigator.clipboard.writeText(JSON.stringify(lastJson, null, 2));
  els.summary.textContent = "Copied JSON to clipboard.";
}

function downloadJson() {
  if (!lastJson) return;
  const blob = new Blob([JSON.stringify(lastJson, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tracking-images.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function analyzeNow() {
  const html = els.htmlInput.value || "";
  const settings = getSettings();
  const results = analyzeHtml(html, settings);
  renderResults(results);
}

// Wire up UI
els.analyzeBtn.addEventListener("click", analyzeNow);
els.loadSampleBtn.addEventListener("click", () => { loadSample(); analyzeNow(); });
els.clearBtn.addEventListener("click", () => {
  els.htmlInput.value = "";
  els.resultsBody.innerHTML = "";
  els.summary.textContent = "No results yet.";
  lastJson = null;
  els.copyJsonBtn.disabled = true;
  els.downloadJsonBtn.disabled = true;
});
els.copyJsonBtn.addEventListener("click", copyJson);
els.downloadJsonBtn.addEventListener("click", downloadJson);

// Load sample on first visit for convenience
loadSample();
analyzeNow();
