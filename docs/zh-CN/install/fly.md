---
title: "Fly.io（不支持的归档）"
summary: "历史 Fly.io 容器部署参考；不是受支持的 Fased 安装路径"
read_when:
  - 你发现了旧 Fly.io manifest 或旧部署指南
  - 你需要把 Fly.io 部署迁移到受支持的 VPS
---

# Fly.io（不支持的归档）

Fased 当前不支持在 Fly.io 上运行完整 Gateway。`deploy/hosting/fly*.toml` 只作为历史
参考保留，不是维护或发布测试覆盖的安装路径。

<Warning>
不要用归档 Fly manifest 创建新部署。它缺少受支持 Hosting profile 所需的 root 管理
原生签名器/更新器、独立应用与控制 socket、Tailscale-first 主机加固、协调回滚和冷启动
验证。不得在该路径启用 Wallet、Vault 或 SAT Mining。
</Warning>

- 常驻服务器：创建普通 Linux VPS，并使用[受维护的 VPS Hosting 安装器](/install/vps)。
- 自己电脑上的容器化 Gateway：使用[本地 Docker](/install/docker)。

不存在 `install.sh --hosting-docker`。私有 Fly proxy 或 volume 不能把归档部署变成受支持
的 Hosting 安全与更新生命周期。

迁移旧 Fly 部署时，先停止变更并备份配置/工作区；把导出视为敏感数据。只把经审查、
兼容的非 custody 配置恢复到干净的 `install.sh --hosting` VPS，然后通过原生签名器重新
注册钱包。新主机的 health、Gateway、plugin、signer 和 channel 全部验证并备份后，
才能删除旧 app、volume 和 secret。
