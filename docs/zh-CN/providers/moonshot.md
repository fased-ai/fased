---
read_when:
  - 你想配置 Moonshot Kimi 或 Kimi Coding
  - 你需要了解独立端点、密钥和模型引用
summary: 配置 Moonshot Kimi 和 Kimi Coding
title: Moonshot AI
x-i18n:
  model: manual
  provider: manual
  source_path: providers/moonshot.md
---

# Moonshot AI（Kimi）

Moonshot 提供 OpenAI-compatible 的 Kimi API。Fased 当前注册两个路线：

- `moonshot/...`：Moonshot Open Platform API key。
- `kimi-coding/...`：Kimi Coding subscription API key。

两条路线的密钥不可互换。

## 设置

```bash
fased onboard --auth-choice moonshot-api-key
```

Kimi Coding：

```bash
fased onboard --auth-choice kimi-code-api-key
```

浏览器中打开 **Agents**，选择 Agent，然后在 **Agent > Models > Moonshot AI**
保存 key 并选择模型角色。

## 当前模型引用

- `moonshot/kimi-k2.6`
- `moonshot/kimi-k2.5`
- `kimi-coding/kimi-for-coding`

## 示例

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.6" },
      models: {
        "moonshot/kimi-k2.6": { alias: "Kimi K2.6" },
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
      },
    },
  },
}
```

Kimi Coding：

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/kimi-for-coding" },
    },
  },
}
```

## 注意事项

- 国际端点默认是 `https://api.moonshot.ai/v1`。
- 中国端点可通过 **Agent > Models** 的 CN API key 方法保存。
- 运行 `fased models list --all --provider moonshot` 查看本机当前 catalog。
