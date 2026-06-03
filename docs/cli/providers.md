---
summary: "Advanced provider catalog and manually curated model entry tools."
read_when:
  - You maintain provider/model catalog entries
  - You need to review provider refresh patches
title: "providers"
---

# `fased providers`

`fased providers` is an advanced catalog-maintenance command. Normal users
should set up model accounts and choose models in **Agent > Models** or through
[`fased models`](/cli/models).

Use this command when you are reviewing provider registry updates or adding a
manual model entry for a custom provider.

## Refresh catalog review

```bash
fased providers refresh
fased providers refresh --no-network
fased providers refresh --from-file snapshot.json
fased providers refresh --json
fased providers refresh --write-review
fased providers refresh --write-review provider-refresh.review.patch
fased providers refresh --apply
fased providers refresh --wizard
```

`refresh` compares the local provider registry against official/source catalog
data. Prefer `--write-review` first so you can inspect the generated patch.

## Manual model entries

```bash
fased providers models list
fased providers models list --provider custom-local
fased providers models add --provider custom-local --model my-model --base-url http://127.0.0.1:8000/v1
fased providers models add --provider custom-local --model my-model --name "My Model" --api openai-responses --tools --json
fased providers models remove --provider custom-local --model my-model
fased providers models delete --provider custom-local --model my-model
```

Manual entries write `models.providers.<provider>.models`. They make a model
visible to model resolution; the selected Agent still owns which model refs it
uses.

`models add` can also record `--context-window`, `--max-tokens`,
`--reasoning`, `--vision`, `--audio`, `--video`, and `--speech` capability
metadata for custom providers.

Related:

- [Models CLI](/cli/models)
- [Provider docs](/providers/index)
- [Model concepts](/concepts/models)
