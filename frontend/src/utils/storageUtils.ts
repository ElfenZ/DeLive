import type { Tag, TranscriptSession } from '../types'
import { hasPostProcessContent } from './transcriptState'
import { formatCorrectionProjection, projectCorrectionOntoSegments } from './correctedSegmentProjection'

const MAX_SESSION_EXPORT_FILENAME_LENGTH = 240

export type SessionExportExtension = 'txt' | 'md' | 'srt' | 'vtt'
export type SessionExportVariant = 'corrected' | 'ai-analysis'

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toISOString().split('T')[0]
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toTimeString().slice(0, 5)
}

function padLocalDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

function truncateUtf16Safely(value: string, maxLength: number): string {
  const truncated = value.slice(0, Math.max(0, maxLength))
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1)
  return lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF ? truncated.slice(0, -1) : truncated
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character
  }).join('')
}

function sanitizeSessionExportTitle(title: string): string {
  const sanitized = replaceControlCharacters(title)
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return sanitized || 'transcript'
}

export function buildSessionExportFilename(
  session: Pick<TranscriptSession, 'createdAt' | 'title'>,
  extension: SessionExportExtension,
  variant?: SessionExportVariant,
): string {
  const date = new Date(Number.isFinite(session.createdAt) ? session.createdAt : 0)
  const timestamp = [
    String(date.getFullYear()).padStart(4, '0'),
    padLocalDatePart(date.getMonth() + 1),
    padLocalDatePart(date.getDate()),
  ].join('-') + `_${[
    padLocalDatePart(date.getHours()),
    padLocalDatePart(date.getMinutes()),
    padLocalDatePart(date.getSeconds()),
  ].join('-')}`
  const variantSuffix = variant ? `_${variant}` : ''
  const fixedLength = timestamp.length + 1 + variantSuffix.length + 1 + extension.length
  const titleLength = Math.max(1, MAX_SESSION_EXPORT_FILENAME_LENGTH - fixedLength)
  const title = truncateUtf16Safely(sanitizeSessionExportTitle(session.title), titleLength)
    .replace(/[. ]+$/g, '') || 'transcript'
  return `${timestamp}_${title}${variantSuffix}.${extension}`
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function exportToTxt(session: TranscriptSession, tags?: Tag[]): void {
  const sessionTags = tags?.filter((tag) => session.tagIds?.includes(tag.id)) || []
  const tagNames = sessionTags.map((tag) => tag.name).join(', ')
  const translatedText = session.translatedTranscript?.text?.trim()
  const transcriptBody = buildTranscriptExportBody(session, 'txt')

  const content = `标题: ${session.title}
日期: ${session.date}
时间: ${session.time}${tagNames ? `\n标签: ${tagNames}` : ''}
${'='.repeat(50)}

${transcriptBody}
${translatedText ? `\n\n${'-'.repeat(20)}\n翻译\n${'-'.repeat(20)}\n\n${translatedText}\n` : ''}
`

  triggerDownload(
    new Blob([content], { type: 'text/plain;charset=utf-8' }),
    buildSessionExportFilename(session, 'txt'),
  )
}

export function exportToMarkdown(session: TranscriptSession, tags?: Tag[]): void {
  const sessionTags = tags?.filter((tag) => session.tagIds?.includes(tag.id)) || []
  const tagNames = sessionTags.map((tag) => `\`${tag.name}\``).join(' ')
  const translatedText = session.translatedTranscript?.text?.trim()
  const transcriptBody = buildTranscriptExportBody(session, 'markdown')

  const lines: string[] = []
  lines.push(`# ${session.title}`)
  lines.push('')
  lines.push(`> ${session.date} ${session.time}${tagNames ? ` | ${tagNames}` : ''}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(transcriptBody)

  if (translatedText) {
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push('## Translation')
    lines.push('')
    lines.push(translatedText)
  }

  lines.push('')

  triggerDownload(
    new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }),
    buildSessionExportFilename(session, 'md'),
  )
}

export function buildTranscriptExportBody(
  session: TranscriptSession,
  format: 'txt' | 'markdown',
): string {
  const projection = projectCorrectionOntoSegments(session.transcript, session.segments, [])
  return projection.status === 'projected'
    ? formatCorrectionProjection(projection, session.speakers, format)
    : session.transcript
}

function formatTimestamp(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString() : ''
}

function getAiAnalysisFilename(session: TranscriptSession, extension: 'txt' | 'md'): string {
  return buildSessionExportFilename(session, extension, 'ai-analysis')
}

export function buildAiAnalysisTxt(session: TranscriptSession): string {
  const postProcess = session.postProcess
  if (postProcess?.status !== 'success' || !hasPostProcessContent(postProcess)) {
    return ''
  }

  const lines: string[] = [
    `标题: ${session.title}`,
    `日期: ${session.date}`,
    `时间: ${session.time}`,
  ]

  if (postProcess.model) lines.push(`模型: ${postProcess.model}`)
  if (postProcess.requestedAt) lines.push(`请求时间: ${formatTimestamp(postProcess.requestedAt)}`)
  if (postProcess.generatedAt) lines.push(`生成时间: ${formatTimestamp(postProcess.generatedAt)}`)

  lines.push('='.repeat(50), '')

  if (postProcess.titleSuggestion?.trim()) {
    lines.push('标题建议', '-'.repeat(20), postProcess.titleSuggestion.trim(), '')
  }

  if (postProcess.summary?.trim()) {
    lines.push('摘要', '-'.repeat(20), postProcess.summary.trim(), '')
  }

  if (postProcess.actionItems?.length) {
    lines.push('行动项', '-'.repeat(20))
    postProcess.actionItems
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item, index) => lines.push(`${index + 1}. ${item}`))
    lines.push('')
  }

  if (postProcess.keywords?.length) {
    const keywords = postProcess.keywords.map((item) => item.trim()).filter(Boolean)
    if (keywords.length) lines.push('关键词', '-'.repeat(20), keywords.join(', '), '')
  }

  if (postProcess.chapters?.length) {
    const chapters = postProcess.chapters.filter((chapter) => chapter.title?.trim() || chapter.summary?.trim())
    if (chapters.length) {
      lines.push('章节', '-'.repeat(20))
      chapters.forEach((chapter, index) => {
        lines.push(`${index + 1}. ${chapter.title?.trim() || 'Untitled'}`)
        if (chapter.summary?.trim()) lines.push(`   ${chapter.summary.trim()}`)
      })
      lines.push('')
    }
  }

  if (postProcess.tagSuggestions?.length) {
    const tags = postProcess.tagSuggestions.map((item) => item.trim()).filter(Boolean)
    if (tags.length) lines.push('标签建议', '-'.repeat(20), tags.join(', '), '')
  }

  return `${lines.join('\n').trim()}\n`
}

export function buildAiAnalysisMarkdown(session: TranscriptSession): string {
  const postProcess = session.postProcess
  if (postProcess?.status !== 'success' || !hasPostProcessContent(postProcess)) {
    return ''
  }

  const lines: string[] = [
    `# ${session.title} AI Analysis`,
    '',
    `> ${session.date} ${session.time}`,
  ]

  const metadata: string[] = []
  if (postProcess.model) metadata.push(`Model: ${postProcess.model}`)
  if (postProcess.requestedAt) metadata.push(`Requested: ${formatTimestamp(postProcess.requestedAt)}`)
  if (postProcess.generatedAt) metadata.push(`Generated: ${formatTimestamp(postProcess.generatedAt)}`)
  if (metadata.length) lines.push(`> ${metadata.join(' | ')}`)

  lines.push('', '---', '')

  if (postProcess.titleSuggestion?.trim()) {
    lines.push('## Title Suggestion', '', postProcess.titleSuggestion.trim(), '')
  }

  if (postProcess.summary?.trim()) {
    lines.push('## Summary', '', postProcess.summary.trim(), '')
  }

  if (postProcess.actionItems?.length) {
    const items = postProcess.actionItems.map((item) => item.trim()).filter(Boolean)
    if (items.length) {
      lines.push('## Action Items', '')
      items.forEach((item) => lines.push(`- ${item}`))
      lines.push('')
    }
  }

  if (postProcess.keywords?.length) {
    const keywords = postProcess.keywords.map((item) => item.trim()).filter(Boolean)
    if (keywords.length) lines.push('## Keywords', '', keywords.map((item) => `\`${item}\``).join(' '), '')
  }

  if (postProcess.chapters?.length) {
    const chapters = postProcess.chapters.filter((chapter) => chapter.title?.trim() || chapter.summary?.trim())
    if (chapters.length) {
      lines.push('## Chapters', '')
      chapters.forEach((chapter, index) => {
        lines.push(`### ${index + 1}. ${chapter.title?.trim() || 'Untitled'}`)
        if (chapter.summary?.trim()) lines.push('', chapter.summary.trim())
        lines.push('')
      })
    }
  }

  if (postProcess.tagSuggestions?.length) {
    const tags = postProcess.tagSuggestions.map((item) => item.trim()).filter(Boolean)
    if (tags.length) lines.push('## Tag Suggestions', '', tags.map((item) => `\`${item}\``).join(' '), '')
  }

  return `${lines.join('\n').trim()}\n`
}

export function exportAiAnalysisToTxt(session: TranscriptSession): void {
  const content = buildAiAnalysisTxt(session)
  if (!content) return
  triggerDownload(
    new Blob([content], { type: 'text/plain;charset=utf-8' }),
    getAiAnalysisFilename(session, 'txt'),
  )
}

export function exportAiAnalysisToMarkdown(session: TranscriptSession): void {
  const content = buildAiAnalysisMarkdown(session)
  if (!content) return
  triggerDownload(
    new Blob([content], { type: 'text/markdown;charset=utf-8' }),
    getAiAnalysisFilename(session, 'md'),
  )
}
