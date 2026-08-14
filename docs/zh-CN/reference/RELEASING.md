---
read_when:
  - 发布新的公共版本
  - 发布新的 macOS 应用版本
  - 发布前验证元数据
summary: 当前 Fased 发布流：版本号、变更日志、Git tag、GitHub release，以及可选的 macOS appcast
x-i18n:
  generated_at: "2026-02-03T10:09:28Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 1a684bc26665966eb3c9c816d58d18eead008fd710041181ece38c21c5ff1c62
  source_path: reference/RELEASING.md
  workflow: 15
---

# 发布清单（GitHub release + 可选 macOS appcast）

从仓库根目录使用 `pnpm`（Node 22+）。在打标签/发布前保持工作树干净。

## 操作员触发

当操作员说"release"时，立即执行此预检（除非遇到阻碍否则不要额外提问）：

- 阅读本文档和 `docs/platforms/mac/release.md`。
- 从 `~/.profile` 加载环境变量并确认 `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect 变量已设置（SPARKLE_PRIVATE_KEY_FILE 应位于 `~/.profile` 中）。
- 如需要，使用 `~/Library/CloudStorage/Dropbox/Backup/Sparkle` 中的 Sparkle 密钥。

1. **版本和元数据**

- [ ] 更新 `package.json` 版本（例如 `2026.1.29`）。
- [ ] 运行 `pnpm plugins:sync` 以对齐扩展包版本和变更日志。
- [ ] 更新 CLI/版本字符串：[`src/cli/program.ts`](https://github.com/fased-ai/fased/blob/main/src/cli/program.ts) 和 [`src/provider-web.ts`](https://github.com/fased-ai/fased/blob/main/src/provider-web.ts) 中的 Baileys user agent。
- [ ] 确认包元数据（name、description、repository、keywords、license）以及 `bin` 映射指向 [`fased.mjs`](https://github.com/fased-ai/fased/blob/main/fased.mjs) 作为 `fased`。
- [ ] 如果依赖项有变化，运行 `pnpm install` 确保 `pnpm-lock.yaml` 是最新的。

2. **构建和产物**

- [ ] 如果 A2UI 输入有变化，运行 `pnpm canvas:a2ui:bundle` 并提交更新后的 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/fased-ai/fased/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)。
- [ ] `pnpm run build`（重新生成 `dist/`）。
- [ ] 验证签名 application generation 包含所有必需的 runtime、extension 和 CLI 文件。
- [ ] 确认 `dist/build-info.json` 存在并绑定预期的 commit。

3. **变更日志和文档**

- [ ] 更新 `CHANGELOG.md`，添加面向用户的亮点（如果文件不存在则创建）；按版本严格降序排列条目。
- [ ] 确保 README 示例/标志与当前 CLI 行为匹配（特别是新命令或选项）。

4. **验证**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test`（如需覆盖率输出则使用 `pnpm test:coverage`）
- [ ] `pnpm release:check`（验证 packaged runtime 内容）
- [ ] 使用 protected PRE-CANDIDATE、pre-tag P1 和 candidate P1 验证 Local/Hosting 安装与更新；不要使用已废弃的 npm installer smoke。
- [ ]（可选）如果你的更改影响发送/接收路径，抽查 Web Gateway 网关。

5. **macOS 应用（Sparkle）**

- [ ] 构建并签名 macOS 应用，然后压缩以供分发。
- [ ] 生成 Sparkle appcast（通过 [`scripts/make_appcast.sh`](https://github.com/fased-ai/fased/blob/main/scripts/make_appcast.sh) 生成 HTML 注释）并更新 `appcast.xml`。
- [ ] 保留应用 zip（和可选的 dSYM zip）以便附加到 GitHub 发布。
- [ ] 按照 [macOS 发布](/platforms/mac/release) 获取确切命令和所需环境变量。
  - `APP_BUILD` 必须是数字且单调递增（不带 `-beta`），以便 Sparkle 正确比较版本。
  - 如果进行公证，使用从 App Store Connect API 环境变量创建的 `fased-notary` 钥匙串配置文件（参见 [macOS 发布](/platforms/mac/release)）。

6. **GitHub 发布**

- [ ] 为 `vX.Y.Z` 创建 GitHub release
- [ ] 只附加真实产物
- [ ] 将整理过的发布说明粘贴进 release 正文
- [ ] 不要宣称当前并不存在或尚不可支持的包管理器安装路径

7. **公开仓库后的加固**

- [ ] 仓库公开后，或组织套餐支持私有仓库保护后，启用 `main` 分支保护
- [ ] 禁止 force push 和删除分支
- [ ] 等公开仓库 CI 稳定后再添加必需状态检查
- [ ] 只允许负责发布的维护者保留紧急管理员绕过权限

8. **可选：macOS app + appcast**

如果你要发布已签名的 macOS 桌面构建：

- [ ] 构建并签名 app bundle
- [ ] 打包 zip 供分发
- [ ] 生成 `appcast.xml`
- [ ] 确认 feed URL 指向真实的原始仓库路径：
  - `https://raw.githubusercontent.com/fased-ai/fased/main/appcast.xml`
- [ ] 发布 appcast 指向的 release 产物

参见 [macOS 发布](/platforms/mac/release) 获取确切命令。

## 不会自动发生的事情

这些都是维护者要单独执行的动作：

- 更新 `package.json` 不会自动创建 GitHub release
- 合并 PR 不会自动改写 `CHANGELOG.md`
- 打 tag 本身不会生成 appcast 产物
- appcast 只对 macOS Sparkle 更新路径有意义

## 相关文件

- [`CHANGELOG.md`](https://github.com/fased-ai/fased/blob/main/CHANGELOG.md)
- [`docs/reference/release-notes-template.md`](https://github.com/fased-ai/fased/blob/main/docs/reference/release-notes-template.md)
- [`docs/reference/RELEASING.md`](https://github.com/fased-ai/fased/blob/main/docs/reference/RELEASING.md)

- @fased/discord
- @fased/slack
- @fased/telegram
- @fased/whatsapp

发布说明还必须标注**默认未启用**的**新可选内置插件**（例如：`tlon`）。
