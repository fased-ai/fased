---
summary: "创建、导入、恢复、路由、检查和退役 signer-owned wallet。"
read_when:
  - 你要创建 Agent、Mining 或 Vault wallet
  - 你需要 RPC、recovery、routing 或 retirement 命令
title: "wallet"
---

# `fased wallet`

Local 与 Hosting 使用相同 public command。Hosting 中由 `app` operator 通过
受限 signer socket 执行；Gateway 不能使用 lifecycle 权限。

## 创建

```bash
fased wallet create \
  --wallet-id agent --wallet-name "Agent" --role agent \
  --rpc-url https://your-solana-rpc.example --non-interactive
```

明确选择永久 `agent`、`mining` 或 `vault` role。signer 创建 key、激活
role baseline v1、验证一个 primary RPC，并返回 authoritative readiness。创建
Agent 不会自动设为 Default Agent wallet。

## 导入

```bash
chmod 600 /absolute/path/to/solana-keypair.json
fased wallet import \
  --wallet-id mining --wallet-name "Mining" --role mining \
  --file /absolute/path/to/solana-keypair.json \
  --rpc-url https://your-solana-rpc.example --non-interactive
```

key file 必须由当前 terminal user 拥有、mode `0600`、regular、非 symlink、
single-link。内容直接进入 native signer，不经过 argv、env、chat、log 或普通
browser API。

## Recovery

```bash
fased wallet recovery export \
  --wallet-id agent --output /absolute/new/agent-recovery.json
```

```bash
fased wallet recovery import \
  --wallet-id agent-restored --wallet-name "Restored Agent" --role agent \
  --file /absolute/path/agent-recovery.json \
  --rpc-url https://your-solana-rpc.example
```

password 只由 signer 从 native terminal 读取。不要放入 command argument、env、
browser 或 chat。

## Default Agent 与 routing

```bash
fased wallet role set agent agent --primary
```

risky Agent action 的顺序是 explicit wallet、skill grant 中唯一 wallet override、
Agent assignment、最后 optional Default Agent wallet。Mining 不参与 generic
skill routing；Vault 只允许 reviewed/manual。

## Legacy baseline activation

Legacy deny-all wallet 不会自动扩权。review immutable role 后执行一次：

```bash
fased wallet policy activate-role-baseline \
  --wallet-id agent --role agent --confirm
```

## Mining retirement

```bash
fased wallet retire \
  --wallet-id mining \
  --successor-wallet-id mining-2 \
  --successor-wallet-name "Mining 2" \
  --recovery-file /absolute/new/mining-recovery.json \
  --rpc-url https://your-solana-rpc.example
```

signer 先确认没有 live work/recoverable balance，保存 encrypted recovery、收紧
old policy、写入不可逆 retirement tombstone，再创建并切换到 distinct role-ready
successor。中断后重跑完全相同命令；retired ID 不能正常恢复使用。

## 状态

```bash
fased wallet status --json
fased wallet signer doctor --json
```

详见 [Wallet role 与 policy](/plugins/crypto/wallet-roles-and-policies) 和
[Mining](/plugins/crypto/mining-page)。
