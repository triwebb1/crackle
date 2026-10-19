import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterProfile, starterThermalIntent } from '../data/demo'
import type { CalibrationSnapshot } from '../domain/types'
import { testRecordedOn } from '../testFixtures/provenance'
import { ProfileSimulationPanel } from './ProfileSimulationPanel'

const patch = { heaterGainCPerMinAt10: 41.2, thermalLossPerMinPerC: 0.021 }
const snapshot: CalibrationSnapshot = {
  id: 'snap',
  name: 'July baseline 4x3',
  createdAt: '2026-07-20T10:00:00.000Z',
  recordedOn: testRecordedOn,
  runIds: ['run'],
  ambientC: 24.5,
  patch,
  curves: [],
}

const render = (props: Partial<Parameters<typeof ProfileSimulationPanel>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ProfileSimulationPanel, {
      profile: starterThermalIntent,
      profiles: [starterThermalIntent],
      calibration: defaultCalibration,
      defaultMassG: 225,
      snapshots: [],
      ...props,
    }),
  )

describe('the simulation states where its numbers come from', () => {
  it('says plainly that the shipped model is an estimate, not a measurement', () => {
    const markup = render()
    expect(markup).toContain('model-provenance estimated')
    expect(markup).toContain('estimated starting baseline (not fitted from your machine)')
    expect(markup).toContain('plausible but unverified')
    expect(markup).not.toContain('model-provenance calibrated')
  })

  it('warns outright when somebody has typed the coefficients in', () => {
    const markup = render({ calibration: { ...defaultCalibration, heaterGainCPerMinAt10: 44 } })
    expect(markup).toContain('model-provenance manual')
    expect(markup).toContain('hand-entered coefficients')
    expect(markup).toContain('SHAPE only')
  })

  it('names the calibration when one has actually been applied', () => {
    const markup = render({ calibration: { ...defaultCalibration, ...patch }, snapshots: [snapshot] })
    expect(markup).toContain('model-provenance calibrated')
    expect(markup).toContain('Model: calibrated from July baseline 4x3')
    expect(markup).toContain('measured on this roaster')
    expect(markup).not.toContain('estimated starting baseline')
  })

  it('labels the modelled trace as predicted, never as actual', () => {
    const markup = render()
    expect(markup).toContain('>Predicted<')
    expect(markup).toContain('Predicted bean temperature (°C)')
    expect(markup).not.toContain('>Actual<')
  })

  it('makes no accuracy claim about itself when no model error was assumed', () => {
    // A perfect-model simulation grading its own tracking is meaningless: with zero
    // assumed error the panel may only report attainment, overruns, and infeasibility.
    const markup = render()
    expect(markup).not.toContain('Furthest off goal')
    expect(markup).not.toContain('Predicted duration')
    expect(markup).not.toContain('Predicted finish')
    expect(markup).toContain('Assumed model error')
    expect(markup).toContain('there is nothing here for it to get wrong')
  })

  /**
   * One caption, and it says where the numbers came from in words a roaster uses. Phrasing such as
   * "Fan and Heat are derived per zone by inverting the thermal model against the goal path" is
   * what the banned list below exists to keep out.
   */
  it('states in plain words that Fan and Heat come from the calibration', () => {
    const markup = render()
    expect(markup).toContain('Fan and heat come from that calibration')
    expect(markup).toContain('produce the climb the zone asks for')
    expect(markup).toContain('reaches its endpoint rather than when a clock runs out')
  })
})

/**
 * The words a user is never shown, applied to every word this panel renders rather than to one
 * known string. Repeated verbatim from `roastProgram.test.ts` - importing one test file
 * into another would register its cases twice.
 */
const BANNED_IN_OWNER_TEXT = ['invert', 'diverg', 'plant']

describe("the panel speaks the user's language", () => {
  const strip = (markup: string) => markup.replace(/<[^>]*>/g, ' ').toLowerCase()

  it('uses none of the banned vocabulary in any of its states', () => {
    const states = [
      render(),
      render({ calibration: { ...defaultCalibration, heaterGainCPerMinAt10: 44 } }),
      render({ calibration: { ...defaultCalibration, ...patch }, snapshots: [snapshot] }),
      render({ profile: starterProfile, profiles: [starterProfile, starterThermalIntent] }),
    ]
    for (const markup of states) {
      const text = strip(markup)
      for (const banned of BANNED_IN_OWNER_TEXT) expect(text).not.toContain(banned)
    }
  })
})

/**
 * The density note must not read as a verdict on the whole simulation. It is one small line, it names the field to fill in, and it
 * is gone the moment there is a volume to compute a density from.
 */
describe('the density note', () => {
  it('appears only while the volume it asks for is missing', () => {
    const markup = render()
    expect(markup).toContain('Starting volume is blank')
    expect(markup).toContain('Starting volume (ml)')
    expect(markup).not.toContain('Density not supplied')
  })
})
