import { describe, expect, it } from 'vitest'
import { MANUAL_INSTRUCTION_LIMIT_MS, TICK_MS } from './config'
import { encodeArchiveFile, readArchiveFile } from './crkFile'
import { MockDevice } from './device'
import { statusDocument } from './documents'

const start = (device: MockDevice, fan = '4', heat = '0') =>
  device.startRoast(
    new URLSearchParams({
      confirm: 'START_ROAST',
      mode: 'manual',
      name: 'manual test',
      mass: '225',
      fan,
      heat,
    }),
  )
const sessionOf = (outcome: ReturnType<typeof start>) => String(outcome.body.session_id)

const runFor = (device: MockDevice, ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) device.step(TICK_MS)
}

const roast = (device: MockDevice) => (statusDocument(device) as { roast: Record<string, unknown> }).roast

describe('the first-class manual roast in local dev', () => {
  it('starts, accepts operator changes, records as a named roast, and stops immediately', () => {
    const device = new MockDevice()
    const started = start(device)
    expect(started).toMatchObject({
      status: 202,
      body: {
        session_id: 1,
        elapsed_sec: 0,
        accepted_fan: 4,
        accepted_heat: 0,
        effective_fan: 4,
        effective_heat: 0,
        thermal_log_interval_ms: 1000,
      },
    })
    expect(started.body.log_id).toBe(device.archive.currentId)
    expect(roast(device)).toMatchObject({
      active: true,
      mode: 'manual',
      name: 'manual test',
      commanded_fan: 4,
      commanded_heat: 0,
    })

    runFor(device, 31_000)
    const changed = device.setRoast(
      new URLSearchParams({ confirm: 'CONTROL_ROAST', expected_session: sessionOf(started), fan: '5', heat: '7' }),
    )
    expect(changed).toMatchObject({ status: 202, body: { elapsed_sec: 31, accepted_fan: 5, accepted_heat: 7 } })
    expect(roast(device)).toMatchObject({
      active: true,
      mode: 'manual',
      commanded_fan: 5,
      commanded_heat: 7,
      instruction_age_ms: 0,
    })

    runFor(device, 2_000)
    expect(device.stopRoast(new URLSearchParams({ expected_session: sessionOf(started) }))).toMatchObject({
      status: 200,
      body: { session_id: 1, was_active: true, elapsed_sec: 33, end_reason: 'stopped' },
    })
    expect(roast(device)).toMatchObject({ active: false, mode: 'manual', end_reason: 'stopped' })
    expect(device.actuator.effectiveHeat).toBe(0)
    // The post-stop cooling tail: Fan 10 for ten seconds, then off.
    expect(device.actuator.mode).toBe('running')
    expect(device.actuator.effectiveFan).toBe(10)
    runFor(device, 11_000)
    expect(device.actuator.mode).toBe('idle')
    expect(device.actuator.effectiveFan).toBe(0)

    device.runUntil(() => !device.archive.active && !device.archive.unsaved, 3600)
    expect(device.archive.logs[0]).toMatchObject({
      source: 'roast',
      version: 4,
      intervalMs: 1000,
      name: 'manual test',
      batchMassG: 225,
      roastMode: 'manual',
      roastStopSec: 33,
      roastEndReason: 'stopped',
    })
    expect(device.archive.entry(device.archive.logs[0])).toMatchObject({
      source: 'roast',
      roast_mode: 'manual',
      roast_stop_sec: 33,
      roast_end_reason: 'stopped',
    })
    const raw = encodeArchiveFile(device.archive.logs[0])
    expect(raw[65]).toBe(3)
    expect(readArchiveFile(raw, device.archive.logs[0].id).log).toMatchObject({
      source: 'roast',
      roastMode: 'manual',
      roastStopSec: 33,
      roastEndReason: 'stopped',
    })
  })

  it('preserves sub-10-second control changes in a compact archive', () => {
    const device = new MockDevice()
    const started = device.startRoast(
      new URLSearchParams({
        confirm: 'START_ROAST',
        mode: 'manual',
        name: 'compact manual',
        mass: '225',
        fan: '4',
        heat: '0',
        record: '0',
      }),
    )
    runFor(device, 1_000)
    device.setRoast(
      new URLSearchParams({ confirm: 'CONTROL_ROAST', expected_session: sessionOf(started), fan: '5', heat: '2' }),
    )
    runFor(device, 1_000)
    device.setRoast(
      new URLSearchParams({ confirm: 'CONTROL_ROAST', expected_session: sessionOf(started), fan: '6', heat: '3' }),
    )
    device.stopRoast(new URLSearchParams({ expected_session: sessionOf(started) }))
    device.runUntil(() => !device.archive.active && !device.archive.unsaved, 3600)

    const restored = readArchiveFile(encodeArchiveFile(device.archive.logs[0]), device.archive.logs[0].id).log
    expect(restored?.intervalMs).toBe(10_000)
    expect(restored?.planJournal).toEqual([
      { elapsed_sec: 0, plan_rev: 1, requested_fan: 4, requested_heat: 0, effective_fan: 4, effective_heat: 0 },
      { elapsed_sec: 1, plan_rev: 2, requested_fan: 5, requested_heat: 2, effective_fan: 5, effective_heat: 0 },
      { elapsed_sec: 2, plan_rev: 3, requested_fan: 6, requested_heat: 3, effective_fan: 6, effective_heat: 0 },
    ])
  })

  it('expires the whole instruction safely and refuses Set outside a running manual roast', () => {
    const device = new MockDevice()
    const started = start(device, '6', '4')
    expect(started.status).toBe(202)
    runFor(device, MANUAL_INSTRUCTION_LIMIT_MS + TICK_MS * 2)
    expect(roast(device)).toMatchObject({ active: false, mode: 'manual', end_reason: 'instruction_expired' })
    expect(device.actuator.effectiveHeat).toBe(0)
    expect(device.actuator.mode).toBe('idle')
    expect(device.actuator.effectiveFan).toBe(0)
    expect(
      device.setRoast(
        new URLSearchParams({ confirm: 'CONTROL_ROAST', expected_session: sessionOf(started), fan: '4', heat: '0' }),
      ).status,
    ).toBe(409)
  })

  it('refuses stale Set and Stop atomically before they affect a later manual session', () => {
    const device = new MockDevice()
    const first = start(device)
    device.stopRoast(new URLSearchParams({ expected_session: sessionOf(first) }))
    device.runUntil(() => device.actuator.mode === 'idle', 120)
    const second = start(device, '5', '3')
    expect(second.body.session_id).toBe(2)

    expect(
      device.setRoast(
        new URLSearchParams({ confirm: 'CONTROL_ROAST', expected_session: sessionOf(first), fan: '9', heat: '9' }),
      ).status,
    ).toBe(409)
    expect(device.roast).toMatchObject({ active: true, sessionId: 2, commandedFan: 5, commandedHeat: 3 })
    expect(device.stopRoast(new URLSearchParams({ expected_session: sessionOf(first) })).status).toBe(409)
    expect(device.roast?.active).toBe(true)
  })
})
