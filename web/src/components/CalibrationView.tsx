import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Download,
  GitCompareArrows,
  Grid3x3,
  ListOrdered,
  Play,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks'
import {
  type AppliedCoefficientSet,
  type CalibrationStartParams,
  calibrationParamError,
  type HttpControllerClient,
  implausibleCoefficient,
  programSteps,
  THERMAL_CSV_BUSY,
} from '../controller/client'
import { defaultCalibration } from '../data/calibration'
import {
  type DecodedCrkRoastPlan,
  decodeCrkCalibrationProgram,
  decodeCrkRoastPlan,
  decodeCrkThermalSamples,
  validateCrkRecording,
} from '../data/crkValidator'
import { downloadFile } from '../data/download'
import { effectiveLevels, isFloored } from '../domain/actuatorFloors'
import { calibrationCompatibility, mixedCalibrationSources } from '../domain/calibrationCompatibility'
import {
  buildCalibrationDashboard,
  type CalibrationDashboardLoad,
  workingPreviewLoads,
} from '../domain/calibrationDashboard'
import { CALIBRATION_GUIDE, CALIBRATION_HELP, type CalibrationHelpKey } from '../domain/calibrationHelp'
import { ingestBannerText, ingestReducer, initialIngestState } from '../domain/calibrationIngest'
import {
  CALIBRATION_LIMITS,
  calibrationStartBlockedReason,
  DEFAULT_GRID_FANS,
  DEFAULT_GRID_HEATS,
  DEFAULT_MAX_STEP_SECONDS,
  DEFAULT_MIN_STEP_SECONDS,
  DEFAULT_SETTLE_BAND_C,
  DEFAULT_SETTLE_SECONDS,
  formatStepPairs,
  gridSummary,
  programMaximumSec,
  resolveProgramForm,
} from '../domain/calibrationProgram'
import { calibrationProvenance, THERMAL_FIELDS } from '../domain/calibrationProvenance'
import {
  baselinePinnedAirflow,
  combineSegmentedCalibration,
  estimateAmbientC,
  fitCoefficientsFromLog,
  fitSourceFromRun,
  isLoadedRun,
  logExcitation,
  unresolvedUnstableFields,
} from '../domain/coefficientFit'
import { formatLocalDateTime } from '../domain/dateTime'
import {
  type DeviceArchive,
  type DeviceLogEntry,
  deviceArchive,
  COEFFICIENT_LABELS as SHARED_COEFFICIENT_LABELS,
  sanitizeFitId,
} from '../domain/deviceLogs'
import { excitationGrade, fitFingerprint, fitInputFromRun, fitReadiness, fitStaleness } from '../domain/fitInputs'
import { newId } from '../domain/ids'
import { baselinePassGrade, tauByFan, tauObservations } from '../domain/meshMetrics'
import { modelFitVerdict, replayCalibrationRun, replayThermalTrace } from '../domain/modelFit'
import { calibrationRecordingKey, recordedOnFromRoaster, recordingKey, sameRecording } from '../domain/provenance'
import { completeEmptyChamberSnapshot, fieldList } from '../domain/provisionalCalibration'
import { formatMetric } from '../domain/roastMetrics'
import {
  analyzeCalibrationRun,
  baselineMapFromCurves,
  buildBaselineMap,
  comparePasses,
  curveFamily,
  curvesFromBaselineMap,
  dedupeRecordings,
  parseThermalCsv,
  patchMatches,
  primaryGain,
  runToCsv,
  type StagedField,
  stageCalibration,
  suspectFanLevels,
} from '../domain/thermalLog'
import type {
  ArchivedCalibrationProgram,
  CalibrationCurve,
  CalibrationForm,
  CalibrationProgramStatus,
  CalibrationRun,
  CalibrationSettings,
  CalibrationSnapshot,
  ControllerStatus,
  RoastRun,
  ThermalCoefficientField,
  ThermalCoefficientPatch,
  ThermalSample,
} from '../domain/types'
import { CalibrationDashboard, type CalibrationDashboardData } from './CalibrationDashboard'
import { BaselineMapGrid, PassDeltaTable } from './CalibrationMesh'
import { FieldHelp, HelpGlossary, TermLabel } from './Help'
import { sourceMatches } from './RoasterSource'
import { StopIcon } from './StopIcon'
import { TextArea, TextField } from './TextField'
import { useChartWidth } from './useChartWidth'

interface CalibrationViewProps {
  /** App-owned singleton so calibration always talks to the selected roaster target. */
  controller: HttpControllerClient
  /** Completed History roast to bring into the ordinary loaded-roast evidence workflow. */
  initialLoadedRoastId?: string
  onInitialLoadedRoastConsumed?: () => void
  status: ControllerStatus
  nowMs: number
  calibrationBlockedReason?: string
  applyCalibrationBlockedReason?: string
  runs: CalibrationRun[]
  /** Shared device-library write gate: active recording tails are read-only. */
  catalogMutationBlockedReason?: string
  snapshots: CalibrationSnapshot[]
  appliedPatch: ThermalCoefficientPatch
  /** The live coefficients, so each pass can be scored against what is actually applied. */
  appliedCalibration: CalibrationSettings
  /** Roasts, so a loaded log can carry its bean lot and its expansion covariates into a fit. */
  roasts: RoastRun[]
  onSaveRun: (run: CalibrationRun) => Promise<void>
  onDeleteRun: (id: string) => Promise<void>
  onSaveSnapshot: (snapshot: CalibrationSnapshot) => Promise<void>
  onDeleteSnapshot: (id: string) => Promise<void>
  /** Fetch the completed device-owned calibration recording, using its exact archive id when known. */
  onFetchCalibrationRecording: (logId?: string) => Promise<string>
  /**
   * Adopt a coefficient set as the one this browser plans with.
   *
   * Called only after the ROASTER has accepted the same set, so the browser can never record an
   * apply the machine refused. See `apply` below for the whole failure story.
   */
  onApply: (
    patch: Partial<Record<StagedField, number>>,
    source: { runId?: string; capturedAt?: string; deviceId: string; modelId: string },
  ) => Promise<{ ok: boolean; message?: string }>
}

const tauFromSavedCurves = (curves: CalibrationCurve[], runId: string, capturedAt: string) =>
  tauByFan(
    curves.flatMap((curve) =>
      curve.points.flatMap((point, stepIndex) =>
        point.tauSec === undefined
          ? []
          : [
              {
                runId,
                capturedAt,
                stepIndex,
                fan: curve.fanLevel,
                heat: point.heat,
                tauSec: point.tauSec,
                r2: point.r2,
                direction: 'rising' as const,
                quality: point.quality ?? (point.extrapolated ? 'extrapolated' : 'measured'),
                kind: 'step' as const,
                source: `saved calibration, fan ${curve.fanLevel.toFixed(1)} heat ${point.heat.toFixed(1)}`,
              },
            ],
      ),
    ),
  )

const calibrationDashboardView = (
  dashboard: ReturnType<typeof buildCalibrationDashboard>,
  loads: readonly CalibrationDashboardLoad[] = ['empty', '100g', '250g'],
): CalibrationDashboardData => {
  const panels: CalibrationDashboardData['panels'] = []
  const titles = { empty: 'Empty chamber', '100g': '100 g bean load', '250g': '250 g bean load' } as const
  for (const direction of ['heating', 'cooling'] as const) {
    for (const load of loads) {
      const heatmap = dashboard.heatmaps[direction][load]
      panels.push({
        id: `${direction}-${load}`,
        title: titles[load],
        direction,
        basisLabel: load === 'empty' ? 'Baseline evidence' : 'Applied-model estimate',
        cells: heatmap.cells.flat().map((cell) => ({
          fan: cell.fan,
          heat: cell.heat,
          averageSec: cell.average,
          count: cell.count,
          minSec: cell.min,
          maxSec: cell.max,
          stdDevSec: cell.stddev,
          basis: cell.basis,
          detail: cell.detail,
        })),
      })
    }
  }
  return { panels }
}

function SavedCalibrationMaps({
  snapshot,
  runsById,
  appliedCalibration,
}: {
  snapshot: CalibrationSnapshot
  runsById: Map<string, CalibrationRun>
  appliedCalibration: CalibrationSettings
}) {
  const baselineRuns = useMemo(
    () =>
      snapshot.runIds.flatMap((id) => {
        const run = runsById.get(id)
        return run && !isLoadedRun(run) ? [run] : []
      }),
    [runsById, snapshot.runIds],
  )
  const map = useMemo(() => {
    const recorded = buildBaselineMap(baselineRuns)
    return Object.keys(recorded.cells).length > 0
      ? recorded
      : baselineMapFromCurves(snapshot.curves, {
          runId: snapshot.id,
          capturedAt: snapshot.createdAt,
          runCount: baselineRuns.length,
        })
  }, [baselineRuns, snapshot.createdAt, snapshot.curves, snapshot.id])
  const byFan = useMemo(() => {
    const recorded = tauByFan(tauObservations(baselineRuns))
    return recorded.length > 0 ? recorded : tauFromSavedCurves(snapshot.curves, snapshot.id, snapshot.createdAt)
  }, [baselineRuns, snapshot.createdAt, snapshot.curves, snapshot.id])
  const calibration = useMemo(
    () => ({ ...appliedCalibration, ...snapshot.patch }),
    [appliedCalibration, snapshot.patch],
  )
  const dashboard = useMemo(
    () =>
      buildCalibrationDashboard({
        baselineMap: map,
        emptyTauByFan: byFan,
        calibration,
        ambientC: snapshot.ambientC ?? baselineRuns.at(-1)?.ambientC ?? 24.5,
        loads: ['empty'],
      }),
    [baselineRuns, byFan, calibration, map, snapshot.ambientC],
  )
  const view = useMemo(() => calibrationDashboardView(dashboard, ['empty']), [dashboard])
  return (
    <div className="saved-calibration-maps">
      {Object.keys(map.cells).length > 0 && <BaselineMapGrid map={map} />}
      <CalibrationDashboard dashboard={view} compact />
    </div>
  )
}

/*
 * ============================================================================================
 * THE CALIBRATE PAGE: WHY IT IS SHAPED LIKE THIS
 * ============================================================================================
 *
 * A calibration page easily sprawls into sections and subsections, and a bare table of settled
 * temperatures does not explain itself. The page ORDER is fixed - explainers, current calibration,
 * build a calibration, record a baseline, saved calibrations. Everything below is about STRUCTURE
 * inside and between those regions.
 *
 * ---------------------------------------------------------------------------------------------
 * 1. THE PAGE TELLS ONE STORY: what does the machine settle at, and how long do moves take.
 * ---------------------------------------------------------------------------------------------
 * Those are the only two questions a thermal calibration answers, and the page is literally two
 * regions saying so, in those words, under Current calibration. Everything else on the screen is
 * either the evidence behind those two answers (Build a calibration), the tool that produces more
 * evidence (Record a baseline), or the record of previous answers (Saved calibrations).
 *
 * ---------------------------------------------------------------------------------------------
 * 2. ONE REPRESENTATION PER FACT.
 * ---------------------------------------------------------------------------------------------
 * The settled surface is drawn once. Two artifacts claiming to be the same fact - say a mesh line
 * chart above a shaded fan-by-heat table, one built from the applied calibration's stored curves and
 * the other from the passes currently ticked - can disagree on screen. The TABLE is the single
 * primary form, because the question is a lookup ("what does fan 4 heat 10 settle at?") and because
 * a table shows its own GAPS, which a line chart hides. Pass detail shows the recorded
 * temperature/Fan/Heat timeline, which is where a curve is the right form.
 *
 * Each cell holds ONE number. Settled temperature and settling seconds are two different facts, and
 * they live in the two different regions that are about them.
 *
 * ---------------------------------------------------------------------------------------------
 * 3. NO TRANSITION CALCULATOR.
 * ---------------------------------------------------------------------------------------------
 * A calculator asks the reader to supply the question, and then answers it with a number that is
 * mostly inference. The map already knows every setting it covers, so the answer is a LIST: one row
 * per destination, reading (fan a, heat b) -> (fan c, heat d) = seconds. Most rows are not
 * predictions at all - every serpentine step of a baseline pass is a move the chamber really made,
 * timed by that step's own fitted time constant. The user-facing view is bounded to one measured response summary per fan; exact steps remain in pass detail.
 *
 * Time constants by fan live in that readout rather than in a separate chart. Which fan a time
 * constant was measured at, how many steps stand behind it, and the weakest R2 are one quiet line per
 * row, in seconds, which is the unit the question is asked in.
 *
 * ---------------------------------------------------------------------------------------------
 * 4. REGIONS, NOT BOXES.
 * ---------------------------------------------------------------------------------------------
 * Sprawl is structural: a bordered panel containing bordered metric blocks containing bordered
 * tables reads as clutter however good each box is. There is exactly ONE sub-structural device on
 * this page - a hairline rule, a heading, and one line of prose (`.calibration-region`) - used
 * identically in every panel. Nothing nests boxes; the page opens with one collapsed guide plus the
 * three-item page map.
 *
 * =============================================================================================
 * ONE PANEL WHERE A CALIBRATION IS BUILT
 * =============================================================================================
 *
 * ---------------------------------------------------------------------------------------------
 * 5. BUILD A CALIBRATION: CHOOSING THE DATA AND SEEING THE RESULT ARE ONE PLACE.
 * ---------------------------------------------------------------------------------------------
 * A panel that holds a preview of what the ticks add up to is not a place where data is chosen; it
 * is a place where a calibration is BUILT, and its name says so. Inside it, half the answer
 * appearing by itself while the other half waits behind a Fit button would be a seam with no rule
 * behind it that a reader could learn.
 *
 * The rule is one sentence: EVERY READING APPEARS BY ITSELF; THE BUTTON ONLY MAKES A RECORD. Ticking
 * a box previews the whole thing - the settled surface AND the moves table, the two questions this
 * page answers, drawn by the same two components that draw the applied ones at the top - and the
 * single primary action is Save and apply: the saved record and the device application are one continuous, explicit workflow.
 *
 * Both readouts depend on the selected passes, so both are previewed.
 *
 * ---------------------------------------------------------------------------------------------
 * 6. RECORDING DETAIL OPENS IN THE ROW THAT CHOOSES IT.
 * ---------------------------------------------------------------------------------------------
 * A separate panel to inspect one recording, below a panel of checkboxes about the same recordings,
 * would be two lists of the same objects, so choosing would mean scrolling to a second copy of the
 * row being decided about. The tick row EXPANDS instead - a labelled disclosure, not a hidden hover
 * target - and the detail opens inside it: the recorded temperature and controls, the step results,
 * the analysis, the notes, Download CSV, Delete. Nothing is hidden, a recording in the place where
 * you decide about it.
 *
 * ---------------------------------------------------------------------------------------------
 * 7. TWO IMPORTS, ONE SHAPE - AND A DESTINATION STATED BEFORE THE CLICK.
 * ---------------------------------------------------------------------------------------------
 * Loaded-roast import and empty-chamber import follow the same UI: `.recording-picker`, a select and
 * one button, twice.
 *
 * The button says BRING IN, and the line under it says where the chosen recording lands before it is
 * pressed - which is knowable, because the roaster records what it was doing. A diagnostic pass
 * lands in Empty-chamber baselines; a roast recording that matches a roast already in the archive
 * lands in Loaded roasts, filed against it. Bringing the same recording in twice is impossible
 * rather than discouraged: see `sourceLogId`.
 *
 * ---------------------------------------------------------------------------------------------
 * 8. A QUESTION IS ONLY ASKED WHEN IT IS OPEN.
 * ---------------------------------------------------------------------------------------------
 * An expanded recording does not offer a dropdown to change what it is, because a dropdown is a
 * question. Two facts are kept apart: WHAT KIND of recording this is, and WHICH ROAST it came from. A
 * recording with a batch weight is a loaded roast and that is not in doubt; a recording from a
 * diagnostic pass is an empty chamber and that is not in doubt either. Each states its kind, with a
 * quiet Change for the correction that is occasionally needed, and only a genuinely unclassified
 * recording - a manual run, a file from somewhere else - is asked the question.
 */

const HEIGHT = 420
const plot = { left: 68, right: 74, top: 40, bottom: 352 }
const TEMPERATURE_MAX_C = 400

const pathFor = (points: Array<{ x: number; y: number }>) =>
  points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
const number = (value: number | undefined, places = 1) => (value === undefined ? '--' : value.toFixed(places))
interface RecordingProgramFields {
  form: CalibrationForm
  steps: CalibrationRun['steps']
  maxStepSeconds: number
  minStepSeconds: number
  settleSeconds: number
  settleBandC: number
}

/** Exact program values committed by the roaster at calibration start. */
export const archivedCalibrationProgramFields = (program: ArchivedCalibrationProgram): RecordingProgramFields => ({
  form: 'steps',
  steps: program.steps.map(({ fan, heat }) => ({ fan, heat })),
  maxStepSeconds: program.maxStepSeconds,
  minStepSeconds: program.minStepSeconds,
  settleSeconds: program.settleSeconds,
  settleBandC: program.settleBandC,
})

/**
 * A roast is not a diagnostic settle program. Its calibration evidence is therefore described by
 * the maximal actuator holds the roaster actually recorded, after codec-2 has proven which initial
 * plan and accepted journal produced them. Nothing here can be inherited from the open Calibrate
 * editor: that browser draft may have changed after the device recorded the roast.
 */
const actuatorProgramFields = (samples: ThermalSample[]): RecordingProgramFields => {
  const segments: Array<{ fan: number; heat: number; firstMs: number; lastMs: number }> = []
  for (const sample of samples) {
    const current = segments.at(-1)
    if (
      current &&
      Math.abs(current.fan - sample.effectiveFan) <= 0.05 &&
      Math.abs(current.heat - sample.effectiveHeat) <= 0.05
    )
      current.lastMs = sample.tMs
    else
      segments.push({ fan: sample.effectiveFan, heat: sample.effectiveHeat, firstMs: sample.tMs, lastMs: sample.tMs })
  }
  const durations = segments.map((segment) => Math.max(1, Math.round((segment.lastMs - segment.firstMs) / 1000)))
  // A journey controller may trim Heat each second. CalibrationRun.steps is only a compact visual
  // descriptor for loaded roasts; the fitter consumes every sample and the roast/archive retains
  // the full codec-2 plan and journal. Preserve the endpoints and evenly summarize the middle so a
  // high-churn roast cannot inflate the device's calibration document by thousands of objects.
  const maximumSummarySteps = 48
  const summarized =
    segments.length <= maximumSummarySteps
      ? segments
      : Array.from(
          { length: maximumSummarySteps },
          (_, index) => segments[Math.round((index * (segments.length - 1)) / (maximumSummarySteps - 1))],
        )
  return {
    form: 'steps',
    steps: summarized.map((segment) => ({ fan: segment.fan, heat: segment.heat })),
    maxStepSeconds: Math.max(...durations, 1),
    minStepSeconds: durations.length > 0 ? Math.max(1, Math.min(...durations)) : 1,
    // Roasts do not use the calibration settle gate; zero states that instead of inventing the
    // values currently visible in a browser editor.
    settleSeconds: 0,
    settleBandC: 0,
  }
}

export const loadedRoastProgramFields = (
  samples: ThermalSample[],
  provenance: DecodedCrkRoastPlan,
): RecordingProgramFields => {
  // The decoder already rejected malformed journals. Touch both decoded pieces here so callers
  // cannot accidentally substitute a CSV-only assertion for the codec-2 provenance proof.
  if (!provenance.initialPlan || !Array.isArray(provenance.planJournal)) {
    throw new Error('The roast recording has no supported device plan')
  }
  return actuatorProgramFields(samples)
}

/**
 * One field, laid out the same way everywhere: label above, control below, one quiet line of help
 * under that. The width class is chosen by what the input holds - a comma list needs room, a
 * bounded number does not - rather than by where the field happens to sit in the grid.
 */
function Field({
  label,
  term,
  span,
  children,
}: {
  label: string
  term: CalibrationHelpKey
  span?: 'wide' | 'narrow'
  children: ComponentChildren
}) {
  return (
    <label className={span ? `form-field ${span}` : 'form-field'}>
      <span className="form-field-label">{label}</span>
      {children}
      <FieldHelp term={term} />
    </label>
  )
}

interface StepBoundary {
  index: number
  startSec: number
  fanLevel: number
  heatLevel: number
}

function TraceChart({
  run,
  boundaries,
  limitC,
  prediction,
}: {
  run: CalibrationRun
  boundaries: StepBoundary[]
  limitC?: number
  prediction?: ThermalSample[]
}) {
  const WIDTH = useChartWidth()
  const xMax = WIDTH - plot.right
  const duration = Math.max((run.samples.at(-1)?.tMs ?? 0) / 1000, 60)
  const x = (seconds: number) => plot.left + (seconds / duration) * (xMax - plot.left)
  const tempY = (temperature: number) =>
    plot.bottom - (Math.max(0, Math.min(TEMPERATURE_MAX_C, temperature)) / TEMPERATURE_MAX_C) * (plot.bottom - plot.top)
  const actuatorY = (value: number) => plot.bottom - (Math.max(0, Math.min(10, value)) / 10) * (plot.bottom - plot.top)

  const traces = useMemo(
    () => ({
      temperature: pathFor(
        run.samples
          .filter((sample) => sample.thermocoupleC !== undefined)
          .map((sample) => ({ x: x(sample.tMs / 1000), y: tempY(sample.thermocoupleC ?? 0) })),
      ),
      prediction: pathFor(
        (prediction ?? [])
          .filter((sample) => sample.thermocoupleC !== undefined)
          .map((sample) => ({ x: x(sample.tMs / 1000), y: tempY(sample.thermocoupleC ?? 0) })),
      ),
      fan: pathFor(run.samples.map((sample) => ({ x: x(sample.tMs / 1000), y: actuatorY(sample.effectiveFan) }))),
      heat: pathFor(run.samples.map((sample) => ({ x: x(sample.tMs / 1000), y: actuatorY(sample.effectiveHeat) }))),
      // The width is a dependency: every one of these paths is built through `x`, which scales with it.
    }),
    [WIDTH, duration, prediction, run],
  )

  const timeTicks = Array.from({ length: 6 }, (_, index) => (duration / 5) * index)
  const temperatureTicks = [0, 100, 200, 300, 400]
  const actuatorTicks = [0, 2, 4, 6, 8, 10]

  return (
    <div className="chart-shell" role="figure" aria-label="Run recording graph">
      <svg
        className="live-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Logged temperature with effective Fan and Heat over the calibration program"
      >
        <rect className="chart-bg" width={WIDTH} height={HEIGHT} />
        <text className="axis-title" x={plot.left} y="24">
          Logged temperature (°C)
        </text>
        <text className="axis-title actuator-title" x={xMax} y="24" text-anchor="end">
          Fan / Heat (0-10)
        </text>
        {temperatureTicks.map((tick) => (
          <g key={`temp-${tick}`}>
            <line className="grid-line" x1={plot.left} x2={xMax} y1={tempY(tick)} y2={tempY(tick)} />
            <text className="axis-label" x={plot.left - 10} y={tempY(tick) + 4} text-anchor="end">
              {tick}
            </text>
          </g>
        ))}
        {actuatorTicks.map((tick) => (
          <text className="axis-label actuator-axis" key={`act-${tick}`} x={xMax + 11} y={actuatorY(tick) + 4}>
            {tick}
          </text>
        ))}
        {timeTicks.map((tick) => (
          <g key={`time-${tick}`}>
            <line className="grid-line vertical" x1={x(tick)} x2={x(tick)} y1={plot.top} y2={plot.bottom} />
            <text className="axis-label time-axis-label" x={x(tick)} y={HEIGHT - 28} text-anchor="middle">
              {clock(tick)}
            </text>
          </g>
        ))}
        {/* Only passes captured while the firmware still had a program ceiling carry this line. */}
        {limitC !== undefined && (
          <>
            <line className="mesh-limit" x1={plot.left} x2={xMax} y1={tempY(limitC)} y2={tempY(limitC)} />
            <text className="axis-label mesh-limit-label" x={xMax - 6} y={tempY(limitC) - 6} text-anchor="end">
              Advance bound {limitC.toFixed(0)} °C
            </text>
          </>
        )}
        {boundaries.map((boundary) => (
          <line
            key={`step-${boundary.index}`}
            className="event-line"
            x1={x(boundary.startSec)}
            x2={x(boundary.startSec)}
            y1={plot.top}
            y2={plot.bottom}
          >
            <title>{`Step ${boundary.index + 1}: fan ${boundary.fanLevel} heat ${boundary.heatLevel}`}</title>
          </line>
        ))}
        <path className="trace bt-trace" d={traces.temperature} />
        {prediction && <path className="trace target-trace" d={traces.prediction} />}
        <path className="trace fan-trace live-actuator-trace" d={traces.fan} />
        <path className="trace heat-trace live-actuator-trace" d={traces.heat} />
        <g className="trace-key" transform={`translate(${plot.left + 8} 56)`}>
          <text className="key bt-key" x="0">
            Measured
          </text>
          {prediction && (
            <text className="key target-key" x="86">
              Fitted model
            </text>
          )}
          <text className="key fan-key" x={prediction ? 202 : 86}>
            Fan
          </text>
          <text className="key heat-key" x={prediction ? 262 : 146}>
            Heat
          </text>
        </g>
      </svg>
    </div>
  )
}

/** What each applied coefficient is called on screen, so Calibrate names them as Settings does. */
const COEFFICIENT_LABELS: Record<string, string> = SHARED_COEFFICIENT_LABELS
const COEFFICIENT_UNITS: Record<string, string> = {
  heaterGainCPerMinAt10: '°C/min',
  fanCoolingCPerMinAt10: '°C/min',
  coolingFanCPerMinAt10: '°C/min',
  thermalLossPerMinPerC: '°C/min/°C',
}

/** How an empty-chamber pass is named wherever it is listed: kind, then when, then what it ran. */
const passLabel = (run: CalibrationRun) =>
  isLoadedRun(run)
    ? `Loaded roast - ${formatLocalDateTime(run.capturedAt)} - ${run.massG} g`
    : `Empty-chamber baseline - ${formatLocalDateTime(run.capturedAt)}`

const sampleSummary = (run: CalibrationRun) =>
  run.samples.length > 0
    ? `${run.samples.length} samples`
    : run.sourceLogId
      ? 'samples loading from the roaster recording'
      : 'no recorded samples'
const percent = (fraction: number) => `${Math.max(0, Math.min(100, fraction * 100)).toFixed(1)}%`

/**
 * ============================================================================================
 * THE CHIPS ON A ROW, IN WORDS RATHER THAN IN THE VOCABULARY OF THE FIT.
 * ============================================================================================
 *
 * The badges stay, but they must not be bare jargon chips. That takes two things, and they are
 * different problems.
 *
 * The WORDS. "excitation good" is the fitter's word for a property of the data, and nobody outside
 * a controls textbook has met it. What it actually means is whether the roast moved the fan and the
 * heat independently enough for their effects to be told apart, so that is what the chip says. Same
 * for "expansion 1.42x", which is beans swelling.
 *
 * The MISSING SENTENCE. A chip is three words and some facts need twenty, so each carries a title
 * with the whole explanation, and each list carries one legend line saying what its chips are for.
 * Both, rather than either: the legend is what a reader who never hovers gets, the title is what a
 * reader who wants the detail gets, and neither is the only route to the meaning.
 */
const EXCITATION_BADGE: Record<'good' | 'partial' | 'poor', string> = {
  good: 'heat and airflow separable',
  partial: 'heat and airflow partly separable',
  poor: 'heat and airflow not separable',
}

const BADGE_TITLES = {
  excitation:
    'A fit can only tell the element apart from the airflow when a roast held the heat and moved the fan, then held the fan and moved the heat. This is how much of that this one did.',
  expansion:
    'How much the beans swelled: roasted volume divided by green volume, from the roast record. Kept for a future model of heat absorption; nothing uses it yet.',
  missing:
    'Measurements the roast record does not carry yet. They are covariates rather than fit inputs, so a roast without them still fits.',
  usable:
    'Whether this recording can contribute to a fit at all. It needs a batch weight and enough readable samples to replay.',
  ticked:
    'Whether this roast is ticked for the calibration being built. Unticking leaves it out of the next one; removing takes it out of the set.',
  mapQuality:
    'What this pass is worth to the settled surface: good means every point held its plateau and both cooling tails were caught, poor means a fan row is physically impossible and never settled.',
  measured: 'Grid points that held their plateau long enough to be read straight off the recording.',
  extrapolated:
    'Grid points cut short, so their settled temperature comes from a curve fit rather than a plateau the chamber reached.',
  unreliable: 'Grid points cut short where the fit identified nothing either, so their number is only a lower bound.',
  tail: 'The fan-off decay after the pass, where nothing but ambient loss acts. Every coefficient is anchored to it, so a pass without one constrains no thermal loss.',
} as const

interface ReportedCalibrationProgress extends CalibrationProgramStatus {
  stepElapsedSec?: number
  settleState?: 'minimum_dwell' | 'waiting_for_transition' | 'checking' | 'settled' | 'capped'
  simulationSpeed?: number
  completedSteps?: Array<{
    index: number
    fan: number
    heat: number
    elapsedSec: number
    temperatureC?: number
    outcome: 'settled' | 'capped'
  }>
}

/** Controller-owned progress only: this browser does not invent clocks or missed events. */
function PassProgress({ program }: { program?: CalibrationProgramStatus }) {
  if (!program) return null
  const reported = program as ReportedCalibrationProgress
  const events = reported.completedSteps ?? []
  const count = program.stepCount ?? 0
  const hasRetainedPass =
    events.length > 0 || count > 0 || program.endReason !== undefined || (program.stepIndex ?? 0) > 0
  if (!program.active && !hasRetainedPass) return null
  const currentStep = (program.stepIndex ?? 0) + 1
  const completedCount =
    program.endReason === 'completed' && count > 0
      ? count
      : Math.min(count || Number.MAX_SAFE_INTEGER, Math.max(0, program.stepIndex ?? events.length))
  const progressCount = program.active ? currentStep : completedCount
  const endedLabel =
    program.endReason === 'completed' ? 'Completed' : program.endReason === 'stopped' ? 'Stopped' : 'Ended'
  const stateText =
    reported.settleState === 'minimum_dwell'
      ? 'Holding this setting for the minimum time'
      : reported.settleState === 'waiting_for_transition'
        ? 'Waiting for this setting to produce a measurable temperature change'
        : reported.settleState === 'checking'
          ? 'Checking whether the temperature is stable'
          : reported.settleState === 'settled'
            ? 'Temperature is settled'
            : reported.settleState === 'capped'
              ? 'Step reached its time limit without settling'
              : 'The roaster is measuring whether the temperature has settled'
  return (
    <div className={`pass-progress ${program.active ? 'running' : 'complete'}`} role="status">
      <div className="pass-progress-head">
        <span className="pass-progress-state">{program.active ? 'Running' : endedLabel}</span>
        <strong>
          {program.active
            ? `Step ${currentStep} of ${count || '?'}`
            : `${completedCount} of ${count || completedCount} steps completed`}
        </strong>
        {program.active && (
          <span>
            fan {number(program.currentFanLevel)} / heat {number(program.currentHeatLevel)}
          </span>
        )}
      </div>
      <div className="progress-track" role="presentation">
        <div className="progress-fill" style={{ width: count > 0 ? percent(progressCount / count) : '0%' }} />
      </div>
      <p className="program-summary">
        {program.active ? (
          <>
            {stateText}
            {reported?.stepElapsedSec === undefined ? '' : ` - ${clock(reported.stepElapsedSec)}`}
            {reported?.simulationSpeed && reported.simulationSpeed !== 1
              ? ` (development mock at ${reported.simulationSpeed}x speed)`
              : ''}
          </>
        ) : (
          `${endedLabel} pass summary retained while its device recording is reconciled.`
        )}
      </p>
      <div
        className="calibration-table-wrap pass-event-table"
        role="region"
        aria-label="Latest retained calibration steps"
      >
        <table className="diff-table">
          <caption>
            Latest {events.length} retained step{events.length === 1 ? '' : 's'}
          </caption>
          <thead>
            <tr>
              <th>Latest retained step</th>
              <th>Setting</th>
              <th>Time</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={4}>No steps completed yet.</td>
              </tr>
            ) : (
              events.map((event) => (
                <tr key={event.index}>
                  <td>{event.index + 1}</td>
                  <td>
                    fan {number(event.fan)} / heat {number(event.heat)}
                  </td>
                  <td>{clock(event.elapsedSec)}</td>
                  <td>
                    {event.outcome === 'settled' ? 'Settled' : 'Reached time limit'}
                    {event.temperatureC === undefined ? '' : ` at ${event.temperatureC.toFixed(1)} °C`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * HOW MUCH OF ITS PLAN A SAVED CALIBRATION ACTUALLY MEASURED.
 *
 * A baseline stopped after a few seconds still produces a saved calibration, and the list must show
 * how many points it actually tested. A pass declares its grid before it runs, so the plan is on the
 * record: `steps` is what was asked for, and the saved curves are what settled. Two of
 * twelve is a different object from twelve of twelve and the list has to say which it is holding.
 *
 * A calibration fitted from loaded roasts has no grid and no points - it is fitted against whole
 * roasts, not against a map - so it reports its roast count instead of a fraction of nothing.
 */
const snapshotCoverage = (snapshot: CalibrationSnapshot, runsById: Map<string, CalibrationRun>) => {
  const measured = snapshot.curves.reduce((count, curve) => count + curve.points.length, 0)
  const planned = snapshot.runIds.reduce((count, runId) => {
    const run = runsById.get(runId)
    return count + (run && !isLoadedRun(run) ? run.steps.length : 0)
  }, 0)
  return { measured, planned, roasts: snapshot.inputs?.length ?? 0, incomplete: planned > 0 && measured < planned }
}

// The two numbers and the range that identify a saved calibration at a glance in the list.
const snapshotTauSummary = (snapshot: CalibrationSnapshot) => {
  const taus = snapshot.curves.flatMap((curve) =>
    curve.points.flatMap((point) => (point.tauSec === undefined ? [] : [point.tauSec])),
  )
  if (taus.length === 0) return 'no fitted taus'
  const low = Math.min(...taus)
  const high = Math.max(...taus)
  return `${low.toFixed(0)}-${high.toFixed(0)} s over ${taus.length} point${taus.length === 1 ? '' : 's'}`
}

export function CalibrationView({
  controller,
  initialLoadedRoastId,
  onInitialLoadedRoastConsumed,
  status,
  nowMs,
  calibrationBlockedReason,
  applyCalibrationBlockedReason,
  catalogMutationBlockedReason,
  runs,
  snapshots,
  appliedPatch,
  appliedCalibration,
  roasts,
  onSaveRun,
  onDeleteRun,
  onSaveSnapshot,
  onDeleteSnapshot,
  onFetchCalibrationRecording,
  onApply,
}: CalibrationViewProps) {
  const [fansRaw, setFansRaw] = useState(DEFAULT_GRID_FANS.join(','))
  const [heatsRaw, setHeatsRaw] = useState(DEFAULT_GRID_HEATS.join(','))
  // Empty by default: the grid above is the program unless this advanced field says otherwise.
  const [stepsRaw, setStepsRaw] = useState('')
  const [maxStepSecondsRaw, setMaxStepSecondsRaw] = useState(String(DEFAULT_MAX_STEP_SECONDS))
  const [minStepSecondsRaw, setMinStepSecondsRaw] = useState(String(DEFAULT_MIN_STEP_SECONDS))
  const [settleSecondsRaw, setSettleSecondsRaw] = useState(String(DEFAULT_SETTLE_SECONDS))
  const [settleBandRaw, setSettleBandRaw] = useState(String(DEFAULT_SETTLE_BAND_C))
  const [busy, setBusy] = useState(false)
  // Stop has its own in-flight flag: the shared `busy` is also held by Start and by Apply, and an
  // unrelated operation must never be able to disable the Stop button.
  const [stopping, setStopping] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [commandError, setCommandError] = useState('')
  const [comparisonId, setComparisonId] = useState<string>()
  const [mode, setMode] = useState<CalibrationForm>('grid')
  const activeDeviceId = status.roaster?.deviceId
  /**
   * WHY THERE IS NO "FILE THE NEXT RECORDING AS" CONTROL.
   *
   * Such a control - a segmented toggle plus a roast picker, declaring in advance what the next
   * recording will be - reads as an empty section asking about a roast that does not exist yet.
   * Declaring the kind BEFORE the recording exists is a control whose effect cannot be seen, because
   * the thing it describes has not happened yet.
   *
   * Recordings arrive by themselves and are classified AFTERWARDS, on the recording's own row,
   * where saying "this was roast X" immediately renames the row, retitles its tag, takes it out of
   * the settled surface and puts it in the list of roasts a fit can answer to. Same question, asked
   * of an object that exists, with a consequence you can watch.
   */
  const [addBaselineLogId, setAddBaselineLogId] = useState('')
  const [addedBaselineIds, setAddedBaselineIds] = useState<string[]>(() =>
    runs.filter((run) => !isLoadedRun(run)).map((run) => run.id),
  )
  const [fitSelection, setFitSelection] = useState<string[]>([])
  /**
   * The loaded roasts the user has explicitly ADDED to the fit set.
   *
   * The region does not list every loaded recording the browser holds. Assume fifty to a hundred
   * roasts - an auto-listing is then a wall, and choosing from it is worse than choosing
   * from nothing. So the region starts empty and grows by one deliberate act each: add a roast, and
   * it is a row here until it is removed. Empty-chamber baselines also require a positive tick, so newly arrived device evidence never changes a working fit by itself.
   */
  const [addedLoadedIds, setAddedLoadedIds] = useState<string[]>([])
  const [addRoastLogId, setAddRoastLogId] = useState('')
  /**
   * Which recording's classification is being CORRECTED.
   *
   * A recording whose kind is known states it rather than asking about it, so the dropdown does not
   * exist until this says it does. Only one row is open at a time, so one id is the whole state.
   */
  /**
   * Which empty-chamber passes feed the surface. Exclusion rather than inclusion, so a pass
   * captured after this screen was opened is in the map without anybody having to tick it.
   */
  const [selectedBaselineIds, setSelectedBaselineIds] = useState<string[]>([])
  /*
   * Which of the ADDED loaded roasts are ticked for the next fit. There is no "untouched means
   * everything" default: the default is nothing, because the default set of added roasts is
   * nothing. That avoids an empty selection meaning two different things.
   */
  const [fitting, setFitting] = useState(false)
  /** Brief local acknowledgement; durable detail already lives in Current calibration and History. */
  const [fitConfirmation, setFitConfirmation] = useState<string>()
  /** Which saved calibration is mid-Apply, so its own row can say so rather than a page banner. */
  const [applyingId, setApplyingId] = useState<string>()
  const [archive, setArchive] = useState<DeviceArchive>(() => deviceArchive('unreachable'))
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [expandedSnapshotId, setExpandedSnapshotId] = useState<string>()
  const [expandedRunId, setExpandedRunId] = useState<string>()
  const [snapshotOverlayId, setSnapshotOverlayId] = useState<string>()
  const [ingest, dispatchIngest] = useReducer(ingestReducer, initialIngestState)
  const [tickMs, setTickMs] = useState(() => Date.now())
  // One fetch at a time, regardless of how many renders the poll and the clock produce.
  const fetching = useRef(false)
  // Automatic capture callbacks stay stable while status polling replaces the status object.
  const statusRef = useRef(status)
  statusRef.current = status

  // One program form. The explicit sequence overrides the grid when it has anything in it.
  const resolved = useMemo(
    () => resolveProgramForm({ fansRaw, heatsRaw, stepsRaw, mode }),
    [fansRaw, heatsRaw, mode, stepsRaw],
  )

  const shared = {
    maxStepSeconds: Number(maxStepSecondsRaw),
    minStepSeconds: Number(minStepSecondsRaw),
    settleSeconds: Number(settleSecondsRaw),
    settleBandC: Number(settleBandRaw),
  }
  const params: CalibrationStartParams = resolved.overridden
    ? { ...shared, steps: resolved.steps }
    : { ...shared, fans: resolved.fans, heats: resolved.heats }
  const paramError = resolved.error ?? calibrationParamError(params)
  const plannedSteps = useMemo(() => (paramError ? [] : programSteps(params)), [paramError, params])

  const program = status.calibration
  const sourceLogId = (program as (CalibrationProgramStatus & { logId?: string }) | undefined)?.logId
  const blocked = calibrationBlockedReason ?? calibrationStartBlockedReason({ status, nowMs, paramError, busy })
  const programSummary = paramError
    ? paramError
    : resolved.overridden
      ? `Explicit sequence ${formatStepPairs(resolved.steps)}: ${plannedSteps.length} step${plannedSteps.length === 1 ? '' : 's'}, up to ${clock(programMaximumSec(plannedSteps, shared.maxStepSeconds))}.`
      : `Grid ${gridSummary(resolved.fans, resolved.heats)}: ${plannedSteps.length} steps, up to ${clock(programMaximumSec(plannedSteps, shared.maxStepSeconds))}.`
  /**
   * Every recording this browser holds, newest first, each of them once.
   *
   * The dedupe is not decoration: a browser can hold byte-identical copies of one recording (for
   * example from a repeated import), and every one of them would otherwise be a row to scroll
   * past, a tick that changes nothing, and a second vote in the pooled surface. `dedupeRecordings`
   * collapses them and keeps the oldest copy, which is the one a saved calibration may already name.
   */
  const allSorted = useMemo(
    () => dedupeRecordings(runs).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
    [runs],
  )
  const activeSorted = useMemo(
    () => allSorted.filter((run) => sourceMatches(run.recordedOn, 'active', activeDeviceId)),
    [activeDeviceId, allSorted],
  )
  // Calibration is meaningful only for the permanently installed roaster. Foreign and mock
  // evidence keeps its provenance in History/backups, but never enters this machine's working fit.
  const sorted = activeSorted
  /**
   * The recording being analysed IS the recording whose row is open. There is no second selection
   * cursor, because there is no second place for the answer to appear: the detail renders inside
   * the row, so "selected" and "expanded" are the same fact, and tracking them apart would let the
   * page show one recording's analysis under another recording's row. Nothing open means nothing analysed, which costs nothing and says so.
   */
  const selected = sorted.find((run) => run.id === expandedRunId)
  const comparison = sorted.find((run) => run.id === comparisonId && run.id !== selected?.id)
  const analysis = useMemo(() => (selected ? analyzeCalibrationRun(selected) : undefined), [selected])
  const comparisonAnalysis = useMemo(() => (comparison ? analyzeCalibrationRun(comparison) : undefined), [comparison])
  const curves = useMemo(() => (analysis ? curveFamily(analysis) : []), [analysis])
  const passCurves = useMemo(
    () => (comparisonAnalysis ? curveFamily(comparisonAnalysis) : undefined),
    [comparisonAnalysis],
  )
  const comparisonCurves = passCurves
  const delta = useMemo(
    () => (comparisonCurves ? comparePasses(curves, comparisonCurves) : undefined),
    [comparisonCurves, curves],
  )
  const staging = useMemo(
    () => (analysis ? stageCalibration(analysis, comparisonAnalysis) : undefined),
    [analysis, comparisonAnalysis],
  )

  /**
   * ============================================================================================
   * TWO SURFACES, AND ONLY ONE OF THEM MOVES WHEN A BOX IS TICKED.
   * ============================================================================================
   *
   * Ticking boxes while still choosing data must not change the Current calibration section. That is
   * a data-flow rule, not a wording one: if Current calibration drew its surface from
   * `includedBaselineRuns` - the live tick state - a region titled with what IS APPLIED would show a
   * set nobody had applied and might never apply.
   *
   * So there are two, and they are computed from different things on purpose:
   *
   *   `map`        THE APPLIED SURFACE. Frozen with respect to the ticks. It is built from the
   *                passes behind the calibration that is applied right now, so it is the evidence
   *                under the coefficients at the top of the page and nothing else. No saved
   *                calibration matches the live coefficients - the shipped estimate, a hand-edit, or
   *                a set fitted from loaded roasts, which has no chamber passes behind it - and
   *                there IS no applied surface; the region says so and falls back to every stored
   *                baseline, still untouched by the ticks.
   *   `workingMap` THE WORKING SURFACE. What the ticks currently select. It appears in exactly one
   *                place, the Preview region, which is labelled as not applied.
   *
   * The preview carries the MOVES as well as the surface. Both readouts are built from the same set
   * of passes, so both are drawn from `workingMap` and `workingTauFans` by the same components the applied pair at the top of the page uses. One implementation of each fact, two scopes.
   */
  const baselineRuns = useMemo(() => sorted.filter((run) => !isLoadedRun(run)), [sorted])
  const activeBaselineRuns = useMemo(() => activeSorted.filter((run) => !isLoadedRun(run)), [activeSorted])
  const addedBaselineRuns = useMemo(
    () =>
      addedBaselineIds.flatMap((id) => {
        const run = baselineRuns.find((candidate) => candidate.id === id)
        return run ? [run] : []
      }),
    [addedBaselineIds, baselineRuns],
  )
  const includedBaselineRuns = useMemo(
    () => addedBaselineRuns.filter((run) => selectedBaselineIds.includes(run.id)),
    [addedBaselineRuns, selectedBaselineIds],
  )
  const fittedBaselineRuns = useMemo(
    () =>
      includedBaselineRuns.map((run) => ({
        ...run,
        ambientC: estimateAmbientC(run.samples, run.ambientC),
      })),
    [includedBaselineRuns],
  )
  const allOrderedSnapshots = useMemo(
    () => [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [snapshots],
  )
  const orderedSnapshots = useMemo(
    () => allOrderedSnapshots.filter((snapshot) => sourceMatches(snapshot.recordedOn, 'active', activeDeviceId)),
    [activeDeviceId, allOrderedSnapshots],
  )
  const appliedSnapshot = useMemo(
    () =>
      allOrderedSnapshots.find(
        (snapshot) =>
          sourceMatches(snapshot.recordedOn, 'active', activeDeviceId) &&
          Object.keys(snapshot.patch).length > 0 &&
          patchMatches(snapshot.patch, appliedPatch as Record<string, number | undefined>),
      ),
    [activeDeviceId, allOrderedSnapshots, appliedPatch],
  )
  const appliedBaselineRuns = useMemo(
    () => (appliedSnapshot ? activeBaselineRuns.filter((run) => appliedSnapshot.runIds.includes(run.id)) : []),
    [activeBaselineRuns, appliedSnapshot],
  )
  const surfaceRuns = useMemo(
    () => (appliedBaselineRuns.length > 0 ? appliedBaselineRuns : activeBaselineRuns),
    [activeBaselineRuns, appliedBaselineRuns],
  )
  const map = useMemo(() => {
    const recorded = buildBaselineMap(surfaceRuns)
    return Object.keys(recorded.cells).length > 0 || !appliedSnapshot?.curves.length
      ? recorded
      : baselineMapFromCurves(appliedSnapshot.curves, {
          runId: appliedSnapshot.id,
          capturedAt: appliedSnapshot.createdAt,
          runCount: appliedSnapshot.runIds.length,
        })
  }, [appliedSnapshot, surfaceRuns])
  const workingMap = useMemo(() => buildBaselineMap(fittedBaselineRuns), [fittedBaselineRuns])
  const workingPassContributions = useMemo(
    () =>
      includedBaselineRuns.map((run) => {
        const ownKeys = Object.keys(buildBaselineMap([run]).cells)
        const otherKeys = new Set(
          Object.keys(buildBaselineMap(includedBaselineRuns.filter((candidate) => candidate.id !== run.id)).cells),
        )
        const unique = ownKeys.filter((key) => !otherKeys.has(key)).length
        return { id: run.id, label: passLabel(run), points: ownKeys.length, unique, repeated: ownKeys.length - unique }
      }),
    [includedBaselineRuns],
  )
  const appliedPoints = Object.keys(map.cells).length
  const workingPoints = Object.keys(workingMap.cells).length
  const tauFans = useMemo(() => {
    const recorded = tauByFan(tauObservations(surfaceRuns))
    return recorded.length > 0 || !appliedSnapshot?.curves.length
      ? recorded
      : tauFromSavedCurves(appliedSnapshot.curves, appliedSnapshot.id, appliedSnapshot.createdAt)
  }, [appliedSnapshot, surfaceRuns])
  const workingTauFans = useMemo(() => tauByFan(tauObservations(fittedBaselineRuns)), [fittedBaselineRuns])
  const settlingDashboardAmbientC = surfaceRuns.at(-1)?.ambientC ?? 24.5
  /**
   * The applied dashboard may model bean-load maps exactly when the roaster reports a complete
   * applied coefficient set — device acceptance already enforced plausibility, so unlike the
   * working preview there is no separate fit gate to consult.
   */
  const appliedLoadedMapsReady = THERMAL_FIELDS.every((field) => Number.isFinite(status.appliedCoefficients?.[field]))
  const settlingDashboardLoads = useMemo<CalibrationDashboardLoad[]>(
    () => (appliedLoadedMapsReady ? ['empty', '100g', '250g'] : ['empty']),
    [appliedLoadedMapsReady],
  )
  const settlingDashboard = useMemo(
    () =>
      buildCalibrationDashboard({
        baselineMap: map,
        emptyTauByFan: tauFans,
        calibration: appliedCalibration,
        ambientC: settlingDashboardAmbientC,
        loads: settlingDashboardLoads,
      }),
    [appliedCalibration, map, settlingDashboardAmbientC, settlingDashboardLoads, tauFans],
  )
  const settlingDashboardView = useMemo(
    () => calibrationDashboardView(settlingDashboard, settlingDashboardLoads),
    [settlingDashboard, settlingDashboardLoads],
  )
  const baselineGrades = useMemo(
    () => new Map(baselineRuns.map((run) => [run.id, baselinePassGrade(analyzeCalibrationRun(run))])),
    [baselineRuns],
  )
  /**
   * The open recording's OWN settled surface, when it has one.
   *
   * `buildBaselineMap` is the same function the aggregate surface at the top of the page is built
   * from, given one pass instead of every included pass, and `BaselineMapGrid` is the same component
   * that draws it. Reusing both is the point: an expanded baseline shows the reader exactly what the
   * Current calibration table shows, scoped to the pass they opened, so there is nothing new to
   * learn to read and no second implementation that could round or shade a cell differently.
   *
   * A LOADED roast has no such surface - it measured a bean load moving, not the air settling - so
   * it gets none rather than an empty grid pretending it does.
   */
  const selectedMap = useMemo(
    () => (selected && !isLoadedRun(selected) ? buildBaselineMap([selected]) : undefined),
    [selected],
  )

  const provenance = useMemo(
    () =>
      calibrationProvenance(
        appliedCalibration,
        allOrderedSnapshots.filter((snapshot) => sourceMatches(snapshot.recordedOn, 'active', activeDeviceId)),
        defaultCalibration,
        status.appliedCoefficients,
      ),
    [activeDeviceId, allOrderedSnapshots, appliedCalibration, status.appliedCoefficients],
  )

  /**
   * ============================================================================================
   * WHERE A RECORDING WILL LAND, KNOWN BEFORE IT IS BROUGHT IN.
   * ============================================================================================
   *
   * Before importing, the user must be able to tell whether a recording will land as an empty
   * chamber or a loaded roast. A generic import that drops everything into the same unclassified
   * heap cannot say. But the roaster records WHAT IT WAS DOING alongside every recording, so the
   * answer exists and only has to be read:
   *
   *   a diagnostic pass (`calibration`, `proof`)   an empty chamber, by construction
   *   a roast whose roast is already in the archive  a loaded roast, filed against that roast
   *   anything else (a manual run, an unnamed roast) unclassified, and asked about on its own row
   *
   * The roast join is the roaster's log id, carried on the roast record by the archive reconciliation
   * that imported it. It is an identity match, not a guess from names or timestamps: either this
   * recording is the one that roast was recorded from, or it is not.
   */
  const destinationFor = (entry: DeviceLogEntry) => {
    const roast = roasts.find(
      (candidate) =>
        candidate.deviceRoast && sameRecording(candidate.deviceRoast.recordingOrigin, entry.recordingOrigin),
    )
    if (roast?.measurements?.startingMassG)
      return {
        roast,
        detail: `a roast recording, and ${roast.name} is already in your history - it lands in Loaded roasts, filed against that roast, with its ${roast.measurements.startingMassG} g batch`,
      }
    if (entry.mode === 'calibration' || entry.mode === 'proof')
      return {
        roast: undefined,
        detail:
          'a diagnostic pass, so the chamber was empty - it lands in Empty-chamber baselines and joins the settled surface',
      }
    return {
      roast: undefined,
      detail: `a ${entry.mode} run, and nothing on the roaster says what was in the chamber - it lands in Empty-chamber baselines, where you can name the roast if it was one`,
    }
  }

  /** Device-owned recordings already represented in the roaster-backed calibration document. */
  const importedLogKeys = useMemo(
    () =>
      new Set(
        allSorted.flatMap((run) => {
          const key = calibrationRecordingKey(run)
          return key ? [key] : []
        }),
      ),
    [allSorted],
  )
  const importableLogs = archive.logs.filter((entry) => !importedLogKeys.has(recordingKey(entry.recordingOrigin)))
  const baselineLogOptions = importableLogs.filter((entry) => entry.mode === 'calibration' || entry.mode === 'proof')
  const roastLogOptions = importableLogs.filter((entry) => destinationFor(entry).roast !== undefined)
  const addableBaselines = baselineRuns.filter((run) => !addedBaselineIds.includes(run.id))
  const chosenBaselineRun = baselineRuns.find((run) => `run:${run.id}` === addBaselineLogId)
  const chosenBaselineLog = baselineLogOptions.find((entry) => `log:${entry.id}` === addBaselineLogId)
  const chosenRoastLog = roastLogOptions.find((entry) => `log:${entry.id}` === addRoastLogId)

  const gain = analysis ? primaryGain(analysis) : undefined
  const boundaries = useMemo<StepBoundary[]>(
    () =>
      analysis
        ? analysis.steps.flatMap((step) =>
            step.startSec === undefined
              ? []
              : [{ index: step.index, startSec: step.startSec, fanLevel: step.fanLevel, heatLevel: step.heatLevel }],
          )
        : [],
    [analysis],
  )
  const ingestBanner = ingestBannerText(ingest, tickMs)
  const suspectFans = useMemo(() => suspectFanLevels(curves), [curves])
  // Warn before the pass, not after it: a requested combination the actuator will floor does not
  // measure the fan level that was asked for, and the map will report it where it actually ran.
  const flooredPlan = useMemo(() => plannedSteps.filter(isFloored), [plannedSteps])

  const downloadRunCsv = (run: CalibrationRun) =>
    downloadFile(`crackle-thermal-${run.capturedAt.slice(0, 19).replace(/[:T]/g, '')}.csv`, runToCsv(run), 'text/csv')

  const announce = (result: { ok: boolean; message?: string }, _success: string) => {
    // Routine acknowledgement is visible as controller-owned live progress. Only a refusal needs a
    // persistent message, and it belongs beside the controls that issued the command.
    setCommandError(result.ok ? '' : (result.message ?? 'The roaster rejected that command'))
  }

  const start = async () => {
    if (blocked) return
    // One deliberate click: there is no typed confirmation or arm endpoint, but a program still
    // drives the heater, so it must never start from a single stray tap.
    const summary = resolved.overridden ? formatStepPairs(resolved.steps) : gridSummary(resolved.fans, resolved.heats)
    if (
      !window.confirm(
        `Start a calibration pass now?\n\n${summary}\n${plannedSteps.length} steps, up to ${clock(programMaximumSec(plannedSteps, shared.maxStepSeconds))}.\n\nThe roaster will heat unattended until the pass finishes or you press Stop.`,
      )
    )
      return
    setBusy(true)
    announce(await controller.startCalibration(params), 'Calibration program accepted')
    setBusy(false)
  }

  const stop = async () => {
    setStopping(true)
    try {
      announce(await controller.stopCalibration(), 'Stop accepted; Fan and Heat are off')
    } finally {
      setStopping(false)
    }
  }

  // Throws rather than reporting, so the automatic path and the manual one can each decide what a
  // failure means: one retries with backoff, the other just says so.
  const store = useCallback(
    async (
      recording: string | ThermalSample[],
      source: string,
      origin: {
        sourceLogId?: string
        sourceMode?: string
        roastRunId?: string
        massG?: number
        capturedAt?: string
        thermocoupleOffsetC?: number
        recordedOn?: CalibrationRun['recordedOn']
        calibrationProgram?: ArchivedCalibrationProgram
        roastPlan?: DecodedCrkRoastPlan
      } = {},
    ) => {
      const currentStatus = statusRef.current
      if (!currentStatus.roaster)
        throw new Error(
          'This controller does not report a stable device and model identity, so its calibration evidence cannot be saved safely',
        )
      const samples = typeof recording === 'string' ? parseThermalCsv(recording) : recording
      if (samples.length === 0) throw new Error('That recording contained no readable samples')
      const { capturedAt, recordedOn, calibrationProgram, roastPlan, ...sourceFields } = origin
      const programFields =
        origin.sourceMode === 'calibration'
          ? calibrationProgram
            ? archivedCalibrationProgramFields(calibrationProgram)
            : (() => {
                throw new Error('The calibration recording does not contain its device-owned program')
              })()
          : origin.sourceMode === 'roast' || origin.sourceMode === 'manual'
            ? roastPlan
              ? loadedRoastProgramFields(samples, roastPlan)
              : (() => {
                  throw new Error('The roast recording does not contain its device-owned plan and accepted edits')
                })()
            : actuatorProgramFields(samples)
      const run: CalibrationRun = {
        id: newId('calibration'),
        capturedAt: capturedAt ?? new Date().toISOString(),
        recordedOn: recordedOn ?? recordedOnFromRoaster(currentStatus.roaster, currentStatus.firmwareVersion),

        ...sourceFields,
        ...programFields,
        ambientC: estimateAmbientC(samples),
        samples,
        notes: '',
        /*
         * A recording arrives UNCLASSIFIED, which for this app means empty-chamber: no linked roast
         * and therefore no batch mass. Saying which roast it belongs to is done on its own row below,
         * afterwards, where the answer changes something you can see. Nothing is guessed here, because
         * a guess about a batch weight is a guess that would silently reach a fit.
         */
      }
      // The row is published by App only after the roaster-backed calibration document acknowledges
      // this write. In particular, automatic capture must not say "saved" while a rejected write is
      // still hidden behind a fire-and-forget promise.
      await onSaveRun(run)
      // Arrival adds one immutable evidence row only. Selection and disclosure are working edits.
      if (origin.massG !== undefined)
        setAddedLoadedIds((current) => (current.includes(run.id) ? current : [...current, run.id]))
      else setAddedBaselineIds((current) => (current.includes(run.id) ? current : [...current, run.id]))
      return `${source}: saved ${samples.length} samples over ${clock((samples.at(-1)?.tMs ?? 0) / 1000)}. Added below, collapsed and not selected.`
    },
    [onSaveRun],
  )

  const fetchAutomaticRecording = useCallback(
    async (logId: string) => {
      // The compact archive contains both provenance and the thermal series. Decode it in the browser
      // so automatic capture makes one bounded device transfer rather than fetching a larger CSV too.
      const archiveBytes = await controller.fetchDeviceLogFile(logId)
      const decoded = decodeCrkCalibrationProgram(archiveBytes, logId)
      if (!decoded)
        throw new Error('The archived calibration recording does not contain the exact program the roaster ran')
      const recording = decodeCrkThermalSamples(archiveBytes, logId) ?? (await onFetchCalibrationRecording(logId))
      const startedEpoch = statusRef.current.calibration?.startedEpoch
      return store(recording, 'Program captured automatically', {
        sourceMode: 'calibration',
        sourceLogId: logId,
        capturedAt: startedEpoch ? new Date(startedEpoch * 1000).toISOString() : undefined,
        calibrationProgram: decoded.program,
        thermocoupleOffsetC: decoded.thermocoupleOffsetC,
      })
    },
    [controller, onFetchCalibrationRecording, store],
  )

  const failureMessage = (failure: unknown, fallback: string) => {
    if (failure instanceof Error) {
      const cancelled =
        failure.name === 'AbortError' ||
        failure.name === 'TimeoutError' ||
        /\b(?:aborted|abort|timed out|timeout)\b/i.test(failure.message)
      if (cancelled)
        return 'The roaster stopped responding while the recording was downloading. Reconnect, then try again.'
      return failure.message
    }
    return fallback
  }
  const report = (summary: string) => {
    setError('')
    setMessage(summary)
  }
  const reportFailure = (failure: unknown, fallback: string) => {
    setMessage('')
    setError(failureMessage(failure, fallback))
  }

  /**
   * The self-contained baseline. Every poll and a local one-second clock drive the ingest state
   * machine; the machine decides when the decay tail has been captured, and this effect is the only
   * place that turns that decision into a fetch. Zero clicks in the happy path beyond Start.
   */
  useEffect(() => {
    dispatchIngest({
      type: 'status',
      active: program?.active === true,
      logActive: status.thermalLog?.source === 'calibration' ? status.thermalLog.active : undefined,
      endReason: program?.endReason,
      nowMs,
    })
  }, [nowMs, program?.active, program?.endReason, status.thermalLog?.active])

  useEffect(() => {
    if (ingest.phase !== 'waiting-tail' && ingest.phase !== 'fetching') return
    const timer = window.setInterval(() => setTickMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ingest.phase])

  useEffect(() => {
    dispatchIngest({ type: 'tick', nowMs: tickMs })
  }, [tickMs])

  useEffect(() => {
    if (fetching.current || ingest.phase !== 'fetching' || tickMs < (ingest.nextAttemptMs ?? 0)) return
    fetching.current = true
    void (async () => {
      try {
        // The archive is the device-owned occurrence: CSV carries measurements and .crk carries
        // the exact accepted program. Saving one without the other would let a later browser draft
        // relabel immutable evidence, so this path fails closed if either half is unavailable.
        if (!sourceLogId) throw new Error('The roaster completed calibration without naming its archived recording')
        const summary = await fetchAutomaticRecording(sourceLogId)
        fetching.current = false
        dispatchIngest({ type: 'stored', message: summary })
      } catch (failure) {
        const message = failureMessage(failure, 'The recording could not be downloaded')
        // Clear the guard before publishing retry state, so the next eligible render can run it.
        fetching.current = false
        dispatchIngest({ type: 'failed', retryable: message === THERMAL_CSV_BUSY, message, nowMs: Date.now() })
      }
    })()
  }, [fetchAutomaticRecording, ingest.nextAttemptMs, ingest.phase, sourceLogId, tickMs])

  useEffect(() => {
    if (!fitConfirmation) return
    const timer = window.setTimeout(() => setFitConfirmation(undefined), 4000)
    return () => window.clearTimeout(timer)
  }, [fitConfirmation])

  useEffect(() => {
    if (ingest.phase !== 'stored') return
    const timer = window.setTimeout(() => dispatchIngest({ type: 'dismiss' }), 6000)
    return () => window.clearTimeout(timer)
  }, [ingest.phase])

  /**
   * The device log archive. Feature detection is the PRESENCE of `log_archive` in the status
   * document - firmware 2026-07-26.37 and older omit it, and no amount of probing `/api/logs` would
   * change that - so the route is only ever called once status has said the feature is there.
   */
  const archiveSupported = status.logArchive !== undefined
  const refreshArchive = async () => {
    if (!archiveSupported) {
      setArchive(deviceArchive('unsupported'))
      return
    }
    setArchiveBusy(true)
    try {
      const next = await controller.deviceLogs()
      setArchive(next)
      if (next.state !== 'available') {
        reportFailure(new Error(next.message), 'The recording list could not be refreshed')
      }
    } catch (failure) {
      reportFailure(failure, 'The recording list could not be refreshed')
    } finally {
      setArchiveBusy(false)
    }
  }
  useEffect(() => {
    void refreshArchive()
  }, [archiveSupported, status.logArchive?.count, status.logArchive?.usedBytes])

  /**
   * Bring one stored recording in from the roaster - once, ever.
   *
   * The guard is not a nicety. Without it a library fills with copies of one recording: a picker
   * that keeps offering a recording that is already here produces another row on every press. So
   * the roaster's own log id travels onto the stored copy, the picker never
   * lists an id this browser already holds, and this last check catches the rest - a stale listing, a
   * double press, two tabs. An already-held recording is not fetched again; its row is opened
   * instead, which is where the copy the user is asking for actually is.
   */
  const importDeviceLog = async (entry: DeviceLogEntry) => {
    const entryKey = recordingKey(entry.recordingOrigin)
    const held = allSorted.find((run) => calibrationRecordingKey(run) === entryKey)
    if (held) {
      setAddBaselineLogId('')
      if (isLoadedRun(held))
        setAddedLoadedIds((current) => (current.includes(held.id) ? current : [...current, held.id]))
      else setAddedBaselineIds((current) => (current.includes(held.id) ? current : [...current, held.id]))
      setAddRoastLogId('')
      report(`Recording ${entry.id} is already present below.`)
      return
    }
    setArchiveBusy(true)
    try {
      const landing = destinationFor(entry)
      // One compact archive supplies provenance and samples; CSV is a legacy fallback only.
      const archiveBytes = await controller.fetchDeviceLogFile(entry.id)
      const validation = validateCrkRecording(archiveBytes, entry.id)
      if (!validation.ok)
        throw new Error(`The roaster's archived recording failed ${validation.check}: ${validation.message}`)
      const calibrationProgram =
        entry.mode === 'calibration' ? decodeCrkCalibrationProgram(archiveBytes, entry.id) : undefined
      if (entry.mode === 'calibration' && !calibrationProgram) {
        throw new Error('That calibration recording does not contain the exact program the roaster ran')
      }
      const roastPlan =
        entry.mode === 'roast' || entry.mode === 'manual' ? decodeCrkRoastPlan(archiveBytes, entry.id) : undefined
      if ((entry.mode === 'roast' || entry.mode === 'manual') && !roastPlan) {
        throw new Error('That roast recording does not contain its device-owned plan and accepted edits')
      }
      const recording =
        decodeCrkThermalSamples(archiveBytes, entry.id) ?? (await controller.fetchDeviceLogCsv(entry.id))
      report(
        await store(recording, `Brought in recording ${entry.id}`, {
          sourceLogId: entry.recordingOrigin.logId,
          capturedAt: entry.startedAt,
          recordedOn: entry.recordedOn,
          sourceMode: entry.mode,
          roastRunId: landing.roast?.id,
          massG: landing.roast?.measurements?.startingMassG,
          thermocoupleOffsetC: validation.summary.thermocoupleOffsetC,
          calibrationProgram: calibrationProgram?.program,
          roastPlan,
        }),
      )
      setAddBaselineLogId('')
      setAddRoastLogId('')
    } catch (failure) {
      reportFailure(failure, 'That recording could not be fetched')
    } finally {
      setArchiveBusy(false)
    }
  }

  // The Calibrate UI has no batch mass or green density fields: a baseline pass is empty-chamber by
  // definition, so those fields would ask for a value that must always be blank. The `CalibrationRun`
  // fields stay in storage, dormant and optional, for the bean-loaded characterization that will
  // come from real roast data rather than from a diagnostic pass.
  const patchRun = async (run: CalibrationRun, patch: Partial<CalibrationRun>) => {
    try {
      if (catalogMutationBlockedReason) {
        setMessage('')
        setError(catalogMutationBlockedReason)
        return
      }
      await onSaveRun({ ...run, ...patch })
    } catch (failure) {
      reportFailure(failure, 'That calibration recording could not be saved')
    }
  }

  const deleteRun = async (id: string) => {
    try {
      if (catalogMutationBlockedReason) {
        setMessage('')
        setError(catalogMutationBlockedReason)
        return
      }
      await onDeleteRun(id)
    } catch (failure) {
      reportFailure(failure, 'That calibration recording could not be deleted')
    }
  }

  const deleteSnapshot = async (id: string) => {
    try {
      if (catalogMutationBlockedReason) {
        setMessage('')
        setError(catalogMutationBlockedReason)
        return
      }
      await onDeleteSnapshot(id)
    } catch (failure) {
      reportFailure(failure, 'That saved calibration could not be deleted')
    }
  }

  /**
   * Every stored log is a fit candidate, with what it can and cannot contribute stated. A run that
   * cannot contribute is excluded by default and says why; it is never hidden and never forced,
   * because the user knows things about their own roasts that this does not.
   */
  const candidates = useMemo(
    () =>
      sorted.map((run) => {
        const roast = roasts.find((candidate) => candidate.id === run.roastRunId)
        return { run, roast, readiness: fitReadiness(run, roast), input: fitInputFromRun(run, roast) }
      }),
    [roasts, sorted],
  )
  const loadedRuns = useMemo(() => candidates.filter((candidate) => isLoadedRun(candidate.run)), [candidates])
  /**
   * The fit set is what has been ADDED, in the order it was added.
   *
   * Nothing auto-lists here. With fifty to a hundred roasts in the archive a list of all of them is
   * not a choice, it is a scroll; and a default selection over a list that long is a decision made
   * on the user's behalf about data only they can judge. So: an empty region, an add
   * control, and one row per deliberate act. Removing a row takes it out of the fit set entirely -
   * unticking it only leaves it out of the next fit.
   */
  const addedLoaded = useMemo(
    () =>
      addedLoadedIds.flatMap((id) => {
        const found = loadedRuns.find((candidate) => candidate.run.id === id)
        return found ? [found] : []
      }),
    [addedLoadedIds, loadedRuns],
  )
  const addableLoaded = useMemo(
    () => loadedRuns.filter((candidate) => !addedLoadedIds.includes(candidate.run.id)),
    [addedLoadedIds, loadedRuns],
  )

  // A completed manual roast arrives here through the same evidence importer as every other loaded
  // roast. It is added to the working set but deliberately left unticked: navigation is not consent
  // to change a fit.
  useEffect(() => {
    if (!initialLoadedRoastId) return
    const existing = loadedRuns.find((candidate) => candidate.run.roastRunId === initialLoadedRoastId)
    if (existing) {
      setAddedLoadedIds((current) => (current.includes(existing.run.id) ? current : [...current, existing.run.id]))
      onInitialLoadedRoastConsumed?.()
      return
    }
    if (archiveBusy) return
    const roast = roasts.find((candidate) => candidate.id === initialLoadedRoastId)
    const storageLogId = roast?.deviceRoast?.storageAddress.logId
    const entry = storageLogId
      ? archive.logs.find((candidate) => candidate.storageAddress.logId === storageLogId)
      : undefined
    if (entry) void importDeviceLog(entry)
  }, [archive.logs, archiveBusy, initialLoadedRoastId, loadedRuns, onInitialLoadedRoastConsumed, roasts])
  /**
   * How many roasts in the archive have NO thermal recording linked to them.
   *
   * This explains why the picker can offer fewer roasts than History lists. Left unexplained, the
   * shortfall would look like a bug, so it is printed under the picker with the act that closes it.
   */
  const selectedForFit = useMemo(
    () => addedLoaded.filter((candidate) => fitSelection.includes(candidate.run.id)),
    [addedLoaded, fitSelection],
  )
  const previewPassPatch = useMemo(
    () =>
      fittedBaselineRuns.length > 0
        ? stageCalibration(
            analyzeCalibrationRun(fittedBaselineRuns[0]),
            fittedBaselineRuns[1] ? analyzeCalibrationRun(fittedBaselineRuns[1]) : undefined,
          ).patch
        : {},
    [fittedBaselineRuns],
  )
  const previewFit = useMemo(
    () =>
      selectedForFit.length > 0
        ? fitCoefficientsFromLog(
            selectedForFit.map((candidate) => fitSourceFromRun(candidate.run, candidate.input.label)),
            appliedCalibration,
            { frozen: baselinePinnedAirflow(previewPassPatch) },
          )
        : undefined,
    [appliedCalibration, previewPassPatch, selectedForFit],
  )
  const previewPatch = useMemo(
    () => combineSegmentedCalibration(previewFit, previewPassPatch),
    [previewFit, previewPassPatch],
  )
  const previewUnstable = unresolvedUnstableFields(previewFit, previewPassPatch)
  const previewImplausible = THERMAL_FIELDS.every((field) => Number.isFinite(previewPatch[field]))
    ? implausibleCoefficient(previewPatch as AppliedCoefficientSet)
    : undefined
  const previewInheritedFields =
    selectedForFit.length === 0 && includedBaselineRuns.length > 0
      ? THERMAL_FIELDS.filter((field) => !Number.isFinite(previewPassPatch[field]))
      : []
  const previewInheritedAvailable = previewInheritedFields.every((field) =>
    Number.isFinite(status.appliedCoefficients?.[field]),
  )
  const previewCalibration = useMemo(
    () => ({ ...appliedCalibration, ...previewPatch }),
    [appliedCalibration, previewPatch],
  )
  const previewReplay = useMemo(() => {
    const candidate = selectedForFit[0]
    if (!candidate || !previewFit) return undefined
    const replay = replayThermalTrace(candidate.run.samples, previewCalibration, {
      ambientC: estimateAmbientC(candidate.run.samples, candidate.run.ambientC),
      batchMassG: candidate.run.massG ?? previewCalibration.referenceBatchMassG,
    })
    return replay ? { candidate, replay } : undefined
  }, [previewCalibration, previewFit, selectedForFit])
  const workingDashboardAmbientC = estimateAmbientC(
    includedBaselineRuns.at(-1)?.samples ?? selectedForFit[0]?.run.samples ?? [],
    24.5,
  )
  /** Bean-load maps render only from a fit that Save and apply would actually accept. */
  const previewFitApplyable =
    previewFit !== undefined && previewUnstable.length === 0 && previewImplausible === undefined
  const workingDashboardLoads = useMemo<CalibrationDashboardLoad[]>(
    () => workingPreviewLoads(includedBaselineRuns.length > 0, previewFitApplyable),
    [includedBaselineRuns.length, previewFitApplyable],
  )
  const workingDashboard = useMemo(
    () =>
      workingDashboardLoads.length > 0
        ? buildCalibrationDashboard({
            baselineMap: workingMap,
            emptyTauByFan: workingTauFans,
            calibration: previewCalibration,
            ambientC: workingDashboardAmbientC,
            loads: workingDashboardLoads,
          })
        : undefined,
    [previewCalibration, workingDashboardAmbientC, workingDashboardLoads, workingMap, workingTauFans],
  )
  const workingDashboardView = useMemo(
    () => (workingDashboard ? calibrationDashboardView(workingDashboard, workingDashboardLoads) : undefined),
    [workingDashboard, workingDashboardLoads],
  )
  const chosenIds = new Set(selectedForFit.map((candidate) => candidate.run.id))
  const chooseFitInputs = (ids: string[]) => setFitSelection(ids)
  const toggleFitInput = (runId: string) =>
    chooseFitInputs(chosenIds.has(runId) ? [...chosenIds].filter((id) => id !== runId) : [...chosenIds, runId])
  /** Adding creates an unchecked, collapsed evidence row; choosing it is a separate working edit. */
  const addBaselineRun = (runId: string) => {
    if (!runId || addedBaselineIds.includes(runId)) return
    setAddedBaselineIds((current) => [...current, runId])
    setAddBaselineLogId('')
  }
  const addBaselineEvidence = () => {
    if (addBaselineLogId.startsWith('run:')) addBaselineRun(addBaselineLogId.slice(4))
    else if (addBaselineLogId.startsWith('log:')) {
      const entry = baselineLogOptions.find((candidate) => candidate.id === addBaselineLogId.slice(4))
      if (entry) void importDeviceLog(entry)
    }
  }
  const removeBaselineRun = (runId: string) => {
    setAddedBaselineIds((current) => current.filter((id) => id !== runId))
    setSelectedBaselineIds((current) => current.filter((id) => id !== runId))
    if (expandedRunId === runId) setExpandedRunId(undefined)
  }
  const addLoadedRun = (runId: string) => {
    if (!runId || addedLoadedIds.includes(runId)) return
    setAddedLoadedIds((current) => [...current, runId])
    setAddRoastLogId('')
  }
  const addLoadedEvidence = () => {
    if (addRoastLogId.startsWith('run:')) addLoadedRun(addRoastLogId.slice(4))
    else if (addRoastLogId.startsWith('log:')) {
      const entry = roastLogOptions.find((candidate) => candidate.id === addRoastLogId.slice(4))
      if (entry) void importDeviceLog(entry)
    }
  }
  const removeLoadedRun = (runId: string) => {
    setAddedLoadedIds((current) => current.filter((id) => id !== runId))
    chooseFitInputs([...chosenIds].filter((id) => id !== runId))
  }
  const toggleBaseline = (runId: string) =>
    setSelectedBaselineIds((current) =>
      current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId],
    )
  /** How a loaded recording is named in the picker and in its row: by the roast, because it IS one. */
  const loadedLabel = (candidate: (typeof loadedRuns)[number]) =>
    candidate.roast
      ? `${formatLocalDateTime(candidate.roast.startedAt)} - ${candidate.roast.name}${candidate.run.massG ? ` - ${candidate.run.massG} g` : ''}`
      : `${passLabel(candidate.run)} - no linked roast`

  /** Every calibration's inputs as they stand TODAY, which is what staleness is measured against. */
  const currentInputs = useMemo(() => candidates.map((candidate) => candidate.input), [candidates])
  /** The recordings behind a saved calibration, for the points column: its plan is on the record. */
  const runsById = useMemo(() => new Map(allSorted.map((run) => [run.id, run])), [allSorted])

  /**
   * ============================================================================================
   * ONE BUTTON, AND ITS ONLY JOB IS TO MAKE A RECORD.
   * ============================================================================================
   *
   * A page that draws the working calibration table by itself but then requires a click to fit has a
   * seam with no reason behind it. The rule is that every READING on this page appears by itself - tick a pass and the settled surface and the moves
   * table redraw at once, because those are measurements and a measurement does not need permission
   * - and the button performs the deliberate state change: it saves the named calibration and applies that same snapshot.
   *
   * So Save and apply uses exactly what the preview above shows: the pooled surface of the ticked passes as curves, and the coefficients. Where the
   * coefficients come from is the one thing that is not free, and it is why the fit runs HERE rather
   * than on every tick - a search over four coefficients across several roast logs is seconds of
   * work, not a redraw:
   *
   *   ticked roasts    the coefficients are FITTED from them, pooled, exactly as before.
   *   ticked passes only  the coefficients are what those passes measured about the empty chamber,
   *                    read off the newest ticked pass with the next-newest as its comparison, which
   *                    is the only form `stageCalibration` can honestly take. The preview says which
   *                    passes they came from before the button is pressed.
   *
   * The result stays where the press happened. Saving into a list two panels away and announcing it
   * in a banner at the top of the page is what made this read as a button that does nothing.
   */
  const saveWorkingCalibration = async (
    refitOf?: CalibrationSnapshot,
    refitRoasts?: typeof loadedRuns,
    applyAfterSave = false,
  ) => {
    const roastInputs = refitRoasts ?? selectedForFit
    if (catalogMutationBlockedReason) {
      setMessage('')
      setError(catalogMutationBlockedReason)
      return
    }
    const passes = refitOf ? [] : fittedBaselineRuns
    if (roastInputs.length === 0 && passes.length === 0) return
    if (!status.roaster) {
      setMessage('')
      setError(
        'The controller does not report a stable device and model identity, so a calibration cannot be saved safely',
      )
      return
    }
    const evidenceRuns = [...roastInputs.map((candidate) => candidate.run), ...passes]
    const mixed = mixedCalibrationSources(evidenceRuns)
    if (mixed) {
      setMessage('')
      setError(mixed)
      return
    }
    const evidenceSource = evidenceRuns[0]
    const evidenceCompatibility = calibrationCompatibility(evidenceSource, status.roaster)
    if (!evidenceCompatibility.compatible) {
      setMessage('')
      setError(evidenceCompatibility.message)
      return
    }
    setFitting(true)
    let snapshotSaved = false
    try {
      const passPatch =
        passes.length > 0
          ? stageCalibration(analyzeCalibrationRun(passes[0]), passes[1] ? analyzeCalibrationRun(passes[1]) : undefined)
              .patch
          : {}
      const result =
        roastInputs.length > 0
          ? fitCoefficientsFromLog(
              roastInputs.map((candidate) => fitSourceFromRun(candidate.run, candidate.input.label)),
              appliedCalibration,
              { frozen: baselinePinnedAirflow(passPatch) },
            )
          : undefined
      if (roastInputs.length > 0 && !result) {
        setMessage('')
        setError('Those recordings contain no readable samples to fit against')
        return
      }
      const unstable = unresolvedUnstableFields(result, passPatch)
      if (unstable.length > 0) {
        setMessage('')
        setError(
          `These recordings cannot separate ${fieldList(unstable)} from the other heat-loss terms: materially different values fit almost equally well. Keep a complete fan-only cooling tail and select an empty-chamber baseline with same-heat Fan changes.`,
        )
        return
      }
      const patch = combineSegmentedCalibration(result, passPatch)
      if (Object.keys(patch).length === 0) {
        setMessage('')
        setError(
          'The ticked passes derive no coefficients - none of them captured a fan-off decay tail, and every coefficient is anchored to that. Tick a pass that has one, or tick a loaded roast to fit against.',
        )
        return
      }
      const curves = passes.length > 0 ? curvesFromBaselineMap(workingMap) : []
      const points = curves.reduce((count, curve) => count + curve.points.length, 0)
      const inputs = roastInputs.map((candidate) => candidate.input)
      const names = inputs.map((input) => input.label).join(', ')
      const createdAt = new Date().toISOString()
      const namedAt = formatLocalDateTime(createdAt)
      const name = refitOf
        ? `${namedAt} - Refit of ${refitOf.name}`
        : inputs.length > 0
          ? `${namedAt} - Fitted from ${inputs.length === 1 ? 'roast' : `${inputs.length} roasts`} ${names}`
          : `${namedAt} - ${passes.length} empty-chamber pass${passes.length === 1 ? '' : 'es'}, ${points} point${points === 1 ? '' : 's'}`
      const snapshot: CalibrationSnapshot = {
        id: newId('calibration-snapshot'),
        name,
        createdAt,
        recordedOn: evidenceSource.recordedOn,

        runIds: [...roastInputs.map((candidate) => candidate.run.id), ...passes.map((run) => run.id)],
        ambientC: (roastInputs[0]?.run ?? passes[0])?.ambientC,
        patch,
        curves,
        ...(inputs.length > 0 ? { inputs, fingerprint: fitFingerprint(inputs), fitRmsC: result!.rmsC } : {}),
      }
      // Validate and confirm the Apply half before persistence. A blocked or cancelled combined
      // action therefore remains atomic from the user's point of view: it writes nothing.
      const preparedApply = applyAfterSave ? prepareApply(snapshot) : undefined
      if (applyAfterSave && !preparedApply) return
      const snapshotToSave = preparedApply?.snapshot ?? snapshot
      await onSaveSnapshot(snapshotToSave)
      snapshotSaved = true
      setError('')
      setMessage('')
      if (preparedApply) {
        if (await applyPrepared(snapshotToSave, preparedApply, true)) {
          setFitConfirmation(
            preparedApply.inheritedFields.length > 0
              ? `Saved and applied provisionally; inherited ${fieldList(preparedApply.inheritedFields)}`
              : 'Saved and applied',
          )
        }
      } else {
        setFitConfirmation('Saved')
      }
    } catch (failure) {
      setBusy(false)
      setApplyingId(undefined)
      setMessage('')
      if (snapshotSaved) {
        setFitConfirmation('Saved, not applied')
        setError(
          failure instanceof Error
            ? `The calibration was saved in History, but Apply did not finish: ${failure.message}`
            : 'The calibration was saved in History, but Apply did not finish.',
        )
      } else {
        setError(
          failure instanceof Error
            ? `The calibration could not be saved: ${failure.message}`
            : 'The calibration could not be saved',
        )
      }
    } finally {
      setFitting(false)
    }
  }

  const refit = (snapshot: CalibrationSnapshot) => {
    const chosen = loadedRuns.filter((candidate) => snapshot.fingerprint?.runIds.includes(candidate.run.id))
    if (chosen.length === 0) {
      setMessage('')
      setError('The recordings this was fitted from are no longer stored, so it cannot be refitted')
      return
    }
    void saveWorkingCalibration(snapshot, chosen)
  }

  /**
   * ============================================================================================
   * APPLY. ONE ACTION, ROASTER FIRST.
   * ============================================================================================
   *
   * Apply applies to the controller. Applying to the browser and then sending to the controller as a
   * separate step - one button pre-filling the Settings form for a second approval, another pushing
   * the same four numbers to the roaster - would make one intention take two presses on two screens
   * and leave it half-done in either direction.
   *
   * THE FAILURE SEMANTICS, chosen because it is the one that cannot lie: THE ROASTER GOES FIRST, and
   * this browser adopts the set only once the roaster has accepted it. If the push fails, nothing
   * has changed anywhere - not on the roaster, not here - and the message says exactly that. The
   * rejected alternative was a local apply carrying a "not yet on the roaster" flag with a retry
   * behind it: that flag is a claim about the future, it goes stale the moment the browser is
   * closed, and a plan drawn from coefficients the roaster never took is precisely the silent
   * disagreement this app spends its provenance code preventing.
   *
   * The one case where the browser applies alone is a roaster whose firmware holds no calibration of
   * its own. That is a stated, permanent condition rather than a pending one, and the confirmation
   * says so before anything is written.
   *
   * The exact old/new diff is shown in this confirmation, which is the last thing between the press and both writes.
   */
  const deviceHoldsCalibration = status.logArchive !== undefined
  const applyBlocked =
    catalogMutationBlockedReason ??
    applyCalibrationBlockedReason ??
    (deviceHoldsCalibration
      ? calibrationStartBlockedReason({ status, nowMs, busy, requiresRecordingStorage: false })
      : undefined)

  const prepareApply = (snapshot: CalibrationSnapshot) => {
    if (applyBlocked) {
      setMessage('')
      setError(applyBlocked)
      return undefined
    }
    if (!status.roaster) {
      setMessage('')
      setError(
        'The controller does not report a stable device and model identity, so this calibration cannot be applied safely',
      )
      return undefined
    }
    const compatibility = calibrationCompatibility(snapshot, status.roaster)
    if (!compatibility.compatible) {
      setMessage('')
      setError(compatibility.message)
      return undefined
    }
    const completion = completeEmptyChamberSnapshot(snapshot, status.appliedCoefficients)
    if (!completion.ok) {
      setMessage('')
      setError(completion.reason)
      return undefined
    }
    const preparedSnapshot = completion.value.snapshot
    const patch = preparedSnapshot.patch as Record<string, number | undefined>
    const fields = THERMAL_FIELDS.filter((field) => typeof patch[field] === 'number')
    if (fields.length === 0) {
      setMessage('')
      setError('That calibration carries no coefficients, so there is nothing to apply')
      return undefined
    }
    if (deviceHoldsCalibration && fields.length < THERMAL_FIELDS.length) {
      const missing = THERMAL_FIELDS.filter((field) => !fields.includes(field))
        .map((field) => COEFFICIENT_LABELS[field] ?? field)
        .join(', ')
      setMessage('')
      setError(`${preparedSnapshot.name} is still missing ${missing}, so it cannot be applied.`)
      return undefined
    }
    if (fields.length === THERMAL_FIELDS.length) {
      const implausible = implausibleCoefficient(patch as AppliedCoefficientSet)
      if (implausible) {
        setMessage('')
        setError(implausible)
        return undefined
      }
    }
    const measured = completion.value.measuredFields
      .map((field) =>
        `  ${COEFFICIENT_LABELS[field] ?? field}: ${status.appliedCoefficients?.[field] ?? (appliedCalibration as unknown as Record<string, number>)[field]} to ${patch[field]} ${COEFFICIENT_UNITS[field] ?? ''}`.trimEnd(),
      )
      .join('\n')
    const inherited = completion.value.inheritedFields
      .map((field) =>
        `  ${COEFFICIENT_LABELS[field] ?? field}: ${patch[field]} ${COEFFICIENT_UNITS[field] ?? ''} (unchanged from the roaster)`.trimEnd(),
      )
      .join('\n')
    const sections = [
      measured ? `Measured by the selected evidence:\n${measured}` : '',
      inherited
        ? `Inherited unchanged from the roaster's currently applied calibration:\n${inherited}\n\nThese inherited values were NOT measured by the empty-chamber pass. This set is provisional: use it to capture the first loaded roast, then fit and apply that loaded roast to replace the inherited values.`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const where = deviceHoldsCalibration
      ? 'These go to the roaster first. This browser adopts them only if the roaster takes them; if it refuses, nothing changes anywhere.'
      : 'This roaster firmware holds no calibration of its own, so this changes what THIS BROWSER plans with and nothing on the machine.'
    const provenanceWarning = compatibility.warning ? `\n\n${compatibility.warning}` : ''
    if (!window.confirm(`Apply ${preparedSnapshot.name}?\n\n${sections}\n\n${where}${provenanceWarning}`))
      return undefined
    return { snapshot: preparedSnapshot, patch, inheritedFields: completion.value.inheritedFields }
  }

  const applyPrepared = async (
    snapshot: CalibrationSnapshot,
    prepared: NonNullable<ReturnType<typeof prepareApply>>,
    snapshotAlreadySaved = false,
  ): Promise<boolean> => {
    const { patch } = prepared
    setApplyingId(snapshot.id)
    setBusy(true)
    if (deviceHoldsCalibration) {
      const sent = await controller.applyCalibration(
        {
          heaterGainCPerMinAt10: patch.heaterGainCPerMinAt10!,
          fanCoolingCPerMinAt10: patch.fanCoolingCPerMinAt10!,
          coolingFanCPerMinAt10: patch.coolingFanCPerMinAt10!,
          thermalLossPerMinPerC: patch.thermalLossPerMinPerC!,
        },
        sanitizeFitId(snapshot.applicationFitId ?? snapshot.fingerprint?.measurementHash ?? snapshot.id),
      )
      if (!sent.ok) {
        setMessage('')
        if (snapshotAlreadySaved) {
          setFitConfirmation('Saved, not applied')
          setError(
            `${snapshot.name} was saved in History, but the roaster did not take it: ${sent.message ?? 'it gave no reason'}. The current calibration was not changed.`,
          )
        } else {
          setError(
            `The roaster did not take ${snapshot.name}: ${sent.message ?? 'it gave no reason'}. Nothing changed - not on the roaster, and not in this browser.`,
          )
        }
        setBusy(false)
        setApplyingId(undefined)
        return false
      }
    }
    const adopted = await onApply(patch, {
      runId: snapshot.runIds[0],
      capturedAt: snapshot.createdAt,
      deviceId: snapshot.recordedOn.deviceId,
      modelId: snapshot.recordedOn.modelId,
    })
    setBusy(false)
    setApplyingId(undefined)
    if (!adopted.ok) {
      setMessage('')
      if (snapshotAlreadySaved)
        setFitConfirmation(deviceHoldsCalibration ? 'Saved; roaster updated' : 'Saved, not applied')
      setError(
        deviceHoldsCalibration
          ? `The roaster took ${snapshot.name}, but this browser view has not reconciled it: ${adopted.message ?? 'the write failed'}. The roaster is the source of truth and already has these numbers; the saved calibration remains in History.`
          : `${snapshot.name}${snapshotAlreadySaved ? ' was saved in History but' : ''} could not be adopted: ${adopted.message ?? 'the write failed'}.`,
      )
      return false
    }
    setError('')
    setMessage('')
    return true
  }

  const apply = async (snapshot: CalibrationSnapshot): Promise<boolean> => {
    const prepared = prepareApply(snapshot)
    return prepared ? applyPrepared(snapshot, prepared) : false
  }
  /**
   * The affordance that opens a row.
   *
   * Deliberately a labelled button rather than a chevron alone or a click anywhere on the row: the
   * detail this opens is a page of analysis, and something that big should not be reachable only by
   * discovering that a row is clickable. "Inspect" says what is behind it in one word.
   */
  const inspectButton = (run: CalibrationRun, open: boolean) => (
    <button
      type="button"
      className="icon-button ghost recording-disclosure"
      aria-expanded={open}
      title={open ? 'Close this recording' : 'Open this recording: its curve, measurements, and notes'}
      onClick={() => setExpandedRunId(open ? undefined : run.id)}
    >
      {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
      <span className="sr-only">{open ? 'Collapse recording' : 'Expand recording'}</span>
    </button>
  )

  const recordingActions = (run: CalibrationRun) => (
    <div className="recording-row-actions">
      <button
        type="button"
        className="compact-button"
        title="Download this recording as thermal.csv"
        onClick={() => downloadRunCsv(run)}
      >
        <Download size={15} />
        CSV
      </button>
      <button
        type="button"
        className="icon-button danger-icon"
        disabled={Boolean(catalogMutationBlockedReason)}
        title={
          catalogMutationBlockedReason
            ? `Permanent deletion must wait: ${catalogMutationBlockedReason} You can still remove it from this working set.`
            : 'Permanently delete this saved calibration evidence from the roaster library. Its original thermal archive remains in Settings.'
        }
        aria-label={`Permanently delete saved evidence ${passLabel(run)}`}
        onClick={() => {
          if (
            window.confirm(
              'Permanently delete this saved calibration evidence from the roaster library? Its original thermal recording remains in Settings.',
            )
          )
            void deleteRun(run.id)
        }}
      >
        <Trash2 size={17} />
      </button>
    </div>
  )

  /**
   * ============================================================================================
   * ONE RECORDING, IN FULL, INSIDE THE ROW THAT DECIDES ABOUT IT.
   * ============================================================================================
   *
   * This was a whole panel of its own, sitting under a panel of checkboxes about the same
   * recordings. Two lists of one set of objects is one list too many: choosing meant scrolling to a
   * second copy of the row you were deciding about, and the detail could be entirely off-screen from
   * the tick it belonged to. Everything that panel held is here, unchanged in substance - the
   * classification, the analysis for this kind of recording, the model-fit score, the notes,
   * Download CSV, Delete - rendered inside the row that was opened.
   *
   * Only one row is open at a time (`expandedRunId` is a single id), which is what lets the one
   * analysis this page computes belong to the open row rather than to some other row's detail.
   */
  const recordingDetail = (run: CalibrationRun) => {
    const loaded = isLoadedRun(run)
    const linkedRoast = roasts.find((candidate) => candidate.id === run.roastRunId)
    const known = loaded
      ? `Loaded roast${run.massG ? ` - ${run.massG} g batch` : ''}${linkedRoast ? ` - ${linkedRoast.name}` : ''}`
      : 'Empty chamber - a diagnostic pass, nothing in it'
    if (run.samples.length === 0 && run.sourceLogId)
      return (
        <div className="empty-state">
          <strong>Recording held by the roaster.</strong> Its samples are loading from the thermal archive. Reconnect or
          refresh if this remains here.
        </div>
      )

    // Replayed open-loop against the LIVE coefficients: how well the model this app plans with
    // actually describes a recording that really happened.
    const fit = replayCalibrationRun(run, appliedCalibration)
    const verdict = modelFitVerdict(fit)
    // A chamber pass replayed through a bean model is expected to score badly. Saying so is what
    // stops the number reading as a fault in the model or in the pass.
    const framing = verdict.text
    const excitation = loaded ? logExcitation(run.samples) : undefined
    // Drift is read by laying one empty-chamber pass over another. A loaded roast has no settled
    // surface, so offering it here would overlay two different kinds of thing.
    const comparableRuns = sorted.filter((other) => other.id !== run.id && !isLoadedRun(other))
    const candidate = candidates.find((entry) => entry.run.id === run.id)

    return (
      <div className="calibration-run-body">
        <div className="recording-head">
          <span>
            {new Date(run.capturedAt).toLocaleString()} / {run.form === 'grid' ? 'automatic grid' : 'explicit sequence'}{' '}
            {formatStepPairs(run.steps.slice(0, 4))}
            {run.steps.length > 4 ? ' ...' : ''} / {sampleSummary(run)}
            {run.ceilingC === undefined ? '' : ` / ceiling ${run.ceilingC} °C`}
          </span>
        </div>

        <div className="recording-kind-known">
          <strong>{known}</strong>
        </div>

        {/*
        ANALYSIS SPLIT BY WHAT THE RECORDING ACTUALLY IS.

        Empty-chamber readouts are wrong for a LOADED roast. A banner such as "suspect: fan 8 falls
        with heat. More heat cannot make an empty chamber cooler" is true of an empty chamber, but a
        loaded roast has none: beans absorb heat, so temperature falling while heat rises is ordinary
        in a roast, and a settled surface, a per-step settle verdict and derived chamber coefficients
        are all meaningless for one. So they are not rendered for one.

        A loaded roast gets what IS true of it instead: its own curve, what it can and cannot
        contribute to a fit, and the covariates the archive holds about the batch.
      */}
        {selected?.id === run.id && analysis && !loaded && (
          <div className="recording-analysis">
            <div className="recording-analysis-head">
              <h4>
                <TermLabel term="mesh" label="What this recording measured" />
              </h4>
              <span className="calibration-duration">
                <TermLabel term="ambient" label="Ambient" /> {number(analysis.ambientC)} °C /{' '}
                <TermLabel term="peak" label="peak" /> {number(analysis.peakC)} °C
                {analysis.limitedSteps > 0
                  ? ` / ${analysis.limitedSteps} limited, ${analysis.skippedSteps} skipped`
                  : ''}
              </span>
            </div>
            {suspectFans.length > 0 && (
              <div className="calibration-suspect" role="alert">
                <TermLabel term="suspect" label="Suspect" />: fan {suspectFans.map((fan) => fan.toFixed(1)).join(', ')}{' '}
                falls with heat. More heat cannot make an empty chamber cooler, so those steps did not settle - widen
                the settle window, narrow the band, and raise the step cap, then run the pass again.
              </div>
            )}

            <div className="recording-analysis-head">
              <h4>Temperature and controls over the pass</h4>
              <span>The exact recorded trace, using the same visual language as a live roast.</span>
            </div>
            <TraceChart run={run} boundaries={boundaries} limitC={analysis.limitC} />

            <div className="calibration-step-detail">
              <div className="recording-analysis-head">
                <h4>Step-by-step results</h4>
                <span>Every destination setting and the result measured there.</span>
              </div>
              <div className="calibration-table-wrap">
                <table className="diff-table calibration-table">
                  <thead>
                    <tr>
                      <th>Fan : Heat</th>
                      <th>
                        <TermLabel term="steadyState" label="Steady state" />
                      </th>
                      <th>
                        <TermLabel term="riseOverAmbient" label="Rise over ambient" />
                      </th>
                      <th>
                        <TermLabel term="tau" label="Tau" />
                      </th>
                      <th>
                        <TermLabel term="held" label="Held" /> / <TermLabel term="approach" label="approach" />
                      </th>
                      <th>
                        <TermLabel term="extrapolated" label="Advance" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.steps.map((step) => (
                      <tr
                        key={step.index}
                        className={
                          step.recovery
                            ? 'recovery-step'
                            : step.quality === 'unreliable'
                              ? 'unreliable-step'
                              : undefined
                        }
                      >
                        <td data-label="Fan : Heat">
                          {step.fanLevel.toFixed(step.floored ? 3 : 1)} : {step.heatLevel.toFixed(1)}
                          {step.recovery && <small> recovery</small>}
                          {step.floored && <small> floored from {step.declaredFanLevel.toFixed(1)}</small>}
                        </td>
                        <td data-label="Steady state">
                          {number(step.steadyStateC)} °C
                          {step.quality !== 'measured' && (
                            <small>
                              {' '}
                              {step.quality === 'unreliable' ? 'lower bound' : 'est'}
                              {step.steadyStateR2 === undefined ? '' : ` R2 ${step.steadyStateR2.toFixed(3)}`}
                            </small>
                          )}
                        </td>
                        <td data-label="Rise over ambient">{number(step.riseOverAmbientC)} °C</td>
                        <td data-label="Tau">
                          {step.tauSec === undefined ? 'not fitted' : `${step.tauSec.toFixed(0)} s`}
                        </td>
                        <td data-label="Held / approach">
                          {step.durationSec === undefined ? 'not seen' : `${step.durationSec.toFixed(0)} s`}
                          {step.approach !== undefined && (
                            <small> {Math.round(Math.max(0, Math.min(1, step.approach)) * 100)}% of rise</small>
                          )}
                        </td>
                        <td data-label="Advance">
                          {step.skipped ? 'skipped' : step.limited ? 'limited' : step.quality}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/*
          An empty-chamber pass measures a settled surface, so it shows one - the SAME table Current
          calibration draws, built from this pass alone rather than from every applied pass. One
          component, two scopes: the aggregate above answers "what does my roaster settle at", this
          one answers "what did THIS pass find", and they cannot disagree about how a surface is
          drawn because there is only one drawing of it.
        */}
            {selectedMap && (
              <>
                <BaselineMapGrid map={selectedMap} />
                <div className="calibration-map-legend">
                  This pass alone: {selectedMap.extrapolatedCount} extrapolated, {selectedMap.unreliableCount}{' '}
                  unreliable, {selectedMap.flooredCount} <TermLabel term="floored" label="floored" />. The surface under
                  Current calibration is the applied calibration passes together.
                </div>
              </>
            )}
            {/* Numerical drift comparison remains useful without duplicating the raw trace as a second
            line chart. It is offered only against other empty-chamber passes. */}
            {comparableRuns.length > 0 && (
              <label className="form-field recording-compare">
                <span className="form-field-label">Compare step values with another empty-chamber pass</span>
                <select
                  value={comparison?.id ?? ''}
                  onInput={(event) => setComparisonId(event.currentTarget.value || undefined)}
                >
                  <option value="">No comparison</option>
                  {comparableRuns.map((other) => (
                    <option key={other.id} value={other.id}>
                      {passLabel(other)}
                    </option>
                  ))}
                </select>
                <small className="field-help">
                  Two passes of the same machine should produce similar settled values; the comparison table puts any
                  drift into numbers.
                </small>
              </label>
            )}
            {delta && (
              <div className="pass-delta">
                <PassDeltaTable delta={delta} />
              </div>
            )}

            <div className="calibration-fit-summary">
              <span>
                <TermLabel term="gainSlope" label="Thermal gain per heat unit" />
                <strong>{gain ? `${gain.slope.toFixed(2)} °C` : 'not fitted'}</strong>
                <small>
                  {gain ? (
                    <>
                      Fan {gain.fanLevel.toFixed(1)}: <TermLabel term="r2" label="R2" /> {gain.r2.toFixed(3)} over{' '}
                      {gain.points} steps
                      {analysis.gains.length > 1 ? `, ${analysis.gains.length} fan groups fitted` : ''}
                    </>
                  ) : (
                    'Needs one fan level holding two or more heat steps'
                  )}
                </small>
              </span>
              <span>
                <TermLabel term="forcedTau" label="Forced cooling tau" />
                <strong>{analysis.forced?.tauSec ? `${analysis.forced.tauSec.toFixed(0)} s` : 'not fitted'}</strong>
                <small>
                  {analysis.forced
                    ? `Fan ${analysis.forced.fanLevel.toFixed(1)} over ${analysis.forced.seconds.toFixed(0)} s`
                    : 'No fan-on cooling tail in this log'}
                </small>
              </span>
              <span>
                <TermLabel term="passiveTau" label="Passive decay tau" />
                <strong>{analysis.passiveTauSec ? `${analysis.passiveTauSec.toFixed(0)} s` : 'not fitted'}</strong>
                <small>
                  Anchors the <TermLabel term="thermalLoss" label="thermal-loss coefficient" />
                </small>
              </span>
            </div>
            {staging && (
              <div className="calibration-staging">
                {staging.entries.map((entry) => (
                  <div
                    className={entry.field ? 'staging-entry derived' : 'staging-entry informational'}
                    key={entry.key}
                  >
                    <span>{entry.label}</span>
                    <strong>{entry.value === undefined ? 'not derivable' : `${entry.value} ${entry.unit}`}</strong>
                    <small>{entry.field ? entry.basis : `Informational only. ${entry.basis}`}</small>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* A LOADED ROAST: its curve, its job, and what the archive knows about the batch. */}
        {selected?.id === run.id && loaded && (
          <div className="recording-analysis">
            <div className="recording-analysis-head">
              <h4>What this roast recorded</h4>
              <span className="calibration-duration">
                <TermLabel term="ambient" label="Ambient" /> {number(analysis?.ambientC)} °C /{' '}
                <TermLabel term="peak" label="peak" /> {number(analysis?.peakC)} °C
              </span>
            </div>
            <p className="fit-reason">
              There were beans in the chamber, so the empty-chamber readings do not apply here and are not shown: beans
              soak up heat, which is why temperature can fall while heat rises in a roast and why there is no settled
              surface to draw. What a recording like this is FOR is the fit - it is the only kind the model can be
              fitted against.
            </p>
            <TraceChart run={run} boundaries={[]} />
            {candidate && (
              <>
                <div className="fit-badges">
                  <span
                    className={`fit-badge ${excitationGrade(candidate.readiness.excitation)}`}
                    title={BADGE_TITLES.excitation}
                  >
                    {EXCITATION_BADGE[excitationGrade(candidate.readiness.excitation)]}
                  </span>
                  <span
                    className={`fit-badge ${candidate.readiness.fittable ? 'good' : 'poor'}`}
                    title={BADGE_TITLES.usable}
                  >
                    {candidate.readiness.fittable ? 'usable in a fit' : 'not usable as it stands'}
                  </span>
                  <span
                    className={`fit-badge ${chosenIds.has(run.id) ? 'good' : 'partial'}`}
                    title={BADGE_TITLES.ticked}
                  >
                    {chosenIds.has(run.id) ? 'ticked for the next calibration' : 'not ticked'}
                  </span>
                </div>
                {candidate.readiness.reasons.length > 0 && (
                  <p className="fit-reason">{candidate.readiness.reasons.join(' ')}</p>
                )}
                <div className="roast-covariates">
                  <span>
                    <small>Batch</small>
                    <strong>{candidate.input.massG === undefined ? '--' : `${candidate.input.massG} g`}</strong>
                  </span>
                  <span>
                    <small>Bean lot</small>
                    <strong>{candidate.input.beanLotName ?? '--'}</strong>
                  </span>
                  <span>
                    <small>Green density</small>
                    <strong>{formatMetric(candidate.input.metrics?.greenDensityGPerMl, 3, ' g/ml')}</strong>
                  </span>
                  <span>
                    <small>Roasted density</small>
                    <strong>{formatMetric(candidate.input.metrics?.roastedDensityGPerMl, 3, ' g/ml')}</strong>
                  </span>
                  <span>
                    <small>Expansion</small>
                    <strong>
                      {candidate.input.metrics?.expansionRatio === undefined
                        ? '--'
                        : `${candidate.input.metrics.expansionRatio.toFixed(2)}x`}
                    </strong>
                  </span>
                  <span>
                    <small>Mass loss</small>
                    <strong>{formatMetric(candidate.input.metrics?.massLossPercent, 1, ' %')}</strong>
                  </span>
                </div>
                <p className="fit-reason">
                  These covariates are recorded so a future regression of heat absorption against expansion has its
                  dataset. No expansion term is in the thermal model yet - it will be fitted when the run count supports
                  it, not invented before.
                </p>
              </>
            )}
          </div>
        )}

        {/* Model replay is meaningful only for a loaded roast that the thermal model describes. */}
        {loaded && (
          <div className={`model-fit-detail ${verdict.grade}`}>
            <strong>
              {fit
                ? `How close the model gets: ${fit.rmsC.toFixed(1)} °C out on average, ${fit.maxC.toFixed(1)} °C at its worst, ${clock(fit.maxAtSec)} in`
                : 'The model cannot be scored here: there are no readable samples to replay'}
            </strong>
            <span>
              {framing} The average is the RMS: how far the model curve sits from the measured one, on average, over the
              whole recording. It comes from running the fan and heat levels this recording really used through the
              model with the coefficients applied right now, started from the first reading and never nudged back onto
              the truth afterwards - a hard test rather than a flattering one.
            </span>
            {excitation && excitation.warnings.length > 0 && (
              <span className="fit-warning">Fitting from this roast alone: {excitation.warnings.join(' ')}</span>
            )}
          </div>
        )}
        {/* Was `onChange` bound to the stored pass - the same revert race as the roast notes. */}
        <TextArea
          className="notes-field calibration-run-notes"
          counterClassName="notes-count"
          label={<span className="form-field-label">Pass notes</span>}
          ariaLabel="Pass notes"
          maxLength={4000}
          value={run.notes}
          placeholder="Chamber state, ambient conditions, anything unusual"
          onCommit={(notes) => {
            void patchRun(run, { notes })
          }}
        >
          <FieldHelp term="passNotes" />
        </TextArea>
      </div>
    )
  }

  return (
    <section className="view calibration-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">Diagnostic program</span>
          <h1>Calibrate</h1>
        </div>
      </div>

      {/*
      Every explainer on this page, in one collapsed place.

      A guide, a page map, a two-kinds-of-run primer, and a scope note as four separate banners would
      put four boxes of prose before a single number. Three of them are inside the guide, which is `details` and therefore renders
      whether it is open or not: the coverage test still sees every explanation, and the page still
      opens on the page map and then on the answer.
    */}
      <details className="calibration-guide">
        <summary>
          <BookOpen size={17} />
          How calibration works
        </summary>
        <div className="calibration-guide-body">
          <ol>
            {CALIBRATION_GUIDE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          <div className="first-baseline-guide">
            <strong>Why there are two kinds of run here</strong>
            <ol>
              <li>
                An <strong>empty-chamber pass</strong> maps the AIR: what the chamber settles at for every fan and heat
                pair with nothing in it. That is what the pass runner directly below Current calibration produces, and
                what the settled surface is made of.
              </li>
              <li>
                A <strong>loaded roast</strong> is a real batch, and the only thing worth fitting the model to, because
                predicting a loaded roast is the model's job.
              </li>
              <li>
                To make one, roast by hand from Controls, and part way through hold the heat and move the fan, then hold
                the fan and move the heat: that is what lets a fit tell the element and the airflow apart. It is
                recorded automatically; add the exact linked roast recording under Build a calibration, so its weight
                and measurements come from the roaster archive rather than being typed twice.
              </li>
            </ol>
          </div>
          <p className="calibration-scope-note">
            Crackle asks the roaster for exactly three things here: start a calibration pass, stop one, and hand back
            the recording. Roast execution stays disabled. Every pass the runner starts is an empty-chamber baseline.
            Its recording is captured as evidence; only Save and apply turns chosen evidence into a named calibration.
          </p>
        </div>
        <HelpGlossary />
      </details>

      {/*
      What is on this page, in the order it appears - one block of three, not three cards.

      There are no step numbers. Only one of these is a step, and numbering the rest would make a
      rarely-needed diagnostic - recording a fresh empty-chamber baseline - read as something to do
      every time, while the saved-calibration history would read as a stage of a workflow it is not
      part of. What is applied right now belongs at the top, because it is the answer to the question the
      screen is usually opened to ask.
    */}
      <ol className="calibration-flow">
        <li>
          <span className="flow-step">First</span>
          <strong>Current calibration</strong>
          <span>
            What is applied, where it came from, and the two things it measures: what the chamber settles at, and how
            long a move takes.
          </span>
        </li>
        <li>
          <span className="flow-step">Rarely</span>
          <strong>Record a baseline</strong>
          <span>
            Only when the machine itself may have drifted. A diagnostic pass with an empty chamber, not part of
            roasting.
          </span>
        </li>
        <li>
          <span className="flow-step">When there is new data</span>
          <strong>Build a calibration</strong>
          <span>
            Add exact records stored on the roaster, tick the evidence this calibration should use, review the preview,
            then save and apply it.
          </span>
        </li>
      </ol>

      {/*
      The current calibration, at the top, where the question "what is my roaster doing" is asked.

      Splitting this - applied coefficients and provenance on Settings, the mesh here - would leave
      neither screen showing the whole thing. Settings keeps only the device-versus-app divergence
      check, which is a device-health concern, and everything about what is applied and what it
      measured lives here in one place.
    */}
      <section className="calibration-panel current-panel">
        <div className="calibration-panel-heading">
          <div className="setting-icon">
            <SlidersHorizontal />
          </div>
          <div>
            <span className="eyebrow">Applied thermal model</span>
            <h2>Current calibration</h2>
          </div>
          <span className={`provenance-badge ${provenance.grade}`}>
            {provenance.grade === 'calibrated'
              ? 'Calibrated'
              : provenance.grade === 'provisional'
                ? 'Provisional'
                : provenance.grade === 'estimated'
                  ? 'Estimated'
                  : 'Hand-entered'}
          </span>
        </div>
        <div className="current-provenance">
          <strong>{provenance.label}</strong>
          <span>{provenance.detail}</span>
        </div>
        <div className="thermal-applied">
          {Object.keys(COEFFICIENT_LABELS).map((field) => (
            <div className="thermal-applied-cell" key={field}>
              <span>{COEFFICIENT_LABELS[field]}</span>
              <strong>{(appliedCalibration as unknown as Record<string, number>)[field]}</strong>
              <small>{COEFFICIENT_UNITS[field]} - applied</small>
            </div>
          ))}
        </div>

        {/* Question one. One artifact: the table. A line chart above it drawing the same surface from a
          different source would be a duplicate that could disagree.

          And the source is FROZEN. This is the evidence under the coefficients printed above it, so
          it is built from the passes behind the applied calibration - never from whatever happens to
          be ticked in Build a calibration, which would make this region move while the user is still
          deciding. See the two-surfaces comment on `map`. */}
        <div className="calibration-region">
          <div className="region-head">
            <h3>What the chamber settles at</h3>
            <p>
              Where the empty chamber ends up and stays, in °C for each fan and heat pair. Read across a row for what
              more heat does at one airflow, and down a column for what more airflow does at one heat. Every prediction
              this app makes is drawn against this surface.
            </p>
          </div>
          <div className="applied-evidence">
            {appliedBaselineRuns.length > 0
              ? `Measured by the ${appliedBaselineRuns.length} empty-chamber pass${appliedBaselineRuns.length === 1 ? '' : 'es'} behind ${appliedSnapshot?.name}, the calibration applied right now. Ticking passes in Build a calibration below builds a working surface there; it does not touch this one.`
              : baselineRuns.length > 0
                ? `The applied calibration has no empty-chamber passes behind it, so this surface is drawn from the ${baselineRuns.length} pass${baselineRuns.length === 1 ? '' : 'es'} stored on the roaster instead. Ticking passes in Build a calibration does not change it.`
                : appliedSnapshot?.curves.length
                  ? `Drawn from the surface saved with ${appliedSnapshot.name}, the calibration applied right now. Ticking passes in Build a calibration does not change it.`
                  : 'No empty-chamber pass is stored on the roaster yet, so there is no measured surface. Record a baseline to draw one.'}
          </div>
          <BaselineMapGrid map={map} />
          <div className="calibration-map-legend">
            <TermLabel term="suspect" label="Suspect rows" />:{' '}
            {map.suspectFans.length === 0 ? 'none' : `fan ${map.suspectFans.map((fan) => fan.toFixed(1)).join(', ')}`}.{' '}
            {map.extrapolatedCount} extrapolated, {map.unreliableCount} unreliable, {map.flooredCount}{' '}
            <TermLabel term="floored" label="floored" />, from {map.runCount} pass{map.runCount === 1 ? '' : 'es'}.
          </div>
        </div>

        {/* Question two. Measured moves first, computed ones marked; the tau-by-fan chart folded in
          here as the per-row basis line rather than surviving as a second artifact. */}
        <div className="calibration-region">
          <div className="region-head">
            <h3>How long empty-chamber destinations take</h3>
            <p>
              Each square averages the time to reach that destination Fan and Heat setting from every valid calibrated
              origin in the baseline evidence. Crackle no longer stretches the bean model to a mathematical equilibrium
              and presents that 30–40 minute settling time as though it were a roast prediction.
            </p>
          </div>
          <CalibrationDashboard dashboard={settlingDashboardView} />
          <p className="move-legend">
            Every map uses the same {settlingDashboard.toleranceC.toFixed(1)} °C settle band held for{' '}
            {settlingDashboard.settleWindowSec.toFixed(0)} seconds. Moves smaller than{' '}
            {settlingDashboard.meaningfulDeltaC.toFixed(1)} °C are excluded as near-flat. Each map carries its own
            gradient and end value, so its full timing range remains visible.
            {settlingDashboardLoads.includes('100g')
              ? ' The 100 g and 250 g maps are model projections from the applied coefficients; no loaded-roast measurement is implied.'
              : ''}
          </p>
        </div>
      </section>

      {/*
      The pass runner, framed as the rarely-needed tool it is.

      It is not a first step at the top of the screen, which would make an empty-chamber diagnostic
      look like the thing this page is for. It is not: the surface it measures changes when the MACHINE
      changes, which is a matter of years rather than of roasts.
    */}
      <section className="calibration-panel run-panel">
        <div className="calibration-panel-heading">
          <div className="setting-icon">
            <Grid3x3 />
          </div>
          <div>
            <span className="eyebrow">Rarely needed</span>
            <h2>Record an empty-chamber baseline</h2>
          </div>
          <span className="calibration-duration">
            {plannedSteps.length > 0
              ? `${plannedSteps.length} steps / at most ${clock(programMaximumSec(plannedSteps, shared.maxStepSeconds))}`
              : 'Enter a valid program'}
          </span>
        </div>
        <div className="calibration-ingest-note">
          <strong>Only when the machine itself may have drifted.</strong> A baseline pass measures the empty chamber:
          what it settles at for every fan and heat pair, and how fast it gets there. That is a property of the roaster
          rather than of a roast - worth running when the machine is new to you, after a clean or a repair, or as a
          repeat pass when the drift itself is the reading. Never needed per batch.
        </div>
        {/* "A pass runs the heater unattended" is engineer-speak for something that matters: the
          machine turns its own heater on and keeps it on with nobody touching it. The warning
          leads with that, in the second person, with the real worst-case duration in it, and the
          firmware protocol follows as the reassurance rather than as the message. */}
        <div className="calibration-arm-note">
          <strong>
            This test switches the heater on by itself and keeps it on for up to{' '}
            {clock(programMaximumSec(plannedSteps, shared.maxStepSeconds))}, then cools down. Stay in the room.
          </strong>{' '}
          There is no temperature limit on the test itself - it measures whatever the machine does. The roaster's own
          protections stand underneath it, always on: a healthy probe reading at or above the overheat limit (
          {status.overtempLimitC === undefined ? '260 °C by default' : `${Math.round(status.overtempLimitC)} °C`}) for a
          second cuts the heat at once, runs a Fan 10 cooldown, and locks the heater off until the roaster is unplugged
          and plugged back in. If an empty-chamber step gets that hot, the pass stops there.
        </div>

        <div className="form-body">
          {/* "Automatic grid" rather than "Grid": naming what it does for you is what makes the
            explicit-sequence tab beside it read as the alternative it is. */}
          <div className="segmented-control" role="group" aria-label="Program form">
            <button
              type="button"
              className={mode === 'grid' ? 'active' : ''}
              aria-pressed={mode === 'grid'}
              onClick={() => setMode('grid')}
            >
              <Grid3x3 size={16} />
              Automatic grid
            </button>
            <button
              type="button"
              className={mode === 'steps' ? 'active' : ''}
              aria-pressed={mode === 'steps'}
              onClick={() => setMode('steps')}
            >
              <ListOrdered size={16} />
              Explicit sequence
            </button>
          </div>

          <fieldset className="form-section" disabled={mode !== 'grid'}>
            <legend>Baseline air map</legend>
            <div className="form-row">
              <Field label={`Fan levels (up to ${CALIBRATION_LIMITS.maximumGridFans})`} term="gridFans" span="wide">
                <TextField ariaLabel="Fan levels" value={fansRaw} placeholder="1,4,7,10" onCommit={setFansRaw} />
              </Field>
              <Field label={`Heat levels (up to ${CALIBRATION_LIMITS.maximumGridHeats})`} term="gridHeats" span="wide">
                <TextField ariaLabel="Heat levels" value={heatsRaw} placeholder="1,5,10" onCommit={setHeatsRaw} />
              </Field>
            </div>
          </fieldset>

          <fieldset className="form-section">
            <legend>Step timing</legend>
            <div className="form-row">
              <Field label="Step cap (s)" term="maxStepSeconds" span="narrow">
                <input
                  type="number"
                  min={15}
                  max={300}
                  step={5}
                  value={maxStepSecondsRaw}
                  onInput={(event) => setMaxStepSecondsRaw(event.currentTarget.value)}
                />
              </Field>
              <Field label="Minimum dwell (s)" term="minStepSeconds" span="narrow">
                <input
                  type="number"
                  min={5}
                  max={120}
                  step={5}
                  value={minStepSecondsRaw}
                  onInput={(event) => setMinStepSecondsRaw(event.currentTarget.value)}
                />
              </Field>
              <Field label="Settle window (s)" term="settleSeconds" span="narrow">
                <input
                  type="number"
                  min={2}
                  max={30}
                  step={1}
                  value={settleSecondsRaw}
                  onInput={(event) => setSettleSecondsRaw(event.currentTarget.value)}
                />
              </Field>
              <Field label="Settle band (°C)" term="settleBandC" span="narrow">
                <input
                  type="number"
                  min={0.2}
                  max={10}
                  step={0.1}
                  value={settleBandRaw}
                  onInput={(event) => setSettleBandRaw(event.currentTarget.value)}
                />
              </Field>
            </div>
          </fieldset>

          {mode === 'steps' && (
            <fieldset className="form-section">
              <legend>Explicit step sequence</legend>
              <div className="form-row">
                <Field label="Steps as fan:heat (1-12)" term="steps" span="wide">
                  <TextField
                    ariaLabel="Steps as fan:heat"
                    value={stepsRaw}
                    placeholder="3:1,3:5,3:10"
                    onCommit={setStepsRaw}
                  />
                </Field>
              </div>
              <p className="form-advanced-note">
                The pass runs exactly these pairs, in this order. The timing fields above still apply. Switch back to
                the automatic grid to sweep a whole fan-by-heat map instead.
              </p>
            </fieldset>
          )}

          <div className="calibration-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy || stopping || Boolean(blocked)}
              onClick={() => void start()}
            >
              <Play size={18} />
              {busy ? 'Starting...' : 'Start pass'}
            </button>
            <button
              type="button"
              className="command-button stop-command"
              disabled={stopping || !program?.active}
              onClick={() => void stop()}
            >
              <StopIcon size={17} />
              {stopping ? 'Stopping...' : 'Stop'}
            </button>
          </div>
          {blocked && !busy && !program?.active && (
            <div className="calibration-blocked" role="status">
              <strong>Waiting to start:</strong> {blocked}
            </div>
          )}
          {/*
          Progress sits WITH the buttons that cause it. Placed blocks lower, past the program summary,
          the serpentine preview and the floored-step warning, pressing Start and seeing what Start did
          would need a scroll. Cause and effect share a viewport. It is progress rather than a field table:
          idle is one compact line instead of eight empty cells.
        */}
          <PassProgress program={program} />
          {commandError && (
            <div className="storage-error-banner" role="alert">
              <span>{commandError}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss pass command error"
                onClick={() => setCommandError('')}
              >
                x
              </button>
            </div>
          )}
          {ingestBanner && (
            <div
              className={ingest.phase === 'failed' ? 'storage-error-banner' : 'ingest-banner'}
              role={ingest.phase === 'failed' ? 'alert' : 'status'}
            >
              <span>{ingestBanner}</span>
              {ingest.phase === 'waiting-tail' && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => dispatchIngest({ type: 'skip', nowMs: Date.now() })}
                >
                  Skip and ingest now
                </button>
              )}
              {ingest.phase === 'failed' && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss ingest status"
                  onClick={() => dispatchIngest({ type: 'dismiss' })}
                >
                  x
                </button>
              )}
            </div>
          )}
          <div className="program-summary">{programSummary}</div>
        </div>

        {!resolved.overridden && plannedSteps.length > 0 && (
          <div className="calibration-path">
            <TermLabel term="serpentine" label="Serpentine path" />: {formatStepPairs(plannedSteps.slice(0, 14))}
            {plannedSteps.length > 14 ? ' ...' : ''}
          </div>
        )}
        {flooredPlan.length > 0 && (
          <div className="calibration-floor-warning" role="status">
            <TermLabel term="floored" label="Normalized steps" />: {flooredPlan.length} of these steps asks for a
            nonzero fan below the public 0.1 minimum. {formatStepPairs(flooredPlan.slice(0, 4))}
            {flooredPlan.length > 4 ? ' ...' : ''} will run at fan {effectiveLevels(flooredPlan[0]).fan.toFixed(1)} and
            will be measured and reported there.
          </div>
        )}
        {/* The remaining live facts that are about the PROGRAM rather than about its progress. */}
      </section>

      {/*
      ONE PANEL WHERE A CALIBRATION IS BUILT.

      A panel that holds a preview of what the ticks add up to is more than a place to choose data, so
      it is named for what it produces, and it holds the whole act - every recording
      this browser has, openable in place, tickable, previewing as it is ticked, with one button at
      the foot that turns the preview into a saved calibration.

      Recording detail opens in these rows rather than in a separate panel. Two lists of the same
      recordings, one to choose from and one to read, would mean scrolling to a second copy of the row
      you are deciding about; a row that opens is the same thing with the scroll deleted.
    */}
      <section className="calibration-panel fit-choice-panel">
        <div className="calibration-panel-heading">
          <div className="setting-icon">
            <SlidersHorizontal />
          </div>
          <div>
            <span className="eyebrow">The data, and what it adds up to</span>
            <h2>Build a calibration</h2>
          </div>
          {/* Counted against what has been ADDED, not against the whole archive: "3 of 87 roasts"
            would be reporting how much of the library is unread, which is not a fact about the
            fit. */}
          <span className="calibration-duration">
            {addedLoaded.length === 0
              ? 'No roasts added'
              : `${selectedForFit.length} of ${addedLoaded.length} added roast${addedLoaded.length === 1 ? '' : 's'}`}{' '}
            / {includedBaselineRuns.length} of {addedBaselineRuns.length} added baseline
            {addedBaselineRuns.length === 1 ? '' : 's'}
          </span>
        </div>

        {/*
        ONE MODEL OF WHAT A RECORDING IS.

        Three rules keep the recordings strip readable:

        1. TWO DIFFERENT THINGS NEVER SHARE ONE WORD. The roaster's LIVE buffer - what it is
           recording this second, in RAM - and the FINISHED recordings written to its flash are both
           "recordings"; if nothing distinguishes them, "holding no recording" next to a list of five
           contradicts itself. The state block names the two facts separately, in that order, and
           neither can be mistaken for the other.
        2. NO CONTROL WITHOUT A VISIBLE EFFECT. A dropdown choice that only arms a button a wrap
           away looks like nothing happened. Choosing prints what was chosen: its kind, when it ran,
           how long, how many samples, and the Import button takes its name.
        3. NO CONTROL FOR A RECORDING THAT DOES NOT EXIST YET. Declaring the kind of the next
           recording is a control whose effect can never be seen; a recording is classified
           afterwards, on its own row, where saying so changes the row.
      */}
        {/*
        THE DATA, IN EXACTLY TWO KINDS, AND THEN WHAT IT ADDS UP TO.

        There are two kinds of evidence and they answer different questions: empty-chamber baselines
        build the settled surface, loaded roasts are what the model is fitted against. Both list
        their recordings as rows that OPEN - there is no separate detail panel - and the third region is what the ticked rows produce.
      */}

        {/* ONE: empty-chamber baselines. A handful of passes, all of them evidence, listed and ticked
          - exclusion rather than inclusion, so a pass captured while this screen is open is already
          in the map. */}
        <div className="calibration-region">
          <div className="region-head">
            <h3>Empty-chamber baselines - what the surface is built from</h3>
            <p>
              Add exact diagnostic recordings from the roaster, then tick only the passes this working calibration
              should use. Opening a row changes nothing; it only reveals the recording.
            </p>
          </div>
          <div className="recording-picker">
            <label className="form-field wide">
              <span className="form-field-label">Add an empty-chamber recording</span>
              <select
                value={addBaselineLogId}
                disabled={addableBaselines.length + baselineLogOptions.length === 0 || archiveBusy}
                onInput={(event) => setAddBaselineLogId(event.currentTarget.value)}
              >
                <option value="">
                  {archiveBusy
                    ? 'Waiting for the recording archive...'
                    : addableBaselines.length + baselineLogOptions.length > 0
                      ? 'Choose an exact recording'
                      : archive.state === 'available'
                        ? 'No unused diagnostic recordings are available'
                        : archive.message}
                </option>
                {addableBaselines.map((run) => (
                  <option key={run.id} value={`run:${run.id}`}>
                    {passLabel(run)} - saved evidence
                  </option>
                ))}
                {baselineLogOptions.map((entry) => (
                  <option key={entry.id} value={`log:${entry.id}`}>
                    {entry.id} - {entry.mode} -{' '}
                    {entry.startedAt ? new Date(entry.startedAt).toLocaleString() : 'time unavailable'}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={!addBaselineLogId || archiveBusy}
              onClick={addBaselineEvidence}
            >
              <Plus size={16} />
              {archiveBusy ? 'Waiting...' : 'Add baseline'}
            </button>
            <p className="picker-consequence">
              {chosenBaselineLog
                ? destinationFor(chosenBaselineLog).detail
                : chosenBaselineRun
                  ? 'Saved evidence; adding it here does not copy or delete anything.'
                  : archive.state === 'available'
                    ? 'Only calibration and proof recordings are shown here.'
                    : archive.message}
            </p>
            {archive.state !== 'available' && (
              <button
                type="button"
                className="compact-button"
                disabled={archiveBusy}
                onClick={() => {
                  void refreshArchive()
                }}
              >
                Retry recording list
              </button>
            )}
          </div>
          {addedBaselineRuns.length === 0 ? (
            <div className="empty-state">
              No empty-chamber baselines have been added. Record one above only when the machine may have drifted, then
              add that recording here.
            </div>
          ) : (
            <>
              <p className="fit-legend">
                Each row states what that pass is worth to the map. Newly added recordings stay unticked and collapsed
                until you deliberately include or inspect them.
              </p>
              <div className="fit-candidates">
                {addedBaselineRuns.map((run) => {
                  const grade = baselineGrades.get(run.id)
                  const included = selectedBaselineIds.includes(run.id)
                  const open = expandedRunId === run.id
                  return (
                    <div className={included ? 'fit-candidate' : 'fit-candidate excluded'} key={run.id}>
                      <div className="fit-candidate-head">
                        {inspectButton(run, open)}
                        <label>
                          <input
                            type="checkbox"
                            checked={included}
                            aria-label={`Include ${passLabel(run)} in preview`}
                            title="Include this recording in the working preview. This remains available while device storage is busy."
                            onChange={() => toggleBaseline(run.id)}
                          />
                          <strong>{passLabel(run)}</strong>
                          <small>
                            {run.form === 'grid'
                              ? `automatic grid, ${formatStepPairs(run.steps.slice(0, 3))}${run.steps.length > 3 ? ' ...' : ''}`
                              : `explicit sequence, ${formatStepPairs(run.steps.slice(0, 3))}`}{' '}
                            / {run.steps.length} steps / {sampleSummary(run)}
                            {run.notes ? ` / ${run.notes.slice(0, 70)}` : ''}
                          </small>
                        </label>
                        {recordingActions(run)}
                        <button
                          type="button"
                          className="icon-button ghost"
                          aria-label={`Remove ${passLabel(run)} from the set`}
                          title="Take this baseline out of this working set. Saved evidence and the original thermal recording are not deleted, and it can be added again."
                          onClick={() => removeBaselineRun(run.id)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="fit-badges">
                        <span
                          className={`fit-badge ${grade?.grade === 'good' ? 'good' : grade?.grade === 'poor' ? 'poor' : 'partial'}`}
                          title={BADGE_TITLES.mapQuality}
                        >
                          map quality {grade?.grade ?? 'unknown'}
                        </span>
                        <span className="fit-badge good" title={BADGE_TITLES.measured}>
                          {grade?.measured ?? 0} points measured
                        </span>
                        {(grade?.extrapolated ?? 0) > 0 && (
                          <span className="fit-badge partial" title={BADGE_TITLES.extrapolated}>
                            {grade!.extrapolated} points from a fit
                          </span>
                        )}
                        {(grade?.unreliable ?? 0) > 0 && (
                          <span className="fit-badge poor" title={BADGE_TITLES.unreliable}>
                            {grade!.unreliable} points unusable
                          </span>
                        )}
                        <span
                          className={`fit-badge ${grade?.hasPassiveTail ? 'good' : 'partial'}`}
                          title={BADGE_TITLES.tail}
                        >
                          {grade?.hasPassiveTail ? 'has a cool-down tail' : 'no cool-down tail'}
                        </span>
                      </div>
                      {grade && grade.reasons.length > 0 && <p className="fit-reason">{grade.reasons.join(' ')}</p>}
                      {open && recordingDetail(run)}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {/*
        TWO: loaded roasts, added one at a time - through the SAME picker the recordings bar uses.

        Loaded-roast import and empty-chamber import follow the same UI: a select and a button,
        sitting open, exactly like the one above.

        The region starts EMPTY and grows by one deliberate act each. The reason is scale: assume
        fifty to a hundred roasts, and an auto-listing is a wall of rows to scroll rather than a
        choice to make, while a default selection over that wall is a judgement made on the user's
        behalf about data only they can weigh. Removing a row is a separate act from
        unticking it: unticking leaves a roast out of this calibration, removing takes it out of the
        set, and neither deletes the recording.
      */}
        <div className="calibration-region">
          <div className="region-head">
            <h3>Loaded roasts - what the fit learns from</h3>
            <p>
              Add a roast recording already linked in History or one still available in storage. Adding creates an
              unticked, collapsed row; ticking it is the separate decision to use it in this fit.
            </p>
          </div>
          <div className="recording-picker">
            <label className="form-field wide">
              <span className="form-field-label">Add a loaded-roast recording</span>
              <select
                value={addRoastLogId}
                disabled={addableLoaded.length + roastLogOptions.length === 0 || archiveBusy}
                onInput={(event) => setAddRoastLogId(event.currentTarget.value)}
              >
                <option value="">
                  {addableLoaded.length + roastLogOptions.length > 0
                    ? 'Choose an exact recording'
                    : 'No unused linked roast recordings are available'}
                </option>
                {addableLoaded.map((candidate) => (
                  <option key={candidate.run.id} value={`run:${candidate.run.id}`}>
                    {loadedLabel(candidate)} - linked roast recording
                  </option>
                ))}
                {roastLogOptions.map((entry) => (
                  <option key={entry.id} value={`log:${entry.id}`}>
                    {entry.id} - {destinationFor(entry).roast?.name} -{' '}
                    {entry.startedAt ? new Date(entry.startedAt).toLocaleString() : 'time unavailable'}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={!addRoastLogId || archiveBusy}
              onClick={addLoadedEvidence}
            >
              <Plus size={16} />
              {archiveBusy ? 'Adding...' : 'Add roast recording'}
            </button>
            <p className="picker-consequence">
              {chosenRoastLog
                ? destinationFor(chosenRoastLog).detail
                : `${loadedRuns.length} linked loaded-roast recording${loadedRuns.length === 1 ? '' : 's'} are known here; ${roastLogOptions.length} unused recording${roastLogOptions.length === 1 ? '' : 's'} remain in storage. A recording appears only when it is linked to a roast record with a starting mass.`}
            </p>
          </div>
          {addedLoaded.length > 1 && (
            <div className="fit-bulk">
              <button
                type="button"
                className="compact-button"
                onClick={() => chooseFitInputs(addedLoaded.map((candidate) => candidate.run.id))}
              >
                Select all
              </button>
              <button
                type="button"
                className="compact-button"
                onClick={() =>
                  chooseFitInputs(
                    addedLoaded
                      .filter((candidate) => candidate.readiness.includedByDefault)
                      .map((candidate) => candidate.run.id),
                  )
                }
              >
                Only the usable ones
              </button>
              <button type="button" className="compact-button" onClick={() => chooseFitInputs([])}>
                Clear
              </button>
            </div>
          )}
          {addedLoaded.length === 0 ? (
            <div className="empty-state">
              No loaded roasts have been added to this working set. Add only the recordings this calibration should
              answer to.
            </div>
          ) : (
            <>
              <p className="fit-legend">
                Each row states what that roast is worth to a fit: whether fan and heat moved independently enough, how
                much the beans swelled, and which measurements are missing.
              </p>
              <div className="fit-candidates">
                {addedLoaded.map(({ run, roast, readiness, input }) => {
                  const grade = excitationGrade(readiness.excitation)
                  const open = expandedRunId === run.id
                  return (
                    <div className={readiness.fittable ? 'fit-candidate' : 'fit-candidate excluded'} key={run.id}>
                      <div className="fit-candidate-head">
                        {inspectButton(run, open)}
                        <label>
                          <input
                            type="checkbox"
                            checked={chosenIds.has(run.id)}
                            onChange={() => toggleFitInput(run.id)}
                          />
                          <strong>{input.label}</strong>
                          <small>
                            {passLabel(run)} / {sampleSummary(run)}
                            {roast ? ` / from roast history: ${roast.name}` : ' / no linked roast'}
                          </small>
                        </label>
                        {recordingActions(run)}
                        <button
                          type="button"
                          className="icon-button ghost"
                          aria-label={`Remove ${input.label} from the set`}
                          title="Take this roast back out of the set. The recording itself is not deleted, and it can be added again."
                          onClick={() => removeLoadedRun(run.id)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="fit-badges">
                        <span className={`fit-badge ${grade}`} title={BADGE_TITLES.excitation}>
                          {EXCITATION_BADGE[grade]}
                        </span>
                        <span
                          className={`fit-badge ${input.metrics?.expansionRatio === undefined ? 'partial' : 'good'}`}
                          title={BADGE_TITLES.expansion}
                        >
                          {input.metrics?.expansionRatio === undefined
                            ? 'swelling not measured'
                            : `beans swelled ${input.metrics.expansionRatio.toFixed(2)}x`}
                        </span>
                        {readiness.missingMeasurements.length > 0 && (
                          <span className="fit-badge partial" title={BADGE_TITLES.missing}>
                            not measured: {readiness.missingMeasurements.join(', ')}
                          </span>
                        )}
                      </div>
                      {readiness.reasons.length > 0 && (
                        <p className="fit-reason">
                          {readiness.fittable ? '' : 'Not usable as it stands: '}
                          {readiness.reasons.join(' ')}
                        </p>
                      )}
                      {open && recordingDetail(run)}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {/*
        ============================================================================================
        THE PREVIEW, AND THE ONE BUTTON THAT MAKES A RECORD OF IT.
        ============================================================================================

        Three requirements meet here and have one answer between them.

        Ticking boxes while choosing data must not change the applied calibration section, yet
        choosing data must have a visible effect - a
        checkbox that changes nothing is as bad as one that changes the wrong thing - but that effect
        belongs to a set that is explicitly NOT applied. This region is that set, and it is the only
        place on the page fed by the ticks.

        Both the settled surface and the how-long-a-move-takes table depend on the ticks, so both are
        here: the same two components that draw the applied pair at the top of the page, given the
        ticked passes instead of the applied ones. A preview that showed half of what it changes was
        teaching the reader that the other half does not move.

        Half the answer appearing by itself while the other half waits behind a Fit button would be a
        seam with no reason. Everything above the rule is a reading and appears by itself. The button below it does the one thing that is not a reading - it
        writes a named record - and it is called what it does.
      */}
        <div className="calibration-region working-region">
          <div className="region-head">
            <h3>
              Preview <span className="not-applied-badge">not applied</span>
            </h3>
            <p>
              Empty-chamber passes preview their measured surface and response times. Loaded roasts preview the fitted
              model against the temperature curve that was actually recorded. Nothing changes on the roaster unless Save
              and apply succeeds.
            </p>
          </div>

          <div className="working-surface">
            <strong>
              What the chamber settles at, from the {includedBaselineRuns.length} ticked pass
              {includedBaselineRuns.length === 1 ? '' : 'es'}
            </strong>
            <BaselineMapGrid map={workingMap} />
            <span>
              {workingPoints === appliedPoints
                ? `${workingPoints} mapped point${workingPoints === 1 ? '' : 's'}, the same count as the applied surface at the top of the page.`
                : `${workingPoints} mapped point${workingPoints === 1 ? '' : 's'} against ${appliedPoints} in the applied surface at the top of the page.`}
              {addedBaselineRuns.length > includedBaselineRuns.length
                ? ` ${addedBaselineRuns.length - includedBaselineRuns.length} added pass${addedBaselineRuns.length - includedBaselineRuns.length === 1 ? ' is' : 'es are'} unticked and left out.`
                : ''}
            </span>
            {workingPassContributions.length > 0 && (
              <div className="pass-contributions">
                <strong>What each selected pass contributes</strong>
                <p>
                  Recordings that measured the same Fan and Heat setting are pooled into one displayed map cell. Extra
                  measurements strengthen that cell; they do not create extra map points.
                </p>
                <ul>
                  {workingPassContributions.map((item) => (
                    <li key={item.id}>
                      <span>{item.label}</span>
                      <small>
                        {item.points} measured setting{item.points === 1 ? '' : 's'}; {item.unique} unique to this
                        selection, {item.repeated} shared with another selected pass.
                      </small>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="working-surface">
            <strong>
              {workingDashboardLoads.includes('100g')
                ? workingDashboardLoads.includes('empty')
                  ? 'Response times from the selected baseline and the previewed fit'
                  : 'Modelled bean-load response times from the previewed fit'
                : 'Empty-chamber response times from the selected baseline'}
            </strong>
            {workingDashboardView ? (
              <>
                <CalibrationDashboard dashboard={workingDashboardView} />
                <span>
                  {workingDashboardLoads.includes('empty')
                    ? 'The empty-chamber maps describe the empty chamber reaching a settled destination. They are not roast-duration predictions. '
                    : ''}
                  {workingDashboardLoads.includes('100g')
                    ? 'The 100 g and 250 g maps are model projections from the previewed coefficients; no loaded-roast measurement is implied. '
                    : selectedForFit.length > 0
                      ? 'Bean-load maps appear once the previewed fit is one Save and apply would accept. '
                      : ''}
                  Loaded-roast prediction is shown against its real timeline below.
                </span>
              </>
            ) : (
              <div className="empty-state">
                No empty-chamber response map is selected. Loaded-roast prediction is shown against the recorded roast
                below instead of being stretched into a synthetic settle-time heatmap.
              </div>
            )}
          </div>

          <div className="working-fit">
            {selectedForFit.length > 0 && (
              <div className="fit-preview" role="status">
                <div>
                  <strong>Loaded-roast fit preview</strong>
                  <span>
                    {previewFit
                      ? `Model error after the opening 3-minute turnaround across ${previewFit.sources} selected roast${previewFit.sources === 1 ? '' : 's'}: ${previewFit.startingRmsC.toFixed(1)} °C now → ${previewFit.rmsC.toFixed(1)} °C with this fit.`
                      : 'The selected roast has too few readable temperature samples to fit.'}
                  </span>
                </div>
                {previewReplay && (
                  <div className="fit-replay-preview">
                    <strong>
                      {previewReplay.candidate.input.label}: measured temperature versus fitted prediction
                    </strong>
                    <TraceChart
                      run={previewReplay.candidate.run}
                      boundaries={[]}
                      prediction={previewReplay.replay.samples}
                    />
                  </div>
                )}
                {previewFit && (
                  <div className="calibration-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Coefficient</th>
                          <th>Applied now</th>
                          <th>Preview</th>
                          <th>Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {THERMAL_FIELDS.map((field) => {
                          const current = (appliedCalibration as unknown as Record<string, number>)[field]
                          const next = previewPatch[field] ?? previewFit.coefficients[field]
                          const digits = field === 'thermalLossPerMinPerC' ? 4 : 2
                          return (
                            <tr key={field}>
                              <td data-label="Coefficient">{COEFFICIENT_LABELS[field]}</td>
                              <td data-label="Applied now">{current.toFixed(digits)}</td>
                              <td data-label="Preview">{next.toFixed(digits)}</td>
                              <td data-label="Change">
                                {next === current
                                  ? 'No change'
                                  : `${next > current ? '+' : ''}${(next - current).toFixed(digits)}`}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {includedBaselineRuns.length > 0 && previewFit && (
                  <small>
                    The selected baseline pins any airflow coefficients it directly measured; the loaded roast fits the
                    remaining heater and bean-loss terms.
                  </small>
                )}
                {previewUnstable.length > 0 && (
                  <div className="stale-notice fit-identifiability-warning" role="alert">
                    <div>
                      <strong>The evidence does not determine one usable answer</strong>
                      <span>
                        Materially different values for {fieldList(previewUnstable)} fit almost equally well. Save and
                        apply is blocked. Keep a complete fan-only cooling tail and select an empty-chamber baseline
                        with same-heat Fan changes.
                      </span>
                    </div>
                  </div>
                )}
                {previewImplausible && (
                  <div className="stale-notice" role="alert">
                    <div>
                      <strong>This preview cannot be applied</strong>
                      <span>{previewImplausible}</span>
                    </div>
                  </div>
                )}
                {previewFit?.pinned.length ? (
                  <small className="fit-warning">
                    At a search bound: {previewFit.pinned.map((field) => COEFFICIENT_LABELS[field]).join(', ')}. Add a
                    roast with more varied Fan and Heat if that is unexpected.
                  </small>
                ) : undefined}
              </div>
            )}
            {previewInheritedFields.length > 0 && (
              <div className="stale-notice">
                <div>
                  <strong>
                    {previewInheritedAvailable
                      ? 'Provisional bridge for your first loaded roast'
                      : 'This empty-chamber set is not complete yet'}
                  </strong>
                  <span>
                    {previewInheritedAvailable
                      ? `${fieldList(previewInheritedFields)} was not measured by this pass. Save and apply will keep ${previewInheritedFields.map((field) => `${COEFFICIENT_LABELS[field]} at ${status.appliedCoefficients?.[field]} ${COEFFICIENT_UNITS[field]}`).join(', ')}, exactly as currently applied on the roaster. The confirmation appears before anything is saved. After the roast, fit and apply its loaded recording to replace this inherited value.`
                      : `The pass did not measure ${fieldList(previewInheritedFields)}, and the roaster is not reporting every missing value to inherit. Save and apply will stop before writing anything.`}
                  </span>
                </div>
              </div>
            )}
            <p className="fit-reason">
              {selectedForFit.length > 0
                ? `The preview above is the exact fit from the ${selectedForFit.length} ticked roast${selectedForFit.length === 1 ? '' : 's'}. Save and apply records those coefficients and offers that same set to the roaster.`
                : includedBaselineRuns.length > 0
                  ? `Coefficients will be what these passes measured about the empty chamber, read off ${passLabel(includedBaselineRuns[0])}${includedBaselineRuns[1] ? ` against ${passLabel(includedBaselineRuns[1])}` : ''}. Tick a loaded roast under Loaded roasts to fit against a real batch instead, which is what the model is actually for.`
                  : 'Nothing is ticked, so there is nothing to save. Tick an empty-chamber pass, a loaded roast, or both.'}
            </p>
            <button
              type="button"
              className="primary-button"
              disabled={
                fitting ||
                Boolean(applyBlocked) ||
                previewUnstable.length > 0 ||
                Boolean(previewImplausible) ||
                (selectedForFit.length === 0 && includedBaselineRuns.length === 0)
              }
              title={
                applyBlocked ??
                previewImplausible ??
                (previewUnstable.length > 0
                  ? 'The selected evidence does not identify a stable coefficient set.'
                  : 'Save this calibration, then apply the same coefficients to the roaster and adopt them here only after the roaster accepts them.')
              }
              onClick={() => void saveWorkingCalibration(undefined, undefined, true)}
            >
              <Save size={17} />
              {fitting ? 'Saving and applying...' : 'Save and apply'}
            </button>
            {(message || error) && (
              <div className={error ? 'storage-error-banner' : 'import-message'} role={error ? 'alert' : 'status'}>
                <span>{error || message}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss calibration message"
                  onClick={() => {
                    setMessage('')
                    setError('')
                  }}
                >
                  x
                </button>
              </div>
            )}
            {fitConfirmation && (
              <div className="import-message" role="status">
                {fitConfirmation}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="calibration-panel snapshot-panel">
        <div className="calibration-panel-heading">
          <div className="setting-icon">
            <Save />
          </div>
          <div>
            <span className="eyebrow">History</span>
            <h2>
              <TermLabel term="snapshot" label="Saved calibrations" />
            </h2>
          </div>
          <span className="calibration-duration" title={CALIBRATION_HELP.calibrationName}>
            Saved deliberately from the working preview
          </span>
        </div>
        {orderedSnapshots.length === 0 ? (
          <div className="empty-state">
            No saved calibrations yet. Build a calibration from the recordings you trust, then use Save and apply.
          </div>
        ) : (
          <div className="calibration-table-wrap">
            <table className="diff-table snapshot-table">
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">Expand</span>
                  </th>
                  <th>Saved</th>
                  <th>Name</th>
                  <th>Points</th>
                  <th>Heat gain</th>
                  <th>Thermal loss</th>
                  <th>Rise taus</th>
                  <th className="snapshot-action-head">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {orderedSnapshots.flatMap((snapshot) => {
                  const applied = patchMatches(snapshot.patch, appliedPatch as Record<string, number | undefined>)
                  const inheritedFields = Object.keys(snapshot.inheritedCoefficients ?? {}) as ThermalCoefficientField[]
                  const open = expandedSnapshotId === snapshot.id
                  const toggle = () => setExpandedSnapshotId(open ? undefined : snapshot.id)
                  const staleness = fitStaleness(snapshot, currentInputs)
                  /*
                   * HOW MUCH OF ITS PLAN THIS ONE ACTUALLY MEASURED.
                   *
                   * A baseline stopped after a few seconds still appears in saved calibrations, so it must
                   * be flagged as not completed. A pass declares its grid before it runs, so "2 of 12" is a fact on the record rather than an inference, and it
                   * is the single most useful thing this list was not saying.
                   */
                  const coverage = snapshotCoverage(snapshot, runsById)
                  return [
                    <tr
                      key={snapshot.id}
                      className={`snapshot-row${applied ? ' applied' : ''}${open ? ' open' : ''}`}
                      onClick={toggle}
                    >
                      <td className="snapshot-expand">
                        {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                      </td>
                      <td>{new Date(snapshot.createdAt).toLocaleString()}</td>
                      <td>
                        <strong>{snapshot.name}</strong>
                        {applied && <span className="applied-badge">Currently applied</span>}
                        {inheritedFields.length > 0 && <span className="incomplete-badge">Provisional</span>}
                        {coverage.incomplete && (
                          <span
                            className="incomplete-badge"
                            title="This pass ended before it finished its grid, so the surface it saved has holes where the remaining points would have been."
                          >
                            Incomplete
                          </span>
                        )}
                        {staleness.stale && <span className="stale-badge">Inputs changed</span>}
                      </td>
                      <td
                        title={
                          coverage.planned > 0
                            ? 'Grid points that settled, against the number the pass set out to measure.'
                            : 'Fitted against whole roasts rather than against a grid of settings, so there are no grid points to count.'
                        }
                      >
                        {coverage.planned > 0
                          ? `${coverage.measured} of ${coverage.planned}`
                          : coverage.roasts > 0
                            ? `${coverage.roasts} roast${coverage.roasts === 1 ? '' : 's'}`
                            : coverage.measured > 0
                              ? `${coverage.measured}`
                              : '--'}
                      </td>
                      <td>
                        {snapshot.patch.heaterGainCPerMinAt10 === undefined
                          ? '--'
                          : `${snapshot.patch.heaterGainCPerMinAt10} °C/min at 10`}
                      </td>
                      <td>
                        {snapshot.patch.thermalLossPerMinPerC === undefined
                          ? '--'
                          : `${snapshot.patch.thermalLossPerMinPerC} /min/C`}
                      </td>
                      <td>{snapshotTauSummary(snapshot)}</td>
                      <td className="snapshot-row-action">
                        <button
                          type="button"
                          className="icon-button danger-icon"
                          disabled={Boolean(catalogMutationBlockedReason)}
                          title={catalogMutationBlockedReason ?? 'Delete'}
                          aria-label={`Delete saved calibration ${snapshot.name}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (window.confirm('Delete this saved calibration?')) void deleteSnapshot(snapshot.id)
                          }}
                        >
                          <Trash2 size={18} />
                        </button>
                      </td>
                    </tr>,
                    open ? (
                      <tr key={`${snapshot.id}-detail`} className="snapshot-detail-row">
                        <td colSpan={8}>
                          <div className="snapshot-detail">
                            {/* What an unfinished pass costs, stated where the decision to apply it is made. */}
                            {inheritedFields.length > 0 && (
                              <div className="stale-notice">
                                <div>
                                  <strong>Provisional bridge for the first loaded roast</strong>
                                  <span>
                                    {fieldList(inheritedFields)} was inherited unchanged from the roaster's previously
                                    applied calibration;{' '}
                                    {inheritedFields
                                      .map(
                                        (field) =>
                                          `${COEFFICIENT_LABELS[field]} ${snapshot.inheritedCoefficients?.[field]?.value}`,
                                      )
                                      .join(', ')}{' '}
                                    was not measured by this empty-chamber pass. Capture a loaded roast, then fit and
                                    apply it to replace this provisional set.
                                  </span>
                                </div>
                              </div>
                            )}
                            {coverage.incomplete && (
                              <div className="stale-notice">
                                <div>
                                  <strong>This pass did not finish its grid</strong>
                                  <span>
                                    It measured {coverage.measured} of the {coverage.planned} settings it set out to
                                    measure, because it was stopped or ended early. The settled surface it saved has
                                    holes where the rest would have been, and every coefficient in it rests on that much
                                    less evidence - the heat gain in particular is a straight line fitted through
                                    however many heat steps survived. Check it against a completed pass before you apply
                                    it.
                                  </span>
                                </div>
                              </div>
                            )}
                            {staleness.stale && (
                              <div className="stale-notice">
                                <div>
                                  <strong>Inputs changed since this fit</strong>
                                  <span>{staleness.detail}</span>
                                </div>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={fitting || staleness.reason === 'input-missing'}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    refit(snapshot)
                                  }}
                                >
                                  <SlidersHorizontal size={16} />
                                  Refit
                                </button>
                              </div>
                            )}
                            {snapshot.inputs && snapshot.inputs.length > 0 && (
                              <div className="fit-inputs">
                                <strong>
                                  Fitted from {snapshot.inputs.length} roast{snapshot.inputs.length === 1 ? '' : 's'}
                                  {snapshot.fitRmsC === undefined
                                    ? ''
                                    : `; replaying them, the model finished ${snapshot.fitRmsC.toFixed(1)} °C out on average`}
                                </strong>
                                <div className="calibration-table-wrap">
                                  <table className="diff-table">
                                    <thead>
                                      <tr>
                                        <th>Roast</th>
                                        <th>Bean lot</th>
                                        <th>Batch g</th>
                                        <th>Green g/ml</th>
                                        <th>Roasted g/ml</th>
                                        <th>Expansion</th>
                                        <th>Mass loss</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {snapshot.inputs.map((input) => (
                                        <tr key={input.runId}>
                                          <td>{input.roastName ?? input.label}</td>
                                          <td>{input.beanLotName ?? '--'}</td>
                                          <td>{input.massG ?? '--'}</td>
                                          <td>{formatMetric(input.metrics?.greenDensityGPerMl, 3)}</td>
                                          <td>{formatMetric(input.metrics?.roastedDensityGPerMl, 3)}</td>
                                          <td>
                                            {input.metrics?.expansionRatio === undefined
                                              ? '--'
                                              : `${input.metrics.expansionRatio.toFixed(2)}x`}
                                          </td>
                                          <td>{formatMetric(input.metrics?.massLossPercent, 1, ' %')}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                <span className="fit-inputs-note">
                                  These covariates are recorded so a future regression of heat absorption against
                                  expansion has its dataset. No expansion term is in the thermal model yet - it will be
                                  fitted when the run count supports it, not invented before.
                                </span>
                              </div>
                            )}
                            <SavedCalibrationMaps
                              snapshot={snapshot}
                              runsById={runsById}
                              appliedCalibration={appliedCalibration}
                            />
                            {snapshotOverlayId === snapshot.id && (
                              <div
                                className="snapshot-comparison"
                                role="region"
                                aria-label={`${snapshot.name} compared with current calibration`}
                              >
                                <h4>Compared with current calibration</h4>
                                <p>
                                  The saved values and the values in use now are shown side by side. Positive changes
                                  raise the saved value; negative changes lower it.
                                </p>
                                <div className="calibration-table-wrap">
                                  <table className="diff-table">
                                    <thead>
                                      <tr>
                                        <th>Coefficient</th>
                                        <th>Current</th>
                                        <th>Saved</th>
                                        <th>Change</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {THERMAL_FIELDS.map((field) => {
                                        const current = (appliedCalibration as unknown as Record<string, number>)[field]
                                        const saved = snapshot.patch[field]
                                        const change = saved === undefined ? undefined : saved - current
                                        return (
                                          <tr key={field}>
                                            <td>{COEFFICIENT_LABELS[field]}</td>
                                            <td>{current}</td>
                                            <td>{saved ?? '--'}</td>
                                            <td>
                                              {change === undefined
                                                ? '--'
                                                : (change >= 0 ? '+' : '') +
                                                  change.toFixed(field === 'thermalLossPerMinPerC' ? 4 : 2)}
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                            <div className="snapshot-values">
                              {Object.entries(snapshot.patch).map(([field, value]) => (
                                <span key={field}>
                                  {field.replace(/([A-Z])/g, ' $1').toLowerCase()}
                                  <strong>{value}</strong>
                                </span>
                              ))}
                            </div>
                            {/*
                      ONE ACTION. A separate "Send to controller" beside Apply would make the user
                      know that this browser and the roaster each hold their own copy, and in which
                      order to press two buttons to end up with one answer. Apply does both, roaster
                      first - see the `apply` comment for why that ordering is the
                      only one that cannot lie about what is in force.
                    */}
                            <div className="snapshot-actions">
                              <button
                                type="button"
                                className="primary-button"
                                disabled={busy || Boolean(applyBlocked)}
                                title={
                                  applyBlocked ??
                                  (deviceHoldsCalibration
                                    ? 'Send these coefficients to the roaster and, once it has taken them, plan with them here'
                                    : 'This roaster firmware holds no calibration of its own, so this applies in this browser only')
                                }
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void apply(snapshot)
                                }}
                              >
                                <SlidersHorizontal size={17} />
                                {applyingId === snapshot.id ? 'Applying...' : applied ? 'Apply again' : 'Apply'}
                              </button>
                              <button
                                type="button"
                                className={
                                  snapshotOverlayId === snapshot.id ? 'secondary-button active' : 'secondary-button'
                                }
                                title="Show this saved calibration directly beside the values in use now"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setSnapshotOverlayId(snapshotOverlayId === snapshot.id ? undefined : snapshot.id)
                                }}
                              >
                                <GitCompareArrows size={17} />
                                {snapshotOverlayId === snapshot.id ? 'Hide comparison' : 'Compare with current'}
                              </button>
                            </div>
                            <p className="snapshot-apply-note">
                              {applyBlocked
                                ? `Apply is waiting: ${applyBlocked.charAt(0).toLowerCase()}${applyBlocked.slice(1)}.`
                                : deviceHoldsCalibration
                                  ? 'Apply shows you the exact old and new numbers, sends them to the roaster, and adopts them here only once the roaster has taken them. If it refuses, nothing changes anywhere.'
                                  : 'This roaster firmware holds no calibration of its own, so Apply changes what this browser plans with and nothing on the machine.'}
                            </p>
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ].filter(Boolean)
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}
