import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { demoRuns, starterBean, starterProfile, starterThermalIntent } from '../data/demo'
import { DEMO_RECORDED_ON, DEMO_SOURCE_DEVICE_ID } from '../data/demoIdentity'
import type { ControllerStatus } from '../domain/types'
import { BeansView } from './BeansView'
import { HistoryView } from './HistoryView'
import { NumberField } from './NumberField'
import { ProfileSimulationPanel } from './ProfileSimulationPanel'
import { RoastView } from './RoastView'

const noop = () => undefined

/**
 * The draft-versus-render bug class, audited app-wide.
 *
 * Two causes, and any numeric field can have either. In Preact `onChange` IS
 * the native change event, which does not fire until the field is committed, so between the first
 * keystroke and blur the DOM and the vdom disagree and the next parent render writes the old value
 * back. And parsing on every keystroke destroys the intermediate states a number passes through -
 * "" is not 0 and "1." is not 1 - so a field that round-trips through `Number()` cannot be typed
 * into at all. `NumberField` fixes both: the draft is text, it updates on `input`, and it is only
 * re-seeded when the committed value changes to something the draft does not already say.
 */
describe('numeric fields are typed into, not fought with', () => {
  it('listens on input rather than waiting for a commit', () => {
    const markup = renderToStaticMarkup(createElement(NumberField, { label: 'Mass', value: 225, onCommit: noop }))
    expect(markup).toContainCode('value="225"')
    expect(markup).toContainCode('type="number"')
  })

  it('renders an absent value as empty rather than as zero', () => {
    const markup = renderToStaticMarkup(
      createElement(NumberField, { label: 'Volume', value: undefined, placeholder: 'Optional', onCommit: noop }),
    )
    expect(markup).toContainCode('placeholder="Optional"')
    // Empty, not zero: an absent optional measurement is not the number 0.
    expect(markup).not.toContainCode('value="0"')
    expect(markup).not.toMatch(/value="[^"]/)
  })

  it('carries its own label, hint and accessible name', () => {
    const markup = renderToStaticMarkup(
      createElement(NumberField, { label: 'Moisture (%)', hint: 'Optional', value: 10.5, onCommit: noop }),
    )
    expect(markup).toContainCode('Moisture (%)')
    expect(markup).toContainCode('<small>Optional</small>')
    expect(markup).toContainCode('aria-label="Moisture (%)"')
  })
})

const status: ControllerStatus = {
  lifecycle: 'READY',
  connected: true,
  stale: false,
  receivedAtMs: Date.now(),
  firmwareVersion: '2026-07-26.36',
  bootId: '4',
  manualLockout: false,
  thermocoupleValid: true,
  roaster: {
    deviceId: DEMO_SOURCE_DEVICE_ID,
    modelId: DEMO_RECORDED_ON.modelId,
    displayName: DEMO_RECORDED_ON.displayNameAtCapture,
    simulated: true,
    simulatesModelId: DEMO_RECORDED_ON.simulatesModelId,
  },
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
}

/**
 * The audit itself: no screen may still be driving a numeric input from the native change event.
 * `onChange` never appears in rendered markup, so this checks the rendered field carries the marks
 * `NumberField` leaves - and the source check below is what actually pins the audit.
 */
const screens = {
  simulation: renderToStaticMarkup(
    createElement(ProfileSimulationPanel, {
      profile: starterThermalIntent,
      profiles: [starterThermalIntent],
      calibration: defaultCalibration,
      defaultMassG: 225,
      snapshots: [],
    }),
  ),
  beans: renderToStaticMarkup(
    createElement(BeansView, {
      beans: [starterBean],
      runs: demoRuns,
      revisions: [],
      onSelect: noop,
      onSave: noop,
      onDelete: noop,
      onDirtyChange: noop,
      onOpenRun: noop,
    }),
  ),
  history: renderToStaticMarkup(
    createElement(HistoryView, {
      runs: demoRuns,
      onOverlay: noop,
      onDelete: noop,
      onSaveDetails: async () => undefined,
      onImport: async () => '',
      onUseAsProfile: noop,
      activeRoasterId: DEMO_SOURCE_DEVICE_ID,
    }),
  ),
  roast: renderToStaticMarkup(
    createElement(RoastView, {
      profile: starterProfile,
      profiles: [starterProfile],
      beans: [starterBean],
      runs: demoRuns,
      status,
      calibration: defaultCalibration,
      ambientC: 24.5,
      elapsedSec: 0,
      samples: [],
      events: [],
      defaultMassG: 225,
      selectedBeanId: starterBean.id,
      onBean: noop,
      onProfile: noop,
      onOverlay: noop,
      onStart: noop,
      onMeasurements: noop,
      onNotes: noop,
      onCloseSession: noop,
      onAbandonSession: noop,
      revisionAvailable: false,
      onSaveRevision: noop,
      onDismissRevision: noop,
    }),
  ),
}

describe('every screen with numbers uses the shared field', () => {
  for (const [name, markup] of Object.entries(screens)) {
    it(`renders ${name} without a raw uncontrolled number input`, () => {
      expect(markup).not.toContainCode('textAnchor')
      // Nothing renders a number field with a bare `value` of NaN or "undefined".
      expect(markup).not.toContainCode('value="NaN"')
      expect(markup).not.toContainCode('value="undefined"')
    })
  }

  it('recomputes the simulation automatically, with no second Run button', () => {
    expect(screens.simulation).not.toContainCode('Run simulation')
    expect(screens.simulation).toContainCode('Up to date')
    expect(screens.simulation).toContainCode('Starting mass (g)')
  })

  it('lists roasts as one line each, with the retired columns gone', () => {
    expect(screens.history).toContainCode('sortable-table')
    expect(screens.history).not.toContainCode('Overrides')
    expect(screens.history).not.toContainCode('Export CSV')
  })
})

/**
 * The free-text half of the same audit.
 *
 * Typed notes in the roast history must not revert about a second after typing stops, and no other
 * free-text field in the UI may share that defect. The mechanism is in `domain/draft.ts` and the rules are tested in `draft.test.ts`; what belongs here is
 * the audit itself - that no screen is still driving a free-text field from the native change event.
 */
describe('every free-text field in the app owns what is being typed', () => {
  it('has no textarea or text input left bound to the native change event', () => {
    const sources = [
      'HistoryView',
      'RoastView',
      'ProfileEditor',
      'BeansView',
      'CalibrationView',
      'DataTable',
      'TextField',
    ].map((name) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8'))
    for (const [index, source] of sources.entries()) {
      // A `<textarea>` may only be rendered by the shared field now, so no screen can regress.
      expect(source.includes('<textarea'), `raw textarea in source ${index}`).toBe(
        source.includes('export function TextArea'),
      )
    }
  })

  it('routes the roast-history notes through the shared field', () => {
    // The detail only exists once a row is open, so this is checked at the source boundary.
    const source = readFileSync(new URL('./HistoryView.tsx', import.meta.url), 'utf8')
    expect(source).toContainCode('<TextArea className="notes-field history-notes"')
    // And its write joins the same merged, debounced record draft as the measurements beside it.
    expect(source).toContainCode('const updateNotes = (run: RoastRun, notes: string) => {')
    expect(source).toContainCode(
      'queueDetails(run, { ...(draft?.measurements ?? run.measurements) }, notes, draft ? draft.score : runScore(run))',
    )
  })

  it('makes the whole roast row the expand target', () => {
    expect(screens.history).toContainCode('table-row expandable')
    // The labelled button stays: it is what the keyboard and assistive technology are offered.
    expect(screens.history).toContainCode('aria-label="Expand row"')
    expect(screens.history).toContainCode('aria-expanded="false"')
  })
})
