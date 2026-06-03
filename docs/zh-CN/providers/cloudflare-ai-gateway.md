---
summary: Cloudflare AI Gateway 设置（认证 + 模型选择）
title: Cloudflare AI Gateway
x-i18n:
  source_path: providers/cloudflare-ai-gateway.md
---

# Cloudflare AI Gateway

Cloudflare AI Gateway 可以放在上游 provider API 前面，提供分析、缓存、限速和控制。Fased 当前内置 Cloudflare 路径使用 Anthropic Messages API。

- Provider：`cloudflare-ai-gateway`
- Base URL：`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- 默认模型：`cloudflare-ai-gateway/claude-sonnet-4-6`
- API key：`CLOUDFLARE_AI_GATEWAY_API_KEY`

## 快速设置

浏览器：**Agents > Agent > Models > Cloudflare AI Gateway**。

CLI：

```bash
fased onboard --auth-choice cloudflare-ai-gateway-api-key
```

非交互式：

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Gateway 认证

如果 Cloudflare Gateway 启用了额外认证，可以添加 `cf-aig-authorization` header：

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

Fased 普通 picker 当前只显示内置支持模型：

- `cloudflare-ai-gateway/claude-sonnet-4-6`

如果你配置其他 Cloudflare route，请在 **Advanced > Config** 中添加准确的模型条目。
