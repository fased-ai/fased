---
read_when:
  - ゼロからの初回セットアップ
  - 動作するブラウザチャットへの最短ルートを知りたい
summary: Fasedをインストールし、Control UIで最初のチャットを実行します。
title: はじめに
x-i18n:
  generated_at: "2026-05-31T00:00:00Z"
  model: manual
  provider: codex
  source_path: start/getting-started.md
  workflow: 15
---

# はじめに

目標：最小構成でFasedを起動し、ブラウザから最初のチャットを送る。

<Info>
最初はチャネル設定なしで始められます。`fased dashboard`を実行し、Control UIの**Chat**を使います。
</Info>

<Warning>
ウォレット、Mining、Fased Networkなどのオペレーターモジュールを有効化する前に、リポジトリのリスク境界を読んでください：
[`docs/legal/disclaimer.md`](https://github.com/fased-ai/fased/blob/main/docs/legal/disclaimer.md)。
</Warning>

## 前提条件

- Node 24推奨、または`node:sqlite`を含むNode 22.14以降
- macOS、Linux、またはWSL2 Ubuntu上のWindows
- Git

確認：

```bash
node --version
node -e 'require("node:sqlite"); console.log("node:sqlite ok")'
```

## クイックセットアップ

<Steps>
  <Step title="インストール">
    ```bash
    git clone https://github.com/fased-ai/fased.git fased
    cd fased
    ./install.sh
    ```

    Windowsでは、Windows 11またはWindows 10 version 2004/build 19041以降が必要です。管理者PowerShellで`wsl --install -d Ubuntu`を実行し、必要なら再起動してUbuntuを開きます。インストーラとすべての`fased`コマンドはUbuntu内で実行してください。PowerShell、コマンドプロンプト、Git Bash、ネイティブWindows Node.jsはFasedの実行環境としてサポートされません。ウォレット署名はUnix socketを使用します。

  </Step>

  <Step title="オンボーディングを再開する場合">
    `./install.sh`は既定でオンボーディングを実行します。中断した場合や再設定したい場合：

    ```bash
    fased onboard --install-daemon
    ```

    VPSまたは常時稼働ホストでは、先にTailscaleへ参加し、オンボーディングでhosting経路を選びます。

  </Step>

  <Step title="Gatewayを確認">
    ```bash
    fased gateway status
    fased doctor
    ```
  </Step>

  <Step title="Control UIを開く">
    ```bash
    fased dashboard
    ```

    ブラウザがトークンを求める場合は、`fased dashboard`が表示する認証済みリンクまたはGatewayトークンを使います。

  </Step>

  <Step title="モデルを設定してチャットする">
    1. **Agent > Models**を開く。
    2. モデルプロバイダーまたはローカルモデルを設定する。
    3. **Chat**を開く。
    4. 次のような短いテストを送る。

    ```text
    Reply with one sentence: Fased is ready.
    ```

  </Step>
</Steps>

## Control UIで続ける場所

- **Agent > Models**: モデルと認証。
- **Agent > Channels**: チャットアプリの接続。
- **Agent > Services**: Gmail、Calendar、GitHub、web/search、custom APIなど。
- **Agent > Skills / Tools**: Agentが使える能力。
- **Agent > Memory**: セッション、QMD、アーカイブ状態。
- **Agent > Tasks**: 保存された定期タスクと実行結果。
- Wallets、Mining、Fased Network: 必要になった場合だけ設定。

## トラブル時の最初の確認

```bash
fased status
fased gateway status
fased doctor
fased logs --follow
```

よくある原因：

- モデルプロバイダーが未設定。
- Gatewayが別ポートまたは別ホストを見ている。
- ブラウザのControl UI認証が切れている。
- チャネル側のpairingまたはallowlistで止まっている。

## 次のステップ

<CardGroup cols={2}>
  <Card title="Wizard" href="/start/wizard" icon="sparkles">
    `fased onboard`が何を設定し、何を設定しないかを確認します。
  </Card>
  <Card title="Install" href="/install" icon="server">
    Node、Docker、VPS、更新、移行、アンインストール。
  </Card>
  <Card title="Control UI" href="/web/control-ui" icon="layout-dashboard">
    ブラウザUIの構成と役割分担。
  </Card>
  <Card title="Help" href="/help" icon="life-buoy">
    うまく動かない時の入口。
  </Card>
</CardGroup>
