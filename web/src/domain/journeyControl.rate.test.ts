import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterThermalIntent } from '../data/demo'
import { effectiveLevels } from './actuatorFloors'
import type { JourneyControlState, RateSample } from './journeyControl'
import {
  appendRateSample,
  initialJourneyControlState,
  journeyCommand,
  journeyControlStep,
  journeyPlan,
  MAX_COOLING_CORRECTION_C_PER_MIN,
  MAX_CORRECTION_C_PER_MIN,
  MAX_RATE_LEAD_C_PER_MIN,
  predictedRate,
  RATE_HISTORY_CAPACITY,
  RATE_HISTORY_SEC,
  RATE_WINDOW_SEC,
  STALE_SAMPLE_GAP_SEC,
  TRACKING_RATE_GAIN,
} from './journeyControl'
import { thermalStep } from './thermalModel'
import type { CalibrationSettings, ThermalIntent, ThermalSegment } from './types'

/**
 * The overshoot-recovery behaviour: corrections spend Heat before Fan, the rate term acts on a
 * lag-compensated RoR, and the cooling-direction authority is bounded separately. The header of
 * `journeyControl.ts` derives every formula pinned here; the numbers below are hand-computable
 * from equations (1)-(7).
 */
const AMBIENT_C = 24.5
const intentOf = (segments: ThermalSegment[]): ThermalIntent => ({ ...starterThermalIntent, id: 'rate-test', segments })

/** A measured 225 g roast's applied fit and plan, exactly as the vector scenario `overshoot_lag_recovery` uses them. */
const overshootFit: CalibrationSettings = {
  ...defaultCalibration,
  heaterGainCPerMinAt10: 49.2,
  fanCoolingCPerMinAt10: 2.94,
  coolingFanCPerMinAt10: 19.67,
  thermalLossPerMinPerC: 0.2443,
  referenceBatchMassG: 225,
}
const overshootJourney = intentOf([
  { id: 'charge', startC: 28.8, endC: 150, durationSec: 120, fanMin: 10, fanMax: 10, heatMin: 10, heatMax: 10 },
  { id: 'drive', startC: 150, endC: 180, durationSec: 60, fanMin: 5, fanMax: 10, heatMin: 5, heatMax: 10 },
  { id: 'develop', startC: 180, endC: 215, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
  { id: 'finish', startC: 215, endC: 233, durationSec: 60, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
  { id: 'cool', startC: 233, endC: 50, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 0 },
])

const samplesOf = (temperatureAt: (sec: number) => number, fromSec: number, toSec: number): RateSample[] => {
  const out: RateSample[] = []
  for (let sec = fromSec; sec <= toSec; sec += 1) out.push({ sec, tempC: temperatureAt(sec) })
  return out
}

describe('the lag-compensated rate estimate, (6) and (7)', () => {
  it('reads a constant climb as its slope with no lead', () => {
    const history = samplesOf((sec) => 25 + sec, 0, 29)
    const estimate = predictedRate(history, { sec: 30, tempC: 55 })!
    expect(estimate.measuredCPerMin).toBeCloseTo(60, 9)
    expect(estimate.leadCPerMin).toBeCloseTo(0, 9)
    expect(estimate.predictedCPerMin).toBeCloseTo(60, 9)
  })

  it('extrapolates an accelerating climb one lag ahead: 2 x RoR(last 10 s) - RoR(the 10 s before)', () => {
    // T = 0.002 t^2. RoR over [20, 30] = 60 x 0.002 x (900 - 400) / 10 = 6.0; over [10, 20] = 3.6.
    const history = samplesOf((sec) => 0.002 * sec * sec, 0, 29)
    const estimate = predictedRate(history, { sec: 30, tempC: 0.002 * 900 })!
    expect(estimate.measuredCPerMin).toBeCloseTo(6.0, 9)
    expect(estimate.leadCPerMin).toBeCloseTo(2.4, 9)
    expect(estimate.predictedCPerMin).toBeCloseTo(2 * 6.0 - 3.6, 9)
  })

  it('clamps the lead so a violent second difference cannot own the correction', () => {
    // T = 0.02 t^2: RoR 60 over the last window, 36 over the one before, a raw lead of 24.
    const history = samplesOf((sec) => 0.02 * sec * sec, 0, 29)
    const estimate = predictedRate(history, { sec: 30, tempC: 0.02 * 900 })!
    expect(estimate.leadCPerMin).toBe(MAX_RATE_LEAD_C_PER_MIN)
    expect(estimate.predictedCPerMin).toBeCloseTo(60 + MAX_RATE_LEAD_C_PER_MIN, 9)
    const falling = samplesOf((sec) => -0.02 * sec * sec, 0, 29)
    expect(predictedRate(falling, { sec: 30, tempC: -0.02 * 900 })!.leadCPerMin).toBe(-MAX_RATE_LEAD_C_PER_MIN)
  })

  it('needs one window for a level and two for a trend, and invents neither', () => {
    expect(predictedRate([], { sec: 30, tempC: 100 })).toBeUndefined()
    expect(
      predictedRate(
        samplesOf((sec) => sec, 21, 29),
        { sec: 30, tempC: 30 },
      ),
    ).toBeUndefined()
    // Exactly one window old is enough for the level, but there is nothing older to trend against.
    const oneWindow = predictedRate(
      samplesOf((sec) => 0.02 * sec * sec, 20, 29),
      { sec: 30, tempC: 0.02 * 900 },
    )!
    expect(oneWindow.measuredCPerMin).toBeCloseTo(60, 9)
    expect(oneWindow.leadCPerMin).toBe(0)
  })

  it('anchors each window on the newest sample at least a window old when sampling is irregular', () => {
    const history: RateSample[] = [
      { sec: 0, tempC: 100 },
      { sec: 3, tempC: 103 },
      { sec: 7, tempC: 107 },
      { sec: 12, tempC: 112 },
      { sec: 20, tempC: 122 },
    ]
    const estimate = predictedRate(history, { sec: 22, tempC: 126 })!
    // Level: from the 12 s sample (age 10), 60 x (126 - 112) / 10 = 84. Trend: the newest sample at
    // least 10 s older than that is the 0 s one, 60 x (112 - 100) / 12 = 60, so the lead is
    // 10 x (84 - 60) / 10 = 24, clamped to 10.
    expect(estimate.measuredCPerMin).toBeCloseTo(84, 9)
    expect(estimate.leadCPerMin).toBe(MAX_RATE_LEAD_C_PER_MIN)
  })
})

describe('the rate history', () => {
  it('drops samples older than the history span and never exceeds its capacity', () => {
    let history: RateSample[] = []
    for (let sec = 0; sec <= 100; sec += 1) history = appendRateSample(history, { sec, tempC: sec })
    expect(history.length).toBeLessThanOrEqual(RATE_HISTORY_CAPACITY)
    expect(history[0].sec).toBe(100 - RATE_HISTORY_SEC)
    expect(history[history.length - 1].sec).toBe(100)
    // Faster than the cadence the span was sized for, the capacity is the binding rule.
    let dense: RateSample[] = []
    for (let tick = 0; tick <= 200; tick += 1) dense = appendRateSample(dense, { sec: tick / 10, tempC: tick })
    expect(dense.length).toBe(RATE_HISTORY_CAPACITY)
    expect(dense[dense.length - 1].sec).toBe(20)
  })

  it('does not record a sample that fails to advance the clock, and never mutates its input', () => {
    const history: RateSample[] = [{ sec: 5, tempC: 50 }]
    const repeated = appendRateSample(history, { sec: 5, tempC: 51 })
    expect(repeated).toEqual(history)
    expect(repeated).not.toBe(history)
    expect(appendRateSample(history, { sec: 4, tempC: 40 })).toEqual(history)
    expect(history).toEqual([{ sec: 5, tempC: 50 }])
  })
})

describe('the rate term inside the step', () => {
  const climb = intentOf([
    { id: 'climb', startC: 25, endC: 200, durationSec: 900, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
  ])
  const plan = journeyPlan(climb)
  const stepAt = (state: JourneyControlState, elapsedSec: number, beanTempC: number) =>
    journeyControlStep(state, {
      plan,
      elapsedSec,
      beanTempC,
      ambientC: AMBIENT_C,
      batchMassG: defaultCalibration.referenceBatchMassG,
      calibration: defaultCalibration,
    })

  /** Run the real step over a temperature series and hand back the last result and its trail. */
  const fold = (
    temperatureAt: (sec: number) => number,
    fromSec: number,
    toSec: number,
    state = initialJourneyControlState(),
  ) => {
    const trail = []
    for (let sec = fromSec; sec <= toSec; sec += 1) {
      const step = stepAt(state, sec, temperatureAt(sec))
      state = step.state
      trail.push(step)
    }
    return { state, trail }
  }

  it('is silent until a window of history exists, then reads Kr x (slope - predicted RoR)', () => {
    // A roast climbing 1 C/s below the 11.67 °C/min plan slope: RoR 60, so the rate error is
    // 11.67 - 60 = -48.3 and the term Kr x that.
    const { trail } = fold((sec) => 25 + sec, 0, 25)
    for (const step of trail.slice(0, RATE_WINDOW_SEC)) {
      expect(Number.isNaN(step.rate.measuredRateCPerMin)).toBe(true)
      expect(step.rate.rateRatePerMin).toBe(0)
    }
    const settled = trail[trail.length - 1]
    expect(settled.rate.measuredRateCPerMin).toBeCloseTo(60, 9)
    expect(settled.rate.predictedRateCPerMin).toBeCloseTo(60, 9)
    expect(settled.rate.rateErrorCPerMin).toBeCloseTo(settled.command.requiredRateCPerMin - 60, 9)
    expect(settled.rate.rateRatePerMin).toBeCloseTo(TRACKING_RATE_GAIN * settled.rate.rateErrorCPerMin, 9)
    // And it is part of the total, before the clamp.
    expect(settled.correction.totalRatePerMin).toBeCloseTo(
      Math.max(
        -MAX_COOLING_CORRECTION_C_PER_MIN,
        Math.min(
          MAX_CORRECTION_C_PER_MIN,
          settled.correction.proportionalRatePerMin +
            settled.rate.rateRatePerMin +
            settled.correction.integralRatePerMin,
        ),
      ),
      9,
    )
  })

  it('applies no rate term on a holdover and appends nothing to the history', () => {
    const { state } = fold((sec) => 25 + sec, 0, 20)
    const blind = stepAt(state, 21, Number.NaN)
    expect(blind.correction.holdover).toBe(true)
    expect(blind.rate.rateRatePerMin).toBe(0)
    expect(Number.isNaN(blind.rate.measuredRateCPerMin)).toBe(true)
    expect(blind.state.rateHistory).toEqual(state.rateHistory)
  })

  it('forgets the history across a gap it did not observe, and rebuilds it', () => {
    const { state } = fold((sec) => 25 + sec, 0, 20)
    const resumed = stepAt(state, 20 + STALE_SAMPLE_GAP_SEC + 1, 25 + 20 + STALE_SAMPLE_GAP_SEC + 1)
    expect(Number.isNaN(resumed.rate.measuredRateCPerMin)).toBe(true)
    expect(resumed.state.rateHistory).toHaveLength(1)
    // A short dropout, on the other hand, keeps what was observed on either side of it.
    const kept = stepAt(state, 25, 50)
    expect(kept.rate.measuredRateCPerMin).toBeCloseTo(60, 9)
    expect(kept.state.rateHistory.length).toBe(state.rateHistory.length + 1)
  })

  it('relaxes as soon as the trend turns, while the level is still above the slope', () => {
    // RoR rises to 30 then falls, with the level still well above the 11.67 °C/min slope at the turn.
    const rising = (sec: number) => 100 + (30 / 60) * sec + 0.01 * sec * sec
    const rose = fold(rising, 0, 40)
    const peak = rose.trail[rose.trail.length - 1]
    // Still rising: the prediction sits above the measurement and the term is more negative.
    expect(peak.rate.predictedRateCPerMin).toBeGreaterThan(peak.rate.measuredRateCPerMin)
    const falling = (sec: number) =>
      rising(40) + (rising(40) - rising(39)) * (sec - 40) - 0.02 * (sec - 40) * (sec - 40)
    const turned = fold(falling, 41, 60, rose.state)
    const after = turned.trail[turned.trail.length - 1]
    expect(after.rate.measuredRateCPerMin).toBeGreaterThan(after.command.requiredRateCPerMin)
    expect(after.rate.predictedRateCPerMin).toBeLessThan(after.rate.measuredRateCPerMin)
    expect(after.rate.rateRatePerMin).toBeGreaterThan(peak.rate.rateRatePerMin)
  })
})

describe('corrections spend Heat before Fan, (4) and (5)', () => {
  // 30 °C/min with a Heat floor of 6: feed-forward sits at Heat 10 with an interior Fan (about 8.05
  // at 170 C, from (2)), Heat has 4 levels = 26.4 °C/min of downward authority before the floor, and
  // no correction below lands under the plant's -5 °C/min heating floor.
  const zone: ThermalSegment = {
    id: 'mid',
    startC: 150,
    endC: 210,
    durationSec: 120,
    fanMin: 1,
    fanMax: 10,
    heatMin: 6,
    heatMax: 10,
  }
  const plan = journeyPlan(intentOf([zone]))
  const at = (rateCorrectionCPerMin: number, calibration = defaultCalibration, beanTempC = 170) =>
    journeyCommand({
      plan,
      elapsedSec: 120,
      beanTempC,
      ambientC: AMBIENT_C,
      batchMassG: calibration.referenceBatchMassG,
      calibration,
      rateCorrectionCPerMin,
      zoneAnchor: { zoneIndex: 0, zoneEntrySec: 0 },
    })

  it('leaves the baseline exactly where the maximum-airflow feed-forward put it', () => {
    const baseline = at(0)
    expect(baseline.heat).toBeCloseTo(zone.heatMax, 9)
    expect(baseline.fan).toBeGreaterThan(zone.fanMin)
    expect(baseline.fan).toBeLessThan(zone.fanMax)
    expect(baseline.baselineRateCPerMin).toBeCloseTo(baseline.requiredRateCPerMin, 9)
    expect(baseline.saturated).toBe(false)
  })

  it('takes a negative correction out of Heat at the baseline Fan, not out of airflow', () => {
    const baseline = at(0)
    const eased = at(-6)
    expect(eased.fan).toBeCloseTo(baseline.fan, 9)
    // One heat level is heaterGain / 10 °C/min at the reference mass, from (1).
    expect(eased.heat).toBeCloseTo(baseline.heat - 6 / (defaultCalibration.heaterGainCPerMinAt10 / 10), 9)
    expect(eased.saturated).toBe(false)
  })

  it('raises Fan only once Heat has reached the zone minimum, and only for the remainder', () => {
    const baseline = at(0)
    const heatAuthority = (baseline.heat - zone.heatMin) * (defaultCalibration.heaterGainCPerMinAt10 / 10)
    const beyond = at(-(heatAuthority + 2))
    expect(beyond.heat).toBeCloseTo(zone.heatMin, 9)
    // The 2 °C/min Heat could not deliver comes from airflow: fanCooling / 10 per level, (2).
    expect(beyond.fan).toBeCloseTo(baseline.fan + 2 / (defaultCalibration.fanCoolingCPerMinAt10 / 10), 6)
    expect(beyond.saturated).toBe(false)
    // Past what airflow can deliver too, the request is reported as unreachable downward.
    const pinned = at(-(heatAuthority + 40))
    expect(pinned.fan).toBe(zone.fanMax)
    expect(pinned.heat).toBe(zone.heatMin)
    expect(pinned.saturatedLow).toBe(true)
  })

  it('spends a positive correction as more Heat first, then less airflow, as the old solve did', () => {
    const baseline = at(0)
    const pushed = at(6)
    expect(pushed.heat).toBeCloseTo(zone.heatMax, 9)
    expect(pushed.fan).toBeCloseTo(baseline.fan - 6 / (defaultCalibration.fanCoolingCPerMinAt10 / 10), 6)
    expect(pushed.saturated).toBe(false)
  })

  it('measures a correction from the pair feed-forward really commands when the band clamped it', () => {
    // Zone 3 at 199 C: the applied fit wants Heat 10.85 at Fan 1 for 17.5 °C/min and can
    // command only 10. `baselineRateCPerMin` is what that pair delivers in the model.
    const overshootPlan = journeyPlan(overshootJourney)
    const command = (rateCorrectionCPerMin: number) =>
      journeyCommand({
        plan: overshootPlan,
        elapsedSec: 323,
        beanTempC: 199,
        ambientC: AMBIENT_C,
        batchMassG: 225,
        calibration: overshootFit,
        rateCorrectionCPerMin,
        zoneAnchor: { zoneIndex: 2, zoneEntrySec: 262 },
      })
    const feedForward = command(0)
    expect(feedForward.fan).toBe(1)
    expect(feedForward.heat).toBe(10)
    expect(feedForward.saturatedHigh).toBe(true)
    expect(feedForward.baselineRateCPerMin).toBeLessThan(feedForward.requiredRateCPerMin - 3)
    // A -6 correction takes 6 / 4.92 = 1.22 levels off the Heat that is actually running, and Fan
    // stays at 1. Re-solving from the plan's slope instead would send Fan toward 10 with Heat at 10.
    const eased = command(-6)
    expect(eased.fan).toBe(1)
    expect(eased.heat).toBeCloseTo(10 - 6 / (overshootFit.heaterGainCPerMinAt10 / 10), 6)
    expect(eased.saturatedLow).toBe(false)
    expect(eased.commandedRateCPerMin).toBeCloseTo(feedForward.requiredRateCPerMin - 6, 9)
  })
})

/**
 * The measured overshoot replayed in closed loop: the roast's plan and the fit the device had
 * applied, against a plant hotter and far more airflow-sensitive than that fit, with the ~8 s
 * actuation dead time and ~10 s probe lag measured from the recording's fan excursion. The same scenario is `overshoot_lag_recovery`
 * in the cross-language vectors; this is the behavioural reading of it.
 */
describe('overshoot replay: the overshoot is corrected with Heat, and relaxed before RoR crosses the slope', () => {
  const roaster: CalibrationSettings = { ...overshootFit, heaterGainCPerMinAt10: 62, fanCoolingCPerMinAt10: 12 }
  const plan = journeyPlan(overshootJourney)
  const rows: Array<{
    sec: number
    beanTempC: number
    rorCPerMin: number
    fan: number
    heat: number
    total: number
    measuredRate: number
    zoneIndex: number
    errorC: number
  }> = []
  let state = initialJourneyControlState()
  let beanTempC = overshootJourney.segments[0].startC
  let rorCPerMin: number | undefined
  const pending: Array<{ fan: number; heat: number; cooling: boolean }> = []
  for (let sec = 0; sec <= 780; sec += 1) {
    const step = journeyControlStep(state, {
      plan,
      elapsedSec: sec,
      beanTempC,
      ambientC: AMBIENT_C,
      batchMassG: 225,
      calibration: overshootFit,
    })
    state = step.state
    rows.push({
      sec,
      beanTempC,
      rorCPerMin: rorCPerMin ?? 0,
      fan: step.command.fan,
      heat: step.command.heat,
      total: step.correction.totalRatePerMin,
      measuredRate: step.rate.measuredRateCPerMin,
      zoneIndex: step.zoneIndex,
      errorC: step.correction.errorC,
    })
    pending.push({
      ...effectiveLevels({ fan: step.command.fan, heat: step.command.heat }),
      cooling: step.command.cooling,
    })
    const applied = pending.length > 8 ? pending.shift()! : pending[0]
    const result = thermalStep(
      {
        previousBeanTempC: beanTempC,
        previousRorCPerMin: rorCPerMin,
        fan: applied.fan,
        heat: applied.heat,
        cooling: applied.cooling,
        batchMassG: 225,
        ambientC: AMBIENT_C,
      },
      roaster,
      { probeOffsetC: 0, sensorLagSec: 10 },
    )
    beanTempC = result.beanTempC
    rorCPerMin = result.rorCPerMin
  }
  const zone3 = rows.filter((row) => row.zoneIndex === 2)
  const slope = 17.5

  it('really does run hot into zone 3, or the replay proves nothing', () => {
    expect(zone3.length).toBeGreaterThan(60)
    expect(Math.max(...zone3.slice(0, 30).map((row) => row.rorCPerMin))).toBeGreaterThan(slope + 4)
  })

  it('never reaches for the fan: Fan holds the zone minimum while Heat moves first', () => {
    expect(Math.max(...zone3.map((row) => row.fan))).toBeCloseTo(1, 9)
    expect(Math.min(...zone3.map((row) => row.heat))).toBeLessThan(9)
    const firstHeatMove = zone3.find((row) => row.heat < 10 - 1e-9)!
    expect(firstHeatMove.sec - zone3[0].sec).toBeLessThan(5)
  })

  it('bounds the correction and the undershoot: RoR never collapses the way the recorded roast did', () => {
    for (const row of zone3) expect(row.total).toBeGreaterThanOrEqual(-MAX_COOLING_CORRECTION_C_PER_MIN - 1e-9)
    // The recorded roast's RoR fell to -2 °C/min and the temperature stalled for ~80 s.
    expect(Math.min(...zone3.map((row) => row.rorCPerMin))).toBeGreaterThan(10)
    expect(Math.min(...zone3.map((row) => row.errorC))).toBeGreaterThan(-4)
    expect(Math.max(...zone3.map((row) => row.errorC))).toBeLessThan(2)
  })

  it('relaxes the correction while measured RoR is still above the slope', () => {
    const minTotal = Math.min(...zone3.map((row) => row.total))
    const trough = zone3.find((row) => row.total === minTotal)!
    const relaxed = zone3.find((row) => row.sec > trough.sec && row.total > minTotal + 1)!
    expect(relaxed).toBeDefined()
    expect(relaxed.measuredRate).toBeGreaterThan(slope)
    // The recorded roast reversed ~20 s after RoR had already fallen through the slope. The probe's ten-second
    // window can only report a crossing after the plant has made it, so the bound is the window.
    const crossed = zone3.find((row) => row.sec > zone3[0].sec + 5 && row.rorCPerMin <= slope)
    if (crossed) expect(relaxed.sec).toBeLessThanOrEqual(crossed.sec + RATE_WINDOW_SEC)
  })

  it('arrives at the zone endpoint near nominal time instead of 30 s late', () => {
    const entry = zone3[0].sec
    const exit = rows.find((row) => row.zoneIndex === 3)!.sec
    expect(Math.abs(exit - entry - 120)).toBeLessThan(12)
  })
})
