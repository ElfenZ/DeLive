# Local Proxy Server

> Runtime contract for Electron's shared provider proxy and Open API server.

---

## Scenario: Dynamic Electron Proxy Port

### 1. Scope / Trigger

Use this contract when changing Electron startup, provider WebSocket proxy routes, Open API HTTP/WebSocket routes, renderer proxy URLs, or local-server shutdown. The six provider proxies and Open API share one HTTP server.

### 2. Signatures

```ts
startVolcProxyServer(ports?: readonly number[]): Promise<{
  server: http.Server
  port: number
  close(): Promise<void>
}>

window.electronAPI.getProxyPort(): Promise<number>
getProxyHttpUrl(path?: string): Promise<string>
getProxyWebSocketUrl(path: string, params?: URLSearchParams): Promise<string>
```

### 3. Contracts

- Try `23456`, `23457`, `23458`, `23459`, and `23460` in order.
- Retry only `EADDRINUSE`; reject every other bind failure immediately.
- Await a successful `listening` event before attaching the API server or creating a renderer window.
- Keep provider routes and `/api/v1/*` plus `/ws/live` on the same `http.Server`.
- `/ws/live` must pass through provider upgrade routing untouched so the API WebSocket handler can accept it.
- Renderer consumers discover and cache the bound port through typed preload IPC. Vite, standalone server, MCP, and external scripts keep an explicit configured/default port.
- Shutdown terminates WebSocket clients, closes every `WebSocketServer`, and closes the shared HTTP server.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| Preferred port available | Bind `23456`; no fallback warning |
| One or more candidates return `EADDRINUSE` | Try the next candidate and expose the selected port |
| Candidate returns another error | Reject startup without trying later ports |
| All candidates return `EADDRINUSE` | Throw `ProxyPortExhaustedError`; do not create the window |
| Unknown WebSocket route | Destroy the socket |
| `/ws/live` upgrade | Provider router does not destroy it; API auth decides acceptance |
| Runtime port differs from `23456` | Settings shows the actual URLs and warns external clients to update manually |

### 5. Good / Base / Bad Cases

- Good: `23456` is occupied, Electron binds `23457`, renderer providers use IPC-discovered URLs, and external-tool docs retain an explicit fallback notice.
- Base: `23456` binds and all existing external defaults continue to work.
- Bad: each renderer module embeds `localhost:23456`, or startup creates a window before the server reports `listening`.

### 6. Tests Required

- Unit-test ordered selection, non-`EADDRINUSE` failure, and exhaustion.
- Bind real local servers to prove conflict fallback and that `close()` releases the port.
- Assert IPC-derived HTTP/WebSocket URL construction is cached and preserves paths/query parameters.
- Cover `/ws/live` independently from provider upgrade routes when changing routing.

### 7. Wrong vs Correct

#### Wrong

```ts
server.listen(23456)
createWindow()
const url = 'ws://localhost:23456/ws/volc'
```

#### Correct

```ts
const runtime = await startVolcProxyServer()
attachApiServer({ server: runtime.server })
createWindow()
const url = await getProxyWebSocketUrl('/ws/volc')
```
