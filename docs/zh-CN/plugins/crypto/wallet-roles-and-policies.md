---
summary: "永久 wallet role、signer-owned baseline 与明确 automation grant。"
read_when:
  - 你在选择 Agent、Mining 或 Vault role
  - 你在配置 signer policy 或 skill wallet 权限
title: "Wallet role 与 policy"
---

# Wallet role 与 policy

创建或导入前先选择 role。signer 会把 role 记录为 immutable；用途变化时创建
另一个 wallet。

| Role   | 正常用途                                                             | Built-in baseline                                                |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Agent  | reviewed payment 与明确批准的 Agent work                             | exact reviewed destination 下的 SOL/SPL transfer 与 positive cap |
| Mining | SAT capital、commit/reveal/settlement/claim/cleanup/ALT 与 SAT sweep | release-bound typed SAT action 与 reviewed owner movement        |
| Vault  | reserve、bond 与 federation authority                                | manual reviewed SOL/SPL transfer；不允许 background automation   |

Agent/Vault 可有多个；只能有一个 active Mining。Display name 只用于显示，risky
request 使用 wallet ID 或 `@wallet:<walletId>`。

## Role-ready 不等于 unlimited

Create/import/recovery 会一起激活 signer-owned role baseline v1 与一个 verified
primary RPC。只有 live role/address、policy version/hash、baseline version、network
version/hash 与 registry 都一致时才 authoritative ready。

任何缺失 operation、program、asset、destination 或 positive cap 的动作仍然拒绝。
Legacy explicit deny-all wallet 保持 deny-all，直到 owner review immutable role 后
明确选择一次 **Activate role baseline**。

## Wallet selection

创建 Agent wallet 不会自动设 fallback。Operator 可以明确设置一个
**Default Agent wallet**。risky action 的 precedence：

1. explicit wallet；
2. approved skill wallet override；
3. Agent assignment；
4. Default Agent wallet。

ambiguity 或 missing selection 会 fail closed。Mining/Vault 不能成为 Default Agent。

## Skill grant

Skill 只能使用 Agent wallet。安装 skill 与授予 wallet authority 是两次独立决定。
请求必须匹配 exact skill/source、Agent role、wallet ID、chain、action、mint、amount、
slippage、autonomous 与 schedule permission。Signer policy 始终是最后一道限制。

## Custody

Control UI account passkey 只保护 web account，不代表 wallet readiness。Private
key 与 recovery password 只留在 native terminal/signer path，不进入普通 Gateway
或 browser UI。异常后停止 Agent/miner 并不等于 custody lock；还要收紧 signer
policy 并 reconcile unknown submission。

详见 [Wallet CLI](/cli/wallet)、[Wallet selection](/plugins/crypto/wallet-selection-contract)
与 [Mining](/plugins/crypto/mining-page)。
