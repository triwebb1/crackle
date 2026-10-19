import { describe, expect, it } from 'vitest'
import {
  MOCK_SR800_MODEL_ID,
  normalizeTargetBaseUrl,
  normalizeTargetPathPrefix,
  resolveActiveRoaster,
  SR800_MODEL_ID,
  unsupportedModelReason,
} from './roasterModel'

describe('roaster model resolution', () => {
  it('resolves only the model declared by the controller', () => {
    const active = resolveActiveRoaster({
      deviceId: 'esp32-1',
      modelId: SR800_MODEL_ID,
      displayName: 'SR800',
      simulated: false,
    })
    expect(active?.model?.modelId).toBe(SR800_MODEL_ID)
    expect(active?.modelSupported).toBe(true)
  })

  it('keeps the simulator a distinct model while declaring the contract it simulates', () => {
    const active = resolveActiveRoaster({
      deviceId: 'sim-1',
      modelId: MOCK_SR800_MODEL_ID,
      displayName: 'Simulator',
      simulated: true,
      simulatesModelId: SR800_MODEL_ID,
    })
    expect(active?.model?.modelId).toBe(MOCK_SR800_MODEL_ID)
    expect(active?.model?.contractModelId).toBe(SR800_MODEL_ID)
  })

  it('fails closed for an unknown or contradictory model', () => {
    const unknown = resolveActiveRoaster({
      deviceId: 'x',
      modelId: 'mystery',
      displayName: 'Mystery',
      simulated: false,
    })
    expect(unknown?.modelSupported).toBe(false)
    expect(unsupportedModelReason(unknown, 'start')).toContain('Status, storage, history, and Stop remain available')
    const contradiction = resolveActiveRoaster({
      deviceId: 'sim',
      modelId: MOCK_SR800_MODEL_ID,
      displayName: 'Simulator',
      simulated: true,
      simulatesModelId: 'other',
    })
    expect(contradiction?.modelSupported).toBe(false)
  })

  it('normalizes a configured endpoint without treating it as model identity', () => {
    expect(normalizeTargetBaseUrl(' http://roaster.local/ ')).toBe('http://roaster.local')
    expect(normalizeTargetPathPrefix(' /__crackle/physical/ ')).toBe('/__crackle/physical')
  })
})
