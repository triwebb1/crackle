import { describe, expect, it } from 'vitest'
import { logExcitation } from '../domain/coefficientFit'
import { excitationGrade } from '../domain/fitInputs'
import { replayCalibrationRun } from '../domain/modelFit'
import { profileUsageForBean } from '../domain/recommendations'
import { analyzeCalibrationRun, comparePasses, curveFamily, patchMatches, suspectFanLevels } from '../domain/thermalLog'
import { defaultCalibration } from './calibration'
import { chamberTauSec } from './chamberPlant'
import { DEMO_REFERENCE_MS, richDemoDataset } from './demoDataset'
import { richSeedEnabled } from './repository'

/**
 * The rich dataset exists so every screen has something to review on a dev server. Two things have
 * to hold: it can never reach a build the firmware serves, and nothing in it may render as an error
 * state - a dangling bean id or a saved calibration that disagrees with its own pass would make the
 * demo worse than no demo.
 */
describe('the rich demo seed is dev-server only', () => {
  it('activates on a dev server and nowhere else', () => {
    expect(richSeedEnabled({ DEV: true, MODE: 'development' })).toBe(true)
    expect(richSeedEnabled({ DEV: false, MODE: 'production' })).toBe(false)
    // `vite build` leaves DEV false; a stray MODE cannot re-enable it, and neither can a stray DEV.
    expect(richSeedEnabled({ DEV: false, MODE: 'development' })).toBe(false)
    expect(richSeedEnabled({ DEV: true, MODE: 'production' })).toBe(false)
    expect(richSeedEnabled({ DEV: true, MODE: 'test' })).toBe(false)
    expect(richSeedEnabled({})).toBe(false)
  })

  it('is off inside this test run, which is what keeps the repository suite seeding the shipped demo', () => {
    expect(richSeedEnabled()).toBe(false)
  })
})

describe('the rich demo dataset', () => {
  const dataset = richDemoDataset()

  it('is deterministic, so a reseed never produces a different library', () => {
    expect(richDemoDataset()).toEqual(dataset)
    const stamps = [
      ...dataset.runs.map((run) => run.startedAt),
      ...dataset.profileRevisions.map((revision) => revision.savedAt),
    ]
    for (const stamp of stamps) expect(Date.parse(stamp)).toBeLessThanOrEqual(DEMO_REFERENCE_MS)
  })

  it('has enough of everything to fill the screens it is there to review', () => {
    expect(dataset.profiles.length).toBeGreaterThanOrEqual(4)
    expect(dataset.profiles.filter((profile) => profile.strategy === 'timed').length).toBeGreaterThanOrEqual(2)
    expect(dataset.profiles.filter((profile) => profile.strategy === 'thermal-intent').length).toBeGreaterThanOrEqual(2)
    expect(dataset.beans.length).toBeGreaterThanOrEqual(5)
    expect(dataset.runs.length).toBeGreaterThanOrEqual(6)
    expect(dataset.manualEvents.length).toBeGreaterThanOrEqual(8)
    expect(dataset.calibrationRuns.length).toBeGreaterThanOrEqual(3)
    expect(dataset.calibrationSnapshots.length).toBeGreaterThanOrEqual(3)
  })

  it('gives every profile a history with more than one kind of change in it', () => {
    for (const profile of dataset.profiles) {
      const history = dataset.profileRevisions.filter((revision) => revision.profileId === profile.id)
      expect(history.length, `${profile.id} has no revision history`).toBeGreaterThanOrEqual(2)
      expect(history.map((revision) => revision.revision)).toEqual(history.map((_, index) => index + 1))
      // The newest revision is the profile as it stands now.
      expect(history[history.length - 1].revision).toBe(profile.revision)
    }
    const summaries = dataset.profileRevisions
      .filter((revision) => revision.summary !== 'Created')
      .map((revision) => revision.summary)
    expect(summaries.some((summary) => summary.includes('Heat step'))).toBe(true)
    expect(summaries.some((summary) => summary.includes('zone'))).toBe(true)
    expect(summaries.some((summary) => summary.includes('notes "'))).toBe(true)
    expect(summaries.every((summary) => summary !== 'Saved with no field changes')).toBe(true)
    // Every summary states both sides of what it reports; a bare field name is the defect.
    expect(summaries.every((summary) => summary.includes(' → '))).toBe(true)
  })

  it('refers only to records it actually contains', () => {
    const beanIds = new Set(dataset.beans.map((bean) => bean.id))
    for (const profile of dataset.profiles) {
      // 0.7.0 retired the explicit link; nothing in the dataset may still carry one.
      expect((profile.metadata as unknown as Record<string, unknown>).beanLotIds).toBeUndefined()
      expect((profile.metadata as unknown as Record<string, unknown>).massG).toBeUndefined()
    }
    for (const run of dataset.runs) expect(beanIds.has(run.beanLotId ?? '')).toBe(true)
    for (const revision of dataset.beanRevisions) expect(beanIds.has(revision.beanId)).toBe(true)
    const runIds = new Set(dataset.calibrationRuns.map((run) => run.id))
    for (const snapshot of dataset.calibrationSnapshots) {
      for (const runId of snapshot.runIds) expect(runIds.has(runId)).toBe(true)
    }
  })

  it('surfaces recommendations: at least one lot has been through more than one profile', () => {
    const perBean = dataset.beans.map((bean) => profileUsageForBean(dataset.runs, bean.id).length)
    expect(perBean.some((count) => count >= 2)).toBe(true)
    // And every roast records the mass the Roast page now defaults from.
    for (const run of dataset.runs) expect(run.measurements?.startingMassG).toBeGreaterThan(0)
  })

  it('carries an air map that is physically plausible, not decorative', () => {
    for (const run of dataset.calibrationRuns.filter((candidate) => candidate.form === 'grid')) {
      const analysis = analyzeCalibrationRun(run)
      const curves = curveFamily(analysis)
      // Steady state must rise with heat at a fixed fan; a falling row would be flagged suspect.
      expect(suspectFanLevels(curves), `${run.id} has a suspect row`).toEqual([])
      const points = curves.flatMap((curve) => curve.points.map((point) => ({ ...point, fanLevel: curve.fanLevel })))
      expect(points.length).toBeGreaterThanOrEqual(10)
      for (const point of points) {
        /*
         * The bounds are the empty chamber's, not a roast's. Heat 1 is a tenth of the element and
         * settles a little over 20 °C above the room; full heat at the lowest fan the actuator will
         * allow is the corner the measurement ceiling exists for. The empty-air node follows the
         * measured cooling response: about 94 s at fan 10, lengthening toward 170 s at fan 1. Compare each fitted
         * value with the shared plant instead of a broad hand-written range, so a fixture/plant drift
         * fails even when both numbers still look superficially plausible.
         */
        expect(point.steadyStateC).toBeGreaterThan(35)
        expect(point.steadyStateC).toBeLessThan(300)
        if (point.tauSec !== undefined) {
          const expectedTauSec = chamberTauSec(point.fanLevel)
          const ratio = point.tauSec / expectedTauSec
          /*
           * This deterministic two-node fixture yields 0.632-0.971 for settled points: their tau is
           * fitted against a tail mean, and descending serpentine steps retain wall energy, so the
           * estimate is biased fast relative to the closed-form AIR-node constant. Extrapolations fit
           * their asymptote directly and yield 0.896-0.921. These ranges add a small explicit margin
           * around those observed envelopes while remaining tight enough to catch plant drift.
           */
          expect(ratio).toBeGreaterThan(point.extrapolated ? 0.8 : 0.6)
          expect(ratio).toBeLessThan(1.05)
        }
      }
      // More airflow must cool the chamber at a fixed heat.
      const hottest = [...curves].sort((a, b) => a.fanLevel - b.fanLevel)
      const lowFan = hottest[0].points.find((point) => point.heat === 1)?.steadyStateC
      const highFan = hottest[hottest.length - 1].points.find((point) => point.heat === 1)?.steadyStateC
      expect(lowFan).toBeGreaterThan(highFan ?? 0)
      // The passive tail is present, which is what makes the loss coefficient derivable at all.
      expect(analysis.passiveTauSec).toBeDefined()
    }
  })

  it('keeps realistic capped passes with both measured and extrapolated evidence', () => {
    const qualityCounts = dataset.calibrationRuns
      .filter((run) => run.form === 'grid')
      .map((run) => {
        const points = curveFamily(analyzeCalibrationRun(run)).flatMap((curve) => curve.points)
        return { total: points.length, extrapolated: points.filter((point) => point.extrapolated).length }
      })
    expect(qualityCounts.some(({ total, extrapolated }) => extrapolated > 0 && extrapolated < total)).toBe(true)
    expect(qualityCounts.every(({ total, extrapolated }) => extrapolated > 0 && extrapolated < total)).toBe(true)
  })

  it('drifts by a couple of degrees between the two passes, which is what a comparison is for', () => {
    const [newest, oldest] = dataset.calibrationRuns
      .filter((run) => run.form === 'grid')
      .map((run) => curveFamily(analyzeCalibrationRun(run)))
    const delta = comparePasses(newest, oldest)
    expect(delta.points.length).toBeGreaterThanOrEqual(10)
    expect(delta.onlyCurrent).toBe(0)
    expect(delta.onlyPrevious).toBe(0)
    expect(Math.abs(delta.meanDeltaC ?? 0)).toBeGreaterThan(1.5)
    expect(Math.abs(delta.meanDeltaC ?? 0)).toBeLessThan(5)
  })

  /**
   * The demo has a real applied model, and it comes from the loaded characterization roast rather
   * than from a chamber pass. A diagnostic pass measures the empty CHAMBER; the model describes a
   * BEAN load, and the two are not on the same scale. Fitting a loaded roast is the path that
   * closes that gap, so the demo is what a healthy system looks like once it has been walked.
   */
  /**
   * Several roasts carry a recording now, not one.
   *
   * A picker with a single option cannot be reviewed: nothing about labels, badges or pooling is
   * visible until there is a list. Five loaded recordings, four of them linked to roasts that were
   * already in the archive, is what makes the Loaded roasts region a choice.
   */
  it('links a recording to several roasts, so the fit picker is a real list', () => {
    const loaded = dataset.calibrationRuns.filter((run) => (run.massG ?? 0) > 0)
    expect(loaded.length).toBeGreaterThanOrEqual(5)
    const linked = loaded.filter((run) => run.roastRunId !== undefined)
    expect(linked.length).toBeGreaterThanOrEqual(4)
    // Every link points at a roast that is really in the archive, with a weight a fit can use.
    const runsById = new Map(dataset.runs.map((run) => [run.id, run]))
    for (const run of linked) {
      const roast = runsById.get(run.roastRunId!)
      expect(roast, `${run.id} names a roast that is not in the dataset`).toBeDefined()
      expect(roast!.measurements?.startingMassG).toBe(run.massG)
    }
    // And they do not all say the same thing about identifiability, which is the point of a list.
    const grades = new Set(loaded.map((run) => excitationGrade(logExcitation(run.samples))))
    expect(grades.size).toBeGreaterThan(1)
  })

  it('applies a model fitted from a LOADED roast, not from a chamber pass', () => {
    const loaded = dataset.calibrationRuns.filter((run) => (run.massG ?? 0) > 0)
    expect(dataset.appliedCalibration.thermalSourceRunId).toBe(loaded[0].id)

    const fitted = dataset.calibrationSnapshots.find((snapshot) => snapshot.runIds.includes(loaded[0].id))!
    expect(fitted.name).toBe('Loaded characterization roast')
    expect(patchMatches(fitted.patch, dataset.appliedCalibration as Record<string, number | undefined>)).toBe(true)
    // And it is genuinely different from the shipped estimate, so the fit found something.
    expect(patchMatches(fitted.patch, defaultCalibration as unknown as Record<string, number | undefined>)).toBe(false)
  })

  it('reads as a healthy system: the applied model tracks the roast it was fitted from', () => {
    const applied = { ...defaultCalibration, ...dataset.appliedCalibration } as typeof defaultCalibration
    const loaded = dataset.calibrationRuns.find((run) => (run.massG ?? 0) > 0)!
    const fit = replayCalibrationRun(loaded, applied)!
    expect(fit.rmsC).toBeLessThan(10)
  })

  /** The chamber passes stay, and their large residual stays visible: it teaches the difference. */
  it('keeps the chamber passes, whose residual against a bean model is real', () => {
    const applied = { ...defaultCalibration, ...dataset.appliedCalibration } as typeof defaultCalibration
    const chamber = dataset.calibrationRuns.filter((run) => (run.massG ?? 0) === 0)
    expect(chamber).toHaveLength(2)
    for (const run of chamber) {
      expect(replayCalibrationRun(run, applied)!.rmsC).toBeGreaterThan(20)
    }
  })
})
