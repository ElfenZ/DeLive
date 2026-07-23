export const PREFERRED_PROXY_PORT = 23456
export const PROXY_PORT_CANDIDATES = [23456, 23457, 23458, 23459, 23460] as const

export class ProxyPortExhaustedError extends Error {
  constructor(public readonly ports: readonly number[]) {
    super(`All local proxy ports are in use: ${ports.join(', ')}`)
    this.name = 'ProxyPortExhaustedError'
  }
}

export function isAddressInUseError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'EADDRINUSE'
}

export async function selectProxyPort(
  tryBind: (port: number) => Promise<void>,
  ports: readonly number[] = PROXY_PORT_CANDIDATES,
): Promise<number> {
  for (const port of ports) {
    try {
      await tryBind(port)
      return port
    } catch (error) {
      if (!isAddressInUseError(error)) throw error
    }
  }
  throw new ProxyPortExhaustedError(ports)
}
