import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Resolve the real SDK from its owning package, not frontend dependencies or mocks.
const requireMcp = createRequire(new URL('../../mcp/package.json', import.meta.url))
const { Client } = await import(/* @vite-ignore */ pathToFileURL(requireMcp.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
const { StdioClientTransport } = await import(/* @vite-ignore */ pathToFileURL(requireMcp.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)
const client = new Client({ name: 'delive-stdio-test', version: '1.0.0' })
const requests: { path: string; query: Record<string, string>; authorization?: string }[] = []
let responseStatus = 200
let responseError = 'Session unavailable'
const api = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1')
  requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization })
  res.setHeader('Content-Type', 'application/json')
  res.statusCode = req.headers.authorization !== 'Bearer stdio-test-token' ? 401 : responseStatus
  if (res.statusCode !== 200) return res.end(JSON.stringify({ error: responseError }))
  if (url.pathname === '/api/v1/topics') {
    return res.end(JSON.stringify({ topics: [
      { id: 'parent', name: 'Parent', emoji: '', description: 'Root project' },
      { id: 'child', name: 'Child', emoji: '', parentId: 'parent', archivedAt: 123 },
    ] }))
  }
  if (url.pathname === '/api/v1/sessions') {
    return res.end(JSON.stringify({ total: 1, sessions: [{ id: 'shared', title: 'Fixture record', date: '2026-10-04', time: '12:00', projectIds: ['parent', 'child'], transcriptLength: 42, hasSummary: true }] }))
  }
  res.statusCode = 404
  res.end(JSON.stringify({ error: 'Session unavailable' }))
})

beforeAll(async () => {
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  const address = api.address() as { port: number }
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../mcp/delive-mcp-server.js', import.meta.url))],
    env: { DELIVE_API_URL: `http://127.0.0.1:${address.port}`, DELIVE_API_TOKEN: 'stdio-test-token' },
    stderr: 'pipe',
  }))
}, 15000)

afterAll(async () => {
  try { await client.close() } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()))
  }
})

describe('real MCP SDK stdio integration', () => {
  it('negotiates and lists only read-only tools and non-file resources', async () => {
    expect(client.getServerVersion()?.name).toBe('delive')
    const { tools } = await client.listTools() as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_recording_status', 'get_session', 'get_session_summary', 'get_session_transcript',
      'list_tags', 'list_topics', 'search_transcripts',
    ])
    const search = tools.find((tool) => tool.name === 'search_transcripts')!
    expect(Object.keys(search.inputSchema.properties!)).toEqual(expect.arrayContaining(['query', 'limit', 'topicId', 'projectId', 'includeDescendants']))
    const listed = await client.listResources() as { resources: Array<{ uri: string }> }
    expect(listed.resources.map((resource) => resource.uri).sort()).toEqual(['delive://sessions/recent', 'delive://status'])
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])
    await expect(client.readResource({ uri: 'file:///private-test.txt' })).rejects.toThrow()
    const unsupported = await client.callTool({ name: 'rename_original', arguments: { path: 'private-test.txt' } })
    expect(unsupported.isError).toBe(true)
  })

  it('retains list_topics and displays project hierarchy and archive metadata', async () => {
    const result = await client.callTool({ name: 'list_topics', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Parent: parent | Archived') }])
    expect(requests[requests.length - 1]).toEqual({ path: '/api/v1/topics', query: {}, authorization: 'Bearer stdio-test-token' })
  })

  it('forwards search and legacy/project filters verbatim through HTTP', async () => {
    for (const includeDescendants of [false, true, undefined]) {
      const result = await client.callTool({ name: 'search_transcripts', arguments: {
        query: 'needle & project/child', topicId: 'legacy second', projectId: 'parent/id',
        ...(includeDescendants === undefined ? {} : { includeDescendants }),
      } })
      expect(result.isError).not.toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Fixture record') }])
      expect(requests[requests.length - 1]).toEqual({ path: '/api/v1/sessions', authorization: 'Bearer stdio-test-token', query: {
        search: 'needle & project/child', limit: '10', topicId: 'legacy second', projectId: 'parent/id',
        ...(includeDescendants === undefined ? {} : { includeDescendants: String(includeDescendants) }),
      } })
    }
    await client.callTool({ name: 'search_transcripts', arguments: { query: 'explicit limit', limit: 3 } })
    expect(requests[requests.length - 1]?.query).toEqual({ search: 'explicit limit', limit: '3' })
  })

  it('returns MCP error results for deleted/unavailable sessions, invalid auth and disabled API', async () => {
    try {
      for (const [status, message] of [[404, 'Session unavailable'], [401, 'DeLive API token is invalid'], [403, 'DeLive Open API is disabled'], [503, 'Session unavailable']] as const) {
        responseStatus = status
        responseError = 'Session unavailable'
        const result = await client.callTool({ name: 'get_session', arguments: { sessionId: 'deleted/id' } })
        expect(result.isError).toBe(true)
        expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(message) }])
        expect(requests[requests.length - 1]?.path).toBe('/api/v1/sessions/deleted%2Fid')
      }
    } finally { responseStatus = 200 }
  })
})
