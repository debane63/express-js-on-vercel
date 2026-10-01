import express from "express";
import crypto from "node:crypto";

const app = express();

const UPSTREAM =
  "https://gynljghdntrcfgzqabfe.supabase.co/functions/v1/hf-lookup";

const API_KEY_SHA256 =
  "01ea8d6a3e5cc51153344f97a924727112ba10b0f51f959928e08a6a734e70d4";

const globalState = globalThis as typeof globalThis & {
  __rateMap?: Map<string, { windowStart: number; count: number }>;
};

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(a: string, b: string) {
  try {
    const aa = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function getApiKey(req: express.Request) {
  const key = String(req.header("x-api-key") || "").trim();
  if (!key) return null;
  return safeEqualHex(sha256(key), API_KEY_SHA256) ? key : null;
}

function rateAllowed(req: express.Request) {
  if (!globalState.__rateMap) globalState.__rateMap = new Map();

  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 60;
  const ip =
    String(req.headers["x-forwarded-for"] || req.ip || "unknown")
      .split(",")[0]
      .trim();

  const existing = globalState.__rateMap.get(ip);

  if (!existing || now - existing.windowStart >= windowMs) {
    globalState.__rateMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }

  existing.count += 1;
  return existing.count <= maxRequests;
}

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "AIM-AI2 Private Sharded Lookup API",
    status: "online",
    endpoint: "/api?search=VALUE&field=auto",
    authentication: "x-api-key header required",
    indexedFields: ["telegram_id", "phone"],
    storage: "private Hugging Face bucket",
    shards: 100,
  });
});


app.get("/tester", (_req, res) => {
  res.setHeader("cache-control", "no-store");
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" />
  <title>AIM-AI2 API Tester</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0f;color:#fff;margin:0;padding:18px}
    .wrap{max-width:720px;margin:auto}
    h2{margin:4px 0 8px}
    .muted{color:#aaa;font-size:13px;margin-bottom:12px}
    label{display:block;margin-top:12px;font-size:13px;color:#bbb}
    input,select,button{width:100%;padding:15px;margin-top:6px;border-radius:11px;border:1px solid #34343d;background:#17171d;color:#fff;font-size:16px}
    button{background:#6d5dfc;border:0;font-weight:800;min-height:52px}
    button:disabled{opacity:.55}
    .status{margin:14px 0;padding:13px 14px;border-radius:10px;background:#17171d;font-weight:700}
    .ok{background:#12351f}
    .bad{background:#441717}
    .busy{background:#2f2a12}
    pre{white-space:pre-wrap;word-break:break-word;background:#111117;padding:16px;border-radius:12px;min-height:160px;font-size:14px}
    .row{display:flex;gap:8px;align-items:center}
    .row input{flex:1}
    .small{width:auto;padding:12px 14px}
  </style>
</head>
<body>
<div class="wrap">
  <h2>AIM-AI2 API Tester</h2>
  <div class="muted">এই page API key-টা URL-এ দেয় না; x-api-key header-এ পাঠায়।</div>

  <div id="status" class="status">Ready</div>

  <label>Search value</label>
  <input id="search" placeholder="e.g. 1038991535" inputmode="numeric" autocomplete="off" />

  <label>Field</label>
  <select id="field">
    <option value="auto">auto</option>
    <option value="telegram_id">telegram_id</option>
    <option value="phone">phone</option>
  </select>

  <label>API key</label>
  <div class="row">
    <input id="key" placeholder="Paste API key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <button id="toggle" class="small" type="button">Show</button>
  </div>

  <button id="send" type="button">Send Request</button>

  <pre id="out">Result will appear here.</pre>
</div>

<script>
(() => {
  const EXPECTED_HASH = "01ea8d6a3e5cc51153344f97a924727112ba10b0f51f959928e08a6a734e70d4";
  const searchEl = document.getElementById("search");
  const fieldEl = document.getElementById("field");
  const keyEl = document.getElementById("key");
  const send = document.getElementById("send");
  const toggle = document.getElementById("toggle");
  const status = document.getElementById("status");
  const out = document.getElementById("out");

  function cleanKey(v) {
    return String(v || "")
      .replace(/[\\s\\u200B-\\u200D\\uFEFF]/g, "")
      .trim();
  }

  async function hashHex(value) {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function setStatus(text, cls) {
    status.className = "status " + (cls || "");
    status.textContent = text;
  }

  toggle.addEventListener("click", () => {
    const show = keyEl.type === "password";
    keyEl.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
  });

  send.addEventListener("click", async () => {
    const search = searchEl.value.trim();
    const field = fieldEl.value;
    const key = cleanKey(keyEl.value);

    out.textContent = "";

    if (!search) {
      setStatus("Search value দাও", "bad");
      searchEl.focus();
      return;
    }

    if (!key) {
      setStatus("API key দাও", "bad");
      keyEl.focus();
      return;
    }

    send.disabled = true;
    send.textContent = "Checking...";
    setStatus("API key check করছি...", "busy");

    try {
      const actualHash = await hashHex(key);

      if (actualHash !== EXPECTED_HASH) {
        setStatus("API key match করছে না", "bad");
        out.textContent = "তুমি যে API key paste করেছ সেটা server-এর configured key-এর সাথে মিলছে না.\n\nKey-টা আবার exact copy/paste করো.";
        out.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }

      setStatus("API key ঠিক আছে — request পাঠাচ্ছি...", "busy");
      send.textContent = "Sending...";

      const u = new URL("/api", location.origin);
      u.searchParams.set("search", search);
      u.searchParams.set("field", field);

      const r = await fetch(u.toString(), {
        method: "GET",
        headers: {
          "x-api-key": key,
          "accept": "application/json"
        },
        cache: "no-store"
      });

      const raw = await r.text();
      let body;
      try { body = JSON.parse(raw); } catch { body = raw; }

      if (r.ok) {
        setStatus("Success — HTTP " + r.status, "ok");
      } else {
        setStatus("Request failed — HTTP " + r.status, "bad");
      }

      out.textContent =
        "HTTP " + r.status + "\n\n" +
        (typeof body === "string" ? body : JSON.stringify(body, null, 2));

      out.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      setStatus("Browser error", "bad");
      out.textContent = String(e);
      out.scrollIntoView({ behavior: "smooth", block: "center" });
    } finally {
      send.disabled = false;
      send.textContent = "Send Request";
    }
  });
})();
</script>
</body>
</html>`);
});

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    status: "proxy_ready",
    upstream: "private sharded lookup",
  });
});

async function searchHandler(
  req: express.Request,
  res: express.Response,
) {
  const apiKey = getApiKey(req);

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  if (!rateAllowed(req)) {
    return res.status(429).json({
      success: false,
      error: "Too many requests",
    });
  }

  const search = String(req.query.search || "").trim();
  const field = String(req.query.field || "auto").trim().toLowerCase();

  if (!/^\d{1,160}$/.test(search)) {
    return res.status(400).json({
      success: false,
      error: "search must contain digits only",
    });
  }

  if (!["auto", "telegram", "telegram_id", "phone"].includes(field)) {
    return res.status(400).json({
      success: false,
      error: "field must be auto, telegram_id, or phone",
    });
  }

  try {
    const upstreamUrl = new URL(UPSTREAM);
    upstreamUrl.searchParams.set("search", search);
    upstreamUrl.searchParams.set("field", field);

    const response = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });

    const text = await response.text();

    res.status(response.status);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "private, no-store");
    return res.send(text);
  } catch (error) {
    console.error(
      "upstream_error",
      error instanceof Error ? error.message : String(error),
    );

    return res.status(502).json({
      success: false,
      error: "Lookup upstream unavailable",
    });
  }
}

app.get("/api", searchHandler);
app.get("/api/search", searchHandler);

export default app;
