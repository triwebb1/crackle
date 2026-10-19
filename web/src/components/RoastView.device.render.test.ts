import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { demoRuns, starterBean, starterProfile, starterThermalIntent } from '../data/demo'
import { formatLocalDateTime } from '../domain/dateTime'
import type { ControllerStatus, RoastProgramStatus } from '../domain/types'
import { testLogProvenance } from '../testFixtures/provenance'
import {
  activeJourneyEditProblem,
  activeJourneyZoneChanges,
  activeTimedStepProblem,
  appendProfiledRoastSample,
  editActiveJourneyZone,
  profileFromActiveRoastPlan,
  RoastView,
  roastViewTitle,
} from './RoastView'

/**
 * ============================================================================================
 * THE ROAST RUNS ON THE CONTROLLER
 * ============================================================================================
 *
 * The requirement: after Start, the browser can be closed and the controller continues running
 * that roast.
 *
 * What can be pinned at the markup boundary is exactly the part a user experiences: that the page
 * says so in those words, that the numbers on screen while it executes are the DEVICE's, that Stop
 * is never absent while it runs, and that a modelled reachability concern is visible without
 * replacing the controller's runtime envelope. The arithmetic behind all of it is pinned in
 * `domain/roastProgram.test.ts`.
 */

const NOW = Date.now()
const noop = () => undefined

const APPLIED = {
  heaterGainCPerMinAt10: 66,
  fanCoolingCPerMinAt10: 19,
  coolingFanCPerMinAt10: 28,
  thermalLossPerMinPerC: 0.17,
}

const executor = (overrides: Partial<RoastProgramStatus> = {}): RoastProgramStatus => ({
  active: false,
  mode: 'none',
  saturated: false,
  holdover: false,
  ...overrides,
})

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'READY',
  connected: true,
  stale: false,
  receivedAtMs: NOW,
  firmwareVersion: '2026-07-27.39',
  bootId: '7',
  roaster: { deviceId: 'esp32-a', modelId: 'freshroast-sr800', displayName: 'FreshRoast SR800', simulated: false },
  manualLockout: false,
  thermocoupleValid: true,
  temperatureC: 24.6,
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  roast: executor(),
  appliedCoefficients: APPLIED,
  ...overrides,
})

const render = (props: Partial<Parameters<typeof RoastView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(RoastView, {
      profile: starterProfile,
      profiles: [starterProfile, starterThermalIntent],
      beans: [starterBean],
      runs: demoRuns,
      status: status(),
      calibration: {
        ...defaultCalibration,
        thermalSourceDeviceId: 'esp32-a',
        thermalSourceModelId: 'freshroast-sr800',
      },
      ambientC: 24.5,
      elapsedSec: 0,
      samples: [],
      events: [],
      defaultMassG: 225,
      selectedBeanId: starterBean.id,
      nowMs: NOW,
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
      ...props,
    }),
  )

describe('handing a roast to the controller', () => {
  /**
   * "Start Roast", not "Start on Controller", and no filing name beside it. Where the roast runs is
   * architecture, not a decision the user makes at the button; the sanitized name is bookkeeping
   * the roast-name field already covers. Both would be noise.
   */
  it('offers one Start, named for what it does rather than for where it runs', () => {
    const markup = render()
    expect(markup).toContain('Start roast')
    expect(markup).not.toContain('Start on controller')
    expect(markup).not.toContain('runs as')
    expect(markup).not.toContain('Before this roast can start')
  })

  /**
   * The button's label is the same on either firmware, so this only asserts that the other path is
   * still the one that renders when there is no executor.
   */
  it('keeps the old Start on firmware that has no roast executor', () => {
    const markup = render({ status: status({ roast: undefined }) })
    expect(markup).toContain('Start roast')
    expect(markup).not.toContain('Keep detailed thermal recording')
  })

  /**
   * The Start button must not sit a label's height above every other control in the row. A spacer
   * label holding a plain space is collapsible whitespace - a box holding only that generates no
   * line box and measures zero high, so the field's stack starts one row short. It holds a
   * non-breaking space, which is a line box like any other label's.
   */
  it('reserves the label line above Start, so its control shares the row baseline', () => {
    const markup = render()
    const spacer = markup.slice(markup.indexOf('setup-start'))
    expect(spacer).toContain('aria-hidden="true"> </span>')
  })

  it('lists every reason Start is blocked rather than only the first', () => {
    const markup = render({ status: status({ manualLockout: true }) })
    expect(markup).toContain('Before this roast can start')
    expect(markup).toContain('latched off after a manual-control conflict')
  })

  it('shows an infeasible model prediction while leaving Start available under the firmware envelope', () => {
    const strangled = {
      ...starterThermalIntent,
      segments: [{ ...starterThermalIntent.segments[0], endC: 260, fanMin: 8, fanMax: 9, heatMin: 3, heatMax: 5 }],
    }
    const markup = render({ profile: strangled, targetIntent: strangled })
    expect(markup).toContain('Prediction to review — Start remains available')
    const start = markup.slice(
      markup.indexOf('setup-start'),
      markup.indexOf('</button>', markup.indexOf('setup-start')),
    )
    expect(start).not.toContain('disabled')
    expect(markup).toContain('Zone 1 asks for 260 °C')
    expect(markup).toContain('153 °C')
    expect(markup).toContain('Batch mass changes the modelled approach time, not that equilibrium')
    expect(markup).toContain('minimum Fan 8 from 8–9')
    expect(markup).toContain('maximum Heat 5 from 3–5')
    expect(markup).toContain('firmware stops all outputs at twice the planned duration plus ten minutes')
  })

  /**
   * ==========================================================================================
   * NO APPLIED CALIBRATION: ONE THING WRONG, ONE THING TO DO
   * ==========================================================================================
   *
   * The mirror of the firmware's own 409, moved to where it can be acted on - and the ONLY thing
   * said in that state. No zone verdicts are stacked on top of it: feasibility would fall back to
   * whatever fit this app happened to hold, and an app fit may be a CHAMBER-scale set whose loss
   * coefficient is an order of magnitude off the bean model's, so such verdicts (a zone settling
   * somewhere in the nineties at heat 8-9) would be arithmetic about a roaster that does not exist,
   * printed as blockers.
   *
   * A setup state, presented as one: a calm heading, one sentence, and the same one-press fix the
   * mismatch banner offers.
   */
  const uncalibrated = (props: Partial<Parameters<typeof RoastView>[0]> = {}) =>
    render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      onOpenCalibrate: noop,
      status: status({ appliedCoefficients: undefined }),
      ...props,
    })

  it('refuses a journey when the roaster holds no applied calibration', () => {
    const markup = uncalibrated()
    expect(markup).toContain('needs calibration coefficients applied on the roaster')
    expect(markup).toContain('Before this roast can start')
  })

  it('says that and nothing else, with no zone verdicts drawn from a set that will not run', () => {
    const panel = uncalibrated()
    const blocked = panel.slice(panel.indexOf('setup-blocked'))
    // Exactly one item in the list, and it is the calibration one.
    expect(blocked.slice(0, blocked.indexOf('</ul>')).split('<li>')).toHaveLength(2)
    expect(panel).not.toContain('settles at')
    expect(panel).not.toContain('Prediction to review')
  })

  it('offers the same one-press fix the mismatch banner does', () => {
    const blocked = uncalibrated()
    expect(blocked.slice(blocked.indexOf('setup-blocked'))).toContain('Apply my calibration to the roaster')
    expect(blocked).toContain('Open Calibrate')
  })

  /**
   * A set the firmware would refuse is not a fix, so it is not offered as one. The loss coefficient
   * here is well outside the plausible range - which is exactly what a CHAMBER-scale fit sitting in
   * the app's settings looks like - and all that is left to offer is Calibrate.
   */
  it('offers only Calibrate when this app holds nothing the roaster would accept', () => {
    const blocked = uncalibrated({ calibration: { ...defaultCalibration, thermalLossPerMinPerC: 3.4 } })
    expect(blocked.slice(blocked.indexOf('setup-blocked'))).not.toContain('Apply my calibration to the roaster')
    expect(blocked).toContain('Open Calibrate')
  })

  /**
   * ==========================================================================================
   * THE UNAPPLIED-CALIBRATION BANNER
   * ==========================================================================================
   *
   * The banner says plainly what is wrong and what to do about it: a headline
   * that states the situation, the two sets as a table, and the fix as a button that presses - not
   * a paragraph ending in an instruction to visit another screen. The wording rules are pinned in
   * `domain/roastProgram.test.ts`; what is pinned here is that the page renders all four parts.
   */
  const mismatched = () =>
    render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      onOpenCalibrate: noop,
      status: status({ appliedCoefficients: { ...APPLIED, heaterGainCPerMinAt10: 61 } }),
    })

  it('states the situation in one headline before it states any number', () => {
    const markup = mismatched()
    expect(markup).toContain("Your latest calibration hasn't been applied to the roaster")
    expect(markup).toContain('the roast and this preview both use the older set the roaster is holding')
    expect(markup).not.toContain('Before this roast can start')
  })

  it('lays the two sets out as a table rather than as prose', () => {
    const markup = mismatched()
    const banner = markup.slice(markup.indexOf('calibration-mismatch'))
    expect(banner).toContain('<th>On the roaster</th>')
    expect(banner).toContain('<th>In this app</th>')
    // Named as every other screen names it, at the precision the firmware serializes at.
    expect(banner).toContain('Heat gain at 10 (°C/min)')
    expect(banner).toContain('<td>61.000</td>')
    expect(banner).toContain('<td>66.000</td>')
  })

  it('offers the fix as a button, with the Calibrate page still one press away', () => {
    const markup = mismatched()
    expect(markup).toContain('Apply my calibration to the roaster')
    expect(markup).toContain('Open Calibrate')
    expect(markup).toContain('The roast holds its targets either way.')
    // Enabled on an idle roaster: this is the state the user reads it in.
    const banner = markup.slice(markup.indexOf('calibration-mismatch'))
    expect(banner.slice(0, banner.indexOf('Open Calibrate'))).not.toContain('disabled')
  })

  /** The firmware answers 409 unless it is idle, so the button says so instead of failing on press. */
  it('disables the apply button with its reason while the roaster is busy', () => {
    const markup = render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: status({ lifecycle: 'RUNNING', appliedCoefficients: { ...APPLIED, heaterGainCPerMinAt10: 61 } }),
    })
    expect(markup).toContain('still running')
    const banner = markup.slice(markup.indexOf('calibration-mismatch'))
    expect(banner.slice(0, banner.indexOf('Apply my calibration'))).toContain('disabled')
  })

  /**
   * The press itself cannot be exercised in a static render, so the wiring is pinned at the source:
   * the banner's button calls the same client method the Calibrate page applies a fit with, and
   * nothing between it and the controller reimplements the request.
   */
  it('applies through the controller client rather than through a copy of it', () => {
    const source = readFileSync(new URL('./RoastView.tsx', import.meta.url), 'utf8')
    expect(source).toContain('controller.applyCalibration(')
    expect(source).toContain('onClick={() => void applyMyCalibration()}')
  })

  it('says nothing at all when the two sets agree', () => {
    const markup = render({ profile: starterThermalIntent, targetIntent: starterThermalIntent })
    expect(markup).not.toContain('calibration-mismatch')
    expect(markup).not.toContain('Apply my calibration to the roaster')
  })
})

describe('a roast running on the controller', () => {
  const running = (overrides: Partial<RoastProgramStatus> = {}) =>
    render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: status({
        lifecycle: 'RUNNING',
        temperatureC: 181.9,
        roast: executor({
          active: true,
          mode: 'journey',
          name: 'ethiopia-yirg',
          elapsedSec: 412,
          zoneIndex: 2,
          zoneCount: 5,
          zoneElapsedSec: 82,
          zoneNominalSec: 135,
          zoneEndC: 196,
          targetC: 187.4,
          commandedFan: 5.4,
          commandedHeat: 8.1,
          solvedFan: 5.37,
          solvedHeat: 8.14,
          correctionTotal: 2.4,
          integral: 1.1,
          ambientC: 26.3,
          batchMassG: 225,
          ...overrides,
        }),
      }),
    })

  it('keeps the running panel focused on the live roast, without a redundant close-page banner', () => {
    expect(running()).not.toContain('this page can be closed')
  })

  it('reports mode, name, zone progress, target, commanded levels and correction', () => {
    const markup = running()
    expect(markup).toContain('Temperature journey')
    expect(markup).toContain('ethiopia-yirg')
    expect(markup).toContain('3 of 5')
    expect(markup).toContain('1:22 of 2:15 nominal')
    expect(markup).toContain('187.4 °C')
    // Fan and Heat live in the readout tiles; the panel does not repeat them, and the tiles carry
    // what the law solved.
    expect(markup).not.toContain('Commanded fan')
    expect(markup).toMatch(/solved \d\.\d\d/)
    expect(markup).toContain('+2.4 °C/min')
    expect(markup).not.toContain('faster than plan')
  })

  /** A browser that arrived halfway through a roast it never started still gets the one command. */
  it('labels retained device values with their age when the live connection is stale', () => {
    const markup = render({
      nowMs: NOW,
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: status({
        connected: true,
        stale: true,
        receivedAtMs: NOW - 17_000,
        lifecycle: 'RUNNING',
        roast: executor({ active: true, mode: 'journey', name: 'stale roast' }),
      }),
    })
    expect(markup).toContain('Last roaster update 17 seconds ago')
    expect(markup).toContain('Values below are not current')
  })
  it('always offers Stop while the device executes, and puts the setup away', () => {
    const markup = running()
    expect(markup.match(/Stop roast/g)).toHaveLength(1)
    expect(markup).not.toContain('Start roast')
    expect(markup).not.toContain('Batch weight (g)')
  })

  /**
   * One control law, one answer, and one panel: this one. The browser's own fold draws the chart and
   * nothing else, so there is no second, rival reading of the same roast anywhere on the page.
   */
  it('is the only journey control on the page', () => {
    expect(running()).not.toContain('Advice only')
    expect(running()).not.toContain('Recommended fan')
    expect(running()).not.toContain('Journey control')
  })

  it('reports a holdover against its budget rather than a confident wrong correction', () => {
    const markup = running({ holdover: true, holdoverMs: 12000, holdoverLimitMs: 30000 })
    expect(markup).toContain('Waiting for temperature')
    expect(markup).toContain('No reading for 12 s; Heat stops after 30 s without one.')
  })

  it('reads a timed roast as steps, with no zone target at all', () => {
    const markup = running({ mode: 'timed', stepIndex: 3, stepCount: 6, targetC: undefined, zoneEndC: undefined })
    expect(markup).toContain('Timed control')
    expect(markup).toContain('4 of 6')
    expect(markup).not.toContain('Zone target')
    expect(markup).not.toContain('open loop')
  })
})

describe('what the controller did while nobody was watching', () => {
  const ended = (endReason: RoastProgramStatus['endReason']) =>
    render({ status: status({ roast: executor({ name: 'ethiopia-yirg', endReason }) }) })

  it('states the end reason in plain language, never as its wire value', () => {
    expect(ended('sensor_lost')).toContain('Ended because the thermocouple was lost')
    expect(ended('sensor_lost')).not.toContain('sensor_lost')
    expect(ended('completed')).toContain('Completed')
    expect(ended('qualification_stalled')).toContain('heat never became effective')
  })

  it('says nothing at all when no roast has ended since boot', () => {
    expect(render()).not.toContain('Ended by')
    expect(render()).not.toContain('Ended because')
  })
})

/**
 * ============================================================================================
 * TOLD BEFORE, NOT AFTER
 * ============================================================================================
 *
 * Automatic deletion is announced beforehand: if starting a roast will delete an older recording,
 * the user is told before Start.
 *
 * So the warning is rendered beside Start, names detailed recordings by id and date, and says
 * whether a summary curve survives. It never blocks: the button stays live and the
 * choice stays the user's. The arithmetic is pinned in `domain/storage.test.ts`.
 */
describe('the pre-roast retention warning', () => {
  const ARCHIVE_TOTAL = 896 * 1024
  const logs = [
    {
      id: '23',
      mode: 'roast' as const,
      bytes: 100 * 1024,
      startedAt: '2026-03-03T09:00:00.000Z',
      ...testLogProvenance('23'),
    },
    {
      id: '24',
      mode: 'roast' as const,
      bytes: 100 * 1024,
      startedAt: '2026-04-04T09:00:00.000Z',
      ...testLogProvenance('24'),
    },
  ]
  // 96 KB reserve, and only 20 KB of headroom left before it - so a ~100 KB recording prunes.
  const full = status({
    logArchive: {
      mounted: true,
      count: 2,
      usedBytes: ARCHIVE_TOTAL - 96 * 1024 - 20 * 1024,
      totalBytes: ARCHIVE_TOTAL,
    },
    dataStore: {
      mounted: true,
      usedBytes: 0,
      totalBytes: ARCHIVE_TOTAL,
      freeBytes: 20 * 1024,
      collections: {},
      runs: { count: 0, bytes: 0 },
    },
  })

  it('warns when the default detailed recording would prune an older recording', () => {
    const markup = render({ status: full, deviceLogs: logs, importedLogIds: [] })
    expect(markup).toContain('will delete 1 older recording')
    expect(markup).toContain('recording #23')
    expect(markup).toContain(formatLocalDateTime(logs[0].startedAt))
    // The default is the detailed curve, so the compact one is offered as the way to save space.
    expect(markup).toContain('switch to the compact 10-second curve')
  })

  it('says nothing while the archive still has room', () => {
    const roomy = status({
      logArchive: { mounted: true, count: 2, usedBytes: 40 * 1024, totalBytes: ARCHIVE_TOTAL },
    })
    expect(render({ status: roomy, deviceLogs: logs })).not.toContain('older recording')
  })

  /**
   * The toggle trades 1 s detail for a 10 s compact curve; it never removes the occurrence.
   *
   * The checkbox stays at checkbox size and its note is never clipped to an ellipsis; both are
   * stylesheet rules. What is pinned here is the wording, which must not claim more than the
   * argument does: the run,
   * its plan, journal and compact temperature path are saved either way; only 1 s detail is optional.
   * The note says exactly that, in full, with no ellipsis in it.
   */
  it('names detailed telemetry and says compact authoritative history is kept regardless', () => {
    const markup = render({ status: full, deviceLogs: logs })
    expect(markup).toContain('Detailed 1-second curve')
    expect(markup).toContain('aria-label="Keep detailed thermal recording"')
    expect(markup).toContain('A compact 10-second curve is always saved')
    // The claim that made turning it off feel like discarding the roast.
    expect(markup).not.toContain('Record this roast')
    expect(markup).not.toContain('The controller keeps the 1 Hz curve')
    expect(markup).toContain('compact 10-second curve')
    expect(markup).not.toContain('...')
    expect(markup).not.toContain('…')
  })

  it('defaults every roast to the detailed curve', () => {
    // A freshly loaded page must not start unticked: Journey roasts are kept at 1 s because they
    // feed the calibration.
    const checkedDetailedRecording =
      /<input(?=[^>]*aria-label="Keep detailed thermal recording")(?=[^>]*\bchecked\b)[^>]*>/
    expect(render()).toMatch(checkedDetailedRecording)
    expect(render({ manualMode: true })).toMatch(checkedDetailedRecording)
  })

  /** A checkbox, at checkbox size: the shared 42 px control band must not reach it. */
  it('keeps the secondary checkbox compact', () => {
    const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(styles).toMatch(/\.setup-record-toggle input \{[^}]*min-height: 0/)
    expect(styles).toMatch(/\.setup-record-toggle small \{[^}]*white-space: normal/)
  })
})

describe('authoritative active roast plans', () => {
  const activeJourney = {
    active: true,
    bootId: '7',
    sessionId: '42',
    planRev: 3,
    mode: 'journey' as const,
    profileId: 'journey-1',
    profileRevision: 8,
    name: 'Device journey',
    batchMassG: 225,
    steps: [],
    zones: [
      { id: 'z1', startC: 25, endC: 150, durationSec: 120, fanMin: 4, fanMax: 8, heatMin: 3, heatMax: 9 },
      { id: 'z2', startC: 150, endC: 190, durationSec: 180, fanMin: 5, fanMax: 9, heatMin: 2, heatMax: 8 },
    ],
  }

  it('reconstructs exact timed and journey profiles without consulting the catalog', () => {
    const journey = profileFromActiveRoastPlan(activeJourney, '2026-01-01T00:00:00.000Z')
    expect(journey).toMatchObject({
      id: 'journey-1',
      revision: 8,
      strategy: 'thermal-intent',
      segments: activeJourney.zones,
    })

    const timed = profileFromActiveRoastPlan(
      {
        ...activeJourney,
        mode: 'timed',
        zones: [],
        profileId: 'timed-1',
        profileRevision: 4,
        steps: [
          { fan: 5, heat: 8, durationSec: 30 },
          { fan: 6, heat: 7, durationSec: 45 },
          { fan: 9, heat: 0, durationSec: 60 },
        ],
      },
      '2026-01-01T00:00:00.000Z',
    )
    expect(timed).toMatchObject({
      id: 'timed-1',
      revision: 4,
      strategy: 'timed',
      coolFan: 9,
      coolDurationSec: 60,
      points: [
        { timeSec: 0, fan: 5, heat: 8 },
        { timeSec: 30, fan: 6, heat: 7 },
        { timeSec: 75, fan: 9, heat: 0 },
      ],
    })
  })

  it('titles the page by what the roaster is doing, not by which browser started it', () => {
    expect(roastViewTitle({ deviceActive: true, controlsActive: false })).toBe('Roast in progress')
    expect(roastViewTitle({ deviceActive: true, controlsActive: false, sessionName: 'Cerrado espresso' })).toBe(
      'Roast in progress',
    )
    expect(roastViewTitle({ deviceActive: false, controlsActive: true })).toBe('Manual control in progress')
    expect(roastViewTitle({ deviceActive: false, controlsActive: false, sessionName: 'Cerrado espresso' })).toBe(
      'Cerrado espresso',
    )
    expect(roastViewTitle({ deviceActive: false, controlsActive: false })).toBe('Set up a roast')
  })

  it('names the plan after the saved profile it was started from, keeping the executed zones', () => {
    const library = [{ ...starterThermalIntent, id: 'journey-1', name: 'Espresso Express', notes: 'Saved notes' }]
    const journey = profileFromActiveRoastPlan(activeJourney, '2026-01-01T00:00:00.000Z', library)
    expect(journey).toMatchObject({
      id: 'journey-1',
      name: 'Espresso Express',
      revision: 8,
      notes: 'Saved notes',
      segments: activeJourney.zones,
    })
    expect(profileFromActiveRoastPlan(activeJourney, '2026-01-01T00:00:00.000Z', []).name).toBe('Device journey')
  })

  it('samples at most once per device second and keeps a bounded live trace', () => {
    const one = appendProfiledRoastSample([], {
      elapsedSec: 1.9,
      beanTempC: 40,
      requestedFan: 5,
      effectiveFan: 5,
      requestedHeat: 8,
      effectiveHeat: 8,
    })
    expect(
      appendProfiledRoastSample(one, {
        elapsedSec: 1.1,
        beanTempC: 41,
        requestedFan: 5,
        effectiveFan: 5,
        requestedHeat: 8,
        effectiveHeat: 8,
      }),
    ).toBe(one)
    let samples = one
    for (let second = 2; second <= 2405; second += 1)
      samples = appendProfiledRoastSample(samples, {
        elapsedSec: second,
        beanTempC: 40 + second / 10,
        requestedFan: 5,
        effectiveFan: 5,
        requestedHeat: 8,
        effectiveHeat: 8,
      })
    expect(samples).toHaveLength(2400)
    expect(samples.at(-1)?.elapsedSec).toBe(2405)
  })

  it('locks completed zones and rejects unsafe current-zone direction or duration changes', () => {
    const completed = editActiveJourneyZone(activeJourney.zones, 0, 1, { endC: 140 })
    expect(completed).toBe(activeJourney.zones)
    const reversed = editActiveJourneyZone(activeJourney.zones, 1, 1, { endC: 120 })
    expect(activeJourneyEditProblem(activeJourney.zones, reversed, 1, 20)).toContain('cannot reverse direction')
    const tooShort = editActiveJourneyZone(activeJourney.zones, 1, 1, { durationSec: 24 })
    expect(activeJourneyEditProblem(activeJourney.zones, tooShort, 1, 20)).toContain('at least 25 seconds')
  })

  it('uses device limits for timed steps and reserves five seconds on the current one', () => {
    const oneSecond = { fan: 4, heat: 0, durationSec: 1 }
    expect(activeTimedStepProblem(oneSecond, 2, 0, 100)).toBeUndefined()
    expect(activeTimedStepProblem(oneSecond, 0, 0, 100)).toContain('enter 105 seconds or more')
    expect(activeTimedStepProblem({ ...oneSecond, durationSec: 105 }, 0, 0, 100)).toBeUndefined()
    const timedPlan = {
      ...activeJourney,
      mode: 'timed' as const,
      zones: [],
      steps: [
        { fan: 4, heat: 0, durationSec: 105 },
        { fan: 5, heat: 0, durationSec: 1 },
      ],
    }
    const markup = render({
      activePlan: timedPlan,
      status: status({
        lifecycle: 'RUNNING',
        roast: executor({
          active: true,
          mode: 'timed',
          sessionId: '42',
          planRev: 3,
          stepIndex: 0,
          stepElapsedSec: 100,
          stepCount: 2,
        }),
      }),
    })
    expect(markup).toMatch(/<input(?=[^>]*aria-label="Step 1 seconds")(?=[^>]*min="105")[^>]*>/)
    expect(markup).toMatch(/<input(?=[^>]*aria-label="Step 2 seconds")(?=[^>]*min="1")[^>]*>/)
  })

  it('renders completed zones disabled and keeps immediate transition as a second explicit action', () => {
    const running = status({
      lifecycle: 'RUNNING',
      roast: executor({
        active: true,
        mode: 'journey',
        sessionId: '42',
        planRev: 3,
        zoneIndex: 1,
        zoneCount: 2,
        zoneElapsedSec: 20,
      }),
    })
    const markup = render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: running,
      activePlan: activeJourney,
    })
    expect(markup).toContain('Edit active journey plan')
    expect(markup).toContain('Zone 1 / completed')
    expect(markup).toContain('disabled')
    const source = readFileSync(new URL('./RoastView.tsx', import.meta.url), 'utf8')
    expect(source).toContain('Confirm apply and advance now')
    expect(source).toContain('patchActivePlan(true)')
    expect(source).toContain('requiresImmediateTransition')
  })
})

describe('edited active-plan completion', () => {
  const editedPlan = {
    active: false,
    bootId: '7',
    sessionId: '42',
    planRev: 2,
    mode: 'journey' as const,
    profileId: starterThermalIntent.id,
    profileRevision: starterThermalIntent.revision,
    name: starterThermalIntent.name,
    steps: [],
    zones: starterThermalIntent.segments,
    initialZones: starterThermalIntent.segments.map((zone) => ({ ...zone })),
    journal: [{ initial: true }, { edited: true }],
  }
  const endedStatus = status({
    lifecycle: 'STANDBY',
    roast: executor({ active: false, mode: 'journey', sessionId: '42', planRev: 2, endReason: 'stopped' }),
  })

  it('shows the exact changed fields but cannot save an early-stopped plan', () => {
    const changed = {
      ...editedPlan,
      zones: editedPlan.zones.map((zone, index) =>
        index === 1 ? { ...zone, endC: zone.endC + 4, heatMax: zone.heatMax - 1 } : zone,
      ),
    }
    expect(activeJourneyZoneChanges(changed)).toEqual([
      { zoneIndex: 1, field: 'endC', before: editedPlan.zones[1].endC, after: editedPlan.zones[1].endC + 4 },
      { zoneIndex: 1, field: 'heatMax', before: editedPlan.zones[1].heatMax, after: editedPlan.zones[1].heatMax - 1 },
    ])
    const markup = render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: endedStatus,
      activePlan: changed,
    })
    expect(markup).toContain('Review the journey changes')
    expect(markup).toContain('2 changed fields')
    expect(markup).toContain(`was ${editedPlan.zones[1].endC}`)
    expect(markup).not.toContain('Save as new profile revision')
    expect(markup).toContain('Reviewed')
    expect(
      render({
        profile: starterThermalIntent,
        targetIntent: starterThermalIntent,
        status: endedStatus,
        activePlan: changed,
        activePlanRevisionHandled: true,
      }),
    ).not.toContain('Review the journey changes')
  })

  it('offers Save only when the roaster reports completed', () => {
    const completed = { ...endedStatus, roast: { ...endedStatus.roast!, endReason: 'completed' as const } }
    const markup = render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: completed,
      activePlan: editedPlan,
    })
    expect(markup).toContain('Save the journey changes?')
    expect(markup).toContain('Save as new profile revision')
    expect(markup).toContain('Keep only in roast record')
  })
})

/**
 * Refreshing the Roast page mid-roast must not show a remnant image of the previous roast. A reload can restore a retained 'running' manual record as the active
 * session; the chart must nevertheless present the roast the ROASTER is executing.
 */
describe('the chart presents the roast the roaster is executing', () => {
  const retainedManualSession = {
    ...demoRuns[0],
    id: 'retained-manual',
    outcome: 'running' as const,
    manualRoast: { changes: [], incomplete: true },
  }
  const journeyExecutor = executor({
    active: true,
    mode: 'journey',
    sessionId: '9',
    planRev: 1,
    elapsedSec: 45,
    zoneIndex: 0,
    zoneEntrySec: 0,
    targetC: 61.5,
    zoneAttainedSec: [null, null, null, null, null],
  })

  it('draws an active device journey as a journey even while a retained manual session record is held', () => {
    const markup = render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: status({ lifecycle: 'RUNNING', roast: journeyExecutor }),
      activeSession: retainedManualSession,
    })
    expect(markup).toContain('Original plan')
    expect(markup).toContain('Adjusted plan')
  })

  it('still draws a retained manual session as manual once the roaster is idle', () => {
    const markup = render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: status({ roast: executor() }),
      activeSession: retainedManualSession,
    })
    expect(markup).not.toContain('Original plan')
  })
})
