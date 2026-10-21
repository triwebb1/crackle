import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import type { HttpControllerClient } from '../controller/client'
import { defaultCalibration } from '../data/calibration'
import { formatLocalDateTime } from '../domain/dateTime'
import type { CalibrationRun, ControllerStatus } from '../domain/types'
import { CalibrationView } from './CalibrationView'

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: Date.now(),
  firmwareVersion: '2026-07-26.40',
  bootId: '3',
  manualLockout: false,
  roaster: { deviceId: 'test-device', modelId: 'freshroast-sr800', displayName: 'Kitchen SR800', simulated: false },
  thermocoupleValid: true,
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  ...overrides,
})

const AMBIENT_C = 24.5
const settlingRun: CalibrationRun = {
  id: 'calibration-settling',
  capturedAt: '2026-07-26T10:00:00.000Z',
  recordedOn: {
    deviceId: 'test-device',
    modelId: 'freshroast-sr800',
    displayNameAtCapture: 'Kitchen SR800',
    simulated: false,
    firmwareVersion: '2026-07-26.40',
    identitySource: 'roaster',
  },
  form: 'grid',
  steps: [
    { fan: 5, heat: 1 },
    { fan: 5, heat: 3 },
  ],
  maxStepSeconds: 150,
  minStepSeconds: 10,
  settleSeconds: 3,
  settleBandC: 5,
  ambientC: AMBIENT_C,
  samples: (() => {
    const samples: CalibrationRun['samples'] = []
    let temperature = AMBIENT_C
    let tMs = 0
    const hold = (fan: number, heat: number, settledC: number, seconds: number) => {
      const from = temperature
      for (let second = 0; second < seconds; second += 1) {
        samples.push({
          tMs,
          thermocoupleC: temperature,
          coldJunctionC: AMBIENT_C,
          effectiveFan: fan,
          effectiveHeat: heat,
        })
        tMs += 1000
        temperature = settledC - (settledC - from) * Math.exp(-(second + 1) / 20)
      }
    }
    hold(5, 1, 120, 150)
    hold(5, 3, 210, 150)
    hold(0, 0, AMBIENT_C, 400)
    return samples
  })(),
  notes: '',
}

const SOURCE = readFileSync(new URL('./CalibrationView.tsx', import.meta.url), 'utf8')
const render = (props: Partial<Parameters<typeof CalibrationView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(CalibrationView, {
      status: status(),
      nowMs: Date.now(),
      runs: [settlingRun],
      snapshots: [],
      appliedPatch: {},
      appliedCalibration: defaultCalibration,
      roasts: [],
      onSaveRun: async () => undefined,
      onDeleteRun: async () => undefined,
      onSaveSnapshot: async () => undefined,
      onDeleteSnapshot: async () => undefined,
      onFetchCalibrationRecording: async () => '',
      onApply: async () => ({ ok: true }),
      ...props,
      controller: props.controller ?? ({} as HttpControllerClient),
    }),
  )
const position = (markup: string, needle: string) => {
  const index = markup.indexOf(needle)
  expect(index, `${needle} is not on the page`).toBeGreaterThan(-1)
  return index
}

describe('calibration workflow contract', () => {
  it('orders current state, rare recording, working build, then saved history', () => {
    const markup = render()
    expect(position(markup, '<h2>Current calibration</h2>')).toBeLessThan(
      position(markup, '<h2>Record an empty-chamber baseline</h2>'),
    )
    expect(position(markup, '<h2>Record an empty-chamber baseline</h2>')).toBeLessThan(
      position(markup, '<h2>Build a calibration</h2>'),
    )
    expect(position(markup, '<h2>Build a calibration</h2>')).toBeLessThan(markup.lastIndexOf('Saved calibrations'))
  })

  it('silently scopes calibration evidence to the installed roaster', () => {
    const foreign = {
      ...settlingRun,
      id: 'foreign-calibration',
      notes: 'FOREIGN CALIBRATION MUST NOT APPEAR',
      recordedOn: { ...settlingRun.recordedOn, deviceId: 'other-device', displayNameAtCapture: 'Other roaster' },
    }
    const markup = render({ runs: [settlingRun, foreign] })
    expect(markup).not.toContainCode('Calibration record source')
    expect(markup).not.toContainCode('Physical')
    expect(markup).not.toContainCode('Other roaster')
    expect(markup).not.toContainCode('FOREIGN CALIBRATION MUST NOT APPEAR')
    expect(SOURCE).toContainCode('const sorted = activeSorted')
    expect(SOURCE).toContainCode("sourceMatches(snapshot.recordedOn, 'active', activeDeviceId)")
  })
  it('uses separate stored-recording pickers without exposing device jargon', () => {
    const markup = render()
    expect(markup).toContainCode('Add an empty-chamber recording')
    expect(markup).toContainCode('Add a loaded-roast recording')
    expect(markup).toContainCode('Add a roast recording already linked in History or one still available in storage.')
    expect(markup).not.toContainCode('exact device recording')
    expect(markup).not.toContainCode('device-backed')
    expect(markup).not.toContainCode('exact roaster log')
    expect(SOURCE).toContainCode('baselineLogOptions')
    expect(SOURCE).toContainCode('roastLogOptions')
    expect(SOURCE).toContainCode('sourceLogId: entry.recordingOrigin.logId')
    expect(SOURCE).toContainCode('capturedAt: entry.startedAt')
    expect(SOURCE).toContainCode('recordedOn: entry.recordedOn')
    expect(SOURCE).toContainCode('decodeCrkThermalSamples(archiveBytes, entry.id)')
    expect(SOURCE).toContainCode('controller.fetchDeviceLogCsv(entry.id)')
    expect(SOURCE).not.toContainCode('const [csv, archiveBytes] = await Promise.all')
    expect(SOURCE.indexOf('const archiveBytes = await controller.fetchDeviceLogFile(entry.id)')).toBeLessThan(
      SOURCE.indexOf('decodeCrkThermalSamples(archiveBytes, entry.id)'),
    )
    expect(SOURCE).toContainCode(
      'decodeCrkThermalSamples(archiveBytes, entry.id) ?? await controller.fetchDeviceLogCsv(entry.id)',
    )
    expect(SOURCE).toContainCode('finally {\n      setArchiveBusy(false)')
    expect(SOURCE).toContainCode('The roaster stopped responding while the recording was downloading')
    expect(SOURCE).not.toContainCode('Import CSV')
    expect(SOURCE).not.toContainCode('Download everything')
  })

  it('associates restored recordings by origin while fetching their current storage address', () => {
    expect(SOURCE).toContainCode('calibrationRecordingKey(run)')
    expect(SOURCE).toContainCode('recordingKey(entry.recordingOrigin)')
    expect(SOURCE).toContainCode('sourceLogId: entry.recordingOrigin.logId')
    expect(SOURCE).toContainCode('recordedOn: entry.recordedOn')
    expect(SOURCE).toContainCode('controller.fetchDeviceLogCsv(entry.id)')
    expect(SOURCE).not.toContainCode('run.sourceLogId === entry.id')
  })

  it('keeps adding, selecting, and expanding as separate working edits', () => {
    expect(SOURCE).toContainCode('Adding creates an unchecked, collapsed evidence row')
    expect(SOURCE).toContainCode('selectedBaselineIds.includes(run.id)')
    expect(SOURCE).toContainCode('setAddedLoadedIds((current) => [...current, runId])')
    expect(SOURCE).not.toContainCode('setExpandedRunId(runId)')
  })

  it('uses a leading disclosure and states immutable classification without inventing edit affordances', () => {
    const markup = render()
    expect(markup).toContainCode('recording-disclosure')
    expect(markup).toContainCode('Expand recording')
    expect(SOURCE).toContainCode('{inspectButton(run, open)}\n                  <label>')
    expect(SOURCE).not.toContainCode('<RoasterSourceBadge')
    expect(SOURCE).toContainCode('<label>')
    expect(SOURCE).toContainCode(
      "`Loaded roast${run.massG ? ` - ${run.massG} g batch` : ''}${linkedRoast ? ` - ${linkedRoast.name}` : ''}`",
    )
    expect(SOURCE).toContainCode("'Empty chamber - a diagnostic pass, nothing in it'")
    expect(SOURCE).not.toContainCode('source and linked roast cannot be changed here')
    expect(SOURCE).not.toContainCode('Correct what this recording is')
  })

  it('opens directly onto the roast-style raw trace and step results without the legacy mesh chart', () => {
    expect(SOURCE).toContainCode('<TraceChart run={run} boundaries={boundaries} limitC={analysis.limitC} />')
    expect(SOURCE).toContainCode('<h4>Step-by-step results</h4>')
    expect(SOURCE).not.toContainCode('<MeshChart')
    expect(SOURCE).not.toContainCode('<details className="calibration-detail"')
    expect(SOURCE).not.toContainCode('Step detail and raw trace')
  })

  it('keeps record actions on collapsed rows and empty-pass detail limited to measurements', () => {
    expect(SOURCE).toContainCode('const recordingActions = (run: CalibrationRun)')
    expect(SOURCE).toContainCode('{recordingActions(run)}')
    expect(SOURCE).toContainCode('Download this recording as thermal.csv')
    expect(SOURCE).not.toContainCode('className="calibration-run-actions"')
    expect(SOURCE).not.toContainCode('These are what this pass measured')
    expect(SOURCE).toContainCode('{loaded && <div className={`model-fit-detail ${verdict.grade}`}>')
    expect(SOURCE).not.toContainCode("loaded ? verdict.grade : 'chamber'")
  })

  it('keeps saved-calibration deletion in the collapsed row instead of its expanded detail', () => {
    expect(SOURCE).toContainCode('<td className="snapshot-row-action">')
    expect(SOURCE).toContainCode('aria-label={`Delete saved calibration ${snapshot.name}`}')
    const detail = SOURCE.slice(
      SOURCE.indexOf('className="snapshot-detail-row"'),
      SOURCE.indexOf('</section>\n\n  </section>'),
    )
    expect(detail).not.toContainCode('aria-label="Delete saved calibration"')
  })
  it('disables calibration catalog mutations while the roaster is finalizing a recording', () => {
    const reason = 'The current thermal recording is still being finalized.'
    const markup = render({ catalogMutationBlockedReason: reason })
    expect(markup).toContainCode(reason)
    expect(SOURCE).toContainCode('disabled={Boolean(catalogMutationBlockedReason)}')
    expect(SOURCE).toContainCode(
      "if (catalogMutationBlockedReason) { setMessage(''); setError(catalogMutationBlockedReason); return }",
    )
    expect(markup).toContainCode(
      `aria-label="Include Empty-chamber baseline - ${formatLocalDateTime(settlingRun.capturedAt)} in preview"`,
    )
    expect(markup).toContainCode('This remains available while device storage is busy.')
  })

  it('keeps the applied dashboard visible but withholds the working maps until evidence is ticked', () => {
    const markup = render()
    expect(markup).toContainCode('Time to heat')
    expect(markup).toContainCode('Time to cool')
    expect(markup.match(/calibration-heatmap-card calibration-heatmap-card--/g)).toHaveLength(2)
    expect(markup).toContainCode('No empty-chamber response map is selected')
    expect(markup).toContainCode('instead of being stretched into a synthetic settle-time heatmap')
    expect(markup).not.toContainCode('calibration-heatmap-detail')
    expect(markup).not.toContainCode('Hover, focus, or tap')
    expect(SOURCE).toContainCode('workingDashboardLoads.length > 0 ? buildCalibrationDashboard')
  })

  it('offers applied bean-load maps exactly when the roaster reports complete coefficients', () => {
    // Device acceptance already enforced plausibility, so the applied dashboard needs no fit
    // gate — but an incomplete applied set (fresh device, empty-chamber-only apply) must not
    // render invented mass surfaces.
    expect(SOURCE).toContainCode("appliedLoadedMapsReady ? ['empty', '100g', '250g'] : ['empty']")
    expect(SOURCE).toContainCode(
      'THERMAL_FIELDS.every((field) => Number.isFinite(status.appliedCoefficients?.[field]))',
    )
  })

  it('freezes baseline-measured airflow terms inside both fit call sites', () => {
    // Fitting all four coefficients freely and swapping airflow in afterwards produces a combined
    // set whose replay error was never measured; the fit must receive the baseline pins up front.
    expect(SOURCE).toContainCode('{ frozen: baselinePinnedAirflow(previewPassPatch) }')
    expect(SOURCE).toContainCode('{ frozen: baselinePinnedAirflow(passPatch) }')
  })

  it('gates working bean-load maps on a fit that Save and apply would accept', () => {
    // The 100 g / 250 g preview panels are model projections. They must never render from a fit
    // the apply gate refuses — an implausible candidate once painted 30-minute settle surfaces.
    expect(SOURCE).toContainCode('workingPreviewLoads(includedBaselineRuns.length > 0, previewFitApplyable)')
    expect(SOURCE).toContainCode('&& previewUnstable.length === 0')
    expect(SOURCE).toContainCode('&& previewImplausible === undefined')
    expect(SOURCE).toContainCode('Bean-load maps appear once the previewed fit is one Save and apply would accept.')
  })

  it('disables Start with concise controller-owned readiness progress', () => {
    const markup = render({
      status: status({
        calibrationReady: false,
        calibrationReadiness: 'stabilizing',
        calibrationStableForMs: 4_200,
      }),
    })
    expect(markup).toContainCode('Waiting to start:')
    expect(markup).toContainCode('Keep the empty roaster steady for 6 more seconds')
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>[^<]*(?:<[^>]+>)*Start pass/)

    const latched = render({
      status: status({ calibrationReady: false, calibrationReadiness: 'sensor_fault_latched' }),
    })
    expect(latched).toContainCode('The thermocouple fault is latched; power-cycle the roaster before calibration')
  })

  it('retains the completed pass summary and step journal beside the baseline controls', () => {
    const calibration = {
      active: false,
      stepIndex: 3,
      stepCount: 4,
      endReason: 'completed',
      completedSteps: [
        { index: 0, fan: 5, heat: 1, elapsedSec: 64, temperatureC: 118.26, outcome: 'settled' },
        { index: 1, fan: 5, heat: 3, elapsedSec: 120, temperatureC: 174.1, outcome: 'capped' },
      ],
    } as ControllerStatus['calibration']
    const markup = render({ status: status({ calibration }) })
    expect(markup).toContainCode('Completed')
    expect(markup).toContainCode('4 of 4 steps completed')
    expect(markup).toContainCode('Latest 2 retained steps')
    expect(markup).toContainCode('Completed pass summary retained while its device recording is reconciled.')
    expect(markup).toContainCode('Settled at 118.3 °C')
    expect(markup).toContainCode('Reached time limit at 174.1 °C')
  })

  it('reports all 48 completed steps while labeling the bounded latest-step journal honestly', () => {
    const completedSteps = Array.from({ length: 12 }, (_, offset) => ({
      index: 36 + offset,
      fan: 5,
      heat: offset + 1,
      elapsedSec: 60,
      temperatureC: 120 + offset,
      outcome: 'settled' as const,
    }))
    const calibration = {
      active: false,
      stepIndex: 48,
      stepCount: 48,
      endReason: 'completed',
      completedSteps,
    } as ControllerStatus['calibration']
    const markup = render({ status: status({ calibration }) })
    expect(markup).toContainCode('48 of 48 steps completed')
    expect(markup).toContainCode('Latest 12 retained steps')
    expect(markup).not.toContainCode('12 of 48 steps')
  })

  it('localizes routine pass feedback and auto-dismisses stored success', () => {
    const runPanel = SOURCE.slice(
      SOURCE.indexOf('<section className="calibration-panel run-panel">'),
      SOURCE.indexOf('<section className="calibration-panel fit-choice-panel">'),
    )
    expect(SOURCE).not.toContainCode('calibration-page-feedback')
    expect(runPanel).toContainCode('{ingestBanner &&')
    expect(runPanel).toContainCode('{commandError &&')
    expect(runPanel).toContainCode("ingest.phase === 'failed' && <button")
    expect(runPanel).not.toContainCode("ingest.phase === 'stored' || ingest.phase === 'failed'")
    expect(SOURCE).toContainCode("if (ingest.phase !== 'stored') return")
    expect(SOURCE).toContainCode("window.setTimeout(() => dispatchIngest({ type: 'dismiss' }), 6000)")
    const announce = SOURCE.slice(SOURCE.indexOf('const announce ='), SOURCE.indexOf('const start ='))
    expect(announce).toContainCode("setCommandError(result.ok ? ''")
    expect(announce).not.toContainCode('setMessage(')
  })

  it('shows controller-reported progress and reported mock speed', () => {
    const calibration = {
      active: true,
      stepIndex: 1,
      stepCount: 4,
      currentFanLevel: 5,
      currentHeatLevel: 3,
      stepElapsedSec: 22,
      settleState: 'waiting_for_transition',
      simulationSpeed: 12,
      completedSteps: [{ index: 0, fan: 5, heat: 1, elapsedSec: 64, temperatureC: 118.26, outcome: 'settled' }],
    } as ControllerStatus['calibration']
    const markup = render({ status: status({ calibration }) })
    expect(markup).toContainCode('Step 2 of 4')
    expect(markup).toContainCode('Waiting for this setting to produce a measurable temperature change')
    expect(markup).toContainCode('development mock at 12x speed')
    expect(markup).toContainCode('Latest retained calibration steps')
    expect(markup).toContainCode('Settled at 118.3 °C')
    expect(SOURCE).not.toContainCode('stepClock')
  })

  it('uses one brief inline save confirmation instead of repeating durable fit detail', () => {
    expect(SOURCE).toContainCode("'Saved and applied'")
    expect(SOURCE).toContainCode('Saved and applied provisionally')
    expect(SOURCE).toContainCode('window.setTimeout(() => setFitConfirmation(undefined), 4000)')
    expect(SOURCE).toContainCode(
      '{fitConfirmation && <div className="import-message" role="status">{fitConfirmation}</div>}',
    )
    expect(SOURCE).not.toContainCode('working-fit-result')
    expect(SOURCE).not.toContainCode('Saved: {fitResult.name}')
  })

  it('preflights and confirms Save-and-apply before persistence', () => {
    const markup = render()
    expect(markup).toContainCode('Save and apply')
    const prepare = SOURCE.indexOf('const preparedApply = applyAfterSave ? prepareApply(snapshot) : undefined')
    const cancelled = SOURCE.indexOf('if (applyAfterSave && !preparedApply) return')
    const save = SOURCE.indexOf('await onSaveSnapshot(snapshotToSave)')
    expect(prepare).toBeGreaterThan(-1)
    expect(prepare).toBeLessThan(cancelled)
    expect(cancelled).toBeLessThan(save)
    expect(SOURCE).toContainCode('if (applyBlocked)')
    expect(markup).not.toContainCode('Save this as a calibration')
  })

  it('blocks the combined action before persistence and reports post-save refusal honestly', () => {
    const blocked = render({ applyCalibrationBlockedReason: 'Controller calibration is unavailable' })
    expect(blocked).toMatch(/<button[^>]*disabled[^>]*title="Controller calibration is unavailable"[^>]*>/)
    expect(SOURCE).toContainCode("setFitConfirmation('Saved, not applied')")
    expect(SOURCE).toContainCode('was saved in History, but the roaster did not take it')
    expect(SOURCE).toContainCode(
      "setFitConfirmation(deviceHoldsCalibration ? 'Saved; roaster updated' : 'Saved, not applied')",
    )
    expect(SOURCE).toContainCode('browser view has not reconciled it')
  })

  it('waits for calibration evidence acknowledgement before claiming it was saved', () => {
    expect(SOURCE).toContainCode('const store = useCallback(async')
    expect(SOURCE).toContainCode('await onSaveRun(run)')
    expect(SOURCE).toContainCode('onFetchCalibrationRecording(logId)')
    expect(SOURCE).toContainCode('controller.fetchDeviceLogFile(logId)')
    expect(SOURCE).toContainCode('decodeCrkCalibrationProgram(archiveBytes, logId)')
    expect(SOURCE).toContainCode('sourceLogId: logId,')
    expect(SOURCE).toContainCode('const startedEpoch = statusRef.current.calibration?.startedEpoch')
    expect(SOURCE).toContainCode('capturedAt: startedEpoch ? new Date(startedEpoch * 1000).toISOString() : undefined')
    expect(SOURCE).toContainCode('}, [controller, onFetchCalibrationRecording, store])')
    expect(SOURCE.indexOf('await onSaveRun(run)')).toBeLessThan(SOURCE.indexOf('return `${source}: saved'))
  })

  it('routes deletions through awaited failure-reporting handlers', () => {
    expect(SOURCE).toContainCode('await onDeleteRun(id)')
    expect(SOURCE).toContainCode('await onDeleteSnapshot(id)')
    expect(SOURCE).toContainCode("reportFailure(failure, 'That calibration recording could not be deleted')")
    expect(SOURCE).toContainCode("reportFailure(failure, 'That saved calibration could not be deleted')")
  })

  it('uses roaster-owned record language and says when a preview becomes real', () => {
    const markup = render()
    expect(markup).toContainCode('records stored on the roaster')
    expect(markup).toContainCode('Nothing changes on the roaster unless Save and apply succeeds')
    expect(markup).not.toContainCode("roaster's library")
    expect(markup).not.toContainCode('already loaded from device')
    expect(markup).not.toContainCode('Manual page')
  })

  it('makes saved-versus-current comparison visible beside its button', () => {
    expect(SOURCE).toContainCode('Compare with current')
    expect(SOURCE).toContainCode('Compared with current calibration')
    expect(SOURCE).toContainCode('snapshot-comparison')
    expect(SOURCE).toContainCode('<th>Coefficient</th><th>Current</th><th>Saved</th><th>Change</th>')
  })

  it('describes history as deliberate rather than automatic', () => {
    const markup = render()
    expect(markup).toContainCode('Saved deliberately from the working preview')
    expect(markup).toContainCode('Build a calibration from the recordings you trust')
    expect(markup).not.toContainCode('Saved automatically as each pass completes')
  })

  it('does not show idle or duplicate live-state summaries', () => {
    const markup = render({
      status: status({ calibration: { active: false, stepIndex: 0, stepCount: 0, completedSteps: [] } }),
    })
    expect(markup).not.toContainCode('class="pass-progress')
    expect(markup).not.toContainCode('0 of 0 steps completed')
    expect(markup).not.toContainCode('calibration-live')
    expect(markup).toContainCode('Start pass')
  })
})
