import { PREFERRED_PROXY_PORT } from '../../../shared/proxyPort'

let proxyPortPromise: Promise<number> | null = null

function configuredDevelopmentPort(): number {
  const raw = import.meta.env.VITE_DELIVE_PROXY_PORT
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : PREFERRED_PROXY_PORT
}

export function getProxyPort(): Promise<number> {
  if (!proxyPortPromise) {
    proxyPortPromise = window.electronAPI?.getProxyPort
      ? window.electronAPI.getProxyPort()
      : Promise.resolve(configuredDevelopmentPort())
  }
  return proxyPortPromise
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

export async function getProxyHttpUrl(path = ''): Promise<string> {
  return `http://localhost:${await getProxyPort()}${normalizePath(path)}`
}

export async function getProxyWebSocketUrl(
  path: string,
  params?: URLSearchParams,
): Promise<string> {
  const query = params?.toString()
  return `ws://localhost:${await getProxyPort()}${normalizePath(path)}${query ? `?${query}` : ''}`
}

export function resetProxyPortCacheForTests(): void {
  proxyPortPromise = null
}
