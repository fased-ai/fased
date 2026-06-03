---
title: "Files and Document Extraction"
summary: "Document attachment extraction for chat, tasks, channels, and OpenResponses input_file."
read_when:
  - Configuring document attachments
  - Replacing document-extract plugin behavior with Fased Services
  - Setting PDF, MIME, URL, and size limits
---

# Files and Document Extraction

Fased has a built-in **Files / document extraction** service. It is configured
from **Agent > Services** and uses the gateway file limits under
`gateway.http.endpoints.responses.files`.

This is the Fased replacement for copying a generic document-extract extension:
document handling is a Media/Files service contract, not a random extension
card and not an Agent model provider.

## What It Does

The service extracts bounded text from attachments before the Agent sees them:

- local chat/task/channel attachments;
- OpenResponses `input_file` parts;
- URL-based file inputs when URL fetch is allowed;
- text, Markdown, HTML, CSV, JSON, and PDF.

PDFs use text extraction first. If a PDF has too little embedded text and the
optional canvas dependency is available, Fased can render bounded page images
for model-side understanding.

## Configure

Open **Agent > Services > Files / document extraction**.

Common fields:

- **Allow URL files**: lets OpenResponses file inputs fetch remote documents.
- **Allowed MIME types**: restricts file types. Leave empty for the built-in
  conservative defaults.
- **URL allowlist**: restricts remote file hosts. Use exact hosts or
  `*.example.com`.
- **Max bytes / max chars**: caps how much data is fetched and injected.
- **PDF pages / pixels / text threshold**: caps PDF parsing and fallback render.

Example raw config:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          files: {
            allowUrl: true,
            urlAllowlist: ["docs.example.com", "*.trusted.example"],
            allowedMimes: ["text/plain", "text/markdown", "application/pdf"],
            maxBytes: 5242880,
            maxChars: 200000,
            pdf: { maxPages: 4, maxPixels: 4000000, minTextChars: 200 },
          },
        },
      },
    },
  },
}
```

## Access Control

The Files service configures extraction. It does not grant every Agent file
tools automatically.

- Use **Agent > Tools** to allow or deny file/media tools per Agent.
- Keep URL fetching disabled or allowlisted when the gateway is reachable from a
  hosted environment.
- Treat extracted document text as untrusted external content.

## Related

- [Media understanding](/nodes/media-understanding)
- [Tools](/tools/index)
- [Gateway security](/gateway/security)
