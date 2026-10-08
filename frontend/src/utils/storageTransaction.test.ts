import { describe, expect, it, vi } from 'vitest'
import { createTransaction } from './storageShared'

describe('IndexedDB durable transaction boundary', () => {
  function database() {
    const transaction = {
      objectStore: vi.fn(() => ({} as IDBObjectStore)),
      abort: vi.fn(),
      error: null as Error | null,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
    }
    return { transaction, db: { transaction: () => transaction } as unknown as IDBDatabase }
  }

  it('does not resolve on request success before transaction commit', async () => {
    const { db, transaction } = database()
    let settled = false
    const result = createTransaction(db, 'store', 'readwrite', (_store, resolve) => resolve('value'))
    void result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    transaction.oncomplete!()
    await expect(result).resolves.toBe('value')
  })

  it('rejects a transaction abort even after the request succeeded', async () => {
    const { db, transaction } = database()
    const result = createTransaction(db, 'store', 'readwrite', (_store, resolve) => resolve('value'))
    transaction.onabort!()
    await expect(result).rejects.toThrow(/aborted/)
  })
})
