# 录制

## 典型流程

1. 打开设置，选择一个 Provider（详见 [ASR Provider](./providers)）。
2. 填写凭证（详见 [API Key 获取指引](./api-keys)），运行 **测试配置**。
3. 在 Live 页面点击 **开始录制**。
4. 选择一个屏幕或窗口 — 确保启用了 **音频共享**。
5. 观察部分文本和最终文本在主窗口及可选悬浮字幕窗中实时更新。
6. 点击 **停止录制**。会话被保存，可在历史记录中查看。

![实时转录](/images/screenshot-live.png)

## 音频捕获

DeLive 通过 `getDisplayMedia` 的 loopback 音频捕获 **系统音频**。捕获管线根据 Provider 自动选择合适的音频路径：

| 音频模式 | 格式 | 使用者 |
|---------|------|--------|
| `MediaRecorder` | WebM/Opus 块 | Soniox、本地 OpenAI 兼容 |
| `AudioWorklet` PCM16 | 16 kHz 单声道原始 PCM | 火山引擎、Groq、硅基流动、whisper.cpp |

::: info
你必须选择一个屏幕或窗口来共享。DeLive 捕获你所选来源的音频 — 浏览器标签页、会议应用、媒体播放器或任何其他播放源。
:::

## 会话生命周期

会话经历以下状态：

```
idle → starting → recording → pausing → paused → resuming → recording
                           ↓                        ↓
                        stopping ←──────────────────┘
                           ↓
                       completed
```

- **草稿会话** 在录制开始时创建，每 1.2 秒自动保存。
- **中断会话** 在下次启动时检测，可恢复或忽略。
- **已完成会话** 出现在历史记录列表中，支持复盘、AI 处理和导出。

## 暂停与恢复

暂停会保留当前会话及已选择录制来源的捕获授权，但会停止正在进行的转写和音频交付管线。暂停期间：

- 不会再将新的音频保存到本机或上传到转写服务。
- 录制计时和会话最终时长保持冻结；暂停时间不会写入音频文件、转写时间轴或最终时长。
- 已有转写内容会保留；暂停和恢复不会在正文或导出文件中插入标记。
- 为便于快速恢复，DeLive 会保留捕获授权，因此操作系统可能仍显示屏幕共享或麦克风授权指示。这些指示不表示暂停期间的音频仍在被保存或上传。

若原屏幕、窗口或音频来源仍有效，恢复会在同一来源和会话中继续。若来源在暂停期间失效，恢复时会打开来源选择器；取消选择后会话仍保持暂停，可再次恢复，或停止后保存。

暂停和恢复不会创建或结束会话。会话 ID 保持不变，也不会为这两个状态转换发送 `session-start` 或 `session-end` 实时事件。

## 设备变更

如果录制过程中音频设备发生变化（如插入耳机），DeLive 根据 Provider 的 `captureRestartStrategy` 处理：

- **`reconnect-session`**（Soniox）— 断开 Provider 连接并重新建立新会话
- **`reuse-session`**（其他所有）— 仅重启捕获管线，保持 Provider 连接

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+D` / `Cmd+Shift+D` | 显示/隐藏主窗口 |
| `Ctrl+Shift+R` / `Cmd+Shift+R` | 空闲时开始录制；录制中或暂停时停止并保存当前会话 |
| `Ctrl+Shift+P` / `Cmd+Shift+P` | 录制中暂停；暂停后恢复 |

如果主全局快捷键被其他程序占用，DeLive 会改为注册对应的 `Ctrl+Alt` / `Cmd+Alt` 组合：暂停/恢复使用 `Ctrl+Alt+P` / `Cmd+Alt+P`，开始/停止录制使用 `Ctrl+Alt+R` / `Cmd+Alt+R`。
