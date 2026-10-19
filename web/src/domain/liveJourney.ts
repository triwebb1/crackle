import { type ZoneRole, zoneRoles } from './controlResidual'
import {
  initialJourneyControlState,
  type JourneyCommand,
  type JourneyPlan,
  journeyControlStep,
  journeyPlan,
  zoneTargetC,
} from './journeyControl'
import {
  finiteAmbientC,
  finiteBatchMassG,
  finiteControlCalibration,
  modeledMass,
  type SimulatedZone,
} from './profileSimulation'
import type {
  CalibrationSettings,
  ControlCorrection,
  RoastProgramStatus,
  TelemetrySample,
  ThermalIntent,
  ThermalSegment,
} from './types'

/**
 * The live roast, read through the SAME control law the simulation runs.
 *
 * Design rule: the algorithms that drive the simulation drive the live roast too - the exact same
 * code. So this module contains no control law of its own. It calls `journeyControlStep` - the
 * identical exported function `profileSimulation.simulateJourney` threads - once per telemetry
 * sample, and reports what came back. There is no second inversion, no second PI, no second idea of
 * which zone the roast is in, and nothing here may acquire one.
 *
 * **Nothing here is commanded, and nothing here is displayed as a control panel either.** The roast
 * is executed by the controller, which reports its own zone, target, levels and correction; what
 * this fold produces is what the CHART is drawn from - zone boundaries, attainment marks, and the
 * stretched in-zone target line. No call in this file or its callers touches the controller.
 *
 * **State is a fold, not a mutable accumulator.** `journeyControlStep` is documented as replayable -
 * two identical sequences of inputs produce two identical sequences of outputs - so the honest way
 * to hold its state across a component's re-renders is to not hold it at all: start from
 * `initialJourneyControlState()` and replay the session's samples. That gives, by construction, the
 * two properties the live path needs and a mutable ref would only approximate: the state resets at
 * roast start and at no other time, and a re-render (or a remount, or a tab switch) cannot perturb
 * it. The cost is one closed-form pass per sample, which is a few thousand multiplications.
 *
 * **A missing thermocouple is a holdover, exactly as the step defines it.** The final step is taken
 * at the live clock against the live probe reading, and when the probe has nothing to say the step
 * is handed a non-finite temperature: the correction drops to zero, the integral freezes, the zone
 * anchor does not advance, and the command becomes pure feed-forward against the plan. Substituting
 * the last good reading is exactly what `journeyControl.ts` refuses to do, and this must not do it
 * either.
 */

/** One zone of the journey, as the roast has actually experienced it so far. */
export interface LiveJourneyZone {
  index: number
  zoneId: string
  role: ZoneRole
  startC: number
  endC: number
  nominalDurationSec: number
  /** Where the PROFILE puts this zone's boundaries. Never moved by anything the roast does. */
  plannedStartSec: number
  plannedEndSec: number
  /** When the roast actually entered, by attainment of the previous zone. Absent if never reached. */
  entrySec?: number
  /** When the measured temperature attained this zone's endpoint. */
  attainedSec?: number
  /** Time in the zone: total once attained, so-far while it is the current one. */
  actualDurationSec?: number
  /** Actual minus nominal. Positive is an overrun, and for a running zone it is still counting. */
  overrunSec?: number
  attained: boolean
  current: boolean
}

export interface LiveJourneyReading {
  plan: JourneyPlan
  zones: LiveJourneyZone[]
  zoneIndex: number
  zoneEntrySec: number
  /** The in-zone target the controller is chasing right now - `zoneTargetC`, not the plan's clock. */
  targetC: number
  /** What was commanded: feed-forward plus correction. Advisory on this page. */
  command: JourneyCommand
  /** What the model alone said. The gap between the two is the measured residual. */
  feedForward: JourneyCommand
  correction: ControlCorrection
  /**
   * The in-zone target ramp the controller is following, anchored where the roast really entered
   * the zone and held at the endpoint past the nominal duration. This is the curve the PI is
   * pulling toward, and it is not the nominal curve: it has been stretched in time by the entry.
   */
  segment: Array<{ timeSec: number; temperatureC: number }>
  elapsedSec: number
  /** The temperature the final step actually saw. Absent means the step ran as a holdover. */
  measuredC?: number
  zonesAttained: number
}

export interface LiveJourneyInput {
  intent: ThermalIntent
  samples: TelemetrySample[]
  /** The roast clock. The final step is taken here, which is what makes a stalled probe visible. */
  elapsedSec: number
  ambientC: number
  massG?: number
  volumeMl?: number
  calibration: CalibrationSettings
  /** The live probe reading. Absent - a faulted, stale or missing thermocouple - is a holdover. */
  probeC?: number
}

/** How long a zone has to run past its nominal duration before the overrun is worth stating. */
export const OVERRUN_NOTICE_SEC = 15

export const liveJourneyControl = ({
  intent,
  samples,
  elapsedSec,
  ambientC: rawAmbientC,
  massG,
  volumeMl,
  calibration: rawCalibration,
  probeC,
}: LiveJourneyInput): LiveJourneyReading | undefined => {
  const plan = journeyPlan(intent)
  if (plan.segments.length === 0 || plan.totalSec <= 0) return undefined

  // A non-finite ambient, mass or coefficient would reach `command.heat` as NaN; substitute defaults.
  const ambientC = finiteAmbientC(rawAmbientC)
  const calibration = finiteControlCalibration(rawCalibration)
  const batchMassG = modeledMass(finiteBatchMassG(massG), volumeMl)
  const roles = zoneRoles(plan.segments)
  const entrySec = plan.segments.map<number | undefined>(() => undefined)
  const attainedSec = plan.segments.map<number | undefined>(() => undefined)
  entrySec[0] = 0

  let state = initialJourneyControlState()
  const advance = (fromIndex: number, step: { zoneIndex: number; zoneEntrySec: number }, atSec: number) => {
    if (step.zoneIndex === fromIndex) return
    // The step recognised the arrival off the temperature it was HANDED, so the sample it was
    // handed is the one that attained the endpoint. Entry and attainment are the same instant on
    // the live path - unlike the simulation, where the controller sees the previous sample.
    for (let index = fromIndex; index < step.zoneIndex; index += 1) attainedSec[index] = atSec
    entrySec[step.zoneIndex] = step.zoneEntrySec
  }

  for (const sample of samples) {
    const step = journeyControlStep(state, {
      plan,
      elapsedSec: sample.elapsedSec,
      beanTempC: sample.beanTempC,
      ambientC,
      batchMassG,
      calibration,
    })
    advance(state.zoneIndex, step, sample.elapsedSec)
    state = step.state
  }

  /*
   * The live step. It runs at the roast clock rather than at the last sample's timestamp, against
   * whatever the probe is reporting now, which is what makes the two states worth telling apart: a
   * roast whose probe has dropped out gets a holdover reading, not a stale one that looks healthy.
   * Its resulting state is deliberately DISCARDED - only recorded samples are observations, so only
   * they may move the integral - and because the whole fold is recomputed, nothing can drift.
   */
  const liveElapsedSec = Math.max(elapsedSec, samples.at(-1)?.elapsedSec ?? 0)
  const measured = Number.isFinite(probeC) ? (probeC as number) : Number.NaN
  const live = journeyControlStep(state, {
    plan,
    elapsedSec: liveElapsedSec,
    beanTempC: measured,
    ambientC,
    batchMassG,
    calibration,
  })
  advance(state.zoneIndex, live, liveElapsedSec)

  const zones = plan.segments.map((zone, index): LiveJourneyZone => {
    const entry = entrySec[index]
    const exit = attainedSec[index] ?? (index === live.zoneIndex && entry !== undefined ? liveElapsedSec : undefined)
    const actualDurationSec = entry === undefined || exit === undefined ? undefined : Math.max(0, exit - entry)
    return {
      index,
      zoneId: zone.id,
      role: roles[index],
      startC: zone.startC,
      endC: zone.endC,
      nominalDurationSec: Math.max(0, zone.durationSec),
      plannedStartSec: plan.boundaries[index] ?? 0,
      plannedEndSec: plan.boundaries[index + 1] ?? plan.totalSec,
      entrySec: entry,
      attainedSec: attainedSec[index],
      actualDurationSec,
      overrunSec: actualDurationSec === undefined ? undefined : actualDurationSec - Math.max(0, zone.durationSec),
      attained: attainedSec[index] !== undefined,
      current: index === live.zoneIndex,
    }
  })

  /*
   * The stretched in-zone target: the zone's own nominal ramp starting where the roast really
   * entered, capped at the endpoint. Three points describe it exactly, because `zoneTargetC` is one
   * straight line and then a hold - and the hold is what makes arrival guaranteed.
   */
  const zone = plan.segments[Math.min(live.zoneIndex, plan.segments.length - 1)]
  const entry = live.zoneEntrySec
  const rampEndSec = entry + Math.max(1, zone.durationSec)
  const segment = [
    { timeSec: entry, temperatureC: zoneTargetC(zone, 0) },
    { timeSec: rampEndSec, temperatureC: zone.endC },
  ]
  if (liveElapsedSec > rampEndSec) segment.push({ timeSec: liveElapsedSec, temperatureC: zone.endC })

  return {
    plan,
    zones,
    zoneIndex: live.zoneIndex,
    zoneEntrySec: live.zoneEntrySec,
    targetC: live.command.goalC,
    command: live.command,
    feedForward: live.feedForward,
    correction: live.correction,
    segment,
    elapsedSec: liveElapsedSec,
    measuredC: Number.isFinite(measured) ? measured : undefined,
    zonesAttained: zones.filter((item) => item.attained).length,
  }
}

export interface DeviceJourneyChartState {
  zones: LiveJourneyZone[]
  /** The complete schedule after authoritative zone entries/attainments have shifted it. */
  targetPath: Array<{ timeSec: number; temperatureC: number }>
}

/**
 * Build the complete schedule after actual zone boundaries have moved the controller clock.
 *
 * The model of the adjusted plan: the CURRENT zone's ramp is anchored at the
 * device's actual entry with its NOMINAL slope; while the zone overruns, the target holds at its
 * endpoint until attainment; and every UPCOMING zone chains from the actual boundary, so the whole
 * downstream curve shifts on the timeline. The nominal plan is drawn elsewhere and never moves.
 *
 * A zone attained EARLY keeps that same nominal slope: the ramp the controller was following is
 * truncated at the instant of attainment - not steepened so that it "reaches" the endpoint there -
 * and the next zone's own ramp begins at that boundary. That is
 * literally `zoneTargetC` at the zone's elapsed time, the one target law behind the simulation's
 * `heldTargetPath` and the roaster's executor alike.
 */
export const adjustedJourneyTargetPath = (
  zones: ReadonlyArray<LiveJourneyZone>,
  elapsedSec: number,
): Array<{ timeSec: number; temperatureC: number }> => {
  const points: Array<{ timeSec: number; temperatureC: number }> = []
  let nextStartSec = 0
  for (const zone of zones) {
    const entrySec = zone.entrySec ?? nextStartSec
    const ramp = { startC: zone.startC, endC: zone.endC, durationSec: Math.max(1, zone.nominalDurationSec) }
    const nominalEndSec = entrySec + ramp.durationSec
    const exitSec = zone.attainedSec
    points.push({ timeSec: entrySec, temperatureC: zone.startC })
    if (exitSec !== undefined && exitSec < nominalEndSec) {
      points.push({ timeSec: exitSec, temperatureC: zoneTargetC(ramp, exitSec - entrySec) })
      nextStartSec = exitSec
      continue
    }
    points.push({ timeSec: nominalEndSec, temperatureC: zone.endC })
    if (exitSec !== undefined && exitSec > nominalEndSec) points.push({ timeSec: exitSec, temperatureC: zone.endC })
    if (exitSec === undefined && zone.current && elapsedSec > nominalEndSec) {
      points.push({ timeSec: elapsedSec, temperatureC: zone.endC })
    }
    nextStartSec = exitSec ?? (zone.current ? Math.max(nominalEndSec, elapsedSec) : nominalEndSec)
  }
  return points
}

/**
 * Build live chart annotations only from the accepted plan and timestamps reported by the roaster.
 * Unlike `liveJourneyControl`, this never replays browser telemetry to infer controller state.
 *
 * Every zone row is self-contained on the ROASTER's clock: entry, attainment, and - for the zone
 * the roast is in, or was stopped in - the measured extent up to the roaster's own elapsed time.
 * The chart draws the overrun bar from those, so it needs nothing from the browser's trace tail.
 */
export const deviceJourneyChartState = (
  segments: ThermalSegment[],
  roast: RoastProgramStatus,
): DeviceJourneyChartState => {
  const roles = zoneRoles(segments)
  let plannedStartSec = 0
  const attained = roast.zoneAttainedSec ?? []
  const currentIndex = Math.max(0, Math.min(segments.length - 1, roast.zoneIndex ?? 0))
  const elapsedSec = Math.max(0, roast.elapsedSec ?? 0)
  const zones = segments.map((zone, index): LiveJourneyZone => {
    const plannedEndSec = plannedStartSec + Math.max(0, zone.durationSec)
    const previousAttained = index === 0 ? 0 : attained[index - 1]
    const entrySec =
      index === currentIndex && roast.zoneEntrySec !== undefined
        ? roast.zoneEntrySec
        : typeof previousAttained === 'number'
          ? previousAttained
          : undefined
    const attainedSec = typeof attained[index] === 'number' ? (attained[index] as number) : undefined
    const exitSec = attainedSec ?? (index === currentIndex && entrySec !== undefined ? elapsedSec : undefined)
    const actualDurationSec =
      entrySec === undefined || exitSec === undefined ? undefined : Math.max(0, exitSec - entrySec)
    const row: LiveJourneyZone = {
      index,
      zoneId: zone.id,
      role: roles[index],
      startC: zone.startC,
      endC: zone.endC,
      nominalDurationSec: Math.max(0, zone.durationSec),
      plannedStartSec,
      plannedEndSec,
      entrySec,
      attainedSec,
      actualDurationSec,
      overrunSec: actualDurationSec === undefined ? undefined : actualDurationSec - Math.max(0, zone.durationSec),
      attained: attainedSec !== undefined,
      current: roast.active && index === currentIndex,
    }
    plannedStartSec = plannedEndSec
    return row
  })
  return { zones, targetPath: adjustedJourneyTargetPath(zones, elapsedSec) }
}

/** Whether a zone has run long enough past its nominal duration to be worth drawing as an overrun. */
export const zoneOverran = (zone: LiveJourneyZone): boolean =>
  zone.overrunSec !== undefined && zone.overrunSec >= OVERRUN_NOTICE_SEC

/*
 * ==============================================================================================
 * THE SAME CHART FOR A SIMULATED JOURNEY - reported as time, never as temperature
 * ==============================================================================================
 *
 * A simulation with no assumed error at all should look like it responded exactly as expected. Drawn
 * against only the nominal clock-anchored goal, it does not: in the controlled zones the simulated
 * temperature sits within a few tenths of a degree of the target the control is actually holding,
 * yet the chart shows a TIME shift as a temperature gap. Zones advance by attainment, so a charge
 * ramp that needs an extra two minutes pushes every later zone two minutes to the right, and without
 * the marks the live chart uses to say "this distance is time", a run that tracked its target
 * perfectly looks like one that missed it by forty degrees.
 *
 * The live chart already answers this: the plan stays where the profile drew
 * it, the stretched in-zone target is drawn as its own line, and the extra time is drawn as a
 * labelled bar along the x-axis. The two functions below put a finished simulation into exactly that
 * shape, so the simulation and the roast are read the same way and there is one implementation of
 * the target law (`zoneTargetC`) behind both.
 */

/** A finished simulation's zones, in the shape the chart already draws a live roast's in. */
export const simulatedChartZones = (zones: ReadonlyArray<SimulatedZone>): LiveJourneyZone[] => {
  let plannedStartSec = 0
  return zones.map((zone) => {
    const plannedEndSec = plannedStartSec + zone.nominalDurationSec
    const row: LiveJourneyZone = {
      index: zone.zoneIndex,
      zoneId: zone.zoneId,
      role: zone.role,
      startC: zone.startC,
      endC: zone.endC,
      nominalDurationSec: zone.nominalDurationSec,
      plannedStartSec,
      plannedEndSec,
      entrySec: zone.entered ? zone.entrySec : undefined,
      attainedSec: zone.attainedSec,
      actualDurationSec: zone.entered ? zone.simulatedDurationSec : undefined,
      overrunSec: zone.entered ? zone.overrunSec : undefined,
      attained: zone.attained,
      current: false,
    }
    plannedStartSec = plannedEndSec
    return row
  })
}

/**
 * The target the control ACTUALLY held, end to end: each zone's own nominal ramp anchored where the
 * run entered that zone, then holding at the endpoint until it was attained. This is the line the
 * tracking error is measured against, so drawing it is what lets the simulated trace be seen riding
 * its target while the nominal plan stays put beside it and the overrun bars state the difference.
 */
export const heldTargetPath = (
  zones: ReadonlyArray<SimulatedZone>,
  completedSec: number,
): Array<{ timeSec: number; temperatureC: number }> => {
  const points: Array<{ timeSec: number; temperatureC: number }> = []
  for (const zone of zones) {
    if (!zone.entered) break
    const segment = { startC: zone.startC, endC: zone.endC, durationSec: zone.nominalDurationSec }
    const entry = zone.entrySec
    const exit = Math.max(entry, zone.attainedSec ?? completedSec)
    const rampEndSec = entry + Math.max(1, zone.nominalDurationSec)
    points.push({ timeSec: entry, temperatureC: zoneTargetC(segment, 0) })
    if (exit <= rampEndSec) {
      points.push({ timeSec: exit, temperatureC: zoneTargetC(segment, exit - entry) })
      continue
    }
    // The ramp is spent and the target HOLDS at the endpoint while the loop pulls for arrival. That
    // flat stretch is the overrun, and it is the part a nominal-only chart could not show at all.
    points.push({ timeSec: rampEndSec, temperatureC: zone.endC })
    points.push({ timeSec: exit, temperatureC: zone.endC })
  }
  return points
}
