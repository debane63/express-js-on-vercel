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
    space_sdk="gradio",
    private=True,
    exist_ok=True,
)

space_app = r'''import gradio as gr
import json
from huggingface_hub import hf_hub_download

DATASET = "deban420/tgdata-api-demo"

def lookup(value, field):
    value = str(value).strip()
    path = hf_hub_download(DATASET, "data/mock.jsonl", repo_type="dataset")
    matches = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            if str(row.get(field, "")) == value:
                safe = dict(row)
                if safe.get("phone"):
                    safe["phone"] = "[redacted]"
                if safe.get("email"):
                    safe["email"] = "[redacted]"
                matches.append(safe)

    return {
        "success": True,
        "query": value,
        "field": field,
        "found": bool(matches),
        "count": len(matches),
        "results": matches,
    }

with gr.Blocks(title="Tgdata API Demo") as demo:
    gr.Markdown("# Tgdata API Demo\nSynthetic test records only.")
    q = gr.Textbox(label="Search value", value="1646744189")
    field = gr.Dropdown(
        ["user_id", "username", "status", "linked_id", "linked_handle"],
        value="user_id",
        label="Field",
    )
    out = gr.JSON(label="Response")
    gr.Button("Search").click(lookup, [q, field], out)

demo.launch()
'''

space_readme = """---
title: Tgdata API Demo
emoji: 🔎
colorFrom: indigo
colorTo: blue
sdk: gradio
sdk_version: 5.49.1
app_file: app.py
pinned: false
---

Synthetic demo only.
"""

api.upload_file(
    path_or_fileobj=space_app.encode("utf-8"),
    path_in_repo="app.py",
    repo_id=SPACE_ID,
    repo_type="space",
    commit_message="Add Gradio demo app",
)

api.upload_file(
    path_or_fileobj=space_readme.encode("utf-8"),
    path_in_repo="README.md",
    repo_id=SPACE_ID,
    repo_type="space",
    commit_message="Configure Space",
)

print(json.dumps({
    "success": True,
    "dataset": f"https://huggingface.co/datasets/{DATASET_ID}",
    "space": f"https://huggingface.co/spaces/{SPACE_ID}",
}, indent=2))
