import { thermalStep } from './thermalModel'
import type { CalibrationRun, CalibrationSettings, ThermalSample } from './types'

/**
 * How well does the thermal model actually describe this roaster?
 *
 * Every plan the app derives - the journey control law, the simulation, any future runner - is only
 * as good as the model underneath it. Until now nothing anywhere said whether that model resembled
 * the hardware, so a confident-looking predicted curve carried no evidence at all. This is the
 * evidence: take a pass that was really recorded, replay the fan and heat levels it really ran
 * through the model, and compare, sample by sample, against the temperatures that were really
 * measured.
 *
 * It is an OPEN-LOOP replay on purpose. The model is seeded once, from the first readable sample,
 * and then left to run: no re-anchoring, no correction from the recorded data. A closed-loop replay
 * would drag the model back onto the truth every step and report a flattering number that says
 * nothing about whether a plan derived from the model would work.
 *
 * The number is therefore a hard test, and a large one is a real answer rather than a failure of
 * the harness. A diagnostic pass measures the empty chamber, whose physics differ from the loaded
 * bean model the coefficients describe, so a big residual against the shipped defaults is expected
 * and is exactly the thing the user should see before trusting a derived temperature.
 */
export interface ModelFit {
  /** Root-mean-square error in C across every replayed sample. */
  rmsC: number
  /** The worst single-sample error, and when it happened. */
  maxC: number
  maxAtSec: number
  /** Mean signed error: positive means the model ran HOTTER than the roaster. */
  biasC: number
  /** How many samples were comparable. */
  samples: number
  /** Where the replay was seeded from. */
  seededAtC: number
}

export interface ModelReplay {
  fit: ModelFit
  samples: ThermalSample[]
}

export interface ReplayOptions {
  ambientC?: number
  batchMassG?: number
  /** Simulate the whole trace, but exclude the structurally unmodelled opening transient from RMS. */
  scoreFromSec?: number
}

const readable = (sample: ThermalSample) => sample.thermocoupleC !== undefined

/**
 * Replay a recorded fan/heat history through the model and score it.
 *
 * `batchMassG` is the reference mass by default, which makes the model's mass factor exactly 1 -
 * the right choice for an empty-chamber diagnostic pass, where there is no batch at all.
 */
export const replayThermalTrace = (
  samples: ThermalSample[],
  calibration: CalibrationSettings,
  options: ReplayOptions = {},
): ModelReplay | undefined => {
  const usable = samples.filter(readable)
  if (usable.length < 2) return undefined

  const ambientC =
    options.ambientC ?? usable.find((sample) => sample.coldJunctionC !== undefined)?.coldJunctionC ?? 24.5
  const batchMassG = options.batchMassG ?? calibration.referenceBatchMassG
  const seededAtC = usable[0].thermocoupleC!

  let modelledC = seededAtC
  let rorCPerMin: number | undefined
  let squared = 0
  let maxC = 0
  let maxAtSec = 0
  let bias = 0
  let compared = 0
  const predicted: ThermalSample[] = [{ ...usable[0], thermocoupleC: seededAtC }]

  for (let index = 1; index < usable.length; index += 1) {
    const previous = usable[index - 1]
    const sample = usable[index]
    const stepSec = Math.max(0, (sample.tMs - previous.tMs) / 1000)
    // The model advances one second at a time whatever the log's own spacing is, so a gap in the
    // recording cannot silently become a single huge integration step.
    for (let second = 0; second < Math.round(stepSec); second += 1) {
      const result = thermalStep(
        {
          previousBeanTempC: modelledC,
          previousRorCPerMin: rorCPerMin,
          fan: previous.effectiveFan,
          heat: previous.effectiveHeat,
          cooling: previous.effectiveHeat === 0,
          batchMassG,
          ambientC,
        },
        calibration,
      )
      modelledC = result.beanTempC
      rorCPerMin = result.rorCPerMin
    }
    const elapsedSec = sample.tMs / 1000
    if (elapsedSec >= (options.scoreFromSec ?? 0)) {
      const errorC = modelledC - sample.thermocoupleC!
      squared += errorC * errorC
      bias += errorC
      compared += 1
      if (Math.abs(errorC) > Math.abs(maxC)) {
        maxC = errorC
        maxAtSec = elapsedSec
      }
    }
    predicted.push({ ...sample, thermocoupleC: modelledC })
  }

  if (compared === 0) return undefined
  return {
    fit: {
      rmsC: Math.sqrt(squared / compared),
      maxC: Math.abs(maxC),
      maxAtSec,
      biasC: bias / compared,
      samples: compared,
      seededAtC,
    },
    samples: predicted,
  }
}

export const replayThermalLog = (
  samples: ThermalSample[],
  calibration: CalibrationSettings,
  options: ReplayOptions = {},
) => replayThermalTrace(samples, calibration, options)?.fit

export const replayCalibrationRun = (run: CalibrationRun, calibration: CalibrationSettings) =>
  replayThermalLog(run.samples, calibration, { ambientC: run.ambientC })

/**
 * A plain reading of the number, so the figure on screen carries its own interpretation. The bands
 * are deliberately coarse: this is a "can I trust a derived plan" question, not a fit statistic.
 */
export const modelFitVerdict = (
  fit: ModelFit | undefined,
): { grade: 'good' | 'fair' | 'poor' | 'unknown'; text: string } => {
  if (!fit) return { grade: 'unknown', text: 'No readable samples to replay' }
  if (fit.rmsC <= 5)
    return {
      grade: 'good',
      text: 'The model stays close to what was really measured here, so the temperatures it predicts are worth trusting.',
    }
  if (fit.rmsC <= 20)
    return {
      grade: 'fair',
      text: 'The model gets the shape of this recording right but not the exact temperatures. Trust which way it goes, not the numbers on it.',
    }
  return {
    grade: 'poor',
    text: 'The model is a long way from what was really measured here. Read anything it predicts as the shape of a curve, not as a number of degrees.',
  }
}
