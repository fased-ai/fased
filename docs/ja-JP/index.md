---
read_when:
  - 新規ユーザーにFasedを紹介するとき
summary: Fasedは、Gateway、Control UI、チャネル、ツール、タスク、ウォレット関連モジュールを備えたセルフホスト型エージェントランタイムです。
title: Fased
x-i18n:
  generated_at: "2026-05-31T00:00:00Z"
  model: manual
  provider: codex
  source_path: index.md
  workflow: 15
---

# Fased

**Fasedは、あなたが管理するマシンまたはサーバーで動くセルフホスト型エージェントランタイムです。**

<Columns>
  <Card title="はじめに" href="/start/getting-started" icon="rocket">
    インストールから最初のブラウザチャットまでの最短ルート。
  </Card>
  <Card title="ウィザード" href="/start/wizard" icon="sparkles">
    `fased onboard`でランタイム、Gateway、ワークスペースを設定します。
  </Card>
  <Card title="Control UI" href="/web/control-ui" icon="layout-dashboard">
    Agent、Models、Channels、Services、Tasksをブラウザで管理します。
  </Card>
</Columns>

## 何をするものか

Fasedはチャットアプリだけではありません。Gatewayがランタイムの中心になり、Agentのセッション、ルーティング、ツール、メモリ、タスク、ノード接続を扱います。

## 基本の流れ

1. インストールする。
2. `fased onboard`でGatewayとワークスペースを作る。
3. `fased dashboard`でControl UIを開く。
4. **Agent > Models**でモデルを設定する。
5. **Chat**で最初のメッセージを送る。
6. 必要な機能だけ追加する。

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh
fased dashboard
```

## 主な領域

## 次に読む

- [Getting Started](/start/getting-started)
- [Wizard](/start/wizard)
- [Install](/install)
- [Features](/concepts/features)
- [Gateway security](/gateway/security)
- [Help](/help)
