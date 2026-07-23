# REST API

在设置中启用 Open API 后，DeLive 会暴露本地 REST API。Electron 优先使用端口 **23456**；若端口被占用，会依次回退到 **23457–23460**。

**设置 > Open API** 显示的地址是运行时事实来源。下方示例使用常规的 `23456`；如果设置页显示了回退端口，请替换示例地址。

## Base URL

```
http://localhost:23456/api/v1
```

## 鉴权

配置了令牌时，在 `Authorization` Header 中包含：

```
Authorization: Bearer <your-token>
```

详见 [鉴权](./authentication)。

## 端点

### GET /health

健康检查。**始终可访问**，即使 API 被禁用。

```bash
curl http://localhost:23456/api/v1/health
```

```json
{
  "status": "ok",
  "version": "1.7.0",
  "apiEnabled": true,
  "liveClients": 0
}
```

### GET /sessions

列出会话，支持可选过滤和分页。

**查询参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `search` | string | 在标题和转录中不区分大小写搜索 |
| `limit` | number | 最大返回会话数（默认：20） |
| `offset` | number | 分页偏移量（默认：0） |
| `topicId` | string | 按主题 ID 过滤 |
| `status` | string | 按状态过滤（`recording`、`completed`、`interrupted`） |

```bash
curl "http://localhost:23456/api/v1/sessions?search=standup&limit=5"
```

```json
{
  "sessions": [
    {
      "id": "abc123",
      "title": "Daily Standup",
      "date": "2026-04-17",
      "time": "09:30",
      "status": "completed",
      "duration": 900000,
      "providerId": "soniox",
      "transcriptLength": 4523,
      "hasSummary": true,
      "topicId": null,
      "tagIds": ["tag1"]
    }
  ],
  "total": 1,
  "limit": 5,
  "offset": 0
}
```

### GET /sessions/:id

完整会话详情，包含转录、AI 摘要、思维导图和问答历史。存在纠错数据时，可选的 `correctionMeta` 仅返回兼容状态、来源哈希、数量和时间；不会暴露 Patch 明细或可续跑草稿。

```bash
curl http://localhost:23456/api/v1/sessions/abc123
```

### GET /sessions/:id/transcript

仅纯文本转录。当 AI 纠错已完成时，额外返回纠错后的文本。

```bash
curl http://localhost:23456/api/v1/sessions/abc123/transcript
```

```json
{
  "sessionId": "abc123",
  "transcript": "Good morning everyone...",
  "translatedTranscript": null,
  "correctedTranscript": "Good morning, everyone..."
}
```

### GET /sessions/:id/summary

AI 摘要、行动项、关键词和思维导图。

```bash
curl http://localhost:23456/api/v1/sessions/abc123/summary
```

```json
{
  "id": "abc123",
  "title": "Daily Standup",
  "postProcess": {
    "summary": "团队讨论了...",
    "actionItems": ["审查 PR #42", "更新文档"],
    "keywords": ["sprint", "deployment"],
    "chapters": [],
    "status": "success"
  },
  "mindMap": {
    "markdown": "# Daily Standup\n## Topics\n...",
    "status": "success"
  }
}
```

### GET /topics

列出所有主题。

```bash
curl http://localhost:23456/api/v1/topics
```

### GET /tags

列出所有标签。

```bash
curl http://localhost:23456/api/v1/tags
```

### GET /status

当前录制状态和应用信息。

```bash
curl http://localhost:23456/api/v1/status
```

```json
{
  "isRecording": false,
  "recordingState": "paused",
  "currentSessionId": "abc123",
  "version": "2.5.5",
  "liveClients": 0
}
```

`recordingState` 的取值为 `idle`、`starting`、`recording`、`pausing`、`paused`、`resuming`、`stopping` 或 `switching`。仅当音频正在录制（`recordingState: "recording"`）时，`isRecording` 才为 `true`。暂停会话返回 `isRecording: false`，但会保留其 `currentSessionId`。

REST API 仅提供录制状态读取，不提供远程暂停或恢复端点。暂停和恢复不会发送 `session-start` 或 `session-end` WebSocket 生命周期事件，因为会话并未改变。

## 错误响应

| 状态码 | 含义 |
|--------|------|
| `403` | Open API 已禁用 |
| `401` | 无效或缺少 Bearer Token |
| `404` | 会话未找到 |
| `500` | 内部服务器错误 |

## IPC 超时

需要从渲染进程获取数据的 API 请求有 **5 秒超时**。如果渲染进程未及时响应，API 返回空/默认数据，状态码 `200`。
