import { createServer, type Server } from 'http'
import { URL } from 'url'
import { WebSocketServer } from 'ws'
import { attachVolcProxyServer } from '../shared/volcProxyCore'
import { attachMistralProxyServer } from '../shared/mistralProxyCore'
import { attachDeepgramProxyServer } from '../shared/deepgramProxyCore'
import { attachAssemblyAIProxyServer } from '../shared/assemblyaiProxyCore'
import { attachElevenLabsProxyServer } from '../shared/elevenlabsProxyCore'
import { attachGladiaProxyServer } from '../shared/gladiaProxyCore'
import { PROXY_PORT_CANDIDATES, selectProxyPort } from '../shared/proxyPort'

export interface ProxyServerRuntime {
  server: Server
  port: number
  close: () => Promise<void>
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      server.off('listening', onListening)
      server.off('error', onError)
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(port, '127.0.0.1')
  })
}

export async function startVolcProxyServer(
  ports: readonly number[] = PROXY_PORT_CANDIDATES,
): Promise<ProxyServerRuntime> {
  const server = createServer()

  const volcWss = new WebSocketServer({ noServer: true })
  attachVolcProxyServer(volcWss)

  const mistralWss = new WebSocketServer({ noServer: true })
  attachMistralProxyServer(mistralWss)

  const deepgramWss = new WebSocketServer({ noServer: true })
  attachDeepgramProxyServer(deepgramWss)

  const assemblyaiWss = new WebSocketServer({ noServer: true })
  attachAssemblyAIProxyServer(assemblyaiWss)

  const elevenlabsWss = new WebSocketServer({ noServer: true })
  attachElevenLabsProxyServer(elevenlabsWss)

  const gladiaWss = new WebSocketServer({ noServer: true })
  attachGladiaProxyServer(gladiaWss)

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url || '', `http://${request.headers.host}`)

    if (pathname === '/ws/volc') {
      volcWss.handleUpgrade(request, socket, head, (ws) => {
        volcWss.emit('connection', ws, request)
      })
    } else if (pathname === '/ws/mistral') {
      mistralWss.handleUpgrade(request, socket, head, (ws) => {
        mistralWss.emit('connection', ws, request)
      })
    } else if (pathname === '/ws/deepgram') {
      deepgramWss.handleUpgrade(request, socket, head, (ws) => {
        deepgramWss.emit('connection', ws, request)
      })
    } else if (pathname === '/ws/assemblyai') {
      assemblyaiWss.handleUpgrade(request, socket, head, (ws) => {
        assemblyaiWss.emit('connection', ws, request)
      })
    } else if (pathname === '/ws/elevenlabs') {
      elevenlabsWss.handleUpgrade(request, socket, head, (ws) => {
        elevenlabsWss.emit('connection', ws, request)
      })
    } else if (pathname === '/ws/gladia') {
      gladiaWss.handleUpgrade(request, socket, head, (ws) => {
        gladiaWss.emit('connection', ws, request)
      })
    } else if (pathname !== '/ws/live') {
      socket.destroy()
    }
  })

  const webSocketServers = [volcWss, mistralWss, deepgramWss, assemblyaiWss, elevenlabsWss, gladiaWss]
  try {
    const port = await selectProxyPort(async (candidate) => {
      try {
        await listen(server, candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          console.warn(`[Proxy] 端口 ${candidate} 已被占用，尝试下一个候选端口`)
        }
        throw error
      }
    }, ports)

    console.log(`[Proxy] 内置代理服务器已启动: http://localhost:${port}`)
    console.log(`[Proxy] Provider WebSocket: ws://localhost:${port}/ws/{provider}`)

    return {
      server,
      port,
      close: async () => {
        for (const wss of webSocketServers) {
          for (const client of wss.clients) client.terminate()
        }
        await Promise.all(webSocketServers.map((wss) => new Promise<void>((resolve) => wss.close(() => resolve()))))
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve())
          })
        }
      },
    }
  } catch (error) {
    for (const wss of webSocketServers) wss.close()
    if (server.listening) server.close()
    throw error
  }
}
