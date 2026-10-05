import express from "express";

const app = express();

const DATASET = "tfqdeadlo/Tgdata";
const HUB_API = `https://huggingface.co/api/datasets/${DATASET}`;
const DATASETS_SERVER = "https://datasets-server.huggingface.co";

type Json = Record<string, any>;

async function fetchJson(url: string, timeoutMs = 20_000): Promise<{ ok: boolean; status: number; body: any }> {
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
      body: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
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
        out.push({
          config: configName,
          fields: features,
        });
      }
    }
  }

  return out;
}

function extractSplits(raw: any) {
  if (Array.isArray(raw?.splits)) {
    return raw.splits.map((s: any) => ({
      config: s?.config ?? null,
      split: s?.split ?? null,
      num_examples: s?.num_examples ?? null,
      num_bytes: s?.num_bytes ?? null,
    }));
  }
  return raw;
}

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "Tgdata Safe Dataset API",
    status: "online",
    dataset: DATASET,
    privacy: "This service never returns row-level phone/email/personal-record values.",
    endpoints: {
      health: "/health",
      dataset: "/api/dataset",
      files: "/api/files",
      schema: "/api/schema",
      splits: "/api/splits",
      metadata_search: "/api/search?q=parquet",
    },
  });
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

  return res.json({
    success: true,
    dataset: publicDatasetMetadata(upstream.body),
  });
});

app.get("/api/files", async (_req, res) => {
  const upstream = await fetchJson(HUB_API);

  if (!upstream.ok) {
    return res.status(upstream.status || 502).json({
      success: false,
      error: "Unable to read Hugging Face dataset files",
      upstreamStatus: upstream.status,
    });
  }

  const metadata = publicDatasetMetadata(upstream.body);
  return res.json({
    success: true,
    dataset: DATASET,
    count: metadata.files.length,
    files: metadata.files,
  });
});

app.get("/api/schema", async (_req, res) => {
  const url = `${DATASETS_SERVER}/info?dataset=${encodeURIComponent(DATASET)}`;
  const upstream = await fetchJson(url, 30_000);

  if (!upstream.ok) {
    return res.status(upstream.status || 502).json({
      success: false,
      error: "Hugging Face dataset schema is not currently available",
      upstreamStatus: upstream.status,
    });
  }

  return res.json({
    success: true,
    dataset: DATASET,
    schema: extractSchema(upstream.body),
  });
});

app.get("/api/splits", async (_req, res) => {
  const url = `${DATASETS_SERVER}/splits?dataset=${encodeURIComponent(DATASET)}`;
  const upstream = await fetchJson(url, 30_000);

  if (!upstream.ok) {
    return res.status(upstream.status || 502).json({
      success: false,
      error: "Hugging Face split metadata is not currently available",
      upstreamStatus: upstream.status,
    });
  }

  return res.json({
    success: true,
    dataset: DATASET,
    splits: extractSplits(upstream.body),
  });
});

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();

  if (!q || q.length > 100) {
    return res.status(400).json({
      success: false,
      error: "q is required and must be 1-100 characters",
    });
  }

  const [metaResult, infoResult] = await Promise.all([
    fetchJson(HUB_API),
    fetchJson(`${DATASETS_SERVER}/info?dataset=${encodeURIComponent(DATASET)}`, 30_000),
  ]);

  const metadata = metaResult.ok ? publicDatasetMetadata(metaResult.body) : null;
  const files = metadata?.files ?? [];
  const matchedFiles = files.filter((f: any) =>
    String(f?.rfilename || "").toLowerCase().includes(q),
  );

  const schema = infoResult.ok ? extractSchema(infoResult.body) : [];
  const matchedFields: Array<{ config: string; field: string; type: any }> = [];

  for (const entry of schema) {
    const fields = entry?.fields;
    if (!fields || typeof fields !== "object") continue;

    for (const [name, type] of Object.entries(fields)) {
      if (name.toLowerCase().includes(q)) {
        matchedFields.push({ config: entry.config, field: name, type });
      }
    }
  }

  return res.json({
    success: true,
    query: q,
    scope: "dataset metadata only",
    dataset: DATASET,
    matches: {
      files: matchedFiles,
      schemaFields: matchedFields,
    },
  });
});

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: "Not found",
  });
});

export default app;
