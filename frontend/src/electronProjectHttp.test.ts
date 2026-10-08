import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
const bridge = vi.hoisted(() => ({ requestSessions: vi.fn(), requestSearchSessions: vi.fn(), requestTopics: vi.fn(), requestSessionDetail: vi.fn(), requestTags: vi.fn(), requestRecordingStatus: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: () => 'test' }, ipcMain: { on: vi.fn() } }))
vi.mock('../../electron/apiIpc', () => bridge)
let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined; vi.clearAllMocks() })

describe('actual HTTP project filter forwarding', () => {
  it('retains old topic clients and forwards subtree/search filters without first-alias refiltering', async () => {
    const { attachApiServer, updateOpenApiConfig } = await import('../../electron/apiServer')
    const server = http.createServer()
    const attachment = attachApiServer({ server })
    updateOpenApiConfig({ enabled: true, token: 'test-token' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    close = async () => { await attachment.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
    const address = server.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}/api/v1`
    const options = { headers: { Authorization: 'Bearer test-token' } }
    bridge.requestSessions.mockResolvedValue([{ id: 'shared', title: 'record', topicId: 'first', projectIds: ['first', 'second'], status: 'completed' }])
    bridge.requestSearchSessions.mockResolvedValue([])
    bridge.requestTopics.mockResolvedValue([{ id: 'parent', name: 'Parent', parentId: undefined }])
    const legacy = await fetch(`${base}/sessions?topicId=second`, options)
    expect(legacy.status).toBe(200)
    expect((await legacy.json() as { sessions: unknown[] }).sessions).toHaveLength(1)
    expect(bridge.requestSessions).toHaveBeenCalledWith({ topicId: 'second', projectId: undefined, includeDescendants: true })
    await fetch(`${base}/sessions?projectId=parent&includeDescendants=false&search=needle`, options)
    expect(bridge.requestSearchSessions).toHaveBeenCalledWith('needle', { topicId: undefined, projectId: 'parent', includeDescendants: false })
    expect((await fetch(`${base}/projects`, options)).status).toBe(200)
    expect((await fetch(`${base}/topics`, options)).status).toBe(200)
    expect((await fetch(`${base}/sessions`)).status).toBe(401)
  })
})
