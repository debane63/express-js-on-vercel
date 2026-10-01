import os
import re
import shutil
from pathlib import Path

import duckdb
from huggingface_hub import HfFileSystem

SOURCE_URL = os.environ.get(
    "SOURCE_URL",
    "https://huggingface.co/datasets/deban420/my-first-data-api/resolve/main/train.parquet",
)
BUCKET = os.environ.get(
    "HF_BUCKET",
    "deban420/my-fast-data-bucket",
)
PREFIX = os.environ.get("HF_PREFIX", "lookup-v1")
WORK = Path(os.environ.get("WORKDIR", "/tmp/hf-index-build"))
STAGE = WORK / "stage"
OUT = WORK / "out"

for p in (STAGE, OUT):
    if p.exists():
        shutil.rmtree(p)
    p.mkdir(parents=True, exist_ok=True)

con = duckdb.connect()
con.execute("INSTALL httpfs")
con.execute("LOAD httpfs")
con.execute("PRAGMA threads=4")
con.execute("PRAGMA memory_limit='6GB'")
con.execute("SET preserve_insertion_order=false")
con.execute("SET http_keep_alive=true")

schema = con.execute(
    f"DESCRIBE SELECT * FROM read_parquet('{SOURCE_URL}')"
).fetchall()

if len(schema) < 4:
    raise RuntimeError(f"Expected at least 4 columns, found {len(schema)}")

cols = [row[0] for row in schema[:4]]

def qi(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'

tg, phone, first_name, last_name = map(qi, cols)

# Build one numeric lookup stream. Each source row contributes up to two
# searchable keys: Telegram ID and phone. The original row values are kept.
# Partition by the last two digits so the API can deterministically choose
# exactly one shard from the input number.
query = f"""
COPY (
    WITH src AS (
        SELECT
            CAST({tg} AS VARCHAR) AS telegram_id,
            CAST({phone} AS VARCHAR) AS phone,
            CAST({first_name} AS VARCHAR) AS first_name,
            CAST({last_name} AS VARCHAR) AS last_name
        FROM read_parquet('{SOURCE_URL}')
    ),
    entries AS (
        SELECT
            telegram_id AS lookup_key,
            'telegram_id' AS matched_field,
            telegram_id,
            phone,
            first_name,
            last_name
        FROM src
        WHERE regexp_full_match(telegram_id, '[0-9]+')

        UNION ALL

        SELECT
            phone AS lookup_key,
            'phone' AS matched_field,
            telegram_id,
            phone,
            first_name,
            last_name
        FROM src
        WHERE regexp_full_match(phone, '[0-9]+')
    )
    SELECT
        right(lookup_key, 2) AS shard,
        lookup_key,
        matched_field,
        telegram_id,
        phone,
        first_name,
        last_name
    FROM entries
)
TO '{STAGE.as_posix()}'
(
    FORMAT PARQUET,
    PARTITION_BY (shard),
    COMPRESSION ZSTD,
    ROW_GROUP_SIZE 50000
)
"""

print("Building 100-way numeric lookup partitions...")
con.execute(query)

print("Compacting and sorting each shard...")
created = []

for i in range(100):
    suffix = f"{i:02d}"
    part_dir = STAGE / f"shard={suffix}"
    target = OUT / f"lookup_{suffix}.parquet"

    if not part_dir.exists():
        continue

    glob = (part_dir / "*.parquet").as_posix()

    con.execute(
        f"""
        COPY (
            SELECT
                lookup_key,
                matched_field,
                telegram_id,
                phone,
                first_name,
                last_name
            FROM read_parquet('{glob}')
            ORDER BY lookup_key
        )
        TO '{target.as_posix()}'
        (
            FORMAT PARQUET,
            COMPRESSION ZSTD,
            ROW_GROUP_SIZE 25000
        )
        """
    )

    created.append(target)
    print(f"  {target.name}: {target.stat().st_size / 1024 / 1024:.2f} MiB")

if not created:
    raise RuntimeError("No lookup shards were created")

token = os.environ.get("HF_TOKEN")
if not token:
    raise RuntimeError(
        "HF_TOKEN is missing. Add a GitHub Actions secret named HF_TOKEN "
        "with write access to the target Hugging Face bucket."
    )

fs = HfFileSystem(token=token)

print(f"Uploading {len(created)} shards to bucket {BUCKET}/{PREFIX}/ ...")

for path in created:
    remote = f"buckets/{BUCKET}/{PREFIX}/{path.name}"
    fs.put(str(path), remote)
    print(f"  uploaded {path.name}")

manifest = OUT / "manifest.txt"
manifest.write_text(
    "\n".join(
        [
            f"source={SOURCE_URL}",
            f"bucket={BUCKET}",
            f"prefix={PREFIX}",
            f"shards={len(created)}",
            "scheme=last-two-digits",
            "fields=telegram_id,phone",
        ]
    )
    + "\n",
    encoding="utf-8",
)
fs.put(str(manifest), f"buckets/{BUCKET}/{PREFIX}/manifest.txt")

print("DONE")
