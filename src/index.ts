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
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AIM-AI2 API Tester</title>
  <style>
    body{font-family:system-ui;background:#0b0b0f;color:#fff;margin:0;padding:24px}
    .wrap{max-width:720px;margin:auto}
    input,select,button{width:100%;box-sizing:border-box;padding:14px;margin:8px 0;border-radius:10px;border:1px solid #333;background:#17171d;color:#fff}
    button{background:#6d5dfc;border:0;font-weight:700}
    pre{white-space:pre-wrap;word-break:break-word;background:#111117;padding:16px;border-radius:12px;min-height:120px}
    .muted{color:#aaa;font-size:14px}
  </style>
</head>
<body>
  <div class="wrap">
    <h2>AIM-AI2 API Tester</h2>
    <div class="muted">API key is sent only in the x-api-key header, not in the URL.</div>
    <input id="search" placeholder="Search value, e.g. 1038991535" inputmode="numeric" />
    <select id="field">
      <option value="auto">auto</option>
      <option value="telegram_id">telegram_id</option>
      <option value="phone">phone</option>
    </select>
    <input id="key" placeholder="API key" type="password" autocomplete="off" />
    <button id="send">Send Request</button>
    <pre id="out">Ready.</pre>
  </div>
<script>
const out = document.getElementById("out");
document.getElementById("send").onclick = async () => {
  const search = document.getElementById("search").value.trim();
  const field = document.getElementById("field").value;
  const key = document.getElementById("key").value.trim();

  if (!search || !key) {
    out.textContent = "Enter search value and API key.";
    return;
  }

  out.textContent = "Sending request...";

  try {
    const u = new URL("/api", location.origin);
    u.searchParams.set("search", search);
    u.searchParams.set("field", field);

    const r = await fetch(u, {
      headers: {
        "x-api-key": key,
        "accept": "application/json"
      }
    });

    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    out.textContent = "HTTP " + r.status + "\n\n" +
      (typeof body === "string" ? body : JSON.stringify(body, null, 2));
  } catch (e) {
    out.textContent = "Request failed: " + String(e);
  }
};
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
