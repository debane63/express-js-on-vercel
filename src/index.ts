import express from "express";
import crypto from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";

const app = express();

const DATASET_URL =
  process.env.DATASET_URL ||
  "https://huggingface.co/datasets/deban420/my-first-data-api/resolve/main/train.parquet";

// The raw API key is not stored in this public repository.
// SHA-256(API key) only:
const API_KEY_SHA256 =
  process.env.API_KEY_SHA256 ||
  "01ea8d6a3e5cc51153344f97a924727112ba10b0f51f959928e08a6a734e70d4";

type DbState = {
  connection: any;
  columns: {
    telegram: string;
    phone: string;
    firstName: string;
    lastName: string;
  };
};

const globalState = globalThis as typeof globalThis & {
  __hfDbState?: Promise<DbState>;
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

function quoteIdentifier(name: string) {
  return '"' + name.replaceAll('"', '""') + '"';
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
    memory_limit: "768MB"
  });

  const connection = await instance.connect();

  // Vercel functions do not expose a normal HOME directory. DuckDB needs
  // one for extension installation/cache, so use the writable /tmp volume.
  await connection.run("SET home_directory='/tmp'");

  // httpfs enables HTTP range reads. Parquet metadata/needed column chunks
  // are fetched remotely instead of downloading the whole file first.
  await connection.run("INSTALL httpfs");
  await connection.run("LOAD httpfs");

  const url = quoteLiteral(DATASET_URL);

  const schemaReader = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM read_parquet(${url})`
  );

  const schemaRows = schemaReader.getRowsJson();

  if (schemaRows.length < 4) {
    throw new Error(
      `Expected at least four columns in Parquet, found ${schemaRows.length}`
    );
  }

  const names = schemaRows.slice(0, 4).map((row: any[]) => String(row[0]));

  return {
    connection,
    columns: {
      telegram: names[0],
      phone: names[1],
      firstName: names[2],
      lastName: names[3]
    }
  };
}

function getDbState() {
  if (!globalState.__hfDbState) {
    globalState.__hfDbState = createDbState().catch((error) => {
      // Allow a later invocation to retry initialization after a transient
      // remote/network error.
      globalState.__hfDbState = undefined;
      throw error;
    });
  }

  return globalState.__hfDbState;
}

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "HF Remote Parquet Search API",
    status: "online",
    endpoint: "/api?search=VALUE",
    authentication: "x-api-key header required",
    modes: ["auto", "telegram_id", "phone", "first_name", "last_name"]
  });
});

app.get("/health", async (_req, res) => {
  try {
    const state = await getDbState();

    const sizeUrl =
      "https://datasets-server.huggingface.co/size?dataset=deban420/my-first-data-api";

    const sizeResp = await fetch(sizeUrl, {
      signal: AbortSignal.timeout(10000)
    });

    const sizeJson: any = await sizeResp.json();

    let totalRows =
      sizeJson?.size?.dataset?.num_rows ||
      sizeJson?.size?.configs?.[0]?.num_rows ||
      sizeJson?.size?.configs?.[0]?.splits?.[0]?.num_rows ||
      0;

    totalRows = Number(totalRows || 0);

    let sampleOrderMonotonic: boolean | null = null;
    let checkedSamples = 0;

    if (Number.isFinite(totalRows) && totalRows > 10) {
      const offsets = Array.from({ length: 9 }, (_, i) =>
        Math.floor((i * (totalRows - 1)) / 8)
      );

      const samples = await Promise.all(
        offsets.map(async (offset) => {
          const u = new URL(
            "https://datasets-server.huggingface.co/rows"
          );
          u.searchParams.set(
            "dataset",
            "deban420/my-first-data-api"
          );
          u.searchParams.set("config", "default");
          u.searchParams.set("split", "train");
          u.searchParams.set("offset", String(offset));
          u.searchParams.set("length", "1");

          const r = await fetch(u, {
            signal: AbortSignal.timeout(10000)
          });

          if (!r.ok) {
            throw new Error("rows endpoint returned " + r.status);
          }

          const j: any = await r.json();
          const row = j?.rows?.[0]?.row || {};
          const raw = String(row["Telegram ID"] ?? "");
          const numeric = /^\d+$/.test(raw) ? BigInt(raw) : null;

          return numeric;
        })
      );

      checkedSamples = samples.length;

      if (samples.every((v) => v !== null)) {
        sampleOrderMonotonic = true;

        for (let i = 1; i < samples.length; i++) {
          if ((samples[i] as bigint) < (samples[i - 1] as bigint)) {
            sampleOrderMonotonic = false;
            break;
          }
        }
      } else {
        sampleOrderMonotonic = false;
      }
    }

    return res.json({
      success: true,
      status: "ready",
      source: "Hugging Face remote Parquet",
      totalRows,
      checkedSamples,
      telegramIdSampleOrderMonotonic: sampleOrderMonotonic
    });
  } catch (error) {
    console.error("health/init error", error);
    return res.status(503).json({
      success: false,
      status: "database_unavailable"
    });
  }
});

async function searchHandler(req: express.Request, res: express.Response) {
  if (!authorized(req)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  if (!rateAllowed(req)) {
    return res.status(429).json({
      success: false,
      error: "Too many requests"
    });
  }

  const search = String(req.query.search || "").trim();
  const field = String(req.query.field || "auto").trim().toLowerCase();

  if (!search) {
    return res.status(400).json({
      success: false,
      error: "Missing search parameter"
    });
  }

  if (search.length > 160) {
    return res.status(400).json({
      success: false,
      error: "Search value is too long"
    });
  }

  const validFields = new Set([
    "auto",
    "telegram",
    "telegram_id",
    "phone",
    "first_name",
    "last_name"
  ]);

  if (!validFields.has(field)) {
    return res.status(400).json({
      success: false,
      error:
        "Invalid field. Use auto, telegram_id, phone, first_name, or last_name."
    });
  }

  try {
    const started = Date.now();
    const { connection, columns } = await getDbState();

    const tg = quoteIdentifier(columns.telegram);
    const phone = quoteIdentifier(columns.phone);
    const first = quoteIdentifier(columns.firstName);
    const last = quoteIdentifier(columns.lastName);
    const url = quoteLiteral(DATASET_URL);

    const projection = `
      CAST(${tg} AS VARCHAR) AS telegram_id,
      CAST(${phone} AS VARCHAR) AS phone,
      CAST(${first} AS VARCHAR) AS first_name,
      CAST(${last} AS VARCHAR) AS last_name
    `;

    let whereSql: string;
    let params: Record<string, string>;

    if (field === "telegram" || field === "telegram_id") {
      whereSql = `CAST(${tg} AS VARCHAR) = $q`;
      params = { q: search };
    } else if (field === "phone") {
      whereSql = `CAST(${phone} AS VARCHAR) = $q`;
      params = { q: search };
    } else if (field === "first_name") {
      whereSql = `lower(trim(CAST(${first} AS VARCHAR))) = $q`;
      params = { q: search.toLowerCase() };
    } else if (field === "last_name") {
      whereSql = `lower(trim(CAST(${last} AS VARCHAR))) = $q`;
      params = { q: search.toLowerCase() };
    } else {
      whereSql = `
        CAST(${tg} AS VARCHAR) = $raw
        OR CAST(${phone} AS VARCHAR) = $raw
        OR lower(trim(CAST(${first} AS VARCHAR))) = $normalized
        OR lower(trim(CAST(${last} AS VARCHAR))) = $normalized
      `;

      params = {
        raw: search,
        normalized: search.toLowerCase()
      };
    }

    const sql = `
      SELECT ${projection}
      FROM read_parquet(${url})
      WHERE ${whereSql}
      LIMIT 10
    `;

    const reader = await connection.runAndReadAll(sql, params);
    const rows = reader.getRowObjectsJson();

    res.setHeader("Cache-Control", "private, no-store");

    return res.json({
      success: true,
      query: search,
      field,
      count: rows.length,
      elapsed_ms: Date.now() - started,
      results: rows
    });
  } catch (error) {
    console.error("search error", error);

    return res.status(500).json({
      success: false,
      error: "Search backend failed"
    });
  }
}

app.get("/api", searchHandler);
app.get("/api/search", searchHandler);

export default app;
