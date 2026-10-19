import { describe, expect, it } from 'vitest'
import { testRecordedOn } from '../testFixtures/provenance'
import { expandBaselineGrid } from './calibrationProgram'
import {
  baselinePassGrade,
  DEFAULT_TRANSITION_TOLERANCE_C,
  defaultTransitionOrigin,
  measuredMoves,
  responseSummary,
  settledAt,
  type TauObservation,
  tauByFan,
  tauForFan,
  tauObservations,
  transitionOrigins,
  transitionSeconds,
  transitionsFrom,
} from './meshMetrics'
import { analyzeCalibrationRun, type BaselineCell, type BaselineMap, buildBaselineMap, meshKey } from './thermalLog'
import type { CalibrationRun, CalibrationStep, ThermalSample } from './types'

/**
 * The transition arithmetic is checked against numbers computed by hand, not against itself.
 *
 * t = tau * ln(|dT| / epsilon), so with the forced-cooling time constant measured on the real
 * roaster at fan 10 - tau = 94 s - a 200 °C gap closed to within 2 °C takes
 *
 *     94 * ln(200 / 2) = 94 * ln(100) = 94 * 4.605170185988091 = 432.8859974828806 s
 *
 * and the approach itself is T(t) = T_inf + (T_0 - T_inf) e^(-t/tau), which at exactly one time
 * constant has closed 1 - 1/e of the gap:
 *
 *     220 + (20 - 220) * e^(-1) = 220 - 200 * 0.36787944117144233 = 146.42411176571153 °C
 */
describe('transition time from the first-order model', () => {
  it('computes t = tau ln(dT/epsilon) against a hand-computed value', () => {
    expect(transitionSeconds(200, 94, 2)!).toBeCloseTo(432.8859974828806, 9)
    // The formula is on the magnitude of the gap, so cooling down 200 °C takes the same time as
    // heating up 200 °C at the same airflow. That IS the physics, and it is why the heating and
    // cooling questions collapse into one calculation.
    expect(transitionSeconds(-200, 94, 2)!).toBeCloseTo(432.8859974828806, 9)
    // One doubling of the gap costs exactly one tau ln 2, whatever the gap was.
    expect(transitionSeconds(4, 94, 2)!).toBeCloseTo(65.15583497263486, 9)
    expect(transitionSeconds(400, 94, 2)! - transitionSeconds(200, 94, 2)!).toBeCloseTo(94 * Math.LN2, 9)
  })

  it('returns zero rather than a negative time when the gap is already inside the tolerance', () => {
    expect(transitionSeconds(2, 94, 2)).toBe(0)
    expect(transitionSeconds(0.4, 94, 2)).toBe(0)
    expect(transitionSeconds(-1, 94, 2)).toBe(0)
  })

  it('refuses a nonsensical time constant or tolerance instead of returning a number', () => {
    expect(transitionSeconds(200, 0, 2)).toBeUndefined()
    expect(transitionSeconds(200, -94, 2)).toBeUndefined()
    expect(transitionSeconds(200, 94, 0)).toBeUndefined()
    expect(transitionSeconds(Number.NaN, 94, 2)).toBeUndefined()
  })

  it('states the tolerance it resolves transitions to', () => {
    expect(DEFAULT_TRANSITION_TOLERANCE_C).toBe(2)
  })
})

/* ------------------------------------------------------------------ a synthetic pass to fit */

const AMBIENT = 22
const observationAt = (
  fan: number,
  tauSec: number,
  r2: number | undefined,
  direction: 'rising' | 'falling',
): TauObservation => ({
  runId: 'run',
  capturedAt: '2026-07-01T00:00:00.000Z',
  stepIndex: 0,
  fan,
  heat: 5,
  tauSec,
  r2,
  direction,
  quality: 'measured',
  kind: 'step',
  source: `fan ${fan}`,
})

describe('time constants grouped by the fan they were measured at', () => {
  const observations = [
    observationAt(10, 90, 0.99, 'rising'),
    observationAt(10, 94, 0.98, 'falling'),
    observationAt(10, 98, 0.97, 'rising'),
    observationAt(4, 140, 0.95, 'rising'),
  ]
  const byFan = tauByFan(observations)

  it('takes the median at each fan and keeps the spread visible', () => {
    expect(byFan.map((entry) => entry.fan)).toEqual([4, 10])
    expect(byFan[1].tauSec).toBe(94)
    expect(byFan[1].lowSec).toBe(90)
    expect(byFan[1].highSec).toBe(98)
    expect(byFan[1].rising).toBe(2)
    expect(byFan[1].falling).toBe(1)
    expect(byFan[1].worstR2).toBeCloseTo(0.97, 9)
    expect(byFan[0].observations).toHaveLength(1)
  })

  it('uses the destination fan exactly when it was measured', () => {
    const choice = tauForFan(byFan, 10)!
    expect(choice.borrowed).toBe(false)
    expect(choice.fan).toBe(10)
    expect(choice.tauSec).toBe(94)
    expect(choice.detail).toContain('3 measured steps at fan 10.0')
  })

  it('borrows the nearest measured fan, and says it borrowed', () => {
    const choice = tauForFan(byFan, 7)!
    expect(choice.borrowed).toBe(true)
    expect(choice.requestedFan).toBe(7)
    // 7 is 3 from 4 and 3 from 10; the sort is stable, so the lower measured fan wins the tie.
    expect([4, 10]).toContain(choice.fan)
    expect(tauForFan(byFan, 9)!.fan).toBe(10)
    expect(tauForFan(byFan, 5)!.fan).toBe(4)
    expect(tauForFan([], 5)).toBeUndefined()
  })
})

/* ------------------------------------------------------------ the settled surface, read anywhere */

const cell = (
  fan: number,
  heat: number,
  steadyStateC: number,
  extra: Partial<BaselineCell> = {},
): [string, BaselineCell] => [
  meshKey(fan, heat),
  {
    fan,
    heat,
    steadyStateC,
    extrapolated: false,
    quality: 'measured',
    runId: 'run',
    capturedAt: '2026-07-01T00:00:00.000Z',
    ...extra,
  },
]

// A deliberately tiny 2x2 grid, so every interpolated answer is arithmetic anyone can check.
const map: BaselineMap = {
  fans: [10, 4],
  heats: [2, 6],
  cells: Object.fromEntries([cell(4, 2, 120), cell(4, 6, 220), cell(10, 2, 100), cell(10, 6, 180)]),
  runCount: 1,
  extrapolatedCount: 0,
  unreliableCount: 0,
  flooredCount: 0,
  suspectFans: [],
}

describe('the settled surface, read at points that were never measured', () => {
  it('returns a measured cell as itself', () => {
    const settled = settledAt(map, 4, 6)!
    expect(settled.temperatureC).toBe(220)
    expect(settled.basis).toBe('measured')
  })

  it('interpolates in heat along one fan row', () => {
    // Halfway between heat 2 (120 °C) and heat 6 (220 °C) at fan 4.
    expect(settledAt(map, 4, 4)!.temperatureC).toBeCloseTo(170, 9)
    expect(settledAt(map, 4, 4)!.basis).toBe('interpolated')
    // A quarter of the way: 120 + 100 * 0.25.
    expect(settledAt(map, 4, 3)!.temperatureC).toBeCloseTo(145, 9)
  })

  it('interpolates in fan between two rows', () => {
    // Fan 7 sits halfway between fan 4 (220 °C) and fan 10 (180 °C) at heat 6.
    expect(settledAt(map, 7, 6)!.temperatureC).toBeCloseTo(200, 9)
    // And bilinearly at heat 4: fan 4 gives 170, fan 10 gives 140, halfway is 155.
    expect(settledAt(map, 7, 4)!.temperatureC).toBeCloseTo(155, 9)
    expect(settledAt(map, 7, 4)!.basis).toBe('interpolated')
  })

  it('clamps outside the measured rectangle rather than running the line off the end', () => {
    const hotter = settledAt(map, 4, 10)!
    expect(hotter.temperatureC).toBe(220)
    expect(hotter.basis).toBe('outside')
    expect(hotter.detail).toContain('nearest measured edge')
    expect(settledAt(map, 1, 6)!.basis).toBe('outside')
    expect(settledAt(map, 1, 6)!.temperatureC).toBe(220)
    expect(settledAt({ ...map, fans: [], heats: [], cells: {} }, 4, 6)).toBeUndefined()
  })

  it('carries a fitted or unreliable cell forward as what it is', () => {
    const shaky: BaselineMap = {
      ...map,
      cells: Object.fromEntries([
        cell(4, 2, 120, { extrapolated: true, quality: 'extrapolated', r2: 0.94 }),
        cell(4, 6, 220, { quality: 'unreliable' }),
      ]),
    }
    expect(settledAt(shaky, 4, 2)!.basis).toBe('fitted')
    expect(settledAt(shaky, 4, 2)!.detail).toContain('R2 0.940')
    expect(settledAt(shaky, 4, 6)!.basis).toBe('unreliable')
  })
})

/**
 * The moves readout that replaced the transition calculator.
 *
 * A calculator asks the user to do the work, and the user does not want a calculator. So the answer
 * is a list, and the honesty lives in whether a row
 * was WALKED by a pass or merely computed from the surface and the fitted time constants.
 */
describe('moves from one setting to another, walked or computed', () => {
  const byFan = tauByFan([observationAt(10, 94, 0.99, 'falling'), observationAt(4, 140, 0.99, 'rising')])

  it('computes an unwalked move with the DESTINATION fan time constant', () => {
    const rows = transitionsFrom({ map, byFan, measured: [], fromFan: 4, fromHeat: 6 })
    const cooling = rows.find((move) => move.toFan === 10 && move.toHeat === 2)!
    expect(cooling.basis).toBe('predicted')
    expect(cooling.fromC).toBe(220)
    expect(cooling.toC).toBe(100)
    expect(cooling.deltaC).toBe(-120)
    expect(cooling.tauSec).toBe(94)
    expect(cooling.borrowedTau).toBe(false)
    // 94 * ln(120 / 2) = 94 * ln 60.
    expect(cooling.secondsToSettle!).toBeCloseTo(94 * Math.log(60), 9)
    // Heating back up is the same formula with the other sign, and the fan 4 constant governs it -
    // not the 94 s the chamber was sitting at before the levels changed.
    const heating = transitionsFrom({ map, byFan, measured: [], fromFan: 10, fromHeat: 2 }).find(
      (move) => move.toFan === 4 && move.toHeat === 6,
    )!
    expect(heating.deltaC).toBe(120)
    expect(heating.tauSec).toBe(140)
    expect(heating.secondsToSettle!).toBeCloseTo(140 * Math.log(60), 9)
  })

  it('lists every mapped destination once, and never the setting it starts from', () => {
    const rows = transitionsFrom({ map, byFan, measured: [], fromFan: 4, fromHeat: 6 })
    expect(rows).toHaveLength(3)
    expect(rows.some((move) => move.toFan === 4 && move.toHeat === 6)).toBe(false)
    // The map's own fan-then-heat order, so the list reads against the settled surface above it.
    expect(rows.map((move) => `${move.toFan}:${move.toHeat}`)).toEqual(['10:2', '10:6', '4:2'])
  })

  it('badges a borrowed time constant and a weaker endpoint rather than hiding them', () => {
    const rows = transitionsFrom({ map, byFan, measured: [], fromFan: 7, fromHeat: 4 })
    const row = rows.find((move) => move.toFan === 7)
    // Fan 7 is not in the map, so every destination is a mapped one and the START is interpolated.
    expect(row).toBeUndefined()
    for (const move of rows) expect(move.endpoint).toBe('interpolated')
    const borrowed = transitionsFrom({
      map: {
        ...map,
        fans: [7],
        cells: {
          ...map.cells,
          [meshKey(7, 6)]: {
            fan: 7,
            heat: 6,
            steadyStateC: 200,
            extrapolated: false,
            quality: 'measured',
            runId: 'r',
            capturedAt: '',
          },
        },
      },
      byFan,
      measured: [],
      fromFan: 4,
      fromHeat: 2,
    })
    expect(borrowed).toHaveLength(1)
    expect(borrowed[0].borrowedTau).toBe(true)
    expect([4, 10]).toContain(borrowed[0].tauFan)
  })

  it('answers nothing at all when no time constant has ever been fitted', () => {
    const rows = transitionsFrom({ map, byFan: [], measured: [], fromFan: 4, fromHeat: 6 })
    for (const move of rows) {
      expect(move.secondsToSettle).toBeUndefined()
      expect(move.tauSec).toBeUndefined()
    }
  })

  it('honours a tolerance the caller widens or tightens', () => {
    const at = (toleranceC: number) =>
      transitionsFrom({ map, byFan, measured: [], fromFan: 4, fromHeat: 6, toleranceC }).find(
        (move) => move.toFan === 10 && move.toHeat === 2,
      )!.secondsToSettle!
    // Halving the tolerance costs exactly one tau ln 2, twice over from 4 °C to 1 °C.
    expect(at(1) - at(4)).toBeCloseTo(2 * 94 * Math.LN2, 9)
  })
})

/* ------------------------------------------------------- against a full synthetic pass */

const TAU = 30
const SLOPE = 12
const FAN_COOLING = 3
const passSteps = expandBaselineGrid([9, 3], [1, 5, 10])

const syntheticPass = (): CalibrationRun => {
  const samples: ThermalSample[] = []
  let temperature = AMBIENT
  let tMs = 0
  const target = (step: CalibrationStep) => AMBIENT + 30 + SLOPE * step.heat - FAN_COOLING * step.fan
  const push = (fan: number, heat: number) => {
    samples.push({ tMs, thermocoupleC: temperature, coldJunctionC: AMBIENT, effectiveFan: fan, effectiveHeat: heat })
    tMs += 1000
  }
  for (const step of passSteps) {
    const to = target(step)
    const from = temperature
    for (let second = 0; second < 140; second += 1) {
      push(step.fan, step.heat)
      temperature = to - (to - from) * Math.exp(-(second + 1) / TAU)
    }
  }
  for (let second = 0; second < 120; second += 1) {
    push(10, 0)
    temperature = AMBIENT + (temperature - AMBIENT) * Math.exp(-1 / 50)
  }
  for (let second = 0; second < 900; second += 1) {
    push(0, 0)
    temperature = AMBIENT + (temperature - AMBIENT) * Math.exp(-1 / 400)
  }
  return {
    id: 'synthetic',
    capturedAt: '2026-07-01T00:00:00.000Z',
    recordedOn: testRecordedOn,
    form: 'grid',
    steps: passSteps,
    maxStepSeconds: 200,
    minStepSeconds: 10,
    settleSeconds: 3,
    settleBandC: 5,
    ambientC: AMBIENT,
    samples,
    notes: '',
  }
}

describe('time constants harvested from a real analysis', () => {
  const run = syntheticPass()
  const analysis = analyzeCalibrationRun(run)

  it('recovers the step time constant the pass was generated with', () => {
    const observations = tauObservations([run])
    const steps = observations.filter((observation) => observation.kind === 'step')
    expect(steps.length).toBeGreaterThanOrEqual(5)
    for (const observation of steps) expect(Math.abs(observation.tauSec - TAU) / TAU).toBeLessThan(0.2)
    // Both tails come back as tails, not as driven steps.
    expect(observations.filter((observation) => observation.kind === 'cooling-tail')).toHaveLength(1)
    expect(observations.filter((observation) => observation.kind === 'passive-tail')).toHaveLength(1)
    expect(observations.find((observation) => observation.kind === 'passive-tail')!.fan).toBe(0)
    expect(observations.find((observation) => observation.kind === 'cooling-tail')!.tauSec).toBeCloseTo(50, 0)
  })

  it('distinguishes the steps that rose from the steps that fell', () => {
    const steps = tauObservations([run]).filter((observation) => observation.kind === 'step')
    // The serpentine walks fan 3's heats back down, so both directions are represented.
    expect(steps.some((observation) => observation.direction === 'rising')).toBe(true)
    expect(steps.some((observation) => observation.direction === 'falling')).toBe(true)
  })

  /**
   * The serpentine is a chain of measured moves: every step but the first began at the settled point
   * the step before it reached. That is what makes the readout a record rather than a model.
   */
  it('harvests every step of the serpentine as a move that was really walked', () => {
    const moves = measuredMoves([run])
    // Six steps in the 2x3 grid, so five moves between them.
    expect(moves).toHaveLength(5)
    for (const move of moves) {
      expect(move.basis).toBe('measured')
      expect(move.walked).toBe(1)
      expect(move.borrowedTau).toBe(false)
      expect(Math.abs(move.tauSec! - TAU) / TAU).toBeLessThan(0.2)
      expect(move.secondsToSettle!).toBeGreaterThan(0)
    }
    // The chain is continuous: each move starts where the previous one ended.
    for (const [index, move] of moves.slice(1).entries()) {
      expect(move.fromFan).toBe(moves[index].toFan)
      expect(move.fromHeat).toBe(moves[index].toHeat)
    }
    // And a second identical pass pools rather than duplicating.
    const pooled = measuredMoves([run, { ...run, id: 'second' }])
    expect(pooled).toHaveLength(5)
    expect(pooled.every((move) => move.walked === 2)).toBe(true)
  })

  it('prefers the walked move over the computed one, and marks the rest predicted', () => {
    const built = buildBaselineMap([run])
    const moves = measuredMoves([run])
    const rows = transitionsFrom({
      map: built,
      byFan: tauByFan(tauObservations([run])),
      measured: moves,
      fromFan: 9,
      fromHeat: 1,
    })
    expect(rows.length).toBe(5)
    expect(rows.some((move) => move.basis === 'measured')).toBe(true)
    expect(rows.some((move) => move.basis === 'predicted')).toBe(true)
    for (const move of rows) expect(move.secondsToSettle!).toBeGreaterThan(0)
  })

  it('opens on the setting the passes walked away from most often', () => {
    const built = buildBaselineMap([run])
    const origins = transitionOrigins(built, measuredMoves([run]))
    expect(origins).toHaveLength(6)
    expect(origins.reduce((total, origin) => total + origin.walked, 0)).toBe(5)
    expect(defaultTransitionOrigin(origins)!.walked).toBeGreaterThan(0)
    expect(defaultTransitionOrigin([])).toBeUndefined()
  })

  it('grades the pass by what it actually pinned down', () => {
    const grade = baselinePassGrade(analysis)
    expect(grade.points).toBe(6)
    expect(grade.measured).toBe(6)
    expect(grade.unreliable).toBe(0)
    expect(grade.suspectFans).toEqual([])
    expect(grade.hasPassiveTail).toBe(true)
    expect(grade.hasCoolingTail).toBe(true)
    expect(grade.grade).toBe('good')
    expect(grade.reasons).toEqual([])
  })

  it('calls out a pass with no fan-off tail rather than grading it good', () => {
    const clipped = { ...run, samples: run.samples.filter((sample) => sample.effectiveFan > 0) }
    const grade = baselinePassGrade(analyzeCalibrationRun(clipped))
    expect(grade.hasPassiveTail).toBe(false)
    expect(grade.grade).toBe('partial')
    expect(grade.reasons.some((reason) => reason.includes('thermal-loss'))).toBe(true)
  })
})

describe('bounded response-time summary', () => {
  const observation = (overrides: Partial<TauObservation>): TauObservation => ({
    runId: 'run',
    capturedAt: '2026-07-01T00:00:00.000Z',
    stepIndex: 0,
    fan: 0,
    heat: 0,
    tauSec: 0,
    direction: 'rising',
    quality: 'measured',
    kind: 'step',
    source: 'synthetic step',
    ...overrides,
  })
  it('returns exactly one row per fan with direction counts and the measured range', () => {
    const rows = responseSummary([
      {
        fan: 3,
        tauSec: 20,
        lowSec: 18,
        highSec: 24,
        rising: 2,
        falling: 1,
        observations: [
          observation({ runId: 'a', kind: 'step', direction: 'rising', fan: 3, heat: 3, tauSec: 18 }),
          observation({ runId: 'a', kind: 'step', direction: 'rising', fan: 3, heat: 5, tauSec: 20 }),
          observation({ runId: 'a', kind: 'step', direction: 'falling', fan: 3, heat: 1, tauSec: 24 }),
        ],
      },
      {
        fan: 7,
        tauSec: 31,
        lowSec: 31,
        highSec: 31,
        rising: 1,
        falling: 0,
        observations: [observation({ runId: 'b', kind: 'step', direction: 'rising', fan: 7, heat: 5, tauSec: 31 })],
      },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      fan: 3,
      medianSec: 20,
      lowSec: 18,
      highSec: 24,
      observations: 3,
      rising: 2,
      falling: 1,
      quality: 'strong',
    })
    expect(rows[1]).toMatchObject({ fan: 7, observations: 1, quality: 'limited' })
  })

  it('marks highly variable or weak fits as mixed evidence', () => {
    const rows = responseSummary([
      {
        fan: 5,
        tauSec: 20,
        lowSec: 8,
        highSec: 45,
        rising: 1,
        falling: 1,
        worstR2: 0.7,
        observations: [
          observation({ runId: 'a', kind: 'step', direction: 'rising', fan: 5, heat: 5, tauSec: 8 }),
          observation({ runId: 'b', kind: 'step', direction: 'falling', fan: 5, heat: 1, tauSec: 45 }),
        ],
      },
    ])
    expect(rows[0].quality).toBe('mixed')
  })
})
