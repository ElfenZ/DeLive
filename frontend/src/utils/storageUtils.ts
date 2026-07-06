import type { Tag, TranscriptSession } from '../types'
import { hasPostProcessContent } from './transcriptState'

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

function buildSpeakerAwareTranscript(session: TranscriptSession): string {
  const speakerNameMap = Object.fromEntries(
    (session.speakers || []).map((speaker) => [
      speaker.id,
      speaker.displayName?.trim() || speaker.label?.trim() || speaker.id,
    ]),
  )

  if ((session.segments || []).length > 0) {
    return (session.segments || [])
      .filter((segment) => segment.text.trim())
      .map((segment) => {
        const speakerLabel = segment.speakerId
          ? speakerNameMap[segment.speakerId] || segment.speakerId
          : ''
        return speakerLabel
          ? `[${speakerLabel}]\n${segment.text}`
          : segment.text
      })
      .join('\n\n')
  }
  return session.transcript
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
  const speakerAwareTranscript = buildSpeakerAwareTranscript(session)

  const content = `标题: ${session.title}
日期: ${session.date}
时间: ${session.time}${tagNames ? `\n标签: ${tagNames}` : ''}
${'='.repeat(50)}

${speakerAwareTranscript}
${translatedText ? `\n\n${'-'.repeat(20)}\n翻译\n${'-'.repeat(20)}\n\n${translatedText}\n` : ''}
`

  triggerDownload(
    new Blob([content], { type: 'text/plain;charset=utf-8' }),
    `${session.title}_${session.date}_${session.time.replace(':', '-')}.txt`,
  )
}

export function exportToMarkdown(session: TranscriptSession, tags?: Tag[]): void {
  const sessionTags = tags?.filter((tag) => session.tagIds?.includes(tag.id)) || []
  const tagNames = sessionTags.map((tag) => `\`${tag.name}\``).join(' ')
  const translatedText = session.translatedTranscript?.text?.trim()

  const speakerNameMap = Object.fromEntries(
    (session.speakers || []).map((speaker) => [
      speaker.id,
      speaker.displayName?.trim() || speaker.label?.trim() || speaker.id,
    ]),
  )

  const hasSegments = (session.segments || []).length > 0
  const transcriptMd = hasSegments
    ? (session.segments || [])
        .filter((seg) => seg.text.trim())
        .map((seg) => {
          const speaker = seg.speakerId
            ? speakerNameMap[seg.speakerId] || seg.speakerId
            : ''
          return speaker ? `**${speaker}**: ${seg.text}` : seg.text
        })
        .join('\n\n')
    : session.transcript

  const lines: string[] = []
  lines.push(`# ${session.title}`)
  lines.push('')
  lines.push(`> ${session.date} ${session.time}${tagNames ? ` | ${tagNames}` : ''}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(transcriptMd)

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
    `${session.title}_${session.date}_${session.time.replace(':', '-')}.md`,
  )
}

function formatTimestamp(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString() : ''
}

function getAiAnalysisFilename(session: TranscriptSession, extension: 'txt' | 'md'): string {
  return `${session.title}_${session.date}_${session.time.replace(':', '-')}_ai-analysis.${extension}`
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
