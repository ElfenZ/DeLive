import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectRepository } from './projectRepository'
import { STORAGE_KEYS } from './storageShared'

describe('checked project repository', () => {
  let values: Map<string, string>
  beforeEach(() => {
    values = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
  })
  const project = { id: 'p', name: 'Project', emoji: '', createdAt: 1, updatedAt: 1 }

  it('preserves the original upgrade snapshot and verifies saved data', () => {
    values.set(STORAGE_KEYS.TOPICS, JSON.stringify([project]))
    projectRepository.write([{ ...project, archivedAt: 2 }])
    expect(projectRepository.read()[0].archivedAt).toBe(2)
    expect(values.get('delive_project_upgrade_topics_v1')).toBe(JSON.stringify([project]))
    projectRepository.write([])
    expect(projectRepository.read()).toEqual([])
    expect(values.get('delive_project_upgrade_topics_v1')).toBe(JSON.stringify([project]))
  })

  it('throws on quota failure instead of reporting an in-memory success', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota') } })
    expect(() => projectRepository.write([project])).toThrow('quota')
  })

  it('does not mask corrupt project data or permit missing parents', () => {
    values.set(STORAGE_KEYS.TOPICS, '{invalid')
    expect(() => projectRepository.read()).toThrow()
    expect(() => projectRepository.write([{ ...project, parentId: 'missing' }])).toThrow(/does not exist/)
  })
})
