import { describe, expect, it } from 'vitest'
import { SonioxProvider } from '../providers/implementations/SonioxProvider'
import {
  buildProviderConfigFromFormState,
  buildProviderFormState,
} from './providerConfigForm'

const provider = new SonioxProvider().info

describe('Soniox provider form', () => {
  it('shows the meeting default for missing legacy sensitivity and preserves explicit zero', () => {
    const legacy = buildProviderFormState(provider, { apiKey: 'key' }, { apiKey: '', languageHints: ['zh', 'en'] })
    expect(legacy.endpointSensitivity).toBe('-0.5')

    const explicitZero = buildProviderFormState(
      provider,
      { apiKey: 'key', endpointSensitivity: 0 },
      { apiKey: '', languageHints: ['zh', 'en'] },
    )
    expect(explicitZero.endpointSensitivity).toBe('0')
    expect(buildProviderConfigFromFormState(provider, explicitZero, 'zh, en').endpointSensitivity).toBe(0)
  })

  it('allows clearing language hints and rejects out-of-range numeric input', () => {
    const state = buildProviderFormState(provider, { apiKey: 'key' }, { apiKey: '', languageHints: ['zh', 'en'] })
    expect(buildProviderConfigFromFormState(provider, { ...state, languageHintsStrict: true }, '')).toEqual(
      expect.objectContaining({ languageHints: [], languageHintsStrict: false }),
    )
    expect(() => buildProviderConfigFromFormState(provider, {
      ...state,
      endpointSensitivity: '1.1',
    }, 'zh')).toThrow('must be at most 1')
  })
})
