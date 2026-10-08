function truncateUtf16Safely(value: string, maxLength: number): string {
  const truncated = value.slice(0, Math.max(0, maxLength))
  const last = truncated.charCodeAt(truncated.length - 1)
  return last >= 0xD800 && last <= 0xDBFF ? truncated.slice(0, -1) : truncated
}

export function buildStorageFileName(
  session: { createdAt: number; title: string }, extension: string, variant?: string, maxLength = 240,
): string {
  if (!/^[a-zA-Z0-9]{1,12}$/.test(extension) || (variant && !/^[a-z-]+$/.test(variant))) throw new Error('Invalid filename extension or variant')
  const date = new Date(Number.isFinite(session.createdAt) ? session.createdAt : 0)
  const pad = (value: number) => String(value).padStart(2, '0')
  const timestamp = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  const suffix = `${variant ? `_${variant}` : ''}.${extension}`
  const available = maxLength - timestamp.length - 1 - suffix.length
  if (available < 1) throw new Error('Directory path is too long for a safe filename')
  const cleaned = Array.from(session.title, (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character
  }).join('').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '') || 'transcript'
  const title = truncateUtf16Safely(cleaned, available).replace(/[. ]+$/g, '') || 't'
  return `${timestamp}_${title}${suffix}`
}
