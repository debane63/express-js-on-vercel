import json
import os
from huggingface_hub import HfApi

TOKEN = os.environ["HF_TOKEN"]
api = HfApi(token=TOKEN)

DATASET_ID = "deban420/tgdata-api-demo"
SPACE_ID = "deban420/tgdata-api-demo-space"

rows = [
    {
        "user_id": 1646744189,
        "username": "mock_user_1646744189",
        "first_name": "Demo",
        "last_name": "User",
        "phone": "+00000000000",
        "email": "demo1646744189@example.invalid",
        "status": "mock",
        "linked_id": "mock-linked-1",
        "linked_name": "Mock Linked",
        "linked_handle": "mock_linked",
    },
    {
        "user_id": 1038991535,
        "username": "mock_user_1038991535",
        "first_name": "Sample",
        "last_name": "Record",
        "phone": "+00000000001",
        "email": "sample1038991535@example.invalid",
        "status": "mock",
        "linked_id": "mock-linked-2",
        "linked_name": "Mock Sample",
        "linked_handle": "mock_sample",
    },
]

api.create_repo(
    repo_id=DATASET_ID,
    repo_type="dataset",
    private=True,
    exist_ok=True,
)

jsonl = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n"
api.upload_file(
    path_or_fileobj=jsonl.encode("utf-8"),
    path_in_repo="data/mock.jsonl",
    repo_id=DATASET_ID,
    repo_type="dataset",
    commit_message="Add synthetic Tgdata-compatible mock rows",
)

dataset_readme = """# Tgdata API Demo Dataset

Synthetic demo dataset only.

Schema is compatible with the Tgdata test API, but no third-party personal-data rows are mirrored here.
"""
api.upload_file(
    path_or_fileobj=dataset_readme.encode("utf-8"),
    path_in_repo="README.md",
    repo_id=DATASET_ID,
    repo_type="dataset",
    commit_message="Add dataset README",
)

api.create_repo(
    repo_id=SPACE_ID,
    repo_type="space",
    space_sdk="static",
    private=False,
    exist_ok=True,
)

space_readme = """---
title: Tgdata API Demo
emoji: 🔎
colorFrom: indigo
colorTo: blue
sdk: static
pinned: false
---

Synthetic static demo only.
"""

index_html = r'''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tgdata API Demo</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b0b0f;color:#fff;font-family:system-ui,-apple-system,sans-serif;padding:24px}
.wrap{max-width:760px;margin:auto}
.card{background:#141419;border:1px solid #2d2d36;border-radius:16px;padding:18px}
input,select,button{width:100%;padding:14px;border-radius:10px;border:1px solid #34343d;background:#1b1b22;color:#fff;font-size:16px;margin-top:10px}
button{font-weight:700;cursor:pointer}
pre{white-space:pre-wrap;word-break:break-word;background:#0f0f14;border-radius:12px;padding:16px;min-height:220px}
.note{color:#aaa;font-size:13px}
</style>
</head>
<body>
<div class="wrap">
<div class="card">
<h2>Tgdata API Demo</h2>
<p class="note">Synthetic test records only. Phone/email are redacted in results.</p>
<input id="q" value="1646744189" placeholder="Search value">
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
</div>
<script>
const rows = [
  {"user_id":1646744189,"username":"mock_user_1646744189","first_name":"Demo","last_name":"User","phone":"+00000000000","email":"demo1646744189@example.invalid","status":"mock","linked_id":"mock-linked-1","linked_name":"Mock Linked","linked_handle":"mock_linked"},
  {"user_id":1038991535,"username":"mock_user_1038991535","first_name":"Sample","last_name":"Record","phone":"+00000000001","email":"sample1038991535@example.invalid","status":"mock","linked_id":"mock-linked-2","linked_name":"Mock Sample","linked_handle":"mock_sample"}
];

function redact(row){
  const x={...row};
  if(x.phone) x.phone="[redacted]";
  if(x.email) x.email="[redacted]";
  return x;
}

document.getElementById("go").onclick = () => {
  const q=document.getElementById("q").value.trim();
  const field=document.getElementById("field").value;
  const results=rows.filter(r=>String(r[field]??"")===q).map(redact);
  document.getElementById("out").textContent=JSON.stringify({
    success:true,
    field,
    query:q,
    found:results.length>0,
    count:results.length,
    results
  },null,2);
};
</script>
</body>
</html>'''

api.upload_file(
    path_or_fileobj=space_readme.encode("utf-8"),
    path_in_repo="README.md",
    repo_id=SPACE_ID,
    repo_type="space",
    commit_message="Configure free static Space",
)
api.upload_file(
    path_or_fileobj=index_html.encode("utf-8"),
    path_in_repo="index.html",
    repo_id=SPACE_ID,
    repo_type="space",
    commit_message="Add static search tester",
)

print(json.dumps({
    "success": True,
    "dataset": f"https://huggingface.co/datasets/{DATASET_ID}",
    "space": f"https://huggingface.co/spaces/{SPACE_ID}",
}, indent=2))
