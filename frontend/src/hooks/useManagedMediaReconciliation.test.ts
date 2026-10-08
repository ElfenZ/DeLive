import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined, originals: vi.fn(), media: vi.fn() }))
vi.mock('react', () => ({ useEffect: (effect: () => (() => void) | undefined) => { mocks.cleanup = effect() } }))
vi.mock('../utils/originalSourceReconciliation', () => ({ reconcileOriginalSourceCatalog: mocks.originals }))
vi.mock('../utils/managedMediaReconciliation', () => ({ reconcileManagedMedia: mocks.media }))
import { useManagedMediaReconciliation } from './useManagedMediaReconciliation'
import type { LocalFileChange } from '../../../shared/fileStorage'

describe('startup file reference reconciliation hook', () => {
  beforeEach(() => {
    mocks.cleanup?.()
    mocks.cleanup = undefined
    vi.clearAllMocks()
    mocks.originals.mockResolvedValue(undefined)
    mocks.media.mockResolvedValue(undefined)
  })
  it('pulls authoritative originals at startup without waiting for a rename event, and refreshes them after one', async () => {
    let changed!: () => void
    const unsubscribe = vi.fn()
    const list = vi.fn().mockResolvedValue({ ok: true, audios: [] })
    vi.stubGlobal('window', { electronAPI: { listMediaAudio: list, onOriginalSourceChanged: (callback: () => void) => { changed = callback; return unsubscribe } } })
    useManagedMediaReconciliation(true)
    await vi.waitFor(() => expect(mocks.media).toHaveBeenCalledTimes(1))
    expect(mocks.originals).toHaveBeenCalledTimes(1)
    changed()
    await vi.waitFor(() => expect(mocks.media).toHaveBeenCalledTimes(2))
    expect(mocks.originals).toHaveBeenCalledTimes(2)
    mocks.cleanup?.()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('keeps managed reconciliation available if the separate original registry is in conflict', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mocks.originals.mockRejectedValueOnce(new Error('Original conflict'))
    const list = vi.fn().mockResolvedValue({ ok: true, audios: [] })
    vi.stubGlobal('window', { electronAPI: { listMediaAudio: list } })
    useManagedMediaReconciliation(true)
    await vi.waitFor(() => expect(mocks.media).toHaveBeenCalledOnce())
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[OriginalSource]'), expect.any(Error))
    vi.restoreAllMocks()
  })
  it('ignores availability-only events so catalog completion cannot trigger another scan', async () => {
    let changed!: (event: LocalFileChange) => void
    const list = vi.fn().mockResolvedValue({ ok: true, audios: [] })
    vi.stubGlobal('window', { electronAPI: { listMediaAudio: list,
      onFileStorageChanged: (callback: typeof changed) => { changed = callback; return () => undefined } } })
    useManagedMediaReconciliation(true)
    await vi.waitFor(() => expect(mocks.media).toHaveBeenCalledOnce())
    changed({ sequence: 1, configurationRevision: 1, activityOnly: true })
    changed({ sequence: 2, configurationRevision: 1, activityOnly: true })
    await Promise.resolve()
    expect(list).toHaveBeenCalledOnce()
    changed({ sequence: 3, configurationRevision: 1 })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })
  it('does not publish a late original catalog or read media after the view disposes', async () => {
    let current!: () => boolean
    let release!: () => void
    mocks.originals.mockImplementationOnce((guard: () => boolean) => { current = guard; return new Promise<void>((resolve) => { release = resolve }) })
    const list = vi.fn().mockResolvedValue({ ok: true, audios: [] })
    vi.stubGlobal('window', { electronAPI: { listMediaAudio: list } })
    useManagedMediaReconciliation(true)
    expect(current()).toBe(true)
    mocks.cleanup?.()
    expect(current()).toBe(false)
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(list).not.toHaveBeenCalled()
    expect(mocks.media).not.toHaveBeenCalled()
  })
})
