import { describe, expect, it } from 'vitest'
import {
  buildSonioxAsyncRequest,
  buildSonioxRealtimeRequest,
  createSonioxRecognitionSnapshot,
  parseSonioxConfig,
  SonioxConfigValidationError,
} from './sonioxConfig'

describe('Soniox effective configuration', () => {
  it('applies the DeLive sensitivity default and preserves explicit zero', () => {
    expect(parseSonioxConfig({}).value.endpointSensitivity).toBe(-0.5)
    expect(parseSonioxConfig({ endpointSensitivity: 0 }).value.endpointSensitivity).toBe(0)
    expect(parseSonioxConfig({ endpointSensitivity: -1 }).value.endpointSensitivity).toBe(-1)
    expect(parseSonioxConfig({ endpointSensitivity: 1 }).value.endpointSensitivity).toBe(1)
  })

  it.each([Number.NaN, -1.1, 1.1, 'not-a-number'])('rejects invalid sensitivity %s', (value) => {
    expect(() => parseSonioxConfig({ endpointSensitivity: value })).toThrow(SonioxConfigValidationError)
  })

  it('returns diagnostics and safe defaults for tolerant legacy input', () => {
    const result = parseSonioxConfig({
      endpointSensitivity: 9,
      maxEndpointDelayMs: 400,
      endpointLatencyAdjustmentLevel: 4,
    }, { fallbackInvalid: true })
    expect(result.value.endpointSensitivity).toBe(-0.5)
    expect(result.value.maxEndpointDelayMs).toBeUndefined()
    expect(result.value.endpointLatencyAdjustmentLevel).toBeUndefined()
    expect(result.diagnostics).toHaveLength(3)
  })

  it('requires hints before enabling strict mode', () => {
    expect(parseSonioxConfig({ languageHints: [], languageHintsStrict: true }).value.languageHintsStrict).toBe(false)
    expect(parseSonioxConfig({ languageHints: [' zh ', 'ZH', 'en'], languageHintsStrict: true }).value)
      .toEqual(expect.objectContaining({ languageHints: ['zh', 'en'], languageHintsStrict: true }))
  })

  it('keeps realtime endpoint fields out of async requests', () => {
    const effective = parseSonioxConfig({
      apiKey: 'secret',
      languageHints: ['zh', 'en'],
      languageHintsStrict: true,
      enableEndpointDetection: true,
      endpointSensitivity: 0,
      maxEndpointDelayMs: 1500,
      endpointLatencyAdjustmentLevel: 2,
      enableSpeakerDiarization: true,
    }, {
      meetingContext: {
        schemaVersion: 1,
        background: 'Developer meeting',
        correctionGuidance: 'Keep product case',
        useForAiCorrection: true,
        useForSoniox: true,
        glossary: [
          { id: '1', source: 'difine', target: 'Dify', note: 'private note' },
          { id: '2', target: 'TypeScript' },
        ],
      },
    }).value

    const realtime = buildSonioxRealtimeRequest(effective)
    expect(realtime).toEqual(expect.objectContaining({
      endpoint_sensitivity: 0,
      max_endpoint_delay_ms: 1500,
      endpoint_latency_adjustment_level: 2,
      language_hints_strict: true,
      context: { text: 'Developer meeting', terms: ['Dify', 'TypeScript'] },
    }))
    expect(JSON.stringify(realtime)).not.toContain('difine')
    expect(JSON.stringify(realtime)).not.toContain('private note')

    const asyncRequest = buildSonioxAsyncRequest(effective, { fileId: 'file-1' })
    expect(asyncRequest).toEqual(expect.objectContaining({
      model: 'stt-async-v5',
      file_id: 'file-1',
      language_hints_strict: true,
      context: { text: 'Developer meeting', terms: ['Dify', 'TypeScript'] },
    }))
    expect(asyncRequest).not.toHaveProperty('endpoint_sensitivity')
    expect(asyncRequest).not.toHaveProperty('max_endpoint_delay_ms')
    expect(asyncRequest).not.toHaveProperty('endpoint_latency_adjustment_level')
  })

  it('omits all endpoint tuning fields when endpoint detection is disabled', () => {
    const effective = parseSonioxConfig({
      enableEndpointDetection: false,
      endpointSensitivity: 0.5,
      maxEndpointDelayMs: 1000,
      endpointLatencyAdjustmentLevel: 1,
    }).value
    const request = buildSonioxRealtimeRequest(effective)
    expect(request.enable_endpoint_detection).toBe(false)
    expect(request).not.toHaveProperty('endpoint_sensitivity')
    expect(createSonioxRecognitionSnapshot(effective)).not.toHaveProperty('endpointSensitivity')
  })
})
