import { describe, expect, it } from 'vitest'
import { testRecordedOn } from '../testFixtures/provenance'
import { effectiveLevels, isFloored, minimumFanForHeat, normalizeFanLevel } from './actuatorFloors'
import {
  INSTRUCTION_LIMIT_MS,
  MANUAL_NOTICE_MS,
  manualApplyBlockedReason,
  manualElapsedMs,
  manualEvent,
  manualEventRows,
  manualParamError,
  manualStopBlockedReason,
  predictedManualLevels,
  reconcileManualEvent,
  visibleManualNotice,
} from './manualControl'
import type { ControllerStatus, ManualEvent, ManualStatus } from './types'

const NOW = 1_800_000_000_000

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: NOW,
  firmwareVersion: '2026-07-26.36',
  bootId: '4',
  manualLockout: false,
  thermocoupleValid: true,
  temperatureC: 120,
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  ...overrides,
})

const gate = (overrides: Partial<ControllerStatus> = {}, extra: { busy?: boolean; paramError?: string } = {}) =>
  manualApplyBlockedReason({
    status: status(overrides),
    nowMs: NOW,
    busy: extra.busy ?? false,
    paramError: extra.paramError,
  })

const event = (atMs: number, kind: 'apply' | 'stop', fan = 0, heat = 0): ManualEvent => ({
  id: `e-${atMs}`,
  atMs,
  kind,
  fan,
  heat,
  source: 'local',
  recordedOn: testRecordedOn,
})

const reconcile = (input: Omit<Parameters<typeof reconcileManualEvent>[0], 'recordedOn'>) =>
  reconcileManualEvent({ ...input, recordedOn: testRecordedOn })

describe('actuator fan normalization', () => {
  // Design rule: Heat on means Fan 1.0 or higher, on every command path, always.
  it('requires Fan 1.0 at every nonzero Heat setting and nothing at Heat 0', () => {
    expect(minimumFanForHeat(0)).toBe(0)
    expect(minimumFanForHeat(0.001)).toBe(1)
    expect(minimumFanForHeat(1)).toBe(1)
    expect(minimumFanForHeat(7.525)).toBe(1)
    expect(minimumFanForHeat(10)).toBe(1)
  })

  it('normalizes a fan-only level into the drive range, keeping zero off and 0.1 valid', () => {
    expect(normalizeFanLevel(0)).toBe(0)
    expect(normalizeFanLevel(0.05)).toBe(0.1)
    expect(normalizeFanLevel(4)).toBe(4)
    expect(normalizeFanLevel(11)).toBe(10)
  })

  it('lifts any heat-carrying pair below Fan 1.0 and leaves Fan 1.0 and above untouched', () => {
    expect(effectiveLevels({ fan: 1, heat: 10 })).toEqual({ fan: 1, heat: 10 })
    expect(isFloored({ fan: 1, heat: 10 })).toBe(false)
    expect(effectiveLevels({ fan: 0.05, heat: 10 })).toEqual({ fan: 1, heat: 10 })
    expect(isFloored({ fan: 0.05, heat: 10 })).toBe(true)
    expect(effectiveLevels({ fan: 7, heat: 10 })).toEqual({ fan: 7, heat: 10 })
    expect(predictedManualLevels({ fan: 0.5, heat: 10 })).toEqual({ fan: 1, heat: 10 })
    // Fan-only requests keep the 0.1 endpoint: the rule binds Heat-carrying pairs only.
    expect(effectiveLevels({ fan: 0.5, heat: 0 })).toEqual({ fan: 0.5, heat: 0 })
    expect(isFloored({ fan: 0.5, heat: 0 })).toBe(false)
  })
})

describe('manual parameters', () => {
  it('accepts the firmware range and rejects everything outside it', () => {
    expect(manualParamError({ fan: 0.1, heat: 0 })).toBeUndefined()
    expect(manualParamError({ fan: 10, heat: 10 })).toBeUndefined()
    expect(manualParamError({ fan: 0, heat: 0 })).toMatch(/0.1 and 10.0/)
    expect(manualParamError({ fan: 0, heat: 0 }, { allowZeroStop: true })).toBeUndefined()
    expect(manualParamError({ fan: 0, heat: 1 })).toMatch(/at least 1.0 while Heat/)
    expect(manualParamError({ fan: 10.1, heat: 0 })).toMatch(/0.1 and 10.0/)
    expect(manualParamError({ fan: 4, heat: -1 })).toMatch(/0.0 and 10.0/)
    expect(manualParamError({ fan: 4, heat: 11 })).toMatch(/0.0 and 10.0/)
    expect(manualParamError({ fan: Number.NaN, heat: 0 })).toMatch(/0.1 and 10.0/)
  })
})

describe('manual apply gate', () => {
  it('opens on a healthy, fresh, capable controller', () => {
    expect(gate()).toBeUndefined()
  })

  it('blocks on every condition in the allow-list, in order', () => {
    expect(gate({}, { busy: true })).toBe('A manual command is in flight')
    expect(gate({ connected: false })).toBe('The roaster is not connected')
    expect(gate({ receivedAtMs: NOW - 20000 })).toBe('The roaster has stopped reporting')
    expect(gate({ manualLockout: true })).toBe('A manual conflict is latched on the roaster')
    expect(gate({ fault: 'overtemperature' })).toBe('overtemperature')
    expect(
      gate({
        capabilities: {
          apiVersion: 'x',
          autonomousTimedPrograms: false,
          thermalExecution: false,
          diagnosticTests: false,
        },
      }),
    ).toBe('This firmware does not offer direct control of the roaster')
    expect(gate({ calibration: { active: true } })).toBe('A calibration program is running')
    expect(gate({}, { paramError: 'Fan must be between 0.1 and 10.0' })).toBe('Fan must be between 0.1 and 10.0')
  })

  it('holds Stop open through faults, latches, staleness, and a running program', () => {
    // Stop is the safe direction during an active direct-control session.
    for (const overrides of [
      { fault: 'overtemperature' },
      { manualLockout: true },
      { receivedAtMs: NOW - 60000 },
      { calibration: { active: true } },
    ]) {
      expect(
        manualStopBlockedReason({
          status: status({ ...overrides, manual: { active: true, fanLevel: 4, heatLevel: 2 } }),
          busy: false,
        }),
      ).toBeUndefined()
    }
    expect(manualStopBlockedReason({ status: status({ connected: false }), busy: false })).toBe(
      'The roaster is not connected',
    )
    expect(manualStopBlockedReason({ status: status(), busy: true })).toBe('A manual command is in flight')
    expect(manualStopBlockedReason({ status: status(), busy: false })).toBe('Direct control is already idle')
  })
})

describe('manual history reconciliation', () => {
  const manual = (overrides: Partial<ManualStatus> = {}): ManualStatus => ({
    active: true,
    fanLevel: 4,
    heatLevel: 6,
    sinceMs: 30000,
    ...overrides,
  })

  it('adds nothing when the controller agrees with the newest row', () => {
    expect(
      reconcile({ manual: manual(), latest: event(NOW - 30000, 'apply', 4, 6), observedAtMs: NOW, nowMs: NOW }),
    ).toBeUndefined()
  })

  it('never reads a poll older than the newest row as a firmware stop', () => {
    // The five-second window between issuing Apply and the next status arriving must not synthesize
    // a stop out of a status that predates the command.
    const applied = event(NOW, 'apply', 4, 6)
    expect(
      reconcile({ manual: { active: false }, latest: applied, observedAtMs: NOW - 2000, nowMs: NOW }),
    ).toBeUndefined()
  })

  it('synthesizes the stop that ended a run while the tab was closed, with its end reason', () => {
    const derived = reconcile({
      manual: { active: false, endReason: 'fault' },
      latest: event(NOW - 120000, 'apply', 4, 6),
      observedAtMs: NOW,
      nowMs: NOW,
      temperatureC: 210,
    })
    expect(derived).toMatchObject({ kind: 'stop', source: 'firmware', temperatureC: 210 })
    expect(derived?.detail).toContain('fault')
    // Idempotent: once the stop is recorded, the same status adds nothing more.
    expect(
      reconcile({ manual: { active: false, endReason: 'fault' }, latest: derived, observedAtMs: NOW, nowMs: NOW }),
    ).toBeUndefined()
  })

  it('synthesizes an apply for a run Crackle never issued, dated from since_ms', () => {
    const derived = reconcile({ manual: manual({ sinceMs: 45000 }), latest: undefined, observedAtMs: NOW, nowMs: NOW })
    expect(derived).toMatchObject({ kind: 'apply', fan: 4, heat: 6, source: 'firmware' })
    expect(derived?.atMs).toBe(NOW - 45000)
  })

  it('records a level change made elsewhere as a new apply', () => {
    const derived = reconcile({
      manual: manual({ fanLevel: 7, heatLevel: 2 }),
      latest: event(NOW - 90000, 'apply', 4, 6),
      observedAtMs: NOW,
      nowMs: NOW,
    })
    expect(derived).toMatchObject({ kind: 'apply', fan: 7, heat: 2, source: 'firmware' })
  })

  it('does nothing at all when the firmware sends no manual block', () => {
    expect(
      reconcile({ manual: undefined, latest: event(NOW - 1000, 'apply', 4, 6), observedAtMs: NOW, nowMs: NOW }),
    ).toBeUndefined()
  })

  /** Dating the change from the poll's own age walked one unchanged session forward every tick. */
  it('dates an observed change from when it was observed, not from when it is examined', () => {
    const derived = reconcile({
      manual: manual({ sinceMs: 30000 }),
      latest: undefined,
      observedAtMs: NOW - 4000,
      nowMs: NOW,
    })
    expect(derived?.atMs).toBe(NOW - 34000)
  })

  it('names a derived row after the observation, so the same observation is never two rows', () => {
    const ended = {
      manual: { active: false, endReason: 'stopped' } as const,
      latest: event(NOW - 60000, 'apply', 4, 6),
    }
    const first = reconcile({ ...ended, observedAtMs: NOW, nowMs: NOW })
    const again = reconcile({ ...ended, observedAtMs: NOW + 30000, nowMs: NOW + 30000 })
    expect(first?.id).toBe(again?.id)
    // And a locally issued command keeps a fresh identity: two Applies of fan 4 are two facts.
    expect(
      manualEvent({ atMs: NOW, kind: 'apply', fan: 4, heat: 0, source: 'local', recordedOn: testRecordedOn }).id,
    ).not.toBe(
      manualEvent({ atMs: NOW, kind: 'apply', fan: 4, heat: 0, source: 'local', recordedOn: testRecordedOn }).id,
    )
  })
})

/**
 * ============================================================================================
 * A WHOLE SESSION, TICK BY TICK - the flood these tests exist to prevent
 * ============================================================================================
 *
 * Applying fan 4 heat 0 must not fill the history with hundreds of "observed on the roaster" rows,
 * and later with hundreds of "ended on the roaster" rows. Nothing is wrong with the commands in that
 * failure: reconciliation runs on every poll, and if it is level-triggered a state that stays true
 * is recorded again on every tick.
 *
 * This is a miniature of the app's own loop - reconcile, append, sort, re-read the newest row - run
 * over a realistic session, and it asserts the count that actually matters: ONE row per thing the
 * operator did, plus at most one row per thing that happened while nobody was watching.
 */
describe('a manual session, poll by poll', () => {
  const session = () => {
    let events: ManualEvent[] = []
    const append = (added: ManualEvent) => {
      events = [...events, added].sort((a, b) => a.atMs - b.atMs)
    }
    return {
      get rows() {
        return manualEventRows(events, NOW, false)
      },
      user: (added: ManualEvent) => append(added),
      /** One reconciliation pass, exactly as the app runs it on every status and every clock tick. */
      poll: (manual: ManualStatus, atMs: number, latest = events.at(-1)) => {
        const derived = reconcile({ manual, latest, observedAtMs: atMs, nowMs: atMs, temperatureC: 120 })
        if (derived) append(derived)
        return derived
      },
    }
  }

  /**
   * The reported defect, reproduced. The merged status is two documents: `active` and `since_ms`
   * arrive on the 1 Hz stream, the LEVELS on the 5 s status poll - so for the first few seconds
   * after Apply the roaster reads as "active at the levels it was running before".
   */
  it('records one row for an Apply, however stale the levels in the polls that follow it are', () => {
    const run = session()
    const setAtMs = NOW
    // The command, and the row the app writes when the response comes back.
    run.user({
      id: 'local-apply',
      atMs: setAtMs + 120,
      kind: 'apply',
      fan: 4,
      heat: 0,
      source: 'local',
      recordedOn: testRecordedOn,
    })
    for (let tick = 1; tick <= 15; tick += 1) {
      const atMs = setAtMs + tick * 1000
      // The first five seconds carry the previous document's levels; after that they catch up.
      const stale = tick <= 5
      run.poll({ active: true, fanLevel: stale ? 0 : 4, heatLevel: 0, sinceMs: atMs - setAtMs }, atMs)
    }
    expect(run.rows).toHaveLength(1)
    expect(run.rows[0].event.id).toBe('local-apply')
  })

  /**
   * A long hold is one instruction, and the pessimistic case is firmware that restamps `since_ms`
   * whenever it is repeated - which is why the level comparison has to survive alongside the
   * timestamp rule.
   */
  it('stays silent through a long hold, whatever a repeated instruction does to since_ms', () => {
    const run = session()
    run.user({
      id: 'local-apply',
      atMs: NOW,
      kind: 'apply',
      fan: 6,
      heat: 7.5,
      source: 'local',
      recordedOn: testRecordedOn,
    })
    for (let tick = 1; tick <= 240; tick += 1) {
      const atMs = NOW + tick * 1000
      // The same instruction re-sent every 25 s, and a firmware that resets the level clock on it.
      const sinceMs = (tick % 25) * 1000
      run.poll(
        {
          active: true,
          fanLevel: 6,
          heatLevel: 7.5,
          sinceMs,
          instructionAgeMs: sinceMs,
          instructionLimitMs: INSTRUCTION_LIMIT_MS,
        },
        atMs,
      )
    }
    expect(run.rows).toHaveLength(1)
  })

  it('records one row for a Stop, and nothing for the idle roaster it leaves behind', () => {
    const run = session()
    run.user({
      id: 'local-apply',
      atMs: NOW,
      kind: 'apply',
      fan: 4,
      heat: 0,
      source: 'local',
      recordedOn: testRecordedOn,
    })
    run.user({
      id: 'local-stop',
      atMs: NOW + 60000,
      kind: 'stop',
      fan: 0,
      heat: 0,
      source: 'local',
      recordedOn: testRecordedOn,
    })
    for (let tick = 1; tick <= 200; tick += 1) {
      run.poll(
        { active: false, fanLevel: 0, heatLevel: 0, endReason: 'stopped', sinceMs: 0 },
        NOW + 60000 + tick * 1000,
      )
    }
    expect(run.rows.map((row) => row.event.id)).toEqual(['local-stop', 'local-apply'])
  })

  /** A stop nobody was watching is still recorded - once, on the poll that first saw it. */
  it('records an unwitnessed stop exactly once across as many polls as it likes', () => {
    const run = session()
    run.user({
      id: 'local-apply',
      atMs: NOW,
      kind: 'apply',
      fan: 4,
      heat: 0,
      source: 'local',
      recordedOn: testRecordedOn,
    })
    const derived: Array<ManualEvent | undefined> = []
    for (let tick = 1; tick <= 200; tick += 1) {
      derived.push(run.poll({ active: false, endReason: 'instruction_expired' }, NOW + tick * 1000))
    }
    expect(derived.filter(Boolean)).toHaveLength(1)
    expect(run.rows).toHaveLength(2)
    expect(run.rows[0].event).toMatchObject({ kind: 'stop', source: 'firmware' })
  })

  /**
   * The same stop, reconciled against a history that keeps reverting - a status re-read racing an
   * in-flight save, which is what turns one missed stop into "hundreds of ended rows, later". The
   * rows are identical because they name the same observation, so the table shows one event.
   */
  it('survives a history that reverts under it: the same observation is the same row', () => {
    const run = session()
    const applied: ManualEvent = {
      id: 'local-apply',
      atMs: NOW,
      kind: 'apply',
      fan: 4,
      heat: 0,
      source: 'local',
      recordedOn: testRecordedOn,
    }
    run.user(applied)
    for (let tick = 1; tick <= 200; tick += 1) {
      // `latest` forced back to the apply row every time, as a stale re-read would leave it.
      run.poll({ active: false, endReason: 'stopped' }, NOW + tick * 1000, applied)
    }
    expect(run.rows).toHaveLength(2)
    expect(run.rows[0].event.source).toBe('firmware')
  })

  /** What reconciliation is FOR: a session that started somewhere else still gets its row. */
  it('still records a run this browser never issued', () => {
    const run = session()
    const derived = run.poll({ active: true, fanLevel: 7, heatLevel: 2, sinceMs: 45000 }, NOW)
    expect(derived).toMatchObject({ kind: 'apply', fan: 7, heat: 2, source: 'firmware' })
    for (let tick = 1; tick <= 100; tick += 1) {
      run.poll({ active: true, fanLevel: 7, heatLevel: 2, sinceMs: 45000 + tick * 1000 }, NOW + tick * 1000)
    }
    // A change made elsewhere later is still caught, and is still exactly one row.
    run.poll({ active: true, fanLevel: 3, heatLevel: 9, sinceMs: 500 }, NOW + 200000)
    expect(run.rows).toHaveLength(2)
    expect(run.rows[0].event).toMatchObject({ fan: 3, heat: 9 })
  })
})

/**
 * A command says one thing, briefly. The confirmation for a Stop is not something to acknowledge -
 * the Stop landed, and the history row is the permanent record - so it fades on the same clock as a
 * refusal rather than waiting to be clicked away.
 */
describe('the manual command notice', () => {
  const notice = { tone: 'ok', text: 'Manual control stopped', atMs: NOW } as const

  it('shows a notice, then takes it away without anyone clicking anything', () => {
    expect(visibleManualNotice(notice, NOW)).toBe(notice)
    expect(visibleManualNotice(notice, NOW + MANUAL_NOTICE_MS - 1)).toBe(notice)
    expect(visibleManualNotice(notice, NOW + MANUAL_NOTICE_MS)).toBeUndefined()
  })

  it('gives a refusal exactly the same lifetime as a confirmation', () => {
    const refused = { tone: 'error', text: 'The roaster rejected that command', atMs: NOW } as const
    expect(visibleManualNotice(refused, NOW + MANUAL_NOTICE_MS - 1)).toBe(refused)
    expect(visibleManualNotice(refused, NOW + MANUAL_NOTICE_MS)).toBeUndefined()
    expect(visibleManualNotice(undefined, NOW)).toBeUndefined()
  })
})

describe('manual event rows', () => {
  const events = [
    event(NOW - 300000, 'apply', 3, 0),
    event(NOW - 240000, 'apply', 3, 5),
    event(NOW - 60000, 'apply', 5, 8),
  ]

  /** One "Held for" duration column: each row states its OWN duration. */
  it('gives every row its own held duration and orders newest first', () => {
    const rows = manualEventRows(events, NOW, true)
    expect(rows.map((row) => row.event.id)).toEqual([`e-${NOW - 60000}`, `e-${NOW - 240000}`, `e-${NOW - 300000}`])
    // The newest row is still running, so its duration ticks against the clock.
    expect(rows[0]).toMatchObject({ live: true, heldMs: 60000 })
    // Every closed row holds exactly until the next event.
    expect(rows[1]).toMatchObject({ live: false, heldMs: 180000 })
    expect(rows[2]).toMatchObject({ live: false, heldMs: 60000 })
  })

  it('closes the newest duration once the controller reports manual idle', () => {
    const rows = manualEventRows(events, NOW, false)
    expect(rows[0].live).toBe(false)
    expect(rows[0].heldMs).toBeUndefined()
  })

  it('never ticks a stop row', () => {
    const rows = manualEventRows([...events, event(NOW - 10000, 'stop')], NOW, true)
    expect(rows[0]).toMatchObject({ live: false })
    expect(rows[0].heldMs).toBeUndefined()
    // The apply it closed now states the full 50 s it was actually held.
    expect(rows[1]).toMatchObject({ live: false, heldMs: 50000 })
  })

  it('does not count idle time between separate sessions as time held', () => {
    const firstStop = event(NOW - 86400000, 'stop')
    const laterApply = event(NOW - 60000, 'apply', 4, 0)
    const rows = manualEventRows([firstStop, laterApply], NOW, false)
    expect(rows.find((row) => row.event.id === firstStop.id)?.heldMs).toBeUndefined()
  })

  it('mints an id for every appended event', () => {
    expect(
      manualEvent({ atMs: NOW, kind: 'apply', fan: 1, heat: 1, source: 'local', recordedOn: testRecordedOn }).id,
    ).toMatch(/^manual-event-/)
  })
})

describe('manual elapsed time', () => {
  it('advances the firmware measure locally between polls', () => {
    const active = status({ manual: { active: true, sinceMs: 30000 }, receivedAtMs: NOW - 4000 })
    expect(manualElapsedMs(active, NOW)).toBe(34000)
  })

  it('reports nothing when manual is idle or the firmware sent no since_ms', () => {
    expect(manualElapsedMs(status({ manual: { active: false, sinceMs: 30000 } }), NOW)).toBeUndefined()
    expect(manualElapsedMs(status({ manual: { active: true } }), NOW)).toBeUndefined()
    expect(manualElapsedMs(status(), NOW)).toBeUndefined()
  })
})

/**
 * The instruction lease.
 *
 * The safeguard is the DEVICE's: an instruction runs for at most 30 minutes and any new command
 * resets that clock. Nothing here re-affirms anything, and nothing about this browser being open
 * enters into it - which is exactly what the client keepalive this replaced got wrong.
 */
describe('the instruction lease', () => {
  it('is the half-hour the firmware enforces, stated once', () => {
    expect(INSTRUCTION_LIMIT_MS).toBe(1800000)
    expect(INSTRUCTION_LIMIT_MS / 60000).toBe(30)
  })

  it('is reported by the status parse without becoming an obligation on the browser', () => {
    const holding = status({
      manual: {
        active: true,
        fanLevel: 6,
        heatLevel: 7.5,
        instructionAgeMs: 5000,
        instructionLimitMs: INSTRUCTION_LIMIT_MS,
      },
    })
    expect(holding.manual?.instructionAgeMs).toBe(5000)
    expect(holding.manual?.instructionLimitMs).toBe(INSTRUCTION_LIMIT_MS)
  })
})
