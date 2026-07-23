import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { startVolcProxyServer, type ProxyServerRuntime } from '../../../electron/volcProxy'

const openServers: Server[] = []
const runtimes: ProxyServerRuntime[] = []

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  openServers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  return address.port
}

async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server, 0)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  openServers.splice(openServers.indexOf(server), 1)
  return port
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)))
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('Electron proxy server binding', () => {
  it('binds the first available candidate and releases it on close', async () => {
    const port = await freePort()
    const runtime = await startVolcProxyServer([port])
    runtimes.push(runtime)
    expect(runtime.port).toBe(port)
    expect(runtime.server.listening).toBe(true)

    await runtime.close()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    const rebound = createServer()
    await listen(rebound, port)
    expect(rebound.listening).toBe(true)
  })

  it('falls back after consecutive address conflicts', async () => {
    const first = await freePort()
    const second = await freePort()
    await listen(createServer(), first)
    const runtime = await startVolcProxyServer([first, second])
    runtimes.push(runtime)
    expect(runtime.port).toBe(second)
  })

  it('does not retry non-EADDRINUSE bind errors', async () => {
    const second = await freePort()
    await expect(startVolcProxyServer([-1, second])).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' })
  })
})
