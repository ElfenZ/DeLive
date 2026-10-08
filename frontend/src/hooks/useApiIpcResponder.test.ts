import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import type { Topic, TranscriptSession } from '../types'
import { useSessionStore } from '../stores/sessionStore'
import { useTopicStore } from '../stores/topicStore'
import type { ElectronAPI } from '../../../shared/electronApi'
import { registerApiIpc, requestSessionDetail, requestSessions, requestSearchSessions, requestTopics, requestTags, requestRecordingStatus } from '../../../electron/apiIpc'
import {
  projectApiRecordingStatus,
  toSessionDetail as projectSessionDetail,
  toSessionDetail,
  toSessionSummary,
  toApiProjects,
  selectApiSessions,
  useApiIpcResponder,
} from './useApiIpcResponder'

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => (() => void)) => { effectCleanup = effect() },
}))
vi.mock('../../../electron/apiBroadcast', () => ({ broadcastSessionEvent: vi.fn() }))
let effectCleanup: (() => void) | undefined
afterEach(() => { effectCleanup?.(); effectCleanup = undefined; vi.unstubAllGlobals() })

function makeSession(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  return {
    id: 'test-1',
    title: 'Test Session',
    date: '2026-04-17',
    time: '14:30',
    createdAt: 1713340200000,
    updatedAt: 1713340200000,
    transcript: 'Hello world',
    ...overrides,
  }
}

describe('toSessionSummary', () => {
  it('maps basic fields', () => {
    const session = makeSession({ duration: 5000, status: 'completed', providerId: 'soniox' })
    const summary = toSessionSummary(session)

    expect(summary.id).toBe('test-1')
    expect(summary.title).toBe('Test Session')
    expect(summary.date).toBe('2026-04-17')
    expect(summary.time).toBe('14:30')
    expect(summary.duration).toBe(5000)
    expect(summary.status).toBe('completed')
    expect(summary.providerId).toBe('soniox')
  })

  it('calculates transcriptLength correctly', () => {
    const session = makeSession({ transcript: 'Hello world, this is a test.' })
    const summary = toSessionSummary(session)

    expect(summary.transcriptLength).toBe('Hello world, this is a test.'.length)
  })

  it('handles empty transcript', () => {
    const session = makeSession({ transcript: '' })
    const summary = toSessionSummary(session)

    expect(summary.transcriptLength).toBe(0)
  })

  it('detects hasSummary and hasMindMap', () => {
    const session = makeSession({
      postProcess: { summary: 'A meeting about AI', status: 'success' },
      mindMap: { markdown: '# Root\n## Branch', status: 'success' },
    })
    const summary = toSessionSummary(session)

    expect(summary.hasSummary).toBe(true)
    expect(summary.hasMindMap).toBe(true)
  })

  it('reports false for missing postProcess/mindMap', () => {
    const session = makeSession()
    const summary = toSessionSummary(session)

    expect(summary.hasSummary).toBe(false)
    expect(summary.hasMindMap).toBe(false)
  })

  it('preserves topicId and tagIds', () => {
    const session = makeSession({ topicId: 'topic-1', tagIds: ['tag-a', 'tag-b'] })
    const summary = toSessionSummary(session)

    expect(summary.topicId).toBe('topic-1')
    expect(summary.tagIds).toEqual(['tag-a', 'tag-b'])
  })
})

describe('toSessionDetail', () => {
  it('includes full transcript', () => {
    const session = makeSession({ transcript: 'Full meeting transcript here' })
    const detail = toSessionDetail(session)

    expect(detail.transcript).toBe('Full meeting transcript here')
  })

  it('handles translated transcript', () => {
    const session = makeSession({
      translatedTranscript: { text: 'Translated text', targetLanguage: 'en' },
    })
    const detail = toSessionDetail(session)

    expect(detail.translatedTranscript).toEqual({ text: 'Translated text', targetLanguage: 'en' })
  })

  it('handles missing translated transcript', () => {
    const session = makeSession()
    const detail = toSessionDetail(session)

    expect(detail.translatedTranscript).toBeUndefined()
  })

  it('maps tokens with all fields', () => {
    const session = makeSession({
      tokens: [
        { text: 'Hello', isFinal: true, startMs: 0, endMs: 500, speaker: 'speaker-1' },
        { text: 'world', isFinal: false, startMs: 500, endMs: 1000 },
      ],
    })
    const detail = toSessionDetail(session)

    expect(detail.tokens).toHaveLength(2)
    expect(detail.tokens![0]).toEqual({
      text: 'Hello',
      isFinal: true,
      startMs: 0,
      endMs: 500,
      speaker: 'speaker-1',
    })
  })

  it('maps speakers', () => {
    const session = makeSession({
      speakers: [
        { id: 'sp-1', label: 'Speaker 1', displayName: 'Alice' },
      ],
    })
    const detail = toSessionDetail(session)

    expect(detail.speakers).toHaveLength(1)
    expect(detail.speakers![0]).toEqual({
      id: 'sp-1',
      label: 'Speaker 1',
      displayName: 'Alice',
    })
  })

  it('maps postProcess', () => {
    const session = makeSession({
      postProcess: {
        summary: 'Summary text',
        actionItems: ['Do A', 'Do B'],
        keywords: ['AI', 'meeting'],
        titleSuggestion: 'AI Meeting',
        tagSuggestions: ['important'],
        generatedAt: 1713340200000,
        status: 'success',
      },
    })
    const detail = toSessionDetail(session)

    expect(detail.postProcess).toBeDefined()
    expect(detail.postProcess!.summary).toBe('Summary text')
    expect(detail.postProcess!.actionItems).toEqual(['Do A', 'Do B'])
    expect(detail.postProcess!.status).toBe('success')
  })

  it('maps mindMap', () => {
    const session = makeSession({
      mindMap: {
        markdown: '# Root\n## Branch 1',
        title: 'Meeting Map',
        generatedAt: 1713340200000,
        status: 'success',
      },
    })
    const detail = toSessionDetail(session)

    expect(detail.mindMap).toBeDefined()
    expect(detail.mindMap!.markdown).toBe('# Root\n## Branch 1')
    expect(detail.mindMap!.title).toBe('Meeting Map')
  })

  it('maps askHistory', () => {
    const session = makeSession({
      askHistory: [
        { id: 'q1', question: 'What was discussed?', answer: 'AI topics', createdAt: 1713340200000, status: 'success' as const },
      ],
    })
    const detail = toSessionDetail(session)

    expect(detail.askHistory).toHaveLength(1)
    expect(detail.askHistory![0].question).toBe('What was discussed?')
    expect(detail.askHistory![0].answer).toBe('AI topics')
  })

  it('handles empty session', () => {
    const session = makeSession({ transcript: '', tokens: undefined, speakers: undefined })
    const detail = toSessionDetail(session)

    expect(detail.transcript).toBe('')
    expect(detail.tokens).toBeUndefined()
    expect(detail.speakers).toBeUndefined()
    expect(detail.postProcess).toBeUndefined()
    expect(detail.mindMap).toBeUndefined()
    expect(detail.askHistory).toBeUndefined()
  })

  it('projects correction metadata without exposing patches or draft payloads', () => {
    const detail = projectSessionDetail(makeSession({
      correction: {
        status: 'done', mode: 'quick', correctedText: 'corrected',
        published: {
          id: 'result-1', formatVersion: 1, revision: 1, baseTranscriptHash: 'base', outputTextHash: 'output',
          correctedText: 'corrected', patches: [], model: 'model', completedAt: 123,
          stats: { applied: 2, reverted: 0, rejected: 1 },
        },
      },
    }))
    expect(detail.correctionMeta).toEqual({
      sourceKind: 'published', formatVersion: 1, sourceHash: 'output', publishedStatus: 'available',
      draftStatus: undefined, appliedPatches: 2, rejectedPatches: 1, updatedAt: 123,
    })
    expect(detail).not.toHaveProperty('patches')
    expect(JSON.stringify(detail)).not.toContain('baseTranscriptHash')
  })
})

describe('projectApiRecordingStatus', () => {
  it('keeps the active session ID while paused without reporting active recording', () => {
    expect(projectApiRecordingStatus('paused', 'session-1')).toEqual({
      isRecording: false,
      currentSessionId: 'session-1',
      recordingState: 'paused',
    })
  })

  it('reports active recording only for the recording state', () => {
    expect(projectApiRecordingStatus('recording', 'session-1').isRecording).toBe(true)
    expect(projectApiRecordingStatus('pausing', 'session-1').isRecording).toBe(false)
    expect(projectApiRecordingStatus('resuming', 'session-1').isRecording).toBe(false)
  })
})

describe('search filtering logic', () => {
  const sessions = [
    makeSession({ id: '1', title: 'AI Meeting', transcript: 'We discussed machine learning' }),
    makeSession({ id: '2', title: 'Lunch Plan', transcript: 'Pizza or sushi?' }),
    makeSession({ id: '3', title: 'Code Review', transcript: 'The AI module needs refactoring' }),
  ]

  it('filters by title match', () => {
    const query = 'ai'
    const filtered = selectApiSessions(sessions, [], {}, query)
    expect(filtered).toHaveLength(2)
    expect(filtered.map(s => s.id)).toEqual(['1', '3'])
  })

  it('filters by transcript content', () => {
    const query = 'pizza'
    const filtered = selectApiSessions(sessions, [], {}, query)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('2')
  })

  it('returns all for empty query', () => {
    const query: string = ''
    const filtered = selectApiSessions(sessions, [], {}, query)
    expect(filtered).toHaveLength(3)
  })
})

function projects(): Topic[] {
  return [
    { id: 'root', name: 'Root', emoji: '', createdAt: 1, updatedAt: 1 },
    { id: 'child', name: 'Child', emoji: '', parentId: 'root', createdAt: 1, updatedAt: 1 },
    { id: 'leaf', name: 'Leaf', emoji: '', parentId: 'child', archivedAt: 2, createdAt: 1, updatedAt: 1 },
  ]
}

describe('compatible project API selectors and projections', () => {
  it('matches every direct link, preserves explicit empty, and deduplicates all descendant levels', () => {
    const linked = makeSession({ id: 'multi', projectIds: ['other', 'leaf'], topicId: 'other' })
    const legacy = makeSession({ id: 'legacy', topicId: 'root' })
    const cleared = makeSession({ id: 'cleared', projectIds: [], topicId: 'root' })
    const input = [linked, legacy, cleared, linked]
    expect(selectApiSessions(input, projects(), { topicId: 'leaf' }).map(s => s.id)).toEqual(['multi'])
    expect(selectApiSessions(input, projects(), { topicId: 'root' }).map(s => s.id)).toEqual(['legacy'])
    expect(selectApiSessions(input, projects(), { projectId: 'root' }).map(s => s.id)).toEqual(['multi', 'legacy'])
    expect(selectApiSessions(input, projects(), { projectId: 'root', includeDescendants: false }).map(s => s.id)).toEqual(['legacy'])
    expect(selectApiSessions(input, projects(), { topicId: 'other', projectId: 'root' }).map(s => s.id)).toEqual(['multi'])
    expect(selectApiSessions(input, projects(), { projectId: 'missing' })).toEqual([])
    expect(toSessionSummary(cleared).topicId).toBeUndefined()
    expect(toSessionDetail(linked).projectIds).toEqual(['other', 'leaf'])
  })

  it('excludes local paths, permissions and path-bearing errors at every projected metadata level', () => {
    const secret = 'C:\\private\\source.wav'
    const local = { audioPath: secret, originalPath: secret, managedPath: secret, directory: secret, token: secret, capability: secret, error: secret }
    const session = makeSession({
      ...local,
      projectIds: ['root'],
      sourceMeta: { ...local },
      tokens: [{ text: 'hello', ...local }],
      segments: [{ text: 'hello', startMs: 0, endMs: 1, ...local }],
      speakers: [{ id: 's', label: 'Speaker', ...local }],
      postProcess: { summary: 'summary', status: 'success', ...local },
      mindMap: { markdown: '# Map', status: 'success', ...local },
      askHistory: [{ id: 'q', question: 'question', answer: 'answer', createdAt: 1, status: 'success', ...local }],
      correction: { status: 'done', mode: 'quick', correctedText: 'corrected', ...local },
    })
    expect(JSON.stringify(toSessionSummary(session))).not.toContain('private')
    expect(JSON.stringify(toSessionDetail(session))).not.toContain('private')
    const project = { ...projects()[1], ...local }
    expect(toApiProjects([projects()[0], project])[1]).toMatchObject({ parentId: 'root' })
    expect(JSON.stringify(toApiProjects([project]))).not.toContain('private')
  })
})

describe('correlated API bridge and real renderer store responses', () => {
  function Bridge() {
    const renderer = new Map<string, (...args: unknown[]) => void>()
    const main = new Map<string, (...args: unknown[]) => void>()
    const sent: Array<{ channel: string; args: unknown[] }> = []
    const sender = { send: (channel: string, ...args: unknown[]) => { sent.push({ channel, args }) } }
    const win = { webContents: sender, isDestroyed: () => false }
    registerApiIpc({ getMainWindow: () => win as never, ipcMain: { on: (channel: string, cb: (...args: unknown[]) => void) => main.set(channel, cb) } as never })
    const api: Record<string, unknown> = { apiNotifySessionStart: vi.fn(), apiNotifySessionEnd: vi.fn() }
    for (const [name, channel] of [
      ['Sessions', 'sessions'], ['SessionDetail', 'session-detail'], ['SearchSessions', 'search-sessions'],
      ['Topics', 'topics'], ['Tags', 'tags'], ['RecordingStatus', 'recording-status'],
    ]) {
      const request = channel === 'search-sessions' ? 'api-search-sessions' : `api-get-${channel}`
      api[`onApi${name === 'SearchSessions' ? name : `Get${name}`}`] = (cb: (...args: unknown[]) => void) => {
        renderer.set(request, cb)
        return () => renderer.delete(request)
      }
      api[`apiRespond${name}`] = (payload: unknown, requestId: string) => main.get(`api-respond-${channel}`)!({ sender }, payload, requestId)
    }
    vi.stubGlobal('window', { electronAPI: api as unknown as ElectronAPI })
    useApiIpcResponder()
    const deliver = (message: { channel: string; args: unknown[] }) => renderer.get(message.channel)!({}, ...message.args)
    return { sent, main, sender, deliver }
  }

  it('routes overlapping out-of-order details, lists and searches without mixing payloads', async () => {
    const previousSessions = useSessionStore.getState().sessions
    const previousTopics = useTopicStore.getState().topics
    useSessionStore.setState({ sessions: [makeSession({ id: 'a', projectIds: ['root'] }), makeSession({ id: 'b', title: 'Leaf record', projectIds: ['leaf'] })] })
    useTopicStore.setState({ topics: projects() })
    const { sent, deliver } = Bridge()
    try {
      const a = requestSessionDetail('a')
      const b = requestSessionDetail('b')
      const list = requestSessions({ projectId: 'root' })
      const search = requestSearchSessions('leaf', { topicId: 'leaf' })
      const otherSearch = requestSearchSessions('test', { projectId: 'root', includeDescendants: false })
      deliver(sent[4]); deliver(sent[3]); deliver(sent[1]); deliver(sent[2]); deliver(sent[0])
      expect((await a)?.id).toBe('a')
      expect((await b)?.id).toBe('b')
      expect((await list).map(s => s.id)).toEqual(['a', 'b'])
      expect((await search).map(s => s.id)).toEqual(['b'])
      expect((await otherSearch).map(s => s.id)).toEqual(['a'])
      const topicRequest = requestTopics()
      deliver(sent[5])
      expect(await topicRequest).toEqual(toApiProjects(projects()))
      useSessionStore.setState({ sessions: [] })
      const missing = requestSessionDetail('b')
      deliver(sent[6])
      expect(await missing).toBeNull()
    } finally {
      useSessionStore.setState({ sessions: previousSessions })
      useTopicStore.setState({ topics: previousTopics })
    }
  })

  it('ignores spoofed sender, wrong channel, duplicate and timed-out responses', async () => {
    vi.useFakeTimers()
    const { sent, main, sender } = Bridge()
    try {
      const old = requestSessionDetail('old')
      const oldId = sent[0].args[1]
      await vi.advanceTimersByTimeAsync(5000)
      expect(await old).toBeNull()
      const current = requestSessionDetail('current')
      const id = sent[1].args[1]
      const respond = main.get('api-respond-session-detail')!
      respond({ sender }, { id: 'stale' }, oldId)
      respond({ sender: {} }, { id: 'spoofed' }, id)
      main.get('api-respond-sessions')!({ sender }, [{ id: 'wrong-channel' }], id)
      respond({ sender }, { id: 'correct' }, id)
      respond({ sender }, { id: 'duplicate' }, id)
      expect(await current).toEqual({ id: 'correct' })
      for (const request of [requestSessions, requestTopics, requestTags, requestRecordingStatus]) {
        const first = request()
        const second = request()
        const firstMessage = sent[sent.length - 2]
        const secondMessage = sent[sent.length - 1]
        const responseChannel = firstMessage.channel.replace('api-get-', 'api-respond-')
        main.get(responseChannel)!({ sender }, { order: 2 }, secondMessage.args[0])
        main.get(responseChannel)!({ sender }, { order: 1 }, firstMessage.args[0])
        expect(await first).toEqual({ order: 1 })
        expect(await second).toEqual({ order: 2 })
      }
    } finally { vi.useRealTimers() }
  })
})

describe('MCP compatibility tool callbacks', () => {
  it('keeps list_topics and forwards optional project filters without adding filesystem tools', async () => {
    const tools = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/topics')
        ? { topics: toApiProjects(projects()) }
        : { sessions: [], total: 0 },
    }))
    const schema = { optional: () => schema, default: () => schema, describe: () => schema }
    // Substitute unavailable SDK imports only; execute the actual server and its registered callbacks.
    const source = readFileSync(new URL('../../../mcp/delive-mcp-server.js', import.meta.url), 'utf8')
      .replace(/^#!.*\n/, '').replace(/^import .+$/gm, '')
    runInNewContext(source, {
      McpServer: class {
        registerTool(name: string, _options: unknown, callback: (input: Record<string, unknown>) => Promise<unknown>) { tools.set(name, callback) }
        registerResource() {}
        async connect() {}
      },
      StdioServerTransport: class {},
      z: { string: () => schema, number: () => schema, boolean: () => schema },
      URLSearchParams, AbortSignal, fetch,
      process: { env: {}, exit: vi.fn() }, console: { error: vi.fn() },
    })
    await tools.get('search_transcripts')!({ query: 'meeting & title', limit: 10, topicId: 'legacy', projectId: 'root', includeDescendants: false })
    const url = new URL(fetch.mock.calls[0][0])
    expect(url.searchParams.get('search')).toBe('meeting & title')
    expect(url.searchParams.get('topicId')).toBe('legacy')
    expect(url.searchParams.get('projectId')).toBe('root')
    expect(url.searchParams.get('includeDescendants')).toBe('false')
    await tools.get('search_transcripts')!({ query: 'old client', limit: 10 })
    expect(new URL(fetch.mock.calls[1][0]).searchParams.has('projectId')).toBe(false)
    const topics = await tools.get('list_topics')!({})
    expect(fetch.mock.calls[2][0]).toBe('http://localhost:23456/api/v1/topics')
    expect(JSON.stringify(topics)).toContain('Parent: child')
    expect(JSON.stringify(topics)).toContain('Archived')
    expect([...tools.keys()]).toEqual([
      'search_transcripts', 'get_session', 'get_session_transcript', 'get_session_summary',
      'get_recording_status', 'list_topics', 'list_tags',
    ])
  })
})
