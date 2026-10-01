import express from "express";
import crypto from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";

const app = express();

const LOOKUP_BASE =
  process.env.LOOKUP_BASE ||
  "https://huggingface.co/buckets/deban420/my-fast-data-bucket/resolve/lookup-v1";

const API_KEY_SHA256 =
  process.env.API_KEY_SHA256 ||
  "01ea8d6a3e5cc51153344f97a924727112ba10b0f51f959928e08a6a734e70d4";

type DbState = {
  connection: any;
};

const globalState = globalThis as typeof globalThis & {
  __hfLookupDbState?: Promise<DbState>;
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

function quoteLiteral(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}

function authorized(req: express.Request) {
  const key = String(req.header("x-api-key") || "");
  if (!key) return false;
  return safeEqualHex(sha256(key), API_KEY_SHA256);
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

async function createDbState(): Promise<DbState> {
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "2",
    memory_limit: "768MB",
  });

  const connection = await instance.connect();

  await connection.run("SET home_directory='/tmp'");
  await connection.run("INSTALL httpfs");
  await connection.run("LOAD httpfs");

  return { connection };
}

function getDbState() {
  if (!globalState.__hfLookupDbState) {
    globalState.__hfLookupDbState = createDbState().catch((error) => {
      globalState.__hfLookupDbState = undefined;
      throw error;
    });
  }

  return globalState.__hfLookupDbState;
}

function shardForNumericKey(value: string) {
  const digits = value.replace(/\D/g, "");
  if (!digits) return null;
  return digits.slice(-2).padStart(2, "0");
}

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "HF Sharded Lookup API",
    status: "online",
    endpoint: "/api?search=VALUE",
    authentication: "x-api-key header required",
    indexedFields: ["telegram_id", "phone"],
    strategy: "100-way last-two-digits shard + sorted Parquet pruning",
  });
});

app.get("/health", async (_req, res) => {
  try {
    const manifestUrl = LOOKUP_BASE + "/manifest.txt?download=true";

    const r = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });

    if (!r.ok) {
      return res.status(503).json({
        success: false,
        status: "index_not_ready",
        index_ready: false,
        manifest_status: r.status,
      });
    }

    const manifest = await r.text();

    return res.json({
      success: true,
      status: "ready",
      index_ready: true,
      lookup_base: LOOKUP_BASE,
      manifest: manifest
        .split("\n")
        .filter(Boolean)
        .reduce((acc: Record<string, string>, line) => {
          const i = line.indexOf("=");
          if (i > 0) acc[line.slice(0, i)] = line.slice(i + 1);
          return acc;
        }, {}),
    });
  } catch (error) {
    console.error("health error", error);

    return res.status(503).json({
      success: false,
      status: "index_not_ready",
      index_ready: false,
    });
  }
});

async function searchHandler(req: express.Request, res: express.Response) {
  if (!authorized(req)) {
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

  if (!search) {
    return res.status(400).json({
      success: false,
      error: "Missing search parameter",
    });
  }

  if (!/^\d+$/.test(search)) {
    return res.status(400).json({
      success: false,
      error:
        "Fast index currently supports numeric Telegram ID or phone searches only.",
    });
  }

  const fieldMap: Record<string, string | null> = {
    auto: null,
    telegram: "telegram_id",
    telegram_id: "telegram_id",
    phone: "phone",
  };

  if (!(field in fieldMap)) {
    return res.status(400).json({
      success: false,
      error: "Fast indexed fields: auto, telegram_id, phone",
    });
  }

  const shard = shardForNumericKey(search);

  if (!shard) {
    return res.status(400).json({
      success: false,
      error: "Invalid numeric search value",
    });
  }

  const shardUrl =
    LOOKUP_BASE + "/lookup_" + shard + ".parquet?download=true";

  try {
    const started = Date.now();
    const { connection } = await getDbState();

    const fieldFilter = fieldMap[field]
      ? " AND matched_field = $matchedField"
      : "";

    const params: Record<string, string> = {
      q: search,
    };

    if (fieldMap[field]) {
      params.matchedField = fieldMap[field] as string;
    }

    const sql = `
      SELECT
        telegram_id,
        phone,
        first_name,
        last_name,
        matched_field
      FROM read_parquet(${quoteLiteral(shardUrl)})
      WHERE lookup_key = $q
      ${fieldFilter}
      LIMIT 20
    `;

    const reader = await connection.runAndReadAll(sql, params);
    const rows = reader.getRowObjectsJson();

    res.setHeader("Cache-Control", "private, no-store");

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        status: "not_found",
        query: search,
        field,
        shard,
        elapsed_ms: Date.now() - started,
        results: [],
      });
    }

    return res.json({
      success: true,
      status: "success",
      query: search,
      field,
      shard,
      count: rows.length,
      elapsed_ms: Date.now() - started,
      results: rows,
    });
  } catch (error) {
    const message = String(error);
    console.error("search error", error);

    if (
      message.includes("404") ||
      message.includes("HTTP Error") ||
      message.includes("not found")
    ) {
      return res.status(503).json({
        success: false,
        status: "index_not_ready",
        error:
          "Lookup shards are not available yet. Build/upload lookup-v1 first.",
        shard,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Search backend failed",
    });
  }
}

app.get("/api", searchHandler);
app.get("/api/search", searchHandler);

export default app;
