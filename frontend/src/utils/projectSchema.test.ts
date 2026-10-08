import { describe, expect, it } from 'vitest'
import type { Topic, TranscriptSession } from '../types'
import { createDraftSession } from './sessionLifecycle'
import { getDirectProjectIds, getProjectLinkOrigins, normalizeProjectIds, normalizeProjects, selectProjectSessions, selectReviewSessions, validateProjectHierarchy } from './projectSchema'
import { normalizeTranscriptSession } from './sessionSchema'

const project = (id: string, parentId?: string): Topic => ({ id, parentId, name: id, emoji: '', createdAt: 1, updatedAt: 1 })
const session = (id: string, projectIds: string[]): TranscriptSession => createDraftSession({ id, title: id, now: 1, projectIds })

describe('project contracts', () => {
  it('orders visible sessions by date/time descending and retains input order on exact ties', () => {
    const records = [
      { ...session('earlier', []), date: '2026-10-05', time: '23:00' },
      { ...session('tie-first', []), date: '2026-10-06', time: '09:00' },
      { ...session('tie-second', []), date: '2026-10-06', time: '09:00' },
      { ...session('latest', []), date: '2026-10-06', time: '12:00' },
    ]
    expect(selectReviewSessions(records, [], { kind: 'all' }).map((item) => item.id)).toEqual(['latest', 'tie-first', 'tie-second', 'earlier'])
    expect(records.map((item) => item.id)).toEqual(['earlier', 'tie-first', 'tie-second', 'latest'])
  })
  it('shares folder and tag scope without truncating heatmap by search, retaining orphan links in all history', () => {
    const projects = [project('root'), project('child', 'root')]
    const records = [session('root-record', ['root']), { ...session('nested', ['child']), tagIds: ['tag'], transcript: 'find me' },
      session('unknown', ['missing']), session('empty', [])]
    expect(selectReviewSessions([...records, records[1]], projects, { kind: 'all' }).map((item) => item.id)).toEqual(['root-record', 'nested', 'unknown', 'empty'])
    expect(selectReviewSessions(records, projects, { kind: 'unclassified' }).map((item) => item.id)).toEqual(['empty'])
    expect(selectReviewSessions(records, projects, { kind: 'topic', topicId: 'root' }, ['tag'], 'find').map((item) => item.id)).toEqual(['nested'])
    expect(selectReviewSessions(records, projects, { kind: 'topic', topicId: 'root' }, [], 'no match')).toEqual([])
    expect(selectReviewSessions(records, projects, { kind: 'topic', topicId: 'root' })).toHaveLength(2)
    expect(records[1].projectIds).toEqual(['child'])
    expect(selectReviewSessions(records, projects, { kind: 'topic', topicId: 'root' }, ['tag'], 'find', [], '2099-01-01')).toEqual([])
    expect(selectReviewSessions(records, projects, { kind: 'topic', topicId: 'root' }, ['tag'], 'find', [], records[1].date).map((item) => item.id)).toEqual(['nested'])
  })
  it('migrates legacy direct links while explicit empty arrays stay unlinked', () => {
    expect(normalizeProjectIds(undefined, 'legacy')).toEqual(['legacy'])
    expect(normalizeTranscriptSession({ topicId: 'legacy', projectIds: [] }).topicId).toBeUndefined()
    expect(getDirectProjectIds(normalizeTranscriptSession({ topicId: 'legacy', projectIds: [] }))).toEqual([])
    expect(normalizeTranscriptSession({ topicId: 'old', projectIds: ['new', 'new', 'orphan'] })).toMatchObject({ projectIds: ['new', 'orphan'], topicId: 'new' })
  })

  it('aggregates all descendants once and distinguishes direct and inherited origins', () => {
    const projects = [project('root'), project('child', 'root'), project('grandchild', 'child'), project('other')]
    const shared = session('shared', ['root', 'child', 'grandchild'])
    const inherited = session('inherited', ['grandchild'])
    expect(selectProjectSessions([shared, inherited, shared, session('other', ['other'])], projects, 'root').map((item) => item.id))
      .toEqual(['shared', 'inherited'])
    expect(selectProjectSessions([shared, inherited], projects, 'root', false)).toEqual([shared])
    expect(getProjectLinkOrigins(inherited, projects, 'root')).toEqual({ direct: false, inheritedFrom: ['grandchild'] })
    expect(getProjectLinkOrigins(shared, projects, 'root')).toEqual({ direct: true, inheritedFrom: ['child', 'grandchild'] })
  })

  it('rejects self-parenting, missing parents, cycles and duplicate IDs', () => {
    expect(() => validateProjectHierarchy([project('a', 'a')])).toThrow(/cycles/)
    expect(() => validateProjectHierarchy([project('a', 'missing')])).toThrow(/does not exist/)
    expect(() => validateProjectHierarchy([project('a', 'b'), project('b', 'a')])).toThrow(/cycles/)
    expect(() => normalizeProjects([project('a'), project('a')])).toThrow(/duplicate/)
  })

  it('freezes creation arrays and save project independently of later associations', () => {
    const selected = ['a', 'b']
    const draft = createDraftSession({ title: 'frozen', projectIds: selected, defaultSaveProjectId: 'b' })
    selected.splice(0, 2, 'c')
    expect(draft.projectIds).toEqual(['a', 'b'])
    expect(normalizeTranscriptSession({ ...draft, projectIds: ['c'] }).defaultSaveProjectId).toBe('b')
  })

  it('round-trips revisions and separate managed/original names without credentials', () => {
    const value = normalizeTranscriptSession({
      ...session('media', ['a']), titleRevision: 8,
      correctedMarkdownFile: { status: 'conflict', revision: 3, publicationRevision: 2, titleRevision: 8, error: 'Externally changed' },
      sourceMeta: {
        managedAsset: { sessionId: 'media', assetKind: 'extracted-audio', revision: 4 },
        originalSourceId: 'source-1', originalSourceRevision: 5,
        originalFileName: 'import.mp4', currentOriginalFileName: 'renamed.mp4', audioFileName: 'managed.mp3',
      },
    })
    expect(normalizeTranscriptSession(JSON.parse(JSON.stringify(value)))).toEqual(value)
    expect(value.titleRevision).toBe(8)
    expect(value.sourceMeta).toMatchObject({ originalFileName: 'import.mp4', currentOriginalFileName: 'renamed.mp4', audioFileName: 'managed.mp3' })
    expect(value.correctedMarkdownFile?.status).toBe('conflict')
  })
})
