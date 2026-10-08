export function normalizeOpenAiBaseUrl(baseUrl: string, fallback = ''): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '') || fallback
  try {
    const url = new URL(normalized)
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/+$/, '')
  } catch {
    return normalized
  }
}
