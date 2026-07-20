---
summary: "创建 role-ready Mining wallet、检查 readiness、充值、运行和安全替换。"
read_when:
  - 你要运行 SAT Mining
  - 你要排查或替换 Mining wallet
title: "Mining"
---

# Mining

Mining 使用一个 dedicated signer-owned wallet。它不能作为 Agent skill、普通
payment 或 Vault wallet 使用。

## 开始

1. 在 **Wallets** 创建 Mining wallet，或在 native Local/Hosting operator terminal
   运行 `fased wallet create --role mining`。
2. 输入一个 primary RPC。signer 会验证 genesis，并安装 release-bound Mining
   role baseline v1。
3. 检查 exact policy/network hash 与 readiness。
4. 只充值你愿意承担风险的小额 SOL，并保留 fee reserve。
5. deposit miner capital，设置 conservative commit。
6. readiness 全绿后再 Start。

```bash
fased mining readiness --wallet mining
fased mining deposit-capital --sol 1
fased mining set-commit --sol 0.75
fased mining start --wallet mining
```

Stop 会阻止新 cycle，但 pending settlement、claim 与 recovery 可以继续。Locked
capital 不会立即释放。

## Retirement 与 replacement

先 Stop，等待 clearing/claim 完成，移动 recoverable funds，再运行：

```bash
fased wallet retire \
  --wallet-id mining \
  --successor-wallet-id mining-2 \
  --successor-wallet-name "Mining 2" \
  --recovery-file /absolute/new/mining-recovery.json \
  --rpc-url https://your-solana-rpc.example
```

signer 会先写不可逆 retirement tombstone，再把 runtime assignment 移到 distinct
role-ready successor。中断时重跑完全相同命令；不要换 successor ID、删除 receipt、
手工修改 registry 或尝试恢复 retired wallet ID。

## 常用检查

```bash
fased mining status --json
fased mining history --window 24h
fased mining readiness --wallet mining
fased wallet signer doctor --json
```

详见 [Wallet role 与 policy](/plugins/crypto/wallet-roles-and-policies) 与
[Mining troubleshooting](/plugins/crypto/mining-troubleshooting)。
