import type { Tag, TranscriptSession } from '../types'
import { buildStorageFileName } from '../../../shared/fileNames'
import { hasPostProcessContent } from './transcriptState'
import {
  formatCorrectionProjection,
  projectCorrectionOntoSegments,
  projectSessionCorrection,
} from './correctedSegmentProjection'

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

export function buildSessionExportFilename(
  session: Pick<TranscriptSession, 'createdAt' | 'title'>,
  extension: SessionExportExtension,
  variant?: SessionExportVariant,
): string {
  return buildStorageFileName(session, extension, variant, MAX_SESSION_EXPORT_FILENAME_LENGTH)
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

export async function saveManualExport(session: Pick<TranscriptSession, 'defaultSaveProjectId'>, content: string, filename: string, mimeType: string): Promise<void> {
  if (!window.electronAPI) {
    triggerDownload(new Blob([content], { type: mimeType }), filename)
    return
  }
  try {
    if (!window.electronAPI.manualExportFile) throw new Error('Desktop manual export is unavailable; restart the updated application.')
    const dot = filename.lastIndexOf('.')
    const suffix = filename.slice(dot)
    const basename = filename.slice(0, dot).slice(0, 220 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix
    const result = await window.electronAPI.manualExportFile({ filename: basename, content, defaultSaveProjectId: session.defaultSaveProjectId })
    if (!result.ok) throw new Error(result.error || 'Export failed')
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error))
  }
}

export function exportToTxt(session: TranscriptSession, tags?: Tag[]): Promise<void> {
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

  return saveManualExport(session, content, buildSessionExportFilename(session, 'txt'), 'text/plain;charset=utf-8')
}

export function exportToMarkdown(session: TranscriptSession, tags?: Tag[]): Promise<void> {
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

  return saveManualExport(session, lines.join('\n'), buildSessionExportFilename(session, 'md'), 'text/markdown;charset=utf-8')
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

export function buildCorrectedTranscriptExportBody(
  session: TranscriptSession,
  format: 'txt' | 'markdown',
  language?: 'zh' | 'en',
): string {
  const correctedText = session.correction?.published?.correctedText
    || session.correction?.legacy?.correctedText
    || (session.correction?.status === 'done' ? session.correction.correctedText : undefined)
  if (!correctedText) return ''

  const projection = projectSessionCorrection(session.transcript, session.segments, session.correction)
  return projection
    ? formatCorrectionProjection(projection, session.speakers, format, language)
    : correctedText
}

export function buildCorrectedTranscriptMarkdown(
  session: TranscriptSession,
  correctedLabel: string,
  language?: 'zh' | 'en',
): string {
  const body = buildCorrectedTranscriptExportBody(session, 'markdown', language)
  if (!body) return ''
  return [
    `# ${session.title} (${correctedLabel})`,
    '',
    `> ${session.date} ${session.time}`,
    '',
    '---',
    '',
    body,
    '',
  ].join('\n')
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

export async function exportAiAnalysisToTxt(session: TranscriptSession): Promise<void> {
  const content = buildAiAnalysisTxt(session)
  if (!content) return
  await saveManualExport(session, content, getAiAnalysisFilename(session, 'txt'), 'text/plain;charset=utf-8')
}

export async function exportAiAnalysisToMarkdown(session: TranscriptSession): Promise<void> {
  const content = buildAiAnalysisMarkdown(session)
  if (!content) return
  await saveManualExport(session, content, getAiAnalysisFilename(session, 'md'), 'text/markdown;charset=utf-8')
}
