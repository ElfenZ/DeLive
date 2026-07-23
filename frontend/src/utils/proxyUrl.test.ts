import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProxyPortExhaustedError,
  selectProxyPort,
} from '../../../shared/proxyPort'
import {
  getProxyHttpUrl,
  getProxyPort,
  getProxyWebSocketUrl,
  resetProxyPortCacheForTests,
} from './proxyUrl'

describe('dynamic proxy port selection', () => {
  it('selects the first available candidate', async () => {
    const attempts: number[] = []
    const selected = await selectProxyPort(async (port) => {
      attempts.push(port)
      if (port < 23458) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' })
    })
    expect(selected).toBe(23458)
    expect(attempts).toEqual([23456, 23457, 23458])
  })

  it('fails immediately for non-address-conflict errors', async () => {
    const attempts: number[] = []
    await expect(selectProxyPort(async (port) => {
      attempts.push(port)
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })).rejects.toMatchObject({ code: 'EACCES' })
    expect(attempts).toEqual([23456])
  })

  it('reports exhaustion after every candidate is occupied', async () => {
    await expect(selectProxyPort(async () => {
      throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' })
    })).rejects.toBeInstanceOf(ProxyPortExhaustedError)
  })
})

describe('proxy URL discovery', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    resetProxyPortCacheForTests()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  })

  it('caches the Electron runtime port and builds HTTP/WebSocket routes', async () => {
    const getProxyPortMock = vi.fn().mockResolvedValue(23458)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electronAPI: { getProxyPort: getProxyPortMock } },
    })
    resetProxyPortCacheForTests()

    expect(await getProxyPort()).toBe(23458)
    expect(await getProxyHttpUrl('/api/v1/')).toBe('http://localhost:23458/api/v1/')
    expect(await getProxyWebSocketUrl('/ws/volc', new URLSearchParams({ a: '1' })))
      .toBe('ws://localhost:23458/ws/volc?a=1')
    expect(getProxyPortMock).toHaveBeenCalledTimes(1)
  })
})
