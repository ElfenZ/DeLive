import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEETING_CONTEXT,
  MAX_CORRECTION_GUIDANCE_CODE_POINTS,
  MAX_MEETING_BACKGROUND_CODE_POINTS,
  MeetingContextValidationError,
  assertValidMeetingContext,
  getSonioxContext,
  normalizeGlossaryEntries,
  normalizeMeetingContextConfig,
  resolveMeetingContextSnapshot,
  unicodeCodePointLength,
} from './meetingContext'

describe('meeting context normalization', () => {
  it('counts Unicode code points instead of UTF-16 code units', () => {
    expect(unicodeCodePointLength('A😀中')).toBe(3)
  })

  it('uses safe defaults and rejects over-budget values without truncation', () => {
    expect(normalizeMeetingContextConfig(undefined).value).toEqual(DEFAULT_MEETING_CONTEXT)

    const result = normalizeMeetingContextConfig({
      background: 'x'.repeat(MAX_MEETING_BACKGROUND_CODE_POINTS + 1),
      correctionGuidance: 'y'.repeat(MAX_CORRECTION_GUIDANCE_CODE_POINTS + 1),
      useForAiCorrection: false,
      useForSoniox: true,
    })
    expect(result.value.background).toBe('')
    expect(result.value.correctionGuidance).toBe('')
    expect(result.value.useForAiCorrection).toBe(false)
    expect(result.value.useForSoniox).toBe(true)
    expect(result.errors).toHaveLength(2)
  })

  it('supports mappings and target-only candidate terms', () => {
    expect(normalizeGlossaryEntries([
      { id: '1', source: ' difine ', target: ' Dify ', note: ' product ' },
      { id: '2', source: '', target: ' TypeScript ' },
      { id: '3', target: 'typescript' },
      { id: '4', source: 'ignored', target: 'Ignored', enabled: false },
    ])).toEqual({
      errors: [],
      value: [
        { id: '1', source: 'difine', target: 'Dify', note: 'product', enabled: true },
        { id: '2', target: 'TypeScript', enabled: true },
      ],
    })
  })

  it('reports conflicting mappings for the same normalized source', () => {
    const result = normalizeGlossaryEntries([
      { id: '1', source: 'delive', target: 'DeLive' },
      { id: '2', source: 'DELIVE', target: 'D-Live' },
    ])
    expect(result.errors).toEqual(['Glossary source "DELIVE" maps to multiple targets'])
    expect(() => assertValidMeetingContext(DEFAULT_MEETING_CONTEXT, [
      { id: '1', source: 'delive', target: 'DeLive' },
      { id: '2', source: 'DELIVE', target: 'D-Live' },
    ])).toThrow(MeetingContextValidationError)
  })

  it('resolves inherit, override, and clear snapshots', () => {
    const glossary = [
      { id: '1', target: 'DeLive' },
      { id: '2', source: 'd live', target: 'delive' },
    ]
    const inherited = resolveMeetingContextSnapshot({
      background: 'Global',
      correctionGuidance: 'Keep case',
      useForAiCorrection: true,
      useForSoniox: true,
    }, glossary)
    expect(inherited.background).toBe('Global')
    expect(getSonioxContext(inherited)).toEqual({ text: 'Global', terms: ['DeLive'] })

    const overridden = resolveMeetingContextSnapshot(inherited, glossary, {
      mode: 'override',
      config: { background: 'One meeting' },
    })
    expect(overridden.background).toBe('One meeting')
    expect(overridden.correctionGuidance).toBe('Keep case')

    const cleared = resolveMeetingContextSnapshot(inherited, glossary, { mode: 'clear' })
    expect(cleared.background).toBe('')
    expect(cleared.glossary).toEqual([])
    expect(cleared.useForAiCorrection).toBe(false)
    expect(getSonioxContext(cleared)).toBeUndefined()
  })
})
