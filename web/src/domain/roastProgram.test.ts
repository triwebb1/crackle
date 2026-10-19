import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterProfile, starterThermalIntent } from '../data/demo'
import { testLogProvenance } from '../testFixtures/provenance'
import { coefficientDivergence } from './deviceLogs'
import { zoneFeasibility } from './journeyControl'
import { effectiveThermalIntent, valuesAt } from './model'
import {
  CALIBRATION_APPLY_ACTION,
  calibrationApplyBlockedReason,
  calibrationMismatchNotice,
  DEFAULT_ROAST_NAME,
  ENDS_HEATING_WARNING,
  journeyZonesError,
  massError,
  profileIdentityArgs,
  ROAST_END_REASONS,
  ROAST_LIMITS,
  roastEndReasonText,
  roastPreflight,
  roastRuntimeEnvelopeSec,
  roastStartArgs,
  roastStartFailure,
  sanitizeRoastName,
  serializeJourneyZones,
  serializeTimedSteps,
  TIMED_ENDS_HEATING_WARNING,
  timedRoastSteps,
  timedStepsError,
} from './roastProgram'
import type {
  CalibrationRun,
  ControllerStatus,
  RoastEndReason,
  RoastRun,
  ThermalIntent,
  ThermalSegment,
  TimedProfile,
} from './types'

const NOW = 1_800_000_000_000

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: NOW,
  firmwareVersion: '2026-07-27.39',
  bootId: '7',
  manualLockout: false,
  thermocoupleValid: true,
  temperatureC: 24.8,
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  // The executor's presence IS the feature detection, so every gate test needs the block.
  roast: { active: false, mode: 'none', saturated: false, holdover: false },
  appliedCoefficients: {
    heaterGainCPerMinAt10: 66,
    fanCoolingCPerMinAt10: 19,
    coolingFanCPerMinAt10: 28,
    thermalLossPerMinPerC: 0.17,
    fitId: 'fit-2026-07-27',
  },
  ...overrides,
})
describe('device runtime envelope', () => {
  it('allows twice the whole nominal plan plus ten minutes', () => {
    expect(roastRuntimeEnvelopeSec(13 * 60)).toBe(36 * 60)
  })
})

const preflight = (overrides: Parameters<typeof roastPreflight>[0]) => roastPreflight(overrides)

const journeyOf = (segments: ThermalSegment[]): ThermalIntent => ({ ...starterThermalIntent, segments })

/** The gate's own sentence, repeated rather than exported: the wording is the thing being pinned. */
const NEEDS_CALIBRATION_TEXT =
  'A journey roast needs calibration coefficients applied on the roaster. Fit and apply a calibration first, or run this roast in timed mode.'

describe('the roast name round-trips through the firmware alphabet', () => {
  /**
   * The name is not decoration: it is the ONLY join key between a recording on the controller's
   * flash and a profile in this library, so a name that changes in transit breaks the history
   * import silently. Sanitizing before sending is what makes the round trip byte-identical.
   */
  it('reduces anything outside [A-Za-z0-9._:- ] to a dash, exactly as the firmware does', () => {
    expect(sanitizeRoastName('Ethiopia Yirgacheffe #3 (light)')).toBe('Ethiopia Yirgacheffe -3 -light-')
    expect(sanitizeRoastName('House espresso')).toBe('House espresso')
    expect(sanitizeRoastName('a.b_c:d-e')).toBe('a.b_c:d-e')
  })

  it('truncates to 32 BYTES, not 32 characters', () => {
    expect(sanitizeRoastName('x'.repeat(80))).toHaveLength(ROAST_LIMITS.nameBytes)
    // The firmware substitutes per byte, so a three-byte character becomes three dashes there. A
    // character-wise version here would produce one, and the echoed name would not match.
    expect(sanitizeRoastName('こん')).toBe('------')
    expect(new TextEncoder().encode('こん')).toHaveLength(6)
  })

  it('substitutes the firmware default only for a name that sanitizes to nothing at all', () => {
    expect(sanitizeRoastName('')).toBe(DEFAULT_ROAST_NAME)
    // Spaces are inside the alphabet, so they survive rather than being trimmed away here and left
    // in place on the device - that would be a divergence of exactly the kind this function exists
    // to prevent.
    expect(sanitizeRoastName('  ')).toBe('  ')
  })

  it('is idempotent, so a name read back from the device sanitizes to itself', () => {
    for (const name of ['House espresso', 'Ethiopia Yirgacheffe -3 -light-', 'roast']) {
      expect(sanitizeRoastName(sanitizeRoastName(name))).toBe(sanitizeRoastName(name))
    }
  })
})

describe('a timed profile serializes to the steps the controller will run', () => {
  it('holds each point until the next, and the last for the cool duration', () => {
    const steps = timedRoastSteps(starterProfile)
    // The starter profile authors its own cooling row, so the trailing window is that row's dwell.
    expect(steps).toEqual([
      { fan: 8.2, heat: 4.6, durationSec: 135 },
      { fan: 7.8, heat: 5.8, durationSec: 150 },
      { fan: 7.2, heat: 7, durationSec: 145 },
      { fan: 6.4, heat: 8.1, durationSec: 140 },
      { fan: 5.8, heat: 7.4, durationSec: 45 },
      { fan: 9, heat: 0, durationSec: 90 },
    ])
    expect(serializeTimedSteps(steps)).toBe('8.2:4.6:135,7.8:5.8:150,7.2:7:145,6.4:8.1:140,5.8:7.4:45,9:0:90')
  })

  /**
   * The serialization is only correct if it reproduces the level timeline the rest of the app draws
   * and simulates from. This replays both and compares them second by second, which is the property
   * that actually matters rather than the string.
   */
  it('reproduces the profile level timeline the simulator and the chart already read', () => {
    const steps = timedRoastSteps(starterProfile)
    let elapsed = 0
    for (const step of steps) {
      for (let offset = 0; offset < step.durationSec; offset += 1) {
        const expected = valuesAt(starterProfile, elapsed + offset)
        expect({ fan: step.fan, heat: step.heat }, `at ${elapsed + offset} s`).toEqual({
          fan: expected.fan,
          heat: expected.heat,
        })
      }
      elapsed += step.durationSec
    }
    // And the whole program is exactly as long as the profile says it is.
    expect(elapsed).toBe(615 + 90)
  })

  it('uses the final point, not an interior heat-zero point, to decide terminal cooling', () => {
    const reheated: TimedProfile = {
      ...starterProfile,
      points: [
        { id: 'hot', timeSec: 0, fan: 8, heat: 5 },
        { id: 'pause', timeSec: 60, fan: 9, heat: 0 },
        { id: 'reheat', timeSec: 120, fan: 7, heat: 6 },
      ],
      coolFan: 10,
      coolDurationSec: 45,
    }
    const steps = timedRoastSteps(reheated)
    expect(steps).toEqual([
      { fan: 8, heat: 5, durationSec: 60 },
      { fan: 9, heat: 0, durationSec: 60 },
      { fan: 7, heat: 6, durationSec: 45 },
      { fan: 10, heat: 0, durationSec: 45 },
    ])
  })

  it('appends the trailing cool window when the profile never authored a cooling row', () => {
    const hot: TimedProfile = {
      ...starterProfile,
      points: [
        { id: 'a', timeSec: 0, fan: 8, heat: 5 },
        { id: 'b', timeSec: 120, fan: 7, heat: 8 },
      ],
      coolFan: 9.5,
      coolDurationSec: 60,
    }
    const steps = timedRoastSteps(hot)
    // A device roast may never end with the element on, so the cool window is explicit.
    expect(steps.at(-1)).toEqual({ fan: 9.5, heat: 0, durationSec: 60 })
    expect(serializeTimedSteps(steps)).toBe('8:5:120,7:8:60,9.5:0:60')
  })

  it('refuses a plan the firmware would reject, in the firmware’s own words', () => {
    expect(timedStepsError([])).toContain('1 to 24 steps')
    expect(timedStepsError([{ fan: 0, heat: 4, durationSec: 60 }])).toBe('Step 1: fan 0 is only allowed with heat 0')
    expect(timedStepsError([{ fan: 5, heat: 4, durationSec: 3600 }])).toContain('1 to 1800 seconds')
    expect(timedStepsError([{ fan: 5, heat: 11, durationSec: 60 }])).toContain('between 0.0 and 10.0')
    expect(timedStepsError(timedRoastSteps(starterProfile))).toBeUndefined()
  })
})

describe('roast mass validation', () => {
  it('requires an actual whole number rather than accepting a rounded decimal', () => {
    expect(massError(225)).toBeUndefined()
    expect(massError(225.4)).toContain('whole number')
  })
})

describe('a temperature journey serializes to the documented zone form', () => {
  it('emits endC:duration:fanMin:fanMax:heatMin:heatMax, semicolon separated', () => {
    expect(serializeJourneyZones(starterThermalIntent.segments)).toBe(
      '150:210:5:9:3:8;175:120:5:9:3:9;196:135:4:8:4:9;210:120:4:8:3:9;40:180:3:10:0:0',
    )
  })

  /** Start temperatures are never authored: each zone starts where the one before it ended. */
  it('carries no start temperature per zone, only the endpoint', () => {
    const fields = serializeJourneyZones(starterThermalIntent.segments).split(';')[0].split(':')
    expect(fields).toHaveLength(6)
    expect(Number(fields[0])).toBe(starterThermalIntent.segments[0].endC)
  })

  it('refuses a zone list the firmware would reject', () => {
    const zone = starterThermalIntent.segments[0]
    expect(journeyZonesError([])).toContain('1 to 12 zones')
    expect(journeyZonesError([{ ...zone, endC: 350 }])).toContain('between 0 and 300 °C')
    expect(journeyZonesError([{ ...zone, durationSec: 2 }])).toContain('5 to 1800 seconds')
    expect(journeyZonesError([{ ...zone, fanMin: 9, fanMax: 4 }])).toContain('fan minimum is above its maximum')
    expect(journeyZonesError([{ ...zone, fanMin: 0, fanMax: 0 }])).toContain('always needs airflow')
    expect(journeyZonesError(starterThermalIntent.segments)).toBeUndefined()
  })
})

describe('levels and descending zones on the wire', () => {
  const zone = starterThermalIntent.segments[0]

  it('lifts a nonzero level below 0.1 to 0.1 before rounding, so it can never go out as off', () => {
    // Edge case: fanMax 0.04 must not validate and then serialize as 0.
    const shallow = { ...zone, fanMin: 0, fanMax: 0.04, heatMin: 0, heatMax: 0.02 }
    expect(journeyZonesError([shallow])).toBeUndefined()
    const fields = serializeJourneyZones([shallow]).split(':')
    expect(fields.slice(2)).toEqual(['0', '0.1', '0', '0.1'])
    for (const value of [0.001, 0.04, 0.049, 0.05, 0.099]) {
      const [, , , fanMax] = serializeJourneyZones([{ ...zone, fanMin: 0, fanMax: value }]).split(':')
      expect(fanMax).toBe('0.1')
    }
    // A timed step's nonzero heat below 0.1 also leaves at 0.1, with the heat-on Fan floor applied.
    expect(serializeTimedSteps([{ fan: 0.04, heat: 0.04, durationSec: 30 }])).toBe('1:0.1:30')
    expect(serializeTimedSteps([{ fan: 0.04, heat: 0, durationSec: 30 }])).toBe('0.1:0:30')
    expect(serializeTimedSteps([{ fan: 0, heat: 0, durationSec: 30 }])).toBe('0:0:30')
  })

  it('never sends a zone handed over as cooling as a heat-allowed hold', () => {
    // A caller handing raw lifted-but-unrelinked segments: 28 -> 29.5 after a zone ending at 29.5.
    // As handed, zone 3 is descending (30 -> 20 lifted to 29.5 is still < start); on the device it
    // relinks to 29.5 -> 29.5, a hold, so its Heat band must travel as 0:0.
    const wire = serializeJourneyZones([
      { ...zone, startC: 25, endC: 200, heatMin: 0, heatMax: 10 },
      { ...zone, startC: 200, endC: 29.5, heatMin: 0, heatMax: 10 },
      { ...zone, startC: 40, endC: 29.5, heatMin: 0, heatMax: 10 },
    ])
      .split(';')
      .map((entry) => entry.split(':'))
    expect(wire[0].slice(4)).toEqual(['0', '10'])
    expect(wire[1].slice(4)).toEqual(['0', '10'])
    expect(wire[2].slice(4)).toEqual(['0', '0'])
  })

  it('sends the effective intent of a journey with a collapsed cooling zone, that zone unheated', () => {
    const effective = effectiveThermalIntent(
      journeyOf([
        { ...zone, id: 'a', startC: 25, endC: 200, durationSec: 480, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
        { ...zone, id: 'b', startC: 200, endC: 28, durationSec: 240, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
        { ...zone, id: 'c', startC: 28, endC: 20, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
      ]),
      24.5,
      5,
    )
    expect(serializeJourneyZones(effective.segments)).toBe('200:480:1:10:0:10;29.5:240:1:10:0:10;29.5:120:1:10:0:0')
  })
})

describe('the whole request', () => {
  it('builds a timed request with the confirm token, sanitized name and integer mass', () => {
    expect(roastStartArgs({ profile: starterProfile, massG: 225 })).toEqual({
      mode: 'timed',
      confirm: 'START_ROAST',
      name: 'House espresso',
      mass: '225',
      profile_id: 'profile-house-espresso',
      profile_revision: '3',
      steps: '8.2:4.6:135,7.8:5.8:150,7.2:7:145,6.4:8.1:140,5.8:7.4:45,9:0:90',
    })
  })

  it('names the saved profile so the roaster can report it back, and omits an unsaved one', () => {
    expect(profileIdentityArgs(starterProfile)).toEqual({ profile_id: 'profile-house-espresso', profile_revision: '3' })
    expect(profileIdentityArgs({ ...starterProfile, revision: 0 })).toEqual({})
    expect(profileIdentityArgs({ ...starterProfile, id: 'has spaces' })).toEqual({})
    expect(profileIdentityArgs({ ...starterProfile, id: 'x'.repeat(65) })).toEqual({})
  })

  it('sends the editable occurrence name instead of replacing it with the profile name', () => {
    const occurrenceName = '2026-07-30 14:45 / House espresso'
    expect(roastStartArgs({ profile: starterProfile, name: occurrenceName, massG: 225 })).toMatchObject({
      mode: 'timed',
      name: sanitizeRoastName(occurrenceName),
    })
  })

  it('builds a journey request carrying the start temperature the roast begins at', () => {
    expect(
      roastStartArgs({ profile: starterThermalIntent, intent: starterThermalIntent, massG: 250, startC: 24.8 }),
    ).toEqual({
      mode: 'journey',
      confirm: 'START_ROAST',
      name: 'Gentle espresso journey',
      mass: '250',
      profile_id: 'intent-gentle-espresso',
      profile_revision: '1',
      zones: '150:210:5:9:3:8;175:120:5:9:3:9;196:135:4:8:4:9;210:120:4:8:3:9;40:180:3:10:0:0',
      start: '24.8',
    })
  })

  it('reports the reason instead of a request when the plan is out of range', () => {
    expect(roastStartArgs({ profile: starterProfile, massG: 5 })).toContain('Batch weight must be')
    expect(roastStartArgs({ profile: starterProfile, massG: undefined })).toContain('Batch weight must be')
  })
})

describe('the pre-start feasibility gate', () => {
  const base = {
    profile: starterThermalIntent,
    intent: starterThermalIntent,
    massG: 225,
    ambientC: 24.5,
    calibration: defaultCalibration,
    nowMs: NOW,
  }

  it('lets a reachable journey start', () => {
    const result = preflight({ ...base, status: status() })
    expect(result.blockers).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.zones).toHaveLength(5)
    expect(result.zones.every((zone) => !zone.infeasible)).toBe(true)
  })

  /** Firmware owns the finite runtime envelope; the browser model may warn but cannot overrule it. */
  it('warns about an unreachable model estimate without blocking Start', () => {
    const strangled = journeyOf([
      { ...starterThermalIntent.segments[0], endC: 250, fanMin: 8, fanMax: 9, heatMin: 3, heatMax: 5 },
    ])
    const result = preflight({ ...base, profile: strangled, intent: strangled, status: status() })
    const reason = result.warnings.find((entry) => entry.startsWith('Zone 1'))
    expect(reason).toBeDefined()
    expect(result.blockers).toEqual([])
    // Both numbers stated: what it asks for and what its own limits actually reach.
    expect(reason).toContain('250 °C')
    expect(reason).toContain('153 °C')
    expect(reason).toContain('Batch mass changes the modelled approach time, not that equilibrium')
    expect(reason).toContain('minimum Fan 8 from 8–9')
    expect(reason).toContain('maximum Heat 5 from 3–5')
    expect(reason).toContain("controller's applied calibration")
    expect(reason).toContain('firmware stops all outputs at twice the planned duration plus ten minutes')
    expect(result.zones[0].infeasible).toBe(true)
  })

  it('lets matching measured evidence override a lower fitted ceiling across batch masses', () => {
    const reported = journeyOf([
      {
        ...starterThermalIntent.segments[0],
        startC: 170,
        endC: 223,
        fanMin: 1,
        fanMax: 10,
        heatMin: 0,
        heatMax: 10,
      },
    ])
    const result = preflight({
      ...base,
      profile: reported,
      intent: reported,
      massG: 250,
      ambientC: 27.1,
      status: status({
        appliedCoefficients: {
          heaterGainCPerMinAt10: 27,
          fanCoolingCPerMinAt10: 0.5,
          coolingFanCPerMinAt10: 43.31,
          thermalLossPerMinPerC: 0.17,
          fitId: 'reported-ceiling',
        },
      }),
      calibrationSnapshots: [
        {
          id: 'reported-fit',
          name: 'Latest loaded fit',
          createdAt: '2026-08-06T12:00:00.000Z',
          runIds: ['28', '29'],
          patch: {},
          curves: [],
          fitRmsC: 18.8,
          fingerprint: { runIds: ['28', '29'], measurementHash: 'reported-ceiling' },
          inputs: [
            {
              runId: '28',
              capturedAt: '2026-08-02T12:00:00.000Z',
              label: '168 g roast',
              massG: 168,
              roastRunId: 'roast-28',
            },
            {
              runId: '29',
              capturedAt: '2026-08-06T12:00:00.000Z',
              label: '206 g roast',
              massG: 206,
              roastRunId: 'roast-29',
            },
          ],
          recordedOn: testLogProvenance('28').recordedOn,
        },
      ],
      calibrationRuns: [
        {
          id: '28',
          capturedAt: '2026-08-02T12:00:00.000Z',
          sourceMode: 'manual',
          form: 'steps',
          steps: [],
          maxStepSeconds: 0,
          minStepSeconds: 0,
          settleSeconds: 0,
          settleBandC: 0,
          ambientC: 27.1,
          notes: '',
          massG: 168,
          // Duplicate calibration samples were compacted; the retained roast fallback remains.
          samples: [],
          recordedOn: testLogProvenance('28').recordedOn,
        } satisfies CalibrationRun,
      ],
      roastRuns: [
        {
          id: 'roast-28',
          name: '168 g roast',
          startedAt: '2026-08-02T12:00:00.000Z',
          profile: reported,
          notes: '',
          controllerVersion: '2026-07-26.98',
          recordedOn: testLogProvenance('28').recordedOn,
          outcome: 'complete',
          events: [],
          samples: [
            {
              elapsedSec: 0,
              beanTempC: 220,
              rorCPerMin: 1,
              requestedFan: 2,
              effectiveFan: 2,
              requestedHeat: 8,
              effectiveHeat: 8,
              phase: 'DEVELOPMENT',
            },
            {
              elapsedSec: 1,
              beanTempC: 224.9,
              rorCPerMin: 1,
              requestedFan: 1,
              effectiveFan: 1,
              requestedHeat: 6,
              effectiveHeat: 6,
              phase: 'DEVELOPMENT',
            },
          ],
        } satisfies RoastRun,
      ],
    })

    expect(result.blockers).toEqual([])
    // A one-zone heating journey also earns the ends-heating advisory; this test is about feasibility.
    expect(result.warnings.filter((warning) => warning !== ENDS_HEATING_WARNING)).toEqual([])
    expect(result.zones[0]).toMatchObject({ askedC: 223, reachableC: 224.9, infeasible: false })
  })

  it('says so when a profile ends while heating, because the roaster then stops the fan with it', () => {
    // The starter journey ends in a cooling zone: no advisory.
    expect(preflight({ ...base, status: status() }).warnings).not.toContain(ENDS_HEATING_WARNING)
    const endsHot = journeyOf(starterThermalIntent.segments.slice(0, 4))
    expect(preflight({ ...base, profile: endsHot, intent: endsHot, status: status() }).warnings).toContain(
      ENDS_HEATING_WARNING,
    )
    // A final unheated dwell cools nothing but heats nothing either; only Heat left on is flagged.
    const unheated = journeyOf([
      ...starterThermalIntent.segments.slice(0, 3),
      { ...starterThermalIntent.segments[3], heatMin: 0, heatMax: 0 },
    ])
    expect(preflight({ ...base, profile: unheated, intent: unheated, status: status() }).warnings).not.toContain(
      ENDS_HEATING_WARNING,
    )
    // A timed profile gets its cooling window appended, unless the cooling time is zero.
    expect(preflight({ ...base, profile: starterProfile, intent: undefined, status: status() }).warnings).not.toContain(
      TIMED_ENDS_HEATING_WARNING,
    )
    const noCooling = {
      ...starterProfile,
      points: starterProfile.points.map((point) => ({ ...point, heat: Math.max(point.heat, 3) })),
      coolDurationSec: 0,
    }
    expect(preflight({ ...base, profile: noCooling, intent: undefined, status: status() }).warnings).toContain(
      TIMED_ENDS_HEATING_WARNING,
    )
  })

  it('warns about a cooling zone asked to go below the ambient model floor', () => {
    const impossible = journeyOf([{ ...starterThermalIntent.segments[4], startC: 210, endC: 10 }])
    const result = preflight({ ...base, profile: impossible, intent: impossible, status: status() })
    expect(result.blockers).toEqual([])
    expect(result.warnings.some((entry) => entry.includes('asks to cool to 10 °C'))).toBe(true)
  })

  /**
   * ==========================================================================================
   * FEASIBILITY IS JUDGED BY THE SET THAT WILL RUN THE ROAST, OR NOT AT ALL
   * ==========================================================================================
   *
   * The reported defect: with no applied set, feasibility fell back to this app's active fit and
   * emitted four zone blockers claiming zones settled at 92-107 °C at heat 8-9. Those numbers are the
   * chamber-scale trap - an app fit derived from a calibration pass describes the empty CHAMBER,
   * whose loss coefficient is more than an order of magnitude larger than a bean load's - so they
   * were arithmetic about a roaster that does not exist, stacked on top of the one real problem.
   *
   * Two rules, pinned here. Without an applied set there is exactly ONE blocker and no zone
   * verdicts; with one, the verdicts follow the DEVICE even where this app disagrees loudly.
   */
  it('blocks a journey when the device holds no applied calibration, and says only that', () => {
    const result = preflight({ ...base, status: status({ appliedCoefficients: undefined }) })
    expect(result.blockers).toEqual([NEEDS_CALIBRATION_TEXT])
    expect(result.needsCalibration).toBe(true)
    // Not "every zone is fine" - not asked at all, which is the only honest answer available.
    expect(result.zones).toEqual([])
  })

  /** The chamber-scale set, verbatim in shape: an order of magnitude more loss than a bean load. */
  const chamberScale = { ...defaultCalibration, heaterGainCPerMinAt10: 44, thermalLossPerMinPerC: 1.9 }

  it("emits no zone verdict at all rather than one drawn from the app's own fit", () => {
    const result = preflight({ ...base, calibration: chamberScale, status: status({ appliedCoefficients: undefined }) })
    // The old fallback made these four; every one of them was about the wrong machine.
    expect(result.blockers.filter((entry) => entry.startsWith('Zone'))).toEqual([])
    expect(result.zones).toEqual([])
  })

  /**
   * The same journey, the same wrong app fit, but the roaster is now holding a bean-scale set. The
   * verdict has to be the roaster's: it is the one that will invert a model on the day.
   */
  it("judges zones by the device's coefficients even when the app's disagree", () => {
    const result = preflight({ ...base, calibration: chamberScale, status: status() })
    expect(result.blockers.filter((entry) => entry.startsWith('Zone'))).toEqual([])
    expect(result.zones).toHaveLength(5)
    expect(result.needsCalibration).toBe(false)
    /*
     * And the numbers really are the device's. Zone 3 asks for 196 °C; on the roaster's bean-scale
     * set its own limits reach past that, while the app's chamber-scale set would have put it in
     * the nineties - which is exactly the shape of the four bogus blockers that were reported.
     */
    const zone = result.zones[2]
    expect(zone.reachableC).toBeGreaterThan(zone.askedC)
    const asIfTheAppDecided = zoneFeasibility(
      starterThermalIntent.segments[2],
      { batchMassG: 225, ambientC: base.ambientC },
      chamberScale,
    )
    expect(asIfTheAppDecided.reachableC).toBeLessThan(120)
    expect(asIfTheAppDecided.infeasible).toBe(true)
  })

  /**
   * A block the device reports without numbers is not a set. It is judged as no set at all - and
   * that has to include the BLOCKER, not only the zone verdicts.
   *
   * If the gate asked "is `appliedCoefficients` present" while feasibility asked "can all four
   * numbers be read out of it", a `{fitId}`-only status would answer yes to the first and no to the
   * second: no zone judged, no blocker raised, Start live, and the firmware refusing the roast with
   * a 409 the operator had no warning about. Both questions are the same question:
   * `feasibilityModel`'s answer.
   */
  it('blocks a journey on a partial applied set, which cannot be inverted either', () => {
    const result = preflight({ ...base, status: status({ appliedCoefficients: { fitId: 'fit-with-no-numbers' } }) })
    expect(result.blockers).toEqual([NEEDS_CALIBRATION_TEXT])
    expect(result.needsCalibration).toBe(true)
    // Start is `blockers.length === 0` in the view, so this is the disabled button, stated here.
    expect(result.blockers.length).toBeGreaterThan(0)
    expect(result.zones).toEqual([])
    expect(result.blockers.filter((entry) => entry.startsWith('Zone'))).toEqual([])
  })

  it('does not ask a timed roast for calibration, because it inverts no model', () => {
    const result = preflight({
      ...base,
      profile: starterProfile,
      intent: undefined,
      status: status({ appliedCoefficients: undefined }),
    })
    expect(result.blockers).toEqual([])
  })

  /**
   * A coefficient mismatch is a notice, never a blocker: the roast is perfectly runnable, and only
   * the operator can decide whether an unapplied fit matters to them.
   *
   * The shape is pinned as hard as the behaviour: the notice must be clear about what is wrong and
   * what the user needs to do, so no engine vocabulary ("inverts"), no humanized property
   * identifiers, and no action buried at the end of a run-on sentence. So: one headline, the values
   * as rows, and the action as something the caller can make a button out of.
   */
  const diverged = status({
    appliedCoefficients: {
      heaterGainCPerMinAt10: 52,
      fanCoolingCPerMinAt10: 19,
      coolingFanCPerMinAt10: 28,
      thermalLossPerMinPerC: 0.17,
    },
  })

  it('reports the mismatch, without blocking, when the app and the device disagree', () => {
    const result = preflight({ ...base, status: diverged })
    expect(result.blockers).toEqual([])
    const notice = result.calibrationMismatch
    expect(notice).toBeDefined()
    // The situation, in the first line, before any number.
    expect(notice?.headline).toContain("Your latest calibration hasn't been applied to the roaster")
    expect(notice?.headline).toContain('the roast and this preview both use the older set the roaster is holding')
    // Both values, labelled as every other screen labels them, at the firmware's precision.
    const row = notice?.rows.find((entry) => entry.field === 'heaterGainCPerMinAt10')
    expect(row?.label).toBe('Heat gain at 10 (°C/min)')
    expect(row?.controller).toBe('52.000')
    expect(row?.app).toBe('66.000')
    // Only what actually differs is listed: three of the four sets agree here.
    expect(notice?.rows).toHaveLength(1)
    // One reassurance line, and it is one line.
    expect(notice?.reassurance).toBe('The roast holds its targets either way.')
  })

  /** The other branch: a preview deliberately drawn against a fit the controller has not got. */
  it("says which set the preview used when it is not the controller's", () => {
    const divergence = coefficientDivergence(
      { heaterGainCPerMinAt10: 52 },
      {
        heaterGainCPerMinAt10: 66,
        fanCoolingCPerMinAt10: 19,
        coolingFanCPerMinAt10: 28,
        thermalLossPerMinPerC: 0.17,
      },
    )
    const notice = calibrationMismatchNotice(divergence, { usingControllerSet: false })
    expect(notice.headline).toContain("hasn't been applied to the roaster")
    expect(notice.headline).toContain('only this preview is drawn with yours')
    expect(notice.rows).toHaveLength(1)
  })

  it('says nothing at all when the two sets agree', () => {
    const result = preflight({
      ...base,
      status: status({
        appliedCoefficients: {
          heaterGainCPerMinAt10: base.calibration.heaterGainCPerMinAt10,
          fanCoolingCPerMinAt10: base.calibration.fanCoolingCPerMinAt10,
          coolingFanCPerMinAt10: base.calibration.coolingFanCPerMinAt10,
          thermalLossPerMinPerC: base.calibration.thermalLossPerMinPerC,
        },
      }),
    })
    expect(result.calibrationMismatch).toBeUndefined()
  })

  /**
   * The words an operator is never shown. Kept as a list so it can grow by one line, and repeated
   * verbatim in `simulationHonesty.render.test.ts` rather than imported - importing one test file
   * into another would register its cases twice.
   */
  const BANNED_IN_OWNER_TEXT = ['invert', 'diverg', 'plant']

  /**
   * The banned vocabulary, by name, over every word of the banner rather than over one sentence of
   * it. "Invert" and "diverge" are the two words that made this read as an engine warning light, and
   * a camelCase identifier is never a name for anything an operator is shown.
   *
   * "Plant" is banned with them. It is the control engineer's word for the machine being
   * controlled and it is exactly nobody else's; the thing meant is the simulated roaster, and that is
   * what it is called. The list is shared with `simulationHonesty.render.test.ts`, which applies
   * it to every word that panel renders.
   */
  it('uses no jargon and no property identifiers anywhere in the mismatch banner', () => {
    const notice = preflight({ ...base, status: diverged }).calibrationMismatch
    const shown = [
      notice?.headline ?? '',
      notice?.reassurance ?? '',
      CALIBRATION_APPLY_ACTION,
      ...(notice?.rows ?? []).map((row) => row.label),
    ]
    for (const text of shown) {
      for (const banned of BANNED_IN_OWNER_TEXT) expect(text.toLowerCase()).not.toContain(banned)
      expect(text).not.toMatch(/[a-z][A-Z]/)
    }
  })

  /**
   * The button the banner offers is idle-gated, because the firmware answers 409 otherwise. It says
   * which of the busy states is in the way rather than only that it is unavailable.
   */
  it('names the reason the controller cannot take coefficients right now', () => {
    expect(calibrationApplyBlockedReason(status())).toBeUndefined()
    expect(calibrationApplyBlockedReason(status({ connected: false }))).toBe('The roaster cannot be reached')
    expect(
      calibrationApplyBlockedReason(
        status({ roast: { active: true, mode: 'journey', saturated: false, holdover: false } }),
      ),
    ).toContain('A roast is running')
    expect(calibrationApplyBlockedReason(status({ manual: { active: true } }))).toContain('Another program is running')
  })

  it('solves feasibility against the DEVICE coefficients, not the app’s', () => {
    // The app believes in a strong heater; the device has a weak one applied. The device wins,
    // because the device is what will solve the inversion.
    const weakDevice = status({
      appliedCoefficients: {
        heaterGainCPerMinAt10: 20,
        fanCoolingCPerMinAt10: 19,
        coolingFanCPerMinAt10: 28,
        thermalLossPerMinPerC: 0.17,
      },
    })
    const result = preflight({ ...base, status: weakDevice })
    expect(result.blockers).toEqual([])
    expect(result.warnings.some((entry) => entry.startsWith('Zone'))).toBe(true)
    // With the app's own (strong) coefficients the same journey is perfectly feasible.
    expect(preflight({ ...base, status: status() }).blockers).toEqual([])
  })

  it('mirrors the firmware start gates it can see, in the order the firmware checks them', () => {
    expect(preflight({ ...base, status: status({ manualLockout: true }) }).blockers[0]).toContain(
      'latched off after a manual-control conflict',
    )
    expect(
      preflight({ ...base, status: status({ fault: 'overtemperature' }) }).blockers.some((entry) =>
        entry.includes('overtemperature'),
      ),
    ).toBe(true)
    expect(
      preflight({
        ...base,
        status: status({ roast: { active: true, mode: 'journey', saturated: false, holdover: false } }),
      }).blockers.some((entry) => entry.includes('already running')),
    ).toBe(true)
    expect(
      preflight({ ...base, status: status({ manual: { active: true } }) }).blockers.some((entry) =>
        entry.includes('manual session'),
      ),
    ).toBe(true)
    expect(
      preflight({ ...base, status: status({ thermocoupleValid: false }) }).blockers.some((entry) =>
        entry.includes('thermocouple'),
      ),
    ).toBe(true)
    expect(
      preflight({ ...base, status: status(), nowMs: NOW + 60000 }).blockers.some((entry) =>
        entry.includes('stopped reporting'),
      ),
    ).toBe(true)
  })

  it('blocks outright on firmware with no roast executor', () => {
    const result = preflight({ ...base, status: status({ roast: undefined }) })
    expect(result.blockers.some((entry) => entry.includes('no on-device roast executor'))).toBe(true)
  })
})

describe('what the controller said, in words', () => {
  it('maps every documented refusal to something an operator can act on', () => {
    expect(roastStartFailure(423)).toContain('only a power cycle clears it')
    expect(roastStartFailure(400, 'bad zones')).toContain('could not read the roast plan')
    expect(roastStartFailure(409, 'A journey roast needs applied calibration coefficients.')).toContain(
      'Fit and apply a calibration first',
    )
    expect(roastStartFailure(409, 'thermocouple telemetry is stale')).toContain('fresh, fault-free thermocouple')
    expect(roastStartFailure(409, 'Zero-cross timing is unavailable.')).toContain('stable mains timing')
    expect(roastStartFailure(409, 'confirm missing')).toContain('disagree about the roast contract')
    expect(roastStartFailure(409, 'calibration program active')).toContain('busy')
    expect(roastStartFailure(409, 'a fan test is running')).toContain('busy')
  })

  /** The actuator's own rejection text is the most specific thing anyone has, so it survives. */
  it('preserves the controller’s own message rather than replacing it', () => {
    expect(roastStartFailure(409, 'Fan qualification failed')).toContain('The roaster said: Fan qualification failed')
  })

  it('says plainly that a timed-out request leaves the outcome unknown', () => {
    expect(roastStartFailure(undefined)).toContain('unknown whether the roast started')
  })
})

describe('every end reason has plain language', () => {
  const ALL: RoastEndReason[] = [
    'completed',
    'stopped',
    'fault',
    'telemetry_stale',
    'sensor_lost',
    'qualification_stalled',
    'step_rejected',
    'renewal_rejected',
    'command_rejected',
    'envelope_timeout',
    'instruction_expired',
    'heat_lease_expired',
  ]

  it('covers the firmware’s table exhaustively, with no bare identifiers left over', () => {
    expect(Object.keys(ROAST_END_REASONS).sort()).toEqual([...ALL].sort())
    for (const reason of ALL) {
      const text = roastEndReasonText(reason)
      expect(text?.headline, reason).toBeTruthy()
      expect(text?.detail.length, reason).toBeGreaterThan(40)
      // No end reason may render as its own wire value.
      expect(text?.headline).not.toContain('_')
    }
  })

  it('says nothing at all when nothing has ended', () => {
    expect(roastEndReasonText(undefined)).toBeUndefined()
  })

  it('describes rejected renewals as outputs stopped', () => {
    expect(ROAST_END_REASONS.renewal_rejected.detail).toContain('both outputs stopped')
  })
})
