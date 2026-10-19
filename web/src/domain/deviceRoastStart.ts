import { sanitizeRoastName } from './roastProgram'
import type { BatchMeasurements, BeanLot, Profile, RecordedOn, RoastRun } from './types'

/**
 * Staging a device-executed roast's setup ON THE ROASTER, before the roast exists.
 *
 * ============================================================================================
 * WHY THE RECORD IS WRITTEN BEFORE THE START COMMAND
 * ============================================================================================
 *
 * The Start command carries only what the firmware executes: the plan, the sanitized name, and the
 * green mass. The setup form collected more - the starting volume, the ambient reading, the bean
 * lot the user picked. Held in a browser localStorage stash, those fields would reach the
 * reconstructed run only when the STARTING browser next reconciled the archive, and every other
 * browser would see a partial record until then. Design rule: all staged setup data lives on the
 * roaster.
 *
 * So the browser durably writes the COMPLETE run record - volume, ambient, bean lot id and
 * snapshot, mass, name, profile snapshot, outcome `running` - to the roaster's document store
 * BEFORE commanding Start. The actuator is idle at that moment, so the firmware's flash-write gate
 * admits the write; the firmware records its own provisional archive occurrence in the same idle
 * window. Any browser that syncs the library from that point on sees the whole record. The archive
 * reconciliation later completes that SAME record in place (`reconcileProfiledArchiveRun` /
 * `reconcileManualArchiveRun`) instead of synthesizing a second one from the log header.
 *
 * ============================================================================================
 * THE WRITE IS A FAIL-CLOSED PRECONDITION
 * ============================================================================================
 *
 * If the record cannot be written, Start does not fire and the reason is shown. A busy refusal is
 * surfaced honestly rather than blind-retried: the storage-priority retry contract covers
 * pre-side-effect READS on the roaster, never a browser-owned document MUTATION, and a mutation
 * retried behind the operator's back could land after the world has changed.
 *
 * If Start is refused AFTER the record was written, the provisional record is removed - the roast
 * never happened. When even that removal fails, the record is marked aborted rather than left
 * claiming a roast is running; and when both fail, the caller says so and reuses the same record id
 * on the next attempt so a retry cannot pile up duplicates.
 *
 * Only a DEFINITE refusal may touch the staged record. When the Start acknowledgement was lost
 * (timeout, dropped response, gateway 504) and status could not settle the outcome, the roast may
 * be running: the record is kept exactly as staged (`cleanup: 'kept'`) and the operator is told to
 * check the roaster. Deleting it would erase the record of a roast in progress.
 */

export interface ProvisionalDeviceRoastInput {
  /** Stable record id. A retry after a failed Start reuses the previous id rather than duplicating. */
  id: string
  /** The per-occurrence name the Start command carries; sanitized here exactly as the firmware does. */
  name: string
  profile: Profile
  /** Everything the setup form collected, ambient already included by the caller. */
  measurements: BatchMeasurements
  beanLotId?: string
  beanLot?: BeanLot
  recordedOn: RecordedOn
  firmwareVersion: string
  /** Controller boot the Start is being issued under - the clockless-recording fallback join. */
  bootId?: string
  startedAt: string
}

/** The complete run record staged on the roaster at Start for a profiled device-executed roast. */
export const provisionalDeviceRoastRun = (input: ProvisionalDeviceRoastInput): RoastRun => ({
  id: input.id,
  name: sanitizeRoastName(input.name),
  startedAt: input.startedAt,
  recordedOn: input.recordedOn,
  profile: structuredClone(input.profile),
  beanLotId: input.beanLotId,
  beanLotSnapshot: input.beanLot ? structuredClone(input.beanLot) : undefined,
  notes: '',
  controllerVersion: input.firmwareVersion,
  measurements: { ...input.measurements },
  outcome: 'running',
  samples: [],
  events: [],
  deviceRoastPending: { bootId: input.bootId },
})

export interface ProvisionalManualRoastInput extends ProvisionalDeviceRoastInput {
  fan: number
  heat: number
}

/** The staged record for a recordable manual roast: same treatment, plus the manual instruction path. */
export const provisionalManualRoastRun = (input: ProvisionalManualRoastInput): RoastRun => ({
  ...provisionalDeviceRoastRun(input),
  manualRoast: {
    changes: [],
    deviceName: sanitizeRoastName(input.name),
    incomplete: true,
  },
})

export interface StartAcknowledgement {
  ok: boolean
  message?: string
  /** The Start may have committed; its outcome could not be determined. Never a refusal. */
  outcomeUnknown?: boolean
}

export interface DeviceRoastStartPorts<R extends StartAcknowledgement = StartAcknowledgement> {
  /** Acknowledged durable write to the roaster's document store. Resolves only once accepted. */
  saveRun(run: RoastRun): Promise<unknown>
  /** Acknowledged removal of the staged record after a refused Start. */
  deleteRun(id: string): Promise<unknown>
  /** Fallback honesty when removal fails: the record must not keep claiming a running roast. */
  markRunAborted(id: string, note: string): Promise<unknown>
  /** The actual Start command. Issued only after `saveRun` resolved. */
  start(): Promise<R>
}

export type DeviceRoastStartOutcome<R extends StartAcknowledgement = StartAcknowledgement> =
  /** The record is durable on the roaster and the roast is running. */
  | { ok: true; run: RoastRun; result: R }
  /** The roaster did not accept the run record; Start was never sent. */
  | { ok: false; stage: 'record'; message: string }
  /**
   * The record was written but Start was refused. `cleanup` reports what happened to the record:
   * `removed` (gone), `aborted` (marked, still visible), or `stranded` (still claims running; the
   * same id is reused on retry).
   */
  | { ok: false; stage: 'start'; message: string; cleanup: 'removed' | 'aborted' | 'stranded' }
  /**
   * The Start's outcome is unknown - the roast may be running. The staged record was left exactly
   * as written; nothing was deleted or marked aborted.
   */
  | { ok: false; stage: 'start'; message: string; cleanup: 'kept'; outcomeUnknown: true }

const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

const unknownOutcome = (
  message: string,
): { ok: false; stage: 'start'; message: string; cleanup: 'kept'; outcomeUnknown: true } => ({
  ok: false,
  stage: 'start',
  message: `${message} The staged run record was kept; check the roaster to see whether the roast is running.`,
  cleanup: 'kept',
  outcomeUnknown: true,
})

/**
 * Write-then-start, fail closed at every boundary. The one ordering that matters is pinned here:
 * `start()` is not called until `saveRun` has resolved, so a roast can never be running while its
 * record exists nowhere but the starting browser.
 */
export const executeDeviceRoastStart = async <R extends StartAcknowledgement>(
  run: RoastRun,
  ports: DeviceRoastStartPorts<R>,
): Promise<DeviceRoastStartOutcome<R>> => {
  try {
    await ports.saveRun(run)
  } catch (error) {
    return {
      ok: false,
      stage: 'record',
      message: failureMessage(error, 'The roaster did not accept the roast record.'),
    }
  }
  let result: R
  try {
    result = await ports.start()
  } catch (error) {
    return unknownOutcome(failureMessage(error, 'The Start request failed before the roaster answered.'))
  }
  if (result.ok) return { ok: true, run, result }
  if (result.outcomeUnknown)
    return unknownOutcome(result.message ?? 'The roaster did not confirm whether the roast started.')
  const message = result.message ?? 'The roaster refused the roast'
  try {
    await ports.deleteRun(run.id)
    return { ok: false, stage: 'start', message, cleanup: 'removed' }
  } catch {
    try {
      await ports.markRunAborted(
        run.id,
        'The roaster refused the Start command after this record was staged, so no roast ran.',
      )
      return { ok: false, stage: 'start', message, cleanup: 'aborted' }
    } catch {
      return { ok: false, stage: 'start', message, cleanup: 'stranded' }
    }
  }
}
