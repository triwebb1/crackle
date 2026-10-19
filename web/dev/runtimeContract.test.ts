import { describe, expect, it } from 'vitest'
import { parseCalibrationsDocument } from '../src/data/documentSerializer'
import { Archive } from './archive'
import { LOG_CAPACITY_SAMPLES, OVERTEMP_C, OVERTEMP_COOLDOWN_MS } from './config'
import { encodeArchiveFile, readArchiveFile } from './crkFile'
import { MockDevice } from './device'
import { liveDocument, statusDocument } from './documents'
import { Plant } from './plant'

describe('device-owned runtime contract', () => {
  it('seeds one applied calibration consistently in status and the controller library', () => {
    const device = new MockDevice()
    device.seed()
    const applied = device.applied()
    const calibrationDocument = parseCalibrationsDocument(String(device.data.read('calibrations').payload))
    expect(applied).toMatchObject({
      heater_gain: calibrationDocument.settings?.heaterGainCPerMinAt10,
      fan_cooling: calibrationDocument.settings?.fanCoolingCPerMinAt10,
      cooling_fan: calibrationDocument.settings?.coolingFanCPerMinAt10,
      loss_per_min: calibrationDocument.settings?.thermalLossPerMinPerC,
    })
  })
  it('reports the actual live subscriber count with the four-client capacity', () => {
    const device = new MockDevice()
    expect(statusDocument(device, 5173, 3)).toMatchObject({
      live_websocket_available: true,
      live_websocket_port: 5173,
      live_websocket_client_count: 3,
      live_websocket_client_capacity: 4,
    })
    expect(statusDocument(device)).toMatchObject({
      live_websocket_available: false,
      live_websocket_client_count: 0,
    })
  })

  it('serializes independent decimal state and live sequence revisions', () => {
    const device = new MockDevice()
    expect(statusDocument(device)).toMatchObject({ state_rev: '1', thermocouple_offset_c: -3 })
    expect(liveDocument(device).stream_seq).toBe(1)
    expect(liveDocument(device).stream_seq).toBe(2)
    expect(device.bumpStateRevision()).toBe('2')
    expect(liveDocument(device)).toMatchObject({ state_rev: '2', boot_id: '1' })
  })

  it('keeps independent cold-junction evidence when the thermocouple input is faulted', () => {
    const device = new MockDevice()
    device.actuator.fault = 'thermal_sensor'
    const ambient = device.plant.coldJunctionReadingC()

    expect(statusDocument(device).max31856).toMatchObject({
      temperature_valid: false,
      thermocouple_c: null,
      cold_junction_c: ambient,
    })
    expect(statusDocument(device)).toMatchObject({
      calibration_ready: false,
      calibration_readiness: 'sensor_fault_latched',
      calibration_stable_for_ms: 0,
    })
    expect(liveDocument(device)).toMatchObject({ tc_c: null, cj_c: ambient })
    expect(
      device.startCalibration(
        new URLSearchParams({
          confirm: 'FOUR_DASHES_CALIBRATION',
          steps: '1:1',
          step_seconds: '30',
          min_step_seconds: '5',
        }),
      ),
    ).toMatchObject({
      status: 409,
      body: { calibration_readiness: 'sensor_fault_latched', stable_for_ms: 0 },
    })

    device.archive.open(0, 1, 'proof')
    device.advance(100)
    const fields = device.archive.currentCsv.trim().split('\n')[1].split(',')
    expect(fields[1]).toBe('')
    expect(Number(fields[2])).toBeCloseTo(ambient, 2)
  })

  it('holds a device-wide expiring restore lease and reports crash provenance', () => {
    const device = new MockDevice()
    const begun = device.beginRestore(new URLSearchParams({ confirm: 'BEGIN_RESTORE' }))
    expect(begun.status).toBe(200)
    const token = String(begun.body.restore_token)
    expect(device.deleteLog(new URLSearchParams({ id: '1', confirm: 'DELETE_LOG' })).status).toBe(423)
    expect(device.commitRestore(new URLSearchParams({ restore_token: 'wrong' })).status).toBe(409)
    expect(device.commitRestore(new URLSearchParams({ restore_token: token })).body).toMatchObject({
      ok: true,
      committed: true,
      state_rev: '2',
    })
    expect(device.restoreStatus()).toMatchObject({ active: false, incomplete: false })
  })

  it('allows a clean restore lease to abort without changing device data', () => {
    const device = new MockDevice()
    const begun = device.beginRestore(new URLSearchParams({ confirm: 'BEGIN_RESTORE' }))
    const token = String(begun.body.restore_token)
    expect(device.abortRestore(new URLSearchParams({ restore_token: token }))).toMatchObject({
      status: 200,
      body: { ok: true, aborted: true },
    })
    expect(device.restoreStatus()).toMatchObject({ active: false, incomplete: false, dirty: false })
  })

  it('refuses to abort after a restore mutation and retains incomplete maintenance', () => {
    const device = new MockDevice()
    const begun = device.beginRestore(new URLSearchParams({ confirm: 'BEGIN_RESTORE' }))
    const token = String(begun.body.restore_token)
    const calibration = new URLSearchParams({
      confirm: 'APPLY_CALIBRATION',
      restore_token: token,
      heater_gain: '105',
      fan_cooling: '35',
      cooling_fan: '40',
      loss_per_min: '0.08',
      fit_id: 'dirty-fit',
    })
    expect(device.applyCalibration(calibration).status).toBe(200)
    expect(device.abortRestore(new URLSearchParams({ restore_token: token }))).toMatchObject({
      status: 409,
      body: { ok: false, incomplete: true, dirty: true },
    })
    expect(device.restoreStatus()).toMatchObject({ active: true, incomplete: true, dirty: true })
    expect(device.commitRestore(new URLSearchParams({ restore_token: token })).status).toBe(200)
  })

  it('accepts calibration restore writes only under the matching maintenance lease', () => {
    const device = new MockDevice()
    const begun = device.beginRestore(new URLSearchParams({ confirm: 'BEGIN_RESTORE' }))
    const token = String(begun.body.restore_token)
    const calibration = new URLSearchParams({
      confirm: 'APPLY_CALIBRATION',
      heater_gain: '105',
      fan_cooling: '35',
      cooling_fan: '40',
      loss_per_min: '0.08',
      fit_id: 'restored-fit',
    })
    expect(device.applyCalibration(calibration).status).toBe(423)
    calibration.set('restore_token', token)
    expect(device.applyCalibration(calibration)).toMatchObject({
      status: 200,
      body: { ok: true, state_rev: '1' },
    })
    expect(device.commitRestore(new URLSearchParams({ restore_token: token }))).toMatchObject({
      status: 200,
      body: { ok: true, committed: true, state_rev: '2' },
    })
  })

  it('requires one fresh valid probe reading without an arbitrary temperature hold', () => {
    const device = new MockDevice()
    const args = new URLSearchParams({
      confirm: 'FOUR_DASHES_CALIBRATION',
      steps: '1:1',
      step_sec: '30',
      min_step_sec: '5',
      settle_sec: '5',
      settle_band_c: '1',
    })
    expect(statusDocument(device)).toMatchObject({
      calibration_ready: false,
      calibration_readiness: 'sensor_invalid',
      calibration_stable_for_ms: 0,
    })
    expect(device.startCalibration(args)).toMatchObject({
      status: 409,
      body: { message: 'Calibration requires a fresh, fault-free thermocouple reading.' },
    })

    device.advance(1_000)
    const readyStatus = statusDocument(device)
    expect(readyStatus).toMatchObject({
      calibration_ready: true,
      calibration_readiness: 'ready',
    })
    expect(readyStatus.calibration_stable_for_ms).toBe(0)
    expect(device.startCalibration(args).status).toBe(200)
  })

  it('reserves a stable recording id as soon as recording opens', () => {
    const device = new MockDevice()
    device.advance(10_500)
    const result = device.startCalibration(
      new URLSearchParams({
        confirm: 'FOUR_DASHES_CALIBRATION',
        steps: '10:10',
        step_sec: '30',
        min_step_sec: '5',
        settle_sec: '5',
        settle_band_c: '1',
      }),
    )
    expect(result.status).toBe(200)
    expect(result.body.log_id).toBe(device.archive.currentId)
    expect(device.archive.lastIssuedLogId).toBe(Number(result.body.log_id))
    expect(device.stateRev).toBe('1')
  })

  it('uses transition-gated 20 s / +/-0.2 C defaults', () => {
    const device = new MockDevice()
    device.advance(10_500)
    const started = device.startCalibration(
      new URLSearchParams({
        confirm: 'FOUR_DASHES_CALIBRATION',
        steps: '0:0',
        step_seconds: '30',
        min_step_seconds: '5',
      }),
    )
    expect(started).toMatchObject({
      status: 200,
      body: { settle_seconds: 20, settle_band_c: 0.2 },
    })
    device.runUntil(() => (device.calibration?.stepElapsedSec ?? 0) >= 6, 20)
    expect(statusDocument(device).calibration).toMatchObject({
      active: true,
      started_epoch: device.calibration?.startedEpoch,
      settle_state: 'waiting_for_transition',
      completed_steps: [],
    })
  })

  it('projects a stable calibration log id and the last twelve completed steps', () => {
    const device = new MockDevice()
    device.advance(10_500)
    const steps = Array.from({ length: 12 }, (_, index) => `${String((index % 10) + 1)}:0`).join(',')
    const result = device.startCalibration(
      new URLSearchParams({
        confirm: 'FOUR_DASHES_CALIBRATION',
        steps,
        step_seconds: '15',
        min_step_seconds: '5',
        settle_seconds: '2',
        settle_band_tenths_c: '100',
      }),
    )
    expect(result.status).toBe(200)
    const logId = String(result.body.log_id)
    device.runUntil(() => device.calibration?.active !== true, 300)
    const status = statusDocument(device).calibration
    expect(status).toMatchObject({
      active: false,
      log_id: logId,
      step_elapsed_sec: 0,
    })
    expect(status.completed_epoch).toBeGreaterThan(0)
    expect(status.completed_steps).toHaveLength(12)
    expect(status.completed_steps[0]).toMatchObject({ index: 0, fan: 1, heat: 0 })
    expect(status.completed_steps[0].temperature_c).toEqual(expect.any(Number))
    expect(device.archive.currentId).toBe(logId)
  })

  it('cuts heat during a transient probe dropout, recovers, and ends only after the holdover bound', () => {
    const start = (device: MockDevice) => {
      device.appliedCoefficients = {
        heater_gain: 100,
        fan_cooling: 30,
        cooling_fan: 40,
        loss_per_min: 0.08,
        fit_id: 'dropout-test',
        applied_epoch: 1,
      }
      expect(
        device.startRoast(
          new URLSearchParams({
            confirm: 'START_ROAST',
            mode: 'journey',
            name: 'Dropout test',
            mass: '225',
            record: '0',
            start: '21.5',
            zones: '180:300:2:8:1:10',
          }),
        ).status,
      ).toBe(202)
      device.advance(3_000)
      expect(device.actuator.effectiveHeat).toBeGreaterThan(0)
    }

    const transient = new MockDevice()
    start(transient)
    transient.setProbeAvailable(false)
    transient.advance(25_000)
    expect(transient.roast).toMatchObject({ active: true, holdover: true })
    expect(transient.actuator.effectiveHeat).toBe(0)
    expect(transient.actuator.fault).toBe('none')
    transient.setProbeAvailable(true)
    transient.advance(2_000)
    expect(transient.roast).toMatchObject({ active: true, holdover: false })
    expect(transient.actuator.effectiveHeat).toBeGreaterThan(0)

    const lost = new MockDevice()
    start(lost)
    lost.setProbeAvailable(false)
    lost.advance(31_000)
    expect(lost.roast).toMatchObject({ active: false, endReason: 'sensor_lost' })
    expect(lost.actuator.effectiveHeat).toBe(0)
    expect(lost.actuator.fault).toBe('none')
  })

  it('keeps manual and timed roasts alive across a recoverable probe dropout', () => {
    const start = (mode: 'manual' | 'timed') => {
      const device = new MockDevice()
      const params =
        mode === 'manual'
          ? new URLSearchParams({
              confirm: 'START_ROAST',
              mode,
              name: 'Manual dropout',
              mass: '225',
              record: '0',
              fan: '4',
              heat: '5',
            })
          : new URLSearchParams({
              confirm: 'START_ROAST',
              mode,
              name: 'Timed dropout',
              mass: '225',
              record: '0',
              steps: '4:5:60',
            })
      expect(device.startRoast(params).status).toBe(202)
      device.advance(3_000)
      expect(device.actuator.effectiveHeat).toBeGreaterThan(0)
      device.setProbeAvailable(false)
      device.advance(25_000)
      expect(device.roast).toMatchObject({ active: true })
      expect(device.actuator.effectiveHeat).toBe(0)
      device.setProbeAvailable(true)
      device.advance(2_000)
      expect(device.roast).toMatchObject({ active: true, holdover: false })
      expect(device.actuator.effectiveHeat).toBeGreaterThan(0)
    }

    start('manual')
    start('timed')
  })
  it('owns and optimistically patches the bounded active journey plan', () => {
    const device = new MockDevice()
    device.appliedCoefficients = {
      heater_gain: 100,
      fan_cooling: 30,
      cooling_fan: 40,
      loss_per_min: 0.08,
      fit_id: 'test',
      applied_epoch: 1,
    }
    const started = device.startRoast(
      new URLSearchParams({
        confirm: 'START_ROAST',
        mode: 'journey',
        name: 'Patch test',
        mass: '225',
        record: '0',
        start: '21.5',
        zones: '180:60:2:8:1:10;205:90:3:10:0:10',
        profile_id: 'profile-a',
        profile_revision: '4',
      }),
    )
    expect(started.status).toBe(202)
    expect(device.activeRoastPlan().body).toMatchObject({
      session_id: 1,
      plan_rev: 1,
      profile_id: 'profile-a',
      profile_revision: 4,
      initial_zones: [
        { start_c: 21.5, end_c: 180, duration_sec: 60 },
        { start_c: 180, end_c: 205, duration_sec: 90 },
      ],
    })
    const stale = device.patchRoastPlan(
      new URLSearchParams({
        confirm: 'PATCH_ROAST_PLAN',
        expected_session: '1',
        expected_plan_rev: '9',
        zones: '190:65:2:8:1:10;205:90:3:10:0:10',
      }),
    )
    expect(stale.status).toBe(409)
    const patched = device.patchRoastPlan(
      new URLSearchParams({
        confirm: 'PATCH_ROAST_PLAN',
        expected_session: '1',
        expected_plan_rev: '1',
        zones: '190:65:2:8:1:10;205:90:3:10:0:10',
      }),
    )
    expect(patched.status).toBe(202)
    expect(patched.body).toMatchObject({ session_id: 1, plan_rev: 2 })
    expect((patched.body.zones as Array<{ end_c: number }>)[0].end_c).toBe(190)
    expect((patched.body.initial_zones as Array<{ end_c: number }>)[0].end_c).toBe(180)
    device.plant.trueC = 195
    device.plant.probeC = 195
    device.plant.step(0.01, { fan: 0, heat: 0 })
    const immediate = device.patchRoastPlan(
      new URLSearchParams({
        confirm: 'PATCH_ROAST_PLAN',
        expected_session: '1',
        expected_plan_rev: '2',
        zones: '190:65:2:8:1:10;205:90:3:10:0:10',
        allow_immediate_transition: '1',
      }),
    )
    expect(immediate).toMatchObject({ status: 202, body: { immediate_transition: true, plan_rev: 3 } })
    expect(device.roast?.zoneIndex).toBe(1)
    expect(device.roast?.zoneAttainedSec[0]).not.toBeNull()
  })

  it('reports timed-step dwell and enforces five remaining seconds when patching the current step', () => {
    const device = new MockDevice()
    expect(
      device.startRoast(
        new URLSearchParams({
          confirm: 'START_ROAST',
          mode: 'timed',
          name: 'Timed patch',
          mass: '225',
          record: '0',
          steps: '0:0:20,0:0:20',
        }),
      ).status,
    ).toBe(202)
    for (let tick = 0; tick < 120; tick += 1) device.step(50)
    const elapsed = statusDocument(device).roast.step_elapsed_sec
    expect(elapsed).toBeGreaterThanOrEqual(6)
    const change = (duration: number) =>
      device.patchRoastPlan(
        new URLSearchParams({
          confirm: 'PATCH_ROAST_PLAN',
          expected_session: '1',
          expected_plan_rev: '1',
          step_index: '0',
          fan: '0',
          heat: '0',
          duration_sec: String(duration),
        }),
      )
    expect(change(elapsed + 4)).toMatchObject({
      status: 400,
      body: { message: expect.stringContaining(`${elapsed + 5} seconds or more`) },
    })
    expect(change(elapsed + 5)).toMatchObject({ status: 202, body: { plan_rev: 2 } })
  })

  it('always archives record=0 roasts at compact cadence with plan and journal provenance', () => {
    const device = new MockDevice()
    device.appliedCoefficients = {
      heater_gain: 100,
      fan_cooling: 30,
      cooling_fan: 40,
      loss_per_min: 0.08,
      fit_id: 'test',
      applied_epoch: 1,
    }
    const started = device.startRoast(
      new URLSearchParams({
        confirm: 'START_ROAST',
        mode: 'journey',
        name: 'Compact roast',
        mass: '225',
        record: '0',
        start: '21.5',
        zones: '180:60:2:8:1:10;205:90:3:10:0:10',
        profile_id: 'profile-a',
        profile_revision: '4',
      }),
    )
    expect(started).toMatchObject({ status: 202, body: { thermal_log_interval_ms: 10_000 } })
    const logId = String(started.body.log_id)
    expect(logId).toBe(device.archive.currentId)
    expect(statusDocument(device).thermal_log).toMatchObject({ source: 'roast', interval_ms: 10_000, log_id: logId })
    const provisional = device.archive.find(logId)
    expect(provisional).toMatchObject({
      id: logId,
      source: 'roast',
      version: 4,
      intervalMs: 10_000,
      samples: [],
      initialPlan: { mode: 'journey' },
      planJournal: [],
    })

    // Patch and Stop in the same device tick: the passive tail must still produce
    // a durable compact occurrence rather than losing a sub-sample roast.
    const patched = device.patchRoastPlan(
      new URLSearchParams({
        confirm: 'PATCH_ROAST_PLAN',
        expected_session: '1',
        expected_plan_rev: '1',
        zones: '190:65:2:8:1:10;205:90:3:10:0:10',
      }),
    )
    expect(patched.status).toBe(202)
    device.stopRoast()
    device.runUntil(() => !device.archive.active && !device.archive.unsaved, 3600)

    const stored = device.archive.find(logId)
    expect(stored).toMatchObject({
      source: 'roast',
      version: 4,
      intervalMs: 10_000,
      roastMode: 'journey',
      initialPlan: { mode: 'journey' },
    })
    expect(stored?.planJournal).toHaveLength(1)
    expect(stored?.samples.length).toBeGreaterThan(0)
    expect(stored?.samples.length).toBeLessThan(30)
    expect(device.archive.entry(stored!)).toMatchObject({ interval_ms: 10_000, samples: stored?.samples.length })
    expect(device.archive.entry(stored!).duration_ms).toBe(stored?.samples.at(-1)?.[0] ?? 0)
    expect(new DataView(encodeArchiveFile(stored!).buffer).getUint32(20, true)).toBe(stored?.samples.at(-1)?.[0] ?? 0)
    const restored = readArchiveFile(encodeArchiveFile(stored!), logId).log
    expect(restored).toMatchObject({ intervalMs: 10_000, initialPlan: { mode: 'journey' } })
    expect(restored?.planJournal).toHaveLength(1)
  })

  it('persists and applies only the thermocouple offset', () => {
    const device = new MockDevice()
    const raw = device.plant.thermocoupleC()
    const cj = device.plant.coldJunctionReadingC()
    const result = device.setThermocoupleOffset(
      new URLSearchParams({ confirm: 'SET_THERMOCOUPLE_OFFSET', offset_c: '2.5' }),
    )
    expect(result.body).toMatchObject({ ok: true, thermocouple_offset_c: 2.5, state_rev: '2' })
    expect(device.reading()).toBeCloseTo(raw + 2.5, 2)
    expect(device.plant.coldJunctionReadingC()).toBe(cj)
    const restored = new MockDevice()
    restored.restore(device.snapshot())
    expect(restored.thermocoupleOffsetC).toBe(2.5)
  })

  /** Holds the plant at `probeC` (before the thermocouple correction) for `ms` of virtual time. */
  const holdAt = (device: MockDevice, probeC: number, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      device.plant.trueC = probeC
      device.plant.wallC = probeC
      device.plant.probeC = probeC
      device.step(50)
    }
  }

  it('uses the corrected thermocouple for overtemperature safety, then cools at Fan 10', () => {
    const device = new MockDevice()
    expect(device.actuator.request(device.nowMs, 1, 10)).toBeUndefined()
    device.thermocoupleOffsetC = 15
    holdAt(device, 250, 1500)
    expect(device.reading()).toBeGreaterThanOrEqual(OVERTEMP_C)
    expect(device.actuator.fault).toBe('overtemperature')
    expect(device.actuator.effectiveHeat).toBe(0)
    expect(device.actuator.effectiveFan).toBe(10)
    expect(device.actuator.request(device.nowMs, 5, 0)).toMatch(/fault/)
    // Still over the limit: the cooldown keeps going. Below it for the full period: everything off.
    holdAt(device, 250, 200_000)
    expect(device.actuator.effectiveFan).toBe(10)
    holdAt(device, 60, OVERTEMP_COOLDOWN_MS + 2000)
    expect(device.actuator.effectiveFan).toBe(0)
    expect(device.actuator.mode).toBe('idle')
    expect(device.actuator.fault).toBe('overtemperature')
  })

  it('ends an overtemperature cooldown on an operator Stop', () => {
    const device = new MockDevice()
    expect(device.actuator.request(device.nowMs, 1, 10)).toBeUndefined()
    holdAt(device, 265, 1500)
    expect(device.actuator.effectiveFan).toBe(10)
    device.stopAll()
    expect(device.actuator.effectiveFan).toBe(0)
    expect(device.actuator.effectiveHeat).toBe(0)
  })
})

describe('mock recording capacity parity', () => {
  it('closes at capacity without claiming the passive tail completed', () => {
    const archive = new Archive()
    archive.open(0, 1, 'roast', {
      name: 'capacity roast',
      roastMode: 'manual',
      initialPlan: { mode: 'manual', fan: 4, heat: 5 },
    })
    for (let index = 0; index < LOG_CAPACITY_SAMPLES; index += 1) {
      archive.sample(index * 1000, { tcC: 25 + index / 100, cjC: 24, fan: 4, heat: 5 })
    }
    expect(archive.active).toBe(false)
    expect(archive.unsaved).toBe(true)
    const stored = archive.persistFinished()
    expect(stored).toMatchObject({ samples: expect.any(Array), passiveTailComplete: false })
    expect(stored?.samples).toHaveLength(LOG_CAPACITY_SAMPLES)
    expect(archive.entry(stored!)).toMatchObject({ passive_tail_complete: false })
  })
})
describe('mock empty-chamber anchor', () => {
  it('follows the shared empty-chamber rise physics at fan 10 / heat 10', () => {
    const plant = new Plant()
    for (let i = 0; i < 400; i += 1) plant.step(0.05, { fan: 10, heat: 10 })
    const corrected = plant.thermocoupleC() - 3
    // The chamber's fan-10 rise time is about 94 seconds; after 20 seconds it is warm, not settled.
    expect(corrected).toBeGreaterThanOrEqual(45)
    expect(corrected).toBeLessThan(55)
  })
})
