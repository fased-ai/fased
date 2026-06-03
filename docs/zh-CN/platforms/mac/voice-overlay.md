---
read_when:
  - 调整语音浮层行为
summary: 唤醒词与按键说话重叠时的语音浮层生命周期
title: 语音浮层
x-i18n:
  generated_at: "2026-02-01T21:33:26Z"
  model: manual
  provider: manual
  source_hash: 3be1a60aa7940b2368ff62cd49f04b2b8422876030e8ea206b467f66a5a6bd4d
  source_path: platforms/mac/voice-overlay.md
  workflow: 15
---

# 语音浮层生命周期（macOS）

受众：macOS 应用贡献者。目标：在唤醒词与按键说话重叠时保持语音浮层行为可预测。

### 当前意图

- 如果浮层已因唤醒词显示，此时用户按下热键，热键会话会*接管*现有文本而非重置。浮层在热键按住期间保持显示。用户松开时：如果有去除空白后的文本则发送，否则关闭。
- 单独使用唤醒词时仍在静音后自动发送；按键说话在松开时立即发送。

### 已实现（2025 年 12 月 9 日）

- 浮层会话现在为每次捕获（唤醒词或按键说话）携带一个令牌。当令牌不匹配时，部分/最终/发送/关闭/音量更新会被丢弃，避免过时回调。
- 按键说话会接管任何可见的浮层文本作为前缀（因此在唤醒浮层显示时按下热键会保留文本并追加新语音）。它最多等待 1.5 秒获取最终转录结果，然后回退到当前文本。
- 提示音/浮层日志以 `info` 级别输出，分类包括 `voicewake.runtime`、`voicewake.coordinator`、`voicewake.overlay`、`voicewake.ptt`、`voicewake.forward` 和 `voicewake.chime`。

### 当前结构

- `VoiceSessionCoordinator` 拥有当前 tokenized 语音会话，并丢弃过时的 partial/final/send/dismiss 回调。
- `VoiceWakeRuntime` 处理唤醒词捕获、静音窗口、硬停止和 dismiss 后重启。
- `VoicePushToTalk` 处理右 Option/Cmd+Fn 按键说话路径，并在热键会话活跃时暂停唤醒词捕获。
- `VoiceWakeOverlayController` 渲染浮层，并通过当前会话 token 回传用户操作。

### 调试清单

- 复现浮层粘滞问题时流式查看日志：

  ```bash
  sudo log stream --predicate 'subsystem == "ai.fased" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 验证只有一个活跃会话令牌；过时回调应被 coordinator 丢弃。
- 确保按键说话松开时始终使用活跃令牌调用 `endCapture`；如果文本为空，预期 `dismiss` 且不播放提示音或发送。
