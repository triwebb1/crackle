/**
 * Mock parity for the instruction lease, against `firmware/crackle/README.md`, "The instruction
 * lease" - the same standard `dataStore.test.ts` holds the document store to, and for the same
 * reason: this is what the manual screen is reviewed against on the dev server, so a mock that
 * models an earlier draft of the firmware certifies behaviour that will not happen on the day.
 *
 * The firmware's sentence is FULL expiry. 30 minutes after the most recent accepted `set` the whole
 * instruction ends - the session goes inactive, every output stops, and `end_reason` becomes
 * `instruction_expired`. Fan-only instructions expire on exactly the same terms, because a fan-only
 * setting is an instruction and a session that lingered would keep blocking programs and holding
 * Wi-Fi awake.
 *
 * An earlier draft of the rule stopped renewing the Heat lease and let the actuator's own 30 s bound
 * drop Heat, fan and session left running. A mock modelling that draft has two visible tells, and
 * both are asserted here so neither can come back.
 */
import { describe, expect, it } from 'vitest'
import { MANUAL_INSTRUCTION_LIMIT_MS, TICK_MS } from './config'
import { MockDevice } from './device'
import { statusDocument } from './documents'

const started = (fan: number, heat: number) => {
  const device = new MockDevice()
  const outcome = device.startManual(
    new URLSearchParams({ confirm: 'MANUAL_CONTROL', fan: String(fan), heat: String(heat) }),
  )
  expect(outcome.status ?? 200).toBe(200)
  expect(device.manual.active).toBe(true)
  return device
}

/** Simulated time only, one tick at a time, exactly as the running mock advances it. */
const runFor = (device: MockDevice, ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) device.step(TICK_MS)
}

const manual = (device: MockDevice) =>
  (
    statusDocument(device) as {
      manual: {
        active: boolean
        end_reason: string
        instruction_age_ms: number
        instruction_limit_ms: number
      }
    }
  ).manual

describe('the manual instruction lease, as the firmware documents it', () => {
  it('holds the instruction for the full 30 minutes without a client saying anything', () => {
    const device = started(6, 4)
    runFor(device, MANUAL_INSTRUCTION_LIMIT_MS - 60_000)
    // Nothing has renewed it and nothing needed to: the browser could have been shut for 29 of them.
    expect(manual(device).active).toBe(true)
    expect(manual(device).end_reason).toBe('none')
    expect(device.actuator.effectiveHeat).toBeGreaterThan(0)
  })

  it('ends the whole session and all outputs at the limit', () => {
    const device = started(6, 4)
    runFor(device, MANUAL_INSTRUCTION_LIMIT_MS + TICK_MS * 2)

    const status = manual(device)
    expect(status.active).toBe(false)
    expect(status.end_reason).toBe('instruction_expired')
    expect(status.instruction_limit_ms).toBe(MANUAL_INSTRUCTION_LIMIT_MS)
    expect(device.actuator.mode).toBe('idle')
    expect(device.actuator.effectiveHeat).toBe(0)
    expect(device.actuator.effectiveFan).toBe(0)
  })

  /**
   * The first tell of the superseded draft. Heat-only expiry left `active` true for up to the
   * actuator's own 30 s lease past the limit, which is a window in which the status document says
   * the roaster is running an instruction that has already run out.
   */
  it('does not outlive its limit by an actuator lease', () => {
    const device = started(6, 4)
    runFor(device, MANUAL_INSTRUCTION_LIMIT_MS + TICK_MS * 2)
    expect(manual(device).active).toBe(false)
    // Said as the bound rather than as a tick count: within one tick of the limit, not 30 seconds.
    expect(device.nowMs - MANUAL_INSTRUCTION_LIMIT_MS).toBeLessThanOrEqual(TICK_MS * 2)
  })

  /** The second tell, and the plainer one: a fan-only session must not run forever. */
  it('expires a fan-only instruction on the same terms, because it is an instruction too', () => {
    const device = started(6, 0)
    expect(device.actuator.effectiveHeat).toBe(0)

    runFor(device, MANUAL_INSTRUCTION_LIMIT_MS - 60_000)
    expect(manual(device).active).toBe(true)

    runFor(device, 60_000 + TICK_MS * 2)
    const status = manual(device)
    expect(status.active).toBe(false)
    expect(status.end_reason).toBe('instruction_expired')
    // The whole instruction ends, so no output remains active.
    expect(device.actuator.mode).not.toBe('running')
    expect(device.manual.fanLevel).toBe(0)
  })

  it('resets the clock on any new set, the same levels repeated included', () => {
    const device = started(6, 4)
    runFor(device, MANUAL_INSTRUCTION_LIMIT_MS - 60_000)
    // The same levels again. The firmware counts it as a new instruction; so does this.
    device.startManual(new URLSearchParams({ confirm: 'MANUAL_CONTROL', fan: '6', heat: '4' }))
    expect(manual(device).instruction_age_ms).toBe(0)

    runFor(device, MANUAL_INSTRUCTION_LIMIT_MS - 60_000)
    expect(manual(device).active).toBe(true)
    runFor(device, 60_000 + TICK_MS * 2)
    expect(manual(device).active).toBe(false)
    expect(manual(device).end_reason).toBe('instruction_expired')
  })

  it('can start calibration immediately after fan-only controls stop', () => {
    const device = started(4, 0)
    expect(device.stopManual()).toMatchObject({ body: { manual_active: false, heater_off: true } })
    expect(device.archive.active).toBe(false)
    expect(device.archive.unsaved).toBe(false)
    // Calibration still requires one current sensor sample; it does not require a stability hold.
    device.advance(1_000)

    const calibration = device.startCalibration(
      new URLSearchParams({
        confirm: 'FOUR_DASHES_CALIBRATION',
        steps: '1:1',
        step_seconds: '30',
        min_step_seconds: '5',
        settle_seconds: '2',
        settle_band_c: '0.2',
      }),
    )
    expect(calibration.status ?? 200).toBe(200)
    expect(device.calibration?.active).toBe(true)
  })
  /** Manual Controls is deliberately separate from the recordable Manual Roast workflow. */
  it('does not create or finalize a thermal recording', () => {
    const device = started(6, 4)
    expect(device.archive.active).toBe(false)
    expect(device.archive.unsaved).toBe(false)
    expect(device.archive.logs).toEqual([])

    runFor(device, MANUAL_INSTRUCTION_LIMIT_MS + TICK_MS * 2)
    expect(manual(device).end_reason).toBe('instruction_expired')
    expect(device.archive.active).toBe(false)
    expect(device.archive.unsaved).toBe(false)
    expect(device.archive.logs).toEqual([])
  })
})
