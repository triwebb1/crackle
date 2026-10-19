import { effectiveLevels } from './actuatorFloors'
import { newId } from './ids'
import { isStatusStale } from './startGate'
import type { ControllerStatus, ManualEvent, ManualStatus, RecordedOn } from './types'

/**
 * Firmware bounds for direct Controls, mirrored so an obviously bad request never leaves the
 * browser. Fan 0 / Heat 0 is the endpoint's explicit immediate-stop command; every running
 * instruction keeps Fan at 0.1 or higher, and Heat on means Fan 1.0 or higher on every command
 * path (a heat-carrying bed must circulate): the firmware lifts a lower fan to 1.0 rather than refusing it,
 * and `predictedManualLevels` previews the same lift here.
 */
export const MANUAL_LIMITS = {
  fan: { min: 0.1, max: 10 },
  heat: { min: 0, max: 10 },
} as const

// What the actuator is expected to drive for a requested pair, before the firmware confirms it.
// The floors themselves live in actuatorFloors.ts, because the log analysis needs the same
// arithmetic to recognise a step that ran at a floored fan.
export const predictedManualLevels = effectiveLevels

const outside = (value: number, { min, max }: { min: number; max: number }) =>
  !Number.isFinite(value) || value < min || value > max

export const manualParamError = (
  { fan, heat }: { fan: number; heat: number },
  { allowZeroStop = false }: { allowZeroStop?: boolean } = {},
): string | undefined => {
  if (outside(heat, MANUAL_LIMITS.heat)) return 'Heat must be between 0.0 and 10.0'
  if (allowZeroStop && fan === 0 && heat === 0) return undefined
  if (outside(fan, MANUAL_LIMITS.fan))
    return heat > 0 && fan === 0
      ? 'Fan must be at least 1.0 while Heat is above 0.0'
      : 'Fan must be between 0.1 and 10.0'
  return undefined
}

export interface ManualGateInput {
  status: ControllerStatus
  nowMs: number
  paramError?: string
  busy: boolean
}

/**
 * Apply is an explicit allow-list, exactly like the roast and calibration gates: connected, fresh,
 * no manual-conflict latch, no actuator fault, the diagnosticTests capability advertised, no
 * calibration program running, and in-range levels. A blocked Apply stays visible with its reason;
 * it is never hidden.
 */
export const manualApplyBlockedReason = ({ status, nowMs, paramError, busy }: ManualGateInput): string | undefined => {
  if (busy) return 'A manual command is in flight'
  if (!status.connected) return 'The roaster is not connected'
  if (isStatusStale(status, nowMs)) return 'The roaster has stopped reporting'
  if (status.manualLockout || status.lifecycle === 'MANUAL_LOCKOUT')
    return 'A manual conflict is latched on the roaster'
  if (status.fault || status.lifecycle === 'FAULT') return status.fault ?? 'The roaster has latched a fault'
  if (!status.capabilities.diagnosticTests) return 'This firmware does not offer direct control of the roaster'
  if (status.calibration?.active) return 'A calibration program is running'
  if (paramError) return paramError
  return undefined
}

/**
 * Stop is gated far more narrowly on purpose. It is always the safe direction, so a fault, a latch,
 * a stale poll, or a running calibration must never be a reason to withhold it - only having no
 * controller to send it to, or a command already in flight.
 */
export const manualStopBlockedReason = ({
  status,
  busy,
}: {
  status: ControllerStatus
  busy: boolean
}): string | undefined => {
  if (busy) return 'A manual command is in flight'
  if (!status.connected) return 'The roaster is not connected'
  if (status.manual?.active !== true) return 'Direct control is already idle'
  return undefined
}

const CLOSE_ENOUGH = 0.05
const sameLevel = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) < CLOSE_ENOUGH

export const manualEvent = (input: Omit<ManualEvent, 'id'>): ManualEvent => ({ id: newId('manual-event'), ...input })

/**
 * How much newer than the newest stored row an observed change has to look before it counts as a
 * change at all.
 *
 * `since_ms` is a duration measured on the device and read in the browser one network hop later, and
 * the row Crackle wrote for its own command is stamped when the response came back - so the same
 * command can date a fraction of a second either side of its own row. Anything inside this window is
 * the row that is already stored, seen again, not a second change. The cost is the one it should be:
 * a change made from another browser within two seconds of a local command is folded into it.
 */
export const RECONCILE_TOLERANCE_MS = 2000

/**
 * A derived row is a FUNCTION of the observation, not a new fact, so it is named by the observation
 * rather than given a fresh random id.
 *
 * That is what makes reconciliation idempotent all the way down to storage: if the same observation
 * is somehow reconciled twice - a status re-read that raced a write, a reload part-way through a
 * queued save - the second pass produces the same row with the same id, which the stores overwrite
 * in place and `manualEventRows` renders once, instead of a second row that looks like a second
 * event. `newId` is still right for a command Crackle actually sent: two Applies of fan 4 really are
 * two separate facts.
 */
const derivedId = (kind: ManualEvent['kind'], afterMs: number, fan: number, heat: number) =>
  `manual-event-derived-${kind}-${Math.round(fan * 10)}-${Math.round(heat * 10)}-after-${Math.round(afterMs)}`

/**
 * Best-effort reconciliation of local history against what the firmware reports. Crackle appends
 * its own row on every Apply and Stop it issues, but a run can also end while the tab is closed - a
 * fault stop, a rejected lease renewal - and it can be started from somewhere else entirely. One
 * status poll cannot describe what was missed, only that the current state disagrees with the last
 * row, so this synthesizes the single event that reconciles them and nothing more.
 *
 * ==========================================================================================
 * EDGE-TRIGGERED, because this runs on EVERY poll
 * ==========================================================================================
 *
 * The caller re-runs this whenever the status, the clock or the history changes, which is several
 * times a second, and appends whatever comes back. So the only safe contract is: return a row for
 * the MOMENT THE STATE CHANGED, once, and return nothing for the state simply continuing to be true.
 *
 * A level-triggered version floods the log, because it assumes that a synthesized row becomes the
 * newest row and so silences the next poll. It does not always. The merged status is two documents - `active` and
 * `since_ms` from the compact live stream, the levels from full-status reconciliation - so briefly after
 * an Apply the levels still read as the PREVIOUS session's while `active` is already true. The
 * level comparison alone therefore disagrees with the row Crackle has just written, and the row it
 * synthesizes is dated from `since_ms`, i.e. a fraction of a second BEFORE that row - so it never
 * becomes the newest row, the next poll disagrees identically, and the log fills with hundreds of
 * "observed" copies of one Apply.
 *
 * So the decision is made on WHEN the change happened, not only on what the levels say: an
 * observation that dates from at or before the newest stored row has already been recorded, whatever
 * the levels in it look like. Both checks are kept, in this order, because they cover opposite
 * failures - the level check silences a firmware that restamps `since_ms` on every repeat of the
 * same instruction, and the timestamp check silences levels that disagree because they are stale.
 *
 * Limitation, deliberately accepted: levels changed while the tab was closed collapse into one
 * synthesized row at the latest levels, and the durations either side of the gap are therefore
 * approximate. A synthesized row is marked `firmware` so it is never mistaken for a command Crackle
 * actually sent.
 */
export const reconcileManualEvent = ({
  manual,
  latest,
  observedAtMs,
  nowMs,
  temperatureC,
  recordedOn,
}: {
  manual?: ManualStatus
  latest?: ManualEvent
  // When the status being reconciled actually arrived, not when it is being examined.
  observedAtMs: number
  nowMs: number
  temperatureC?: number
  recordedOn: RecordedOn
}): ManualEvent | undefined => {
  if (!manual) return undefined
  // A poll that predates the newest row cannot describe it. Without this, the five-second window
  // between Crackle issuing an Apply and the next status arriving would read as a firmware stop.
  if (latest && observedAtMs < latest.atMs) return undefined
  if (manual.active) {
    const fan = manual.fanLevel ?? 0
    const heat = manual.heatLevel ?? 0
    if (latest?.kind === 'apply' && sameLevel(latest.fan, fan) && sameLevel(latest.heat, heat)) return undefined
    /*
     * `since_ms` is time at the current applied levels, so it dates the change - measured at the
     * moment the observation was taken, NOT at the moment it is being examined. Dating it from
     * `nowMs` walked the same change forward by the age of the poll, so one unchanged session read
     * as a change that kept getting newer.
     */
    const changedAtMs =
      manual.sinceMs !== undefined && manual.sinceMs >= 0 ? Math.min(observedAtMs - manual.sinceMs, nowMs) : undefined
    if (changedAtMs !== undefined && latest && changedAtMs <= latest.atMs + RECONCILE_TOLERANCE_MS) return undefined
    // Firmware that reports no `since_ms` cannot date its change, so it is dated now - which at
    // least makes it the newest row, so the level comparison above can silence the next poll.
    const atMs = changedAtMs ?? nowMs
    return {
      id: derivedId('apply', latest?.atMs ?? 0, fan, heat),
      atMs,
      kind: 'apply',
      fan,
      heat,
      temperatureC,
      source: 'firmware',
      detail: 'Observed on the roaster',
      recordedOn,
    }
  }
  // Manual is idle. If the newest row is an apply, the run ended without Crackle seeing the stop -
  // and that is an edge: the row is written for the transition, and every later poll that reports
  // the same idle roaster finds a stop already at the top of the history and adds nothing.
  if (latest?.kind !== 'apply') return undefined
  return {
    id: derivedId('stop', latest.atMs, 0, 0),
    atMs: nowMs,
    kind: 'stop',
    fan: 0,
    heat: 0,
    temperatureC,
    source: 'firmware',
    detail: `Ended on the roaster (${manual.endReason ?? 'reason not reported'})`,
    recordedOn,
  }
}

/**
 * How long a command's confirmation or refusal stays on screen.
 *
 * Both tones fade, on the same clock. "Manual control stopped" is not a message anyone needs to
 * acknowledge - the Stop landed, the history row says so permanently - and a confirmation that has
 * to be clicked away turns every command into two. Nothing is lost by letting it go: the refusal
 * reason is repeated by the blocked-reason line for as long as the block lasts, and the event table
 * is the durable record.
 */
export const MANUAL_NOTICE_MS = 6000

export interface ManualNotice {
  tone: 'ok' | 'error'
  text: string
  atMs: number
}

/**
 * The notice still worth showing, if any - a pure function of the clock the view is already
 * re-rendered against, rather than a timer that has to be cancelled, re-armed, and torn down.
 */
export const visibleManualNotice = (notice: ManualNotice | undefined, nowMs: number): ManualNotice | undefined =>
  notice && nowMs - notice.atMs < MANUAL_NOTICE_MS ? notice : undefined

export interface ManualEventRow {
  event: ManualEvent
  /**
   * How long THIS row's levels were held: until the next row, or - while it is still the current
   * one - up to now, ticking. There is one duration column, not two, because the previous row's
   * duration is always readable as the previous row's own value: a second column would print the
   * same number twice.
   */
  heldMs?: number
  live: boolean
}

/**
 * Newest first, with the duration computed rather than stored, so a history recorded across
 * reloads still reads correctly. The newest row ticks only while the controller still reports
 * manual active: once it stops, its duration is closed at the stop row above it.
 *
 * One row per id, because a derived row is named after the observation it came from: if the same
 * observation is reconciled twice while a save is still in flight, the table shows the one event
 * that happened rather than two identical rows and a duplicate render key.
 */
export const manualEventRows = (events: ManualEvent[], nowMs: number, active: boolean): ManualEventRow[] => {
  const byId = new Map(events.map((event) => [event.id, event]))
  const ordered = [...byId.values()].sort((a, b) => a.atMs - b.atMs)
  return ordered
    .map((event, index) => {
      const next = ordered[index + 1]
      const live = index === ordered.length - 1 && active && event.kind === 'apply'
      return {
        event,
        heldMs:
          event.kind === 'stop'
            ? undefined
            : next
              ? Math.max(0, next.atMs - event.atMs)
              : live
                ? Math.max(0, nowMs - event.atMs)
                : undefined,
        live,
      }
    })
    .reverse()
}

// Time at the current applied levels: the firmware's own measure, advanced locally between polls.
export const manualElapsedMs = (status: ControllerStatus, nowMs: number): number | undefined => {
  if (!status.manual?.active || status.manual.sinceMs === undefined) return undefined
  return status.manual.sinceMs + Math.max(0, nowMs - status.receivedAtMs)
}

/**
 * ============================================================================================
 * THE INSTRUCTION LEASE - the safeguard that lives on the DEVICE
 * ============================================================================================
 *
 * One rule covers every path that can command the machine: **an instruction is good for at most 30
 * minutes, and any new instruction - the same levels repeated or different ones - resets the clock.**
 * 30 minutes after the last accepted `set` the WHOLE instruction expires: the session ends with a
 * full stop, with Fan and Heat both turned off - the
 * same path as an explicit Stop, so the fan is never cut at the moment cooling needs it
 * (`end_reason: instruction_expired`). A fan-only session expires on the same terms; a fan-only
 * setting is an instruction too, and one that lingered would go on blocking programs.
 *
 * This replaced a CLIENT KEEPALIVE - 60 s of browser silence released heat, and this page re-POSTed
 * the applied levels every 25 s to prevent that. Two things were wrong with it and both are worth
 * remembering, because the shape is tempting to rebuild: it made closing the browser cut the heat,
 * treating an ordinary deliberate action as an emergency; and it put a safety property in JavaScript
 * on someone else's laptop rather than in the firmware. Closing this page is now fine. The session
 * keeps running its instruction for the full lease and then stops itself.
 *
 * So there is nothing here to re-affirm, and no liveness obligation of any kind on this browser.
 * `status.manual.instructionAgeMs` / `instructionLimitMs` are reported for completeness; the page
 * states the rule in one line rather than turning it into a countdown to watch.
 */
export const INSTRUCTION_LIMIT_MS = 1800000
