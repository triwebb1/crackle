import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Actuator } from './actuator'
import { HEAT_LEASE_MS, TICK_MS } from './config'
import { MockDevice } from './device'

const runFor = (device: MockDevice, ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) device.step(TICK_MS)
}

describe('the minimal actuator safety contract', () => {
  it('has no cooling takeover route or cooldown state', () => {
    const routeSource = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8')
    const actuatorSource = readFileSync(new URL('./actuator.ts', import.meta.url), 'utf8')
    expect(routeSource).not.toContain('/api/manual/takeover')
    expect(actuatorSource).not.toContain('coolingRemainingMs')
    expect(actuatorSource).not.toContain("'cooling'")
  })

  it('lifts a heat-carrying request to Fan 1.0', () => {
    const actuator = new Actuator()
    expect(actuator.request(0, 0, 6)).toBeUndefined()
    expect(actuator).toMatchObject({ requestedFan: 0, requestedHeat: 6, effectiveFan: 1, effectiveHeat: 0 })

    actuator.tick(1_500, 1_500, 25)
    expect(actuator).toMatchObject({ effectiveFan: 1, effectiveHeat: 6 })
  })

  it('honors fan-only levels and turns Fan off immediately when asked', () => {
    const actuator = new Actuator()
    actuator.request(0, 5, 10)
    actuator.tick(1_500, 1_500, 25)
    expect(actuator).toMatchObject({ effectiveFan: 5, effectiveHeat: 10 })

    actuator.request(1_500, 0.1, 0)
    expect(actuator).toMatchObject({ requestedFan: 0.1, requestedHeat: 0, effectiveFan: 0.1, effectiveHeat: 0 })

    actuator.request(2_500, 0, 0)
    expect(actuator).toMatchObject({ requestedFan: 0, requestedHeat: 0, effectiveFan: 0, effectiveHeat: 0 })
  })

  it('accepts direct Fan 0 commands and treats Fan 0 / Heat 0 as Stop', () => {
    const device = new MockDevice()
    // Heat on means Fan 1.0 or higher: the command layer lifts the pair, never refuses it.
    expect(device.startManual(new URLSearchParams({ confirm: 'MANUAL_CONTROL', fan: '0', heat: '6' }))).toMatchObject({
      status: 200,
      body: { manual_active: true, fan_level: 1, effective_fan: 1 },
    })
    runFor(device, 2_000)
    expect(device.actuator).toMatchObject({ effectiveFan: 1, effectiveHeat: 6 })

    expect(device.startManual(new URLSearchParams({ confirm: 'MANUAL_CONTROL', fan: '0.1', heat: '0' }))).toMatchObject(
      { status: 200, body: { manual_active: true, fan_level: 0.1, effective_fan: 0.1 } },
    )
    expect(device.startManual(new URLSearchParams({ confirm: 'MANUAL_CONTROL', fan: '0', heat: '0' }))).toMatchObject({
      status: 200,
      body: { manual_active: false, heater_off: true },
    })
    expect(device.actuator).toMatchObject({ mode: 'idle', effectiveFan: 0, effectiveHeat: 0 })
  })

  it('makes an unrenewed Heat lease an immediate full stop', () => {
    const actuator = new Actuator()
    actuator.request(0, 4, 10)
    actuator.tick(1_500, 1_500, 25)

    expect(actuator.tick(HEAT_LEASE_MS + 1, TICK_MS, 25).leaseExpired).toBe(true)
    expect(actuator).toMatchObject({
      mode: 'idle',
      requestedFan: 0,
      requestedHeat: 0,
      effectiveFan: 0,
      effectiveHeat: 0,
    })
  })

  it('follows a roast Stop with the ten-second Fan 10 / Heat 0 cooling tail, then a passive fan-off tail', () => {
    // A Stop that interrupts an active roast commands Fan 10 / Heat 0
    // for ten seconds, then both outputs off — residual element heat must not scorch still beans.
    const device = new MockDevice()
    const started = device.startRoast(
      new URLSearchParams({
        confirm: 'START_ROAST',
        mode: 'manual',
        name: 'stop test',
        mass: '225',
        fan: '4',
        heat: '8',
      }),
    )
    runFor(device, 2_000)

    expect(device.stopRoast(new URLSearchParams({ expected_session: String(started.body.session_id) }))).toMatchObject({
      status: 200,
      body: { heater_off: true, effective_fan: 10, effective_heat: 0 },
    })
    expect(device.roast).toMatchObject({ active: false, endReason: 'stopped' })
    expect(device.actuator).toMatchObject({ mode: 'running', effectiveFan: 10, effectiveHeat: 0 })
    expect(device.archive.active).toBe(true)

    runFor(device, 9_000)
    expect(device.actuator).toMatchObject({ mode: 'running', effectiveFan: 10, effectiveHeat: 0 })
    runFor(device, 2_000)
    expect(device.actuator).toMatchObject({ mode: 'idle', effectiveFan: 0, effectiveHeat: 0 })

    runFor(device, 2_000)
    expect(device.archive.currentSamples).toBeGreaterThan(0)
    expect(device.archive.currentCsv).toContain(',10.000,0.000')
    expect(device.archive.currentCsv).toContain(',0.000,0.000')
  })

  it('lets a second Stop end the cooling tail with genuinely-off outputs in one command', () => {
    const device = new MockDevice()
    const started = device.startRoast(
      new URLSearchParams({
        confirm: 'START_ROAST',
        mode: 'manual',
        name: 'double stop',
        mass: '225',
        fan: '4',
        heat: '8',
      }),
    )
    runFor(device, 2_000)
    device.stopRoast(new URLSearchParams({ expected_session: String(started.body.session_id) }))
    expect(device.actuator).toMatchObject({ mode: 'running', effectiveFan: 10 })

    expect(device.stopRoast()).toMatchObject({ status: 200, body: { effective_fan: 0, effective_heat: 0 } })
    expect(device.actuator).toMatchObject({ mode: 'idle', effectiveFan: 0, effectiveHeat: 0 })
  })

  it('never lets the cooling tail block or outlive a newly accepted instruction', () => {
    const device = new MockDevice()
    const started = device.startRoast(
      new URLSearchParams({
        confirm: 'START_ROAST',
        mode: 'manual',
        name: 'preempt',
        mass: '225',
        fan: '4',
        heat: '8',
      }),
    )
    runFor(device, 2_000)
    device.stopRoast(new URLSearchParams({ expected_session: String(started.body.session_id) }))
    expect(device.actuator).toMatchObject({ mode: 'running', effectiveFan: 10 })

    // A manual instruction lands DURING the tail — no lockout, and it owns the actuator from here.
    expect(device.startManual(new URLSearchParams({ confirm: 'MANUAL_CONTROL', fan: '3', heat: '0' }))).toMatchObject({
      status: 200,
      body: { manual_active: true, fan_level: 3 },
    })
    expect(device.actuator).toMatchObject({ effectiveFan: 3, effectiveHeat: 0 })

    // The retired tail deadline must not fire into the successor instruction.
    runFor(device, 11_000)
    expect(device.manual.active).toBe(true)
    expect(device.actuator).toMatchObject({ mode: 'running', effectiveFan: 3 })
  })

  it('keeps an authored Fan-only step until its own duration ends', () => {
    const device = new MockDevice()
    device.startRoast(
      new URLSearchParams({
        confirm: 'START_ROAST',
        mode: 'timed',
        name: 'fan only',
        mass: '225',
        steps: '10:0:3',
      }),
    )
    runFor(device, 1_000)
    expect(device.actuator).toMatchObject({ mode: 'running', effectiveFan: 10, effectiveHeat: 0 })

    runFor(device, 2_000)
    expect(device.roast).toMatchObject({ active: false, endReason: 'completed' })
    expect(device.actuator).toMatchObject({ mode: 'idle', effectiveFan: 0, effectiveHeat: 0 })
  })
})
