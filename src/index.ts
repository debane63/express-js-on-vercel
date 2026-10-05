import express from "express";

const app = express();

const DATASET = "tfqdeadlo/Tgdata";
const CONFIG = "default";
const SPLIT = "train";
const HUB_API = `https://huggingface.co/api/datasets/${DATASET}`;
const DATASETS_SERVER = "https://datasets-server.huggingface.co";

type Json = Record<string, any>;

async function fetchJson(url: string, timeoutMs = 30_000): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });

    const text = await response.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 2000) };
    }

    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function redactRow(row: Record<string, any>) {
  return {
    user_id: row?.user_id ?? null,
    username: row?.username ?? null,
    first_name: row?.first_name ?? null,
    last_name: row?.last_name ?? null,
    phone: row?.phone ? "[redacted]" : null,
    email: row?.email ? "[redacted]" : null,
    status: row?.status ?? null,
    linked_id: row?.linked_id ?? null,
    linked_name: row?.linked_name ?? null,
    linked_handle: row?.linked_handle ?? null,
  };
}

function escapeSqlString(value: string) {
  return value.replace(/'/g, "''");
}

function buildWhere(field: string, value: string) {
  const numericFields = new Set(["user_id"]);

  if (numericFields.has(field)) {
    if (!/^\d+$/.test(value)) throw new Error("user_id must contain digits only");
    return `"${field}"=${value}`;
  }

  return `"${field}"='${escapeSqlString(value)}'`;
}

function publicDatasetMetadata(raw: Json) {
  const siblings = Array.isArray(raw?.siblings)
    ? raw.siblings.map((f: any) => ({
        rfilename: f?.rfilename ?? null,
        size: typeof f?.size === "number" ? f.size : null,
      }))
    : [];

  return {
    id: raw?.id ?? DATASET,
    author: raw?.author ?? DATASET.split("/")[0],
    private: Boolean(raw?.private),
    gated: raw?.gated ?? false,
    disabled: Boolean(raw?.disabled),
    downloads: raw?.downloads ?? null,
    likes: raw?.likes ?? null,
    createdAt: raw?.createdAt ?? null,
    lastModified: raw?.lastModified ?? null,
    tags: Array.isArray(raw?.tags) ? raw.tags : [],
    files: siblings,
  };
}

function extractSchema(raw: any) {
  const out: Array<{ config: string; fields: any }> = [];
  const datasetInfo = raw?.dataset_info ?? raw?.datasetInfo ?? raw;

  if (datasetInfo && typeof datasetInfo === "object") {
    for (const [configName, cfg] of Object.entries(datasetInfo)) {
      const c: any = cfg;
      if (!c || typeof c !== "object") continue;
      const features = c.features ?? c?.dataset_info?.features;
      if (features && typeof features === "object") {
        out.push({ config: configName, fields: features });
      }
    }
  }

  return out;
}

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "Tgdata Query Test API",
    status: "online",
    dataset: DATASET,
    mode: "live Hugging Face dataset query",
    endpoints: {
      tester: "/tester",
      lookup: "/api/lookup?user_id=1646744189",
      search: "/api/search?search=1646744189&field=user_id",
      health: "/health",
      dataset: "/api/dataset",
      schema: "/api/schema",
    },
    note: "Phone/email values are redacted in responses.",
  });
});

app.get("/tester", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tgdata API Tester</title>
<style>
*{box-sizing:border-box} body{font-family:system-ui;background:#0b0b0f;color:#fff;margin:0;padding:20px}
.wrap{max-width:760px;margin:auto} input,select,button{width:100%;padding:14px;margin-top:10px;border-radius:10px;border:1px solid #333;background:#17171d;color:white;font-size:16px}
button{font-weight:700;cursor:pointer} pre{white-space:pre-wrap;word-break:break-word;background:#111117;padding:16px;border-radius:12px;min-height:180px}
.note{color:#aaa;font-size:13px;margin:8px 0 16px}
</style>
</head>
<body>
<div class="wrap">
<h2>Tgdata API Tester</h2>
<div class="note">Queries the Hugging Face dataset directly. Sensitive values are redacted.</div>
<input id="search" value="1646744189" placeholder="Search value">
<select id="field">
<option value="user_id">user_id</option>
<option value="username">username</option>
<option value="status">status</option>
<option value="linked_id">linked_id</option>
<option value="linked_handle">linked_handle</option>
</select>
<button id="go">Search</button>
<pre id="out">Ready.</pre>
</div>
<script>
const go=document.getElementById("go");
const out=document.getElementById("out");
go.onclick=async()=>{
  const search=document.getElementById("search").value.trim();
  const field=document.getElementById("field").value;
  go.disabled=true; out.textContent="Searching...";
  try{
    const u=new URL("/api/search",location.origin);
    u.searchParams.set("search",search);
    u.searchParams.set("field",field);
    const r=await fetch(u,{cache:"no-store"});
    const t=await r.text();
    try{out.textContent=JSON.stringify(JSON.parse(t),null,2)}catch{out.textContent=t}
  }catch(e){out.textContent=String(e)}
  finally{go.disabled=false}
};
</script>
</body>
</html>`);
});

app.get("/health", async (_req, res) => {
  const upstream = await fetchJson(HUB_API, 10_000);
  res.status(upstream.ok ? 200 : 502).json({
    success: upstream.ok,
    status: upstream.ok ? "ready" : "upstream_unavailable",
    dataset: DATASET,
    upstreamStatus: upstream.status,
    checkedAt: new Date().toISOString(),
  });
});

app.get("/api/dataset", async (_req, res) => {
  const upstream = await fetchJson(HUB_API);
  if (!upstream.ok) {
    return res.status(upstream.status || 502).json({
      success: false,
      error: "Unable to read Hugging Face dataset metadata",
      upstreamStatus: upstream.status,
    });
  }
  return res.json({ success: true, dataset: publicDatasetMetadata(upstream.body) });
});

app.get("/api/schema", async (_req, res) => {
  const url = `${DATASETS_SERVER}/info?dataset=${encodeURIComponent(DATASET)}`;
  const upstream = await fetchJson(url);
  if (!upstream.ok) {
    return res.status(upstream.status || 502).json({
      success: false,
      error: "Dataset schema unavailable",
      upstreamStatus: upstream.status,
    });
  }
  return res.json({ success: true, dataset: DATASET, schema: extractSchema(upstream.body) });
});

async function liveSearch(req: express.Request, res: express.Response) {
  const search = String(req.query.search ?? req.query.q ?? "").trim();
  const field = String(req.query.field ?? "user_id").trim().toLowerCase();

  const allowedFields = new Set([
    "user_id",
    "username",
    "status",
    "linked_id",
    "linked_handle",
  ]);

  if (!search || search.length > 160) {
    return res.status(400).json({ success: false, error: "search is required" });
  }

  if (!allowedFields.has(field)) {
    return res.status(400).json({
      success: false,
      error: "field must be user_id, username, status, linked_id, or linked_handle",
    });
  }

  let where: string;
  try {
    where = buildWhere(field, search);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const url = new URL(`${DATASETS_SERVER}/filter`);
  url.searchParams.set("dataset", DATASET);
  url.searchParams.set("config", CONFIG);
  url.searchParams.set("split", SPLIT);
  url.searchParams.set("where", where);
  url.searchParams.set("offset", "0");
  url.searchParams.set("length", "10");

  let upstream = await fetchJson(url.toString(), 240_000);
  let attempts = 1;

  while (
    !upstream.ok &&
    attempts < 5 &&
    /index is loading/i.test(String(upstream.body?.error || ""))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    upstream = await fetchJson(url.toString(), 240_000);
    attempts += 1;
  }

  if (!upstream.ok) {
    const loading = /index is loading/i.test(String(upstream.body?.error || ""));
    return res.status(loading ? 503 : upstream.status || 502).json({
      success: false,
      error: loading ? "Dataset index is still loading" : "Hugging Face filter query failed",
      upstreamStatus: upstream.status,
      attempts,
      retryable: loading,
      upstream: upstream.body,
    });
  }

  const rows = Array.isArray(upstream.body?.rows) ? upstream.body.rows : [];
  const results = rows.map((item: any) => ({
    row_idx: item?.row_idx ?? null,
    row: redactRow(item?.row ?? {}),
  }));

  return res.json({
    success: true,
    dataset: DATASET,
    field,
    query: search,
    found: results.length > 0,
    count: results.length,
    partial_index: Boolean(upstream.body?.partial),
    attempts,
    results,
  });
}

app.get("/api/search", liveSearch);

app.get("/api/lookup", async (req, res) => {
  req.query.search = req.query.user_id;
  req.query.field = "user_id";
  return liveSearch(req, res);
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

export default app;
