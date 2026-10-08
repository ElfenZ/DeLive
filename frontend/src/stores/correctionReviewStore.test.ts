import { beforeEach, describe, expect, it } from 'vitest'
import { reconcileCorrectionReview, useCorrectionReviewStore as store } from './correctionReviewStore'

describe('transient correction review state', () => {
  beforeEach(() => store.setState({ reviews: {} }))
  it('preserves deselection and unsaved input through repeat synchronization and independent session consumers', () => {
    store.getState().sync('session', 'run', ['a', 'b'])
    store.getState().select('session', 'run', ['b'])
    store.getState().edit('session', 'run', 'a', 'unsaved')
    const previous = store.getState().reviews.session
    store.getState().sync('session', 'run', ['a', 'b'])
    expect(store.getState().reviews.session).toBe(previous)
    store.getState().sync('other', 'run', ['a'])
    expect(store.getState().reviews.session).toMatchObject({ selectedIds: ['b'], edits: { a: 'unsaved' } })
    expect(store.getState().reviews.other.selectedIds).toEqual(['a'])
  })
  it('prunes removed IDs, selects new candidates only and initializes replacement tasks independently', () => {
    store.getState().sync('session', 'run', ['a', 'b'])
    store.getState().select('session', 'run', [])
    store.getState().edit('session', 'run', 'b', 'discard')
    store.getState().sync('session', 'run', ['a', 'c'])
    expect(store.getState().reviews.session).toMatchObject({ selectedIds: ['c'], edits: {} })
    store.getState().sync('session', 'new-run', ['a', 'c'])
    expect(store.getState().reviews.session.selectedIds).toEqual(['a', 'c'])
    store.getState().select('session', 'run', [])
    expect(store.getState().reviews.session.selectedIds).toEqual(['a', 'c'])
  })
  it('does not erase a newer unsaved edit when an older save completes', () => {
    store.getState().sync('session', 'run', ['a'])
    store.getState().edit('session', 'run', 'a', 'newer')
    store.getState().saved('session', 'run', 'a', 'older')
    expect(store.getState().reviews.session.edits.a).toBe('newer')
    store.getState().saved('session', 'run', 'a', 'newer')
    expect(store.getState().reviews.session.edits).toEqual({})
    expect(reconcileCorrectionReview(undefined, 'run', []).selectedIds).toEqual([])
  })
})
