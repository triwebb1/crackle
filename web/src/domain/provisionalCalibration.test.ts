import { describe, expect, it } from 'vitest'
import { completeEmptyChamberSnapshot } from './provisionalCalibration'
import type { CalibrationSnapshot } from './types'

const snapshot = (
  patch: CalibrationSnapshot['patch'],
  extras: Partial<CalibrationSnapshot> = {},
): CalibrationSnapshot => ({
  id: 'cal-empty',
  name: '2026-07-30 16:15 - 1 empty-chamber pass, 12 points',
  createdAt: '2026-07-30T20:15:00.000Z',
  runIds: ['pass-1'],
  patch,
  curves: [],
  recordedOn: {
    deviceId: 'esp-test',
    modelId: 'freshroast-sr800',
    firmwareVersion: '2026-07-26.51',
    displayNameAtCapture: 'Test roaster',
    simulated: false,
    identitySource: 'roaster',
  },
  ...extras,
})

const device = {
  heaterGainCPerMinAt10: 70,
  fanCoolingCPerMinAt10: 20,
  coolingFanCPerMinAt10: 30,
  thermalLossPerMinPerC: 0.15,
  fitId: 'previous-loaded-fit',
  updatedAt: '2026-07-29T18:00:00.000Z',
}

describe('provisional empty-chamber apply completion', () => {
  it('builds the exact complete set for a first loaded roast and records inherited provenance', () => {
    const original = snapshot({
      heaterGainCPerMinAt10: 74,
      fanCoolingCPerMinAt10: 22,
      coolingFanCPerMinAt10: 31,
    })
    const result = completeEmptyChamberSnapshot(original, device)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.snapshot.patch).toEqual({
      heaterGainCPerMinAt10: 74,
      fanCoolingCPerMinAt10: 22,
      coolingFanCPerMinAt10: 31,
      thermalLossPerMinPerC: 0.15,
    })
    expect(result.value.measuredFields).toEqual([
      'heaterGainCPerMinAt10',
      'fanCoolingCPerMinAt10',
      'coolingFanCPerMinAt10',
    ])
    expect(result.value.inheritedFields).toEqual(['thermalLossPerMinPerC'])
    expect(result.value.snapshot.inheritedCoefficients?.thermalLossPerMinPerC).toEqual({
      source: 'roaster-applied',
      value: 0.15,
      fitId: 'previous-loaded-fit',
      appliedAt: '2026-07-29T18:00:00.000Z',
    })
    expect(result.value.snapshot.name).toContain('Provisional - inherited Thermal loss')
    expect(result.value.snapshot.applicationFitId).toBe('provisional:cal-empty')
    expect(original.patch.thermalLossPerMinPerC).toBeUndefined()
  })

  it('fails closed without mutating when the roaster cannot supply every missing field', () => {
    const original = snapshot({ heaterGainCPerMinAt10: 74 })
    const before = structuredClone(original)
    const result = completeEmptyChamberSnapshot(original, { heaterGainCPerMinAt10: 70 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('roaster does not currently report')
    expect(original).toEqual(before)
  })

  it('preserves inherited attribution when a saved provisional snapshot is applied again', () => {
    const first = completeEmptyChamberSnapshot(
      snapshot({
        heaterGainCPerMinAt10: 74,
        fanCoolingCPerMinAt10: 22,
        coolingFanCPerMinAt10: 31,
      }),
      device,
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const again = completeEmptyChamberSnapshot(first.value.snapshot, device)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.inheritedFields).toEqual(['thermalLossPerMinPerC'])
    expect(again.value.measuredFields).not.toContain('thermalLossPerMinPerC')
    expect(again.value.snapshot.inheritedCoefficients).toEqual(first.value.snapshot.inheritedCoefficients)
  })

  it('leaves a complete loaded-roast fit unchanged and never labels it provisional', () => {
    const loaded = snapshot(
      { ...device },
      {
        inputs: [{ runId: 'roast-1', capturedAt: '2026-07-30T19:00:00.000Z', label: 'First roast', massG: 250 }],
      },
    )
    const result = completeEmptyChamberSnapshot(loaded, device)
    expect(result).toEqual({
      ok: true,
      value: {
        snapshot: loaded,
        measuredFields: [
          'heaterGainCPerMinAt10',
          'fanCoolingCPerMinAt10',
          'coolingFanCPerMinAt10',
          'thermalLossPerMinPerC',
        ],
        inheritedFields: [],
      },
    })
  })

  it('does not complete a partial loaded-roast fit from old roaster values', () => {
    const partialLoaded = snapshot(
      { heaterGainCPerMinAt10: 74 },
      {
        inputs: [{ runId: 'roast-1', capturedAt: '2026-07-30T19:00:00.000Z', label: 'First roast', massG: 250 }],
      },
    )
    const result = completeEmptyChamberSnapshot(partialLoaded, device)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('Loaded fits must provide a complete measured set')
  })
})
