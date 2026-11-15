# spxnso micro-fork — patch notes

Fork of [codefuturist/email-mcp](https://github.com/codefuturist/email-mcp) carrying **one
patch commit** on top of upstream `main`:

## What the patch does

`send_email` / `reply_email` accept **inline base64 attachments**, in addition to local
file paths:

```json
{
  "attachments": [
    {
      "content": "<base64-encoded file>",
      "filename": "report.pdf",
      "contentType": "application/pdf",
      "cid": "optional-for-inline-images"
    }
  ]
}
```

Rationale: the server runs in a Docker container (self-hosted, Coolify), while the MCP
client runs elsewhere — there is no shared filesystem, so path-based attachments are
unusable from a remote client. Base64 entries are decoded server-side, written to a
per-call temp directory, then follow the exact same size-cap (base64-encoded total vs
`[settings.send] max_attachment_mb`) and cid/contentType handling as filesystem
attachments.

### Files changed

- `src/services/attachments.ts` — `AttachmentInput` gains optional `content`; when set,
  `filename` is required and `path` must be absent. Base64 entries are decoded once and
  written under a `mkdtemp` directory (basename applied, so the temp write cannot escape
  it).
- `src/tools/send.tool.ts` — `attachmentInputSchema` gains the optional `content` field,
  strict mode preserved, plus an XOR refine (exactly one of `path` / `content`).
  Descriptions updated on `send_email` and `reply_email`.

Everything else is untouched upstream code.

## Automation

`.github/workflows/sync-upstream-and-build.yml`:

- **Weekly** (Mon 04:23 UTC): rebases this patch commit onto upstream `main` and pushes.
  A successful push triggers the build job. If upstream touched the same files, the
  rebase fails loudly (GitHub notification) — resolve the conflict, force-push, done.
- **On push to `main`**: builds the repo Dockerfile and pushes
  `ghcr.io/spxnso/email-mcp:latest` (+ commit SHA tag) for linux/amd64.

## Deployment (Coolify)

The production container runs the GHCR image with
`CMD ["http", "--host", "0.0.0.0", "--port", "8080"]`; the account config is mounted as a
Coolify file storage at `/home/node/.config/email-mcp/config.toml` and all secrets come
from environment variables — no secrets in this image.
