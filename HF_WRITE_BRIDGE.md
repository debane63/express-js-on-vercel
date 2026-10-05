# Hugging Face write bridge

This branch contains a manual GitHub Actions workflow that creates:

- Private dataset: `deban420/tgdata-api-demo`
- Private Gradio Space: `deban420/tgdata-api-demo-space`

The dataset contains synthetic demo rows only.

## Required secret

Add a GitHub repository Actions secret named:

`HF_TOKEN`

Use a Hugging Face User Access Token with write permission. Do not commit the token into this repository.

Then open **Actions → Deploy Hugging Face demo → Run workflow** and choose branch `hf-write-bridge`.
