import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseThermalCsv } from '../domain/thermalLog'
import { testLogProvenance } from '../testFixtures/provenance'
import {
  type CalibrationStartParams,
  calibrationParamError,
  HttpControllerClient,
  programSteps,
  RESTORE_MAX_BYTES,
  setControllerModelGate,
  setControllerMutationGate,
  stateRevision,
} from './client'

const respondWith = (body: unknown, status = 200) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  )
}

interface Call {
  url: string
  method: string
}

// Routes by URL prefix so a command's own status pre-flight is visible in the call log.
const route = (handlers: Array<[string, () => Response]>) => {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      const match = handlers.find(([prefix]) => url.startsWith(prefix))
      return match ? match[1]() : new Response('', { status: 404 })
    }),
  )
  return calls
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** One handler for every call, for tests that only care what came back. */
const stubFetch = (handler: (url: RequestInfo | URL, init?: RequestInit) => Response) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => handler(url, init)),
  )
}

const diagnosticBody = (overrides: Record<string, unknown> = {}) => ({
  firmware_version: '2026-07-26.26',
  boot_count: 7,
  roaster: {
    device_id: 'esp32-aabbccddeeff',
    model_id: 'freshroast-sr800',
    display_name: 'FreshRoast SR800',
    simulated: false,
  },
  lifecycle: 'STANDBY',
  manual_conflict_latched: false,
  actuator: { fault: 'none' },
  max31856: { temperature_valid: true, thermocouple_c: 24.75, cold_junction_c: 23.5 },
  ...overrides,
})

afterEach(() => {
  setControllerMutationGate(undefined)
  setControllerModelGate(undefined)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('model-specific command gate', () => {
  it('blocks actuation but preserves Stop and model-neutral storage', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    setControllerModelGate((operation) => `unsupported ${operation}`)
    const controller = new HttpControllerClient()
    await expect(
      controller.startRoast({ mode: 'timed', confirm: 'START_ROAST', name: 'x', mass: '225', steps: '8:5:120' }),
    ).resolves.toMatchObject({ ok: false, message: 'unsupported start' })
    expect(calls).toEqual([])
    await expect(controller.stopRoast()).resolves.toMatchObject({ ok: true })
    await expect(controller.stopAll()).resolves.toMatchObject({ ok: true })
    await expect(controller.deleteDeviceLog('1')).resolves.toMatchObject({ ok: true })
    expect(calls).toEqual(['/api/roast/stop', '/api/stop', '/api/logs/delete?id=1&confirm=DELETE_LOG'])
  })
})

describe('diagnostic controller status', () => {
  it('shares one full status request among overlapping callers', async () => {
    let answer!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve
          }),
      ),
    )
    const controller = new HttpControllerClient()

    const first = controller.status()
    const second = controller.status()
    expect(fetch).toHaveBeenCalledTimes(1)

    answer(
      new Response(JSON.stringify(diagnosticBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(first).resolves.toMatchObject({ connected: true, bootId: '7' })
    await expect(second).resolves.toMatchObject({ connected: true, bootId: '7' })

    const third = controller.status()
    expect(fetch).toHaveBeenCalledTimes(2)
    answer(
      new Response(JSON.stringify(diagnosticBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(third).resolves.toMatchObject({ connected: true })
  })
  it('drains and retries one explicitly transient idempotent read and then stops', async () => {
    vi.useFakeTimers()
    const first = new Response(JSON.stringify({ message: 'workers busy' }), {
      status: 503,
      headers: { 'Retry-After': '1' },
    })
    const replies = [
      first,
      new Response(JSON.stringify(diagnosticBody()), { status: 200, headers: { 'content-type': 'application/json' } }),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => replies.shift()!),
    )
    const pending = new HttpControllerClient().status()
    await vi.advanceTimersByTimeAsync(1_200)
    await expect(pending).resolves.toMatchObject({ connected: true, bootId: '7' })
    expect(first.bodyUsed).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reads a healthy diagnostic status', async () => {
    respondWith(diagnosticBody())
    const status = await new HttpControllerClient().status()
    expect(status.connected).toBe(true)
    expect(status.lifecycle).toBe('STANDBY')
    expect(status.temperatureC).toBe(24.75)
    expect(status.bootId).toBe('7')
    expect(status.roaster).toEqual({
      deviceId: 'esp32-aabbccddeeff',
      modelId: 'freshroast-sr800',
      displayName: 'FreshRoast SR800',
      simulated: false,
    })
    expect(status.receivedAtMs).toBeGreaterThan(0)
  })

  it('surfaces boot, timing, memory, and named probe-fault diagnostics', async () => {
    respondWith(
      diagnosticBody({
        system: {
          reset_reason: 'brownout',
          uptime_ms: 123_000,
          heap_free_bytes: 91_000,
          heap_minimum_free_bytes: 72_000,
          heap_largest_free_block_bytes: 64_000,
          psram_free_bytes: 1_200_000,
          psram_minimum_free_bytes: 1_100_000,
          psram_largest_free_block_bytes: 1_000_000,
          loop_last_gap_ms: 2,
          loop_maximum_gap_ms: 87,
          archive_persist_last_ms: 41,
          archive_persist_maximum_ms: 319,
          archive_persist_count: 6,
          boot_history: [{ boot: 685, reset_reason: 'power_on' }, { boot: 684, reset_reason: 'panic' }, { boot: 'x' }],
          stored_crash: {
            task: 'httpd',
            pc: '0x4200abcd',
            corrupted: false,
            elf_sha256: '851987c191581f7b',
            current_build: false,
            backtrace: ['0x4200abcd', '0x4200beef'],
          },
          psram_low_water_bytes: 1_050_000,
          psram_low_water_at_ms: 61_000,
          failed_allocations: 2,
          last_failed_allocation: { bytes: 4_096, caps: 2_048, at_ms: 90_000 },
        },
        max31856: {
          temperature_valid: false,
          thermocouple_c: null,
          cold_junction_c: 23.5,
          fault_status: 1,
          fault_reasons: ['open_circuit'],
        },
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status.system).toMatchObject({
      resetReason: 'brownout',
      uptimeMs: 123_000,
      freeHeapBytes: 91_000,
      minimumFreeHeapBytes: 72_000,
      maximumLoopGapMs: 87,
      maximumArchivePersistMs: 319,
      archivePersistCount: 6,
      bootHistory: [
        { boot: 685, resetReason: 'power_on' },
        { boot: 684, resetReason: 'panic' },
      ],
      storedCrash: {
        task: 'httpd',
        pc: '0x4200abcd',
        corrupted: false,
        elfSha256: '851987c191581f7b',
        currentBuild: false,
        backtrace: ['0x4200abcd', '0x4200beef'],
      },
      psramLowWaterBytes: 1_050_000,
      psramLowWaterAtMs: 61_000,
      failedAllocations: 2,
      lastFailedAllocation: { bytes: 4_096, caps: 2_048, atMs: 90_000 },
    })
    expect(status.sensorFaultReasons).toEqual(['open_circuit'])
  })
  it('keeps the controller-owned calibration readiness and progress', async () => {
    respondWith(
      diagnosticBody({
        calibration_ready: false,
        calibration_readiness: 'stabilizing',
        calibration_stable_for_ms: 6_250,
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status).toMatchObject({
      calibrationReady: false,
      calibrationReadiness: 'stabilizing',
      calibrationStableForMs: 6_250,
    })

    respondWith(
      diagnosticBody({
        calibration_ready: false,
        calibration_readiness: 'sensor_fault_latched',
        calibration_stable_for_ms: 0,
      }),
    )
    expect(await new HttpControllerClient().status()).toMatchObject({
      calibrationReady: false,
      calibrationReadiness: 'sensor_fault_latched',
      calibrationStableForMs: 0,
    })

    respondWith(diagnosticBody())
    const legacy = await new HttpControllerClient().status()
    expect(legacy.calibrationReady).toBeUndefined()
    expect(legacy.calibrationReadiness).toBeUndefined()
  })

  it('keeps WebSocket recovery diagnostics in the copyable status snapshot', async () => {
    respondWith(
      diagnosticBody({
        live_websocket_available: true,
        live_websocket_port: 81,
        live_websocket_client_count: 2,
        live_websocket_client_capacity: 4,
        live_websocket_broadcast_count: 1_234,
        live_websocket_send_failure_count: 3,
        live_websocket_queue_failure_count: 1,
        live_websocket_stack_low_water_bytes: 2_048,
        http_pending_static_transfer_count: 2,
        http_response_stall_abort_count: 4,
        http_response_peer_abort_count: 7,
        http_rejected_request_count: 9,
        http_worker_failure_count: 2,
        http_worker_stack_low_water_bytes: 6_144,
        http_asset_worker_stack_low_water_bytes: 2_960,
        http_command_worker_stack_low_water_bytes: 6_144,
        storage_worker_stack_low_water_bytes: 7_168,
        storage_worker_stack_low_water_route: 'POST /api/data/runs/run-a',
        storage_request_slowest_ms: 612,
        storage_request_slowest_route: 'GET /api/logs',
        storage_requests_over_1s: 0,
        station_rssi_dbm: -68,
        wifi_disconnect_count: 1,
      }),
    )
    expect((await new HttpControllerClient().status()).liveTransport).toEqual({
      websocketAvailable: true,
      websocketPort: 81,
      websocketClientCount: 2,
      websocketClientCapacity: 4,
      websocketBroadcastCount: 1_234,
      websocketSendFailureCount: 3,
      websocketQueueFailureCount: 1,
      websocketStackLowWaterBytes: 2_048,
      pendingStaticTransferCount: 2,
      httpResponseStallAbortCount: 4,
      httpResponsePeerAbortCount: 7,
      httpRejectedRequestCount: 9,
      httpWorkerFailureCount: 2,
      httpWorkerStackLowWaterBytes: 6_144,
      httpAssetWorkerStackLowWaterBytes: 2_960,
      httpCommandWorkerStackLowWaterBytes: 6_144,
      storageWorkerStackLowWaterBytes: 7_168,
      storageWorkerStackLowWaterRoute: 'POST /api/data/runs/run-a',
      storageSlowestRequestMs: 612,
      storageSlowestRequestRoute: 'GET /api/logs',
      storageRequestsOverOneSecond: 0,
      wifiRssiDbm: -68,
      wifiDisconnectCount: 1,
    })
  })
  it('resolves every HTTP request against an explicitly configured target origin', async () => {
    respondWith(diagnosticBody())
    await new HttpControllerClient({ baseUrl: 'http://roaster.local/' }).status()
    expect(fetch).toHaveBeenCalledWith('http://roaster.local/api/status', expect.any(Object))
  })

  it('routes HTTP through the selected same-origin development proxy prefix', async () => {
    respondWith(diagnosticBody())
    await new HttpControllerClient({ baseUrl: 'http://127.0.0.1:5173', pathPrefix: '/__crackle/physical' }).status()
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5173/__crackle/physical/api/status', expect.any(Object))
  })

  it('rejects target URLs that are not plain HTTP origins', () => {
    expect(() => new HttpControllerClient({ baseUrl: 'ftp://roaster.local' })).toThrow(/http or https/)
    expect(() => new HttpControllerClient({ baseUrl: 'http://roaster.local/controller' })).toThrow(/without a path/)
    expect(() => new HttpControllerClient({ baseUrl: 'http://user:pass@roaster.local' })).toThrow(/without credentials/)
  })

  it('treats null sensor readings as missing rather than 0 °C', async () => {
    respondWith(diagnosticBody({ max31856: { temperature_valid: false, thermocouple_c: null, cold_junction_c: null } }))
    const status = await new HttpControllerClient().status()
    expect(status.temperatureC).toBeUndefined()
    expect(status.ambientC).toBeUndefined()
    expect(status.thermocoupleValid).toBe(false)
  })

  it('keeps manual lockout dominant over the reported lifecycle', async () => {
    respondWith(diagnosticBody({ lifecycle: 'RUNNING', manual_conflict_latched: true }))
    const status = await new HttpControllerClient().status()
    expect(status.lifecycle).toBe('MANUAL_LOCKOUT')
    expect(status.manualLockout).toBe(true)
  })

  it('keeps an actuator fault dominant over the reported lifecycle', async () => {
    respondWith(diagnosticBody({ lifecycle: 'READY', actuator: { fault: 'fan_stalled' } }))
    const status = await new HttpControllerClient().status()
    expect(status.lifecycle).toBe('FAULT')
    expect(status.fault).toBe('fan_stalled')
  })

  it('fails capabilities closed whenever the firmware advertises a capability object', async () => {
    respondWith(
      diagnosticBody({
        capabilities: { api_version: 'runner-v1', autonomous_timed_programs: true, thermal_execution: true },
      }),
    )
    const advertised = await new HttpControllerClient().status()
    expect(advertised.capabilities).toEqual({
      apiVersion: 'runner-v1',
      autonomousTimedPrograms: false,
      thermalExecution: false,
      diagnosticTests: false,
      manualRoast: false,
    })

    respondWith(diagnosticBody({ capabilities: { diagnostic_tests: true, manual_roast: true } }))
    const explicit = await new HttpControllerClient().status()
    expect(explicit.capabilities.diagnosticTests).toBe(true)
    expect(explicit.capabilities.manualRoast).toBe(true)

    respondWith(diagnosticBody({ capabilities: { diagnostic_tests: 'yes' } }))
    const fuzzy = await new HttpControllerClient().status()
    expect(fuzzy.capabilities.diagnosticTests).toBe(false)

    respondWith(diagnosticBody())
    const legacy = await new HttpControllerClient().status()
    expect(legacy.capabilities.diagnosticTests).toBe(true)
    expect(legacy.capabilities.autonomousTimedPrograms).toBe(false)
    expect(legacy.capabilities.thermalExecution).toBe(false)
  })

  it('treats 401 as an authentication requirement', async () => {
    respondWith({}, 401)
    const status = await new HttpControllerClient().status()
    expect(status.connected).toBe(false)
    expect(status.lifecycle).toBe('DISCONNECTED')
    expect(status.fault).toBe('Sign in required')
  })

  it('treats other HTTP failures as disconnected and preserves a device explanation', async () => {
    respondWith({}, 503)
    expect((await new HttpControllerClient().status()).fault).toBe('HTTP 503')
    respondWith({ message: 'The roaster is restoring its library.' }, 503)
    expect((await new HttpControllerClient().status()).fault).toBe('The roaster is restoring its library.')
  })

  it('treats a timeout or network rejection as disconnected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('The operation was aborted due to timeout')
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status.connected).toBe(false)
    expect(status.stale).toBe(true)
    expect(status.fault).toBe('The operation was aborted due to timeout')
  })

  /**
   * `write_floor_bytes` is where the controller answers 507. Discarding it here would make the
   * storage panel fall back to a constant that predates the derived line, and then subtract the
   * archive's reserve a second time on top of it. The firmware emits the field
   * precisely because "the line is not a round number a client should hardcode".
   */
  it('keeps the document store write floor the controller reports', async () => {
    respondWith(
      diagnosticBody({
        data_store: {
          mounted: true,
          used_bytes: 8192,
          total_bytes: 917_504,
          free_bytes: 700_000,
          write_floor_bytes: 218_408,
          collections: {},
          runs: { count: 0, bytes: 0 },
        },
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status.dataStore?.writeFloorBytes).toBe(218_408)

    // Absent on older firmware, and absent is not zero: the app's own derivation takes over.
    respondWith(diagnosticBody({ data_store: { mounted: true, used_bytes: 8192, collections: {}, runs: {} } }))
    expect((await new HttpControllerClient().status()).dataStore?.writeFloorBytes).toBeUndefined()
  })
})

describe('calibration and thermal-log status blocks', () => {
  it('parses a running pair-form calibration program and its log counters', async () => {
    respondWith(
      diagnosticBody({
        lifecycle: 'RUNNING',
        calibration: {
          active: true,
          started_epoch: 1_774_443_000,
          step_index: 2,
          step_count: 12,
          current_fan_level: 3,
          current_heat_level: 5,
          max_step_seconds: 120,
          min_step_seconds: 10,
          settle_seconds: 3,
          settle_band_c: 5,
          last_step_advance: 'settled',
          log_id: '71',
          completed_epoch: 1_774_444_222,
          step_elapsed_sec: 38,
          settle_state: 'waiting_for_transition',
          completed_steps: [{ index: 0, fan: 2, heat: 4, elapsed_sec: 61, temperature_c: 148.26, outcome: 'capped' }],
          lease_renewals: 7,
          end_reason: 'none',
        },
        thermal_log: {
          available: false,
          active: true,
          samples: 184,
          capacity: 2400,
          interval_ms: 1000,
          download: '/thermal.csv',
          log_id: '72',
        },
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status.calibration).toEqual({
      active: true,
      startedEpoch: 1_774_443_000,
      stepIndex: 2,
      stepCount: 12,
      currentFanLevel: 3,
      currentHeatLevel: 5,
      maxStepSeconds: 120,
      minStepSeconds: 10,
      settleSeconds: 3,
      settleBandC: 5,
      lastStepAdvance: 'settled',
      logId: '71',
      completedEpoch: 1_774_444_222,
      stepElapsedSec: 38,
      settleState: 'waiting_for_transition',
      completedSteps: [{ index: 0, fan: 2, heat: 4, elapsedSec: 61, temperatureC: 148.26, outcome: 'capped' }],
      leaseRenewals: 7,
      endReason: undefined,
    })
    expect(status.thermalLog).toEqual({
      available: false,
      active: true,
      samples: 184,
      capacity: 2400,
      intervalMs: 1000,
      download: '/thermal.csv',
      logId: '72',
    })
  })

  it('ignores fields retired by later firmware rather than mis-reading them', async () => {
    respondWith(
      diagnosticBody({
        calibration: {
          active: true,
          fan_level: 5,
          step_seconds: 60,
          step_count: 4,
          ceiling_c: 320,
          advance_margin_c: 15,
          skipped_steps: 3,
        },
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status.calibration?.currentFanLevel).toBeUndefined()
    expect(status.calibration?.maxStepSeconds).toBeUndefined()
    expect(status.calibration?.stepCount).toBe(4)
    // Firmware 2026-07-26.34 and later omit these three, and the client does not read them.
    expect(Object.keys(status.calibration ?? {})).not.toContain('ceilingC')
    expect(Object.keys(status.calibration ?? {})).not.toContain('advanceMarginC')
    expect(Object.keys(status.calibration ?? {})).not.toContain('skippedSteps')
  })

  it('keeps both blocks undefined on firmware that does not send them', async () => {
    respondWith(diagnosticBody())
    const status = await new HttpControllerClient().status()
    expect(status.calibration).toBeUndefined()
    expect(status.thermalLog).toBeUndefined()
  })

  it('is null-safe about every field inside the blocks', async () => {
    respondWith(
      diagnosticBody({
        calibration: {
          active: 'yes',
          started_epoch: 0,
          current_fan_level: null,
          step_index: 'two',
          step_count: null,
          current_heat_level: null,
          max_step_seconds: null,
          min_step_seconds: null,
          settle_seconds: 'five',
          settle_band_c: null,
          last_step_advance: 'none',
          lease_renewals: null,
          end_reason: 'completed',
        },
        thermal_log: { samples: null, capacity: 'lots' },
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status.calibration).toEqual({
      active: false,
      startedEpoch: undefined,
      stepIndex: undefined,
      stepCount: undefined,
      currentFanLevel: undefined,
      currentHeatLevel: undefined,
      maxStepSeconds: undefined,
      minStepSeconds: undefined,
      settleSeconds: undefined,
      settleBandC: undefined,
      lastStepAdvance: undefined,
      leaseRenewals: undefined,
      endReason: 'completed',
    })
    expect(status.thermalLog).toEqual({
      active: false,
      samples: undefined,
      capacity: undefined,
      intervalMs: undefined,
      download: undefined,
    })
  })

  it('accepts only the two advance sentinels the firmware can emit', async () => {
    respondWith(diagnosticBody({ calibration: { active: true, last_step_advance: 'capped' } }))
    expect((await new HttpControllerClient().status()).calibration?.lastStepAdvance).toBe('capped')

    // `limited` retired with the program ceiling and must not be accepted any more.
    respondWith(diagnosticBody({ calibration: { active: true, last_step_advance: 'limited' } }))
    expect((await new HttpControllerClient().status()).calibration?.lastStepAdvance).toBeUndefined()

    respondWith(diagnosticBody({ calibration: { active: true, last_step_advance: 'something_else' } }))
    expect((await new HttpControllerClient().status()).calibration?.lastStepAdvance).toBeUndefined()
  })

  it('ignores non-object blocks instead of throwing', async () => {
    respondWith(diagnosticBody({ calibration: 'idle', thermal_log: [] }))
    const status = await new HttpControllerClient().status()
    expect(status.calibration).toBeUndefined()
    expect(status.thermalLog).toBeUndefined()
  })
})

describe('diagnostic calibration commands', () => {
  const shared = { maxStepSeconds: 120, minStepSeconds: 10, settleSeconds: 3, settleBandC: 5 }
  const params: CalibrationStartParams = {
    ...shared,
    steps: [
      { fan: 3, heat: 1 },
      { fan: 3, heat: 5 },
      { fan: 3, heat: 10 },
    ],
  }
  const grid: CalibrationStartParams = { ...shared, fans: [1, 4, 7, 10], heats: [1, 5, 10] }

  it('sends the steps pair form with the confirm token and every bounded parameter', async () => {
    const calls = route([
      ['/api/status', json(diagnosticBody({ capabilities: { diagnostic_tests: true } }))],
      ['/api/calibration/start', json({ ok: true, message: 'Calibration started' }, 202)],
    ])
    const result = await new HttpControllerClient().startCalibration({
      ...params,
      steps: [
        { fan: 3, heat: 1 },
        { fan: 5.5, heat: 3.5 },
        { fan: 0, heat: 0 },
      ],
      settleBandC: 1.5,
    })
    expect(result).toEqual({ ok: true, message: 'Calibration started' })
    expect(calls[0].url).toBe('/api/status')
    expect(calls[1].method).toBe('POST')
    expect(calls[1].url).toBe(
      '/api/calibration/start?confirm=FOUR_DASHES_CALIBRATION&steps=3%3A1%2C5.5%3A3.5%2C0%3A0&step_seconds=120&min_step_seconds=10&settle_seconds=3&settle_band_tenths_c=15',
    )
    // Firmware 2026-07-26.34 and later have no program ceiling, so the parameter is never sent.
    expect(calls[1].url).not.toContain('max_c')
  })

  it('sends the baseline grid form and lets the firmware expand the serpentine', async () => {
    const calls = route([
      ['/api/status', json(diagnosticBody())],
      ['/api/calibration/start', json({ ok: true }, 202)],
    ])
    await new HttpControllerClient().startCalibration(grid)
    expect(calls[1].url).toBe(
      '/api/calibration/start?confirm=FOUR_DASHES_CALIBRATION&fans=1%2C4%2C7%2C10&heats=1%2C5%2C10&step_seconds=120&min_step_seconds=10&settle_seconds=3&settle_band_tenths_c=50',
    )
    expect(calls[1].url).not.toContain('steps=')
    expect(calls[1].url).not.toContain('max_c')
  })

  it('mirrors the firmware serpentine when reporting the steps a grid will run', () => {
    expect(programSteps(grid)).toHaveLength(12)
    expect(
      programSteps(grid)
        .map((step) => `${step.fan}:${step.heat}`)
        .join(' '),
    ).toBe('1:1 1:5 1:10 4:10 4:5 4:1 7:1 7:5 7:10 10:10 10:5 10:1')
    expect(programSteps(params)).toEqual(params.steps)
    // No recovery steps exist any more: a grid is exactly fans x heats.
    expect(programSteps(grid).some((step) => step.heat === 0)).toBe(false)
  })

  it('sends the settle band in tenths, as the firmware argument expects', async () => {
    const calls = route([
      ['/api/status', json(diagnosticBody())],
      ['/api/calibration/start', json({ ok: true }, 202)],
    ])
    await new HttpControllerClient().startCalibration({ ...params, settleBandC: 0.2 })
    expect(calls[1].url).toContain('settle_band_tenths_c=2')

    await new HttpControllerClient().startCalibration({ ...params, settleBandC: 10 })
    expect(calls[3].url).toContain('settle_band_tenths_c=100')
  })

  it('never emits the legacy fan_level or heat_levels arguments', async () => {
    const calls = route([
      ['/api/status', json(diagnosticBody())],
      ['/api/calibration/start', json({ ok: true }, 202)],
    ])
    await new HttpControllerClient().startCalibration(params)
    expect(calls[1].url).not.toContain('fan_level')
    expect(calls[1].url).not.toContain('heat_levels')
  })

  it('blocks calibration start when the firmware offers no diagnostic tests', async () => {
    const blockedStart = route([['/api/status', json(diagnosticBody({ capabilities: { diagnostic_tests: false } }))]])
    expect(await new HttpControllerClient().startCalibration(params)).toEqual({
      ok: false,
      message: 'This firmware does not offer diagnostic tests',
    })
    expect(blockedStart.map((call) => call.url)).toEqual(['/api/status'])
  })

  it('refuses to command a controller it cannot reach', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Network unreachable')
      }),
    )
    expect(await new HttpControllerClient().startCalibration(params)).toEqual({
      ok: false,
      message: 'Network unreachable',
    })
  })

  it('rejects out-of-range parameters before any request leaves the browser', async () => {
    const calls = route([['/api/status', json(diagnosticBody())]])
    const controller = new HttpControllerClient()
    const thirteen = Array.from({ length: 13 }, () => ({ fan: 3, heat: 1 }))
    expect((await controller.startCalibration({ ...params, steps: [] })).message).toMatch(/1 to 12 fan:heat steps/)
    expect((await controller.startCalibration({ ...params, steps: thirteen })).message).toMatch(
      /1 to 12 fan:heat steps/,
    )
    expect((await controller.startCalibration({ ...params, steps: [{ fan: 11, heat: 1 }] })).message).toMatch(
      /0.0 and 10.0/,
    )
    expect((await controller.startCalibration({ ...params, steps: [{ fan: 3, heat: 10.5 }] })).message).toMatch(
      /0.0 and 10.0/,
    )
    // Fan 0 with heat is the one pair rule the firmware enforces beyond simple ranges.
    expect((await controller.startCalibration({ ...params, steps: [{ fan: 0, heat: 5 }] })).message).toMatch(
      /Fan 0 is only allowed with heat 0/,
    )
    expect((await controller.startCalibration({ ...params, maxStepSeconds: 10 })).message).toMatch(/15 and 300/)
    expect((await controller.startCalibration({ ...params, maxStepSeconds: 301 })).message).toMatch(/15 and 300/)
    // The settle window reaches 30 s so a map does not settle on mid-transient slopes.
    expect((await controller.startCalibration({ ...params, settleSeconds: 1 })).message).toMatch(/2 and 30/)
    expect((await controller.startCalibration({ ...params, settleSeconds: 31 })).message).toMatch(/2 and 30/)
    expect(calibrationParamError({ ...params, settleSeconds: 30 })).toBeUndefined()
    expect((await controller.startCalibration({ ...params, settleBandC: 0.1 })).message).toMatch(/0.2 and 10.0 °C/)
    expect((await controller.startCalibration({ ...params, settleBandC: 10.1 })).message).toMatch(/0.2 and 10.0 °C/)
    expect((await controller.startCalibration({ ...params, minStepSeconds: 4 })).message).toMatch(/5 and 120/)
    expect((await controller.startCalibration({ ...params, minStepSeconds: 121 })).message).toMatch(/5 and 120/)
    expect((await controller.startCalibration({ ...params, minStepSeconds: 100, maxStepSeconds: 60 })).message).toMatch(
      /cannot exceed the step cap/,
    )
    expect(calls).toEqual([])
  })

  it('bounds the baseline grid axes and the expanded program length', async () => {
    const calls = route([['/api/status', json(diagnosticBody())]])
    const controller = new HttpControllerClient()
    expect((await controller.startCalibration({ ...grid, fans: [] })).message).toMatch(/1 to 6 fan levels/)
    expect((await controller.startCalibration({ ...grid, fans: [9, 8, 7, 6, 5, 4, 3] })).message).toMatch(
      /1 to 6 fan levels/,
    )
    expect((await controller.startCalibration({ ...grid, heats: [1, 2, 3, 4, 5, 6, 7, 8] })).message).toMatch(
      /1 to 7 heat levels/,
    )
    expect((await controller.startCalibration({ ...grid, fans: [0, 5] })).message).toMatch(
      /grid fan level must be above 0.0/,
    )
    expect((await controller.startCalibration({ ...grid, heats: [0, 5] })).message).toMatch(
      /grid heat level must be above 0.0/,
    )
    expect(calls).toEqual([])
    // The largest legal grid is 6 x 7 = 42 steps, comfortably inside the firmware's 48.
    expect(calibrationParamError({ ...grid, fans: [9, 8, 7, 6, 5, 4], heats: [1, 2, 3, 4, 5, 6, 7] })).toBeUndefined()
  })

  it('accepts a legal fan-zero passive-decay step alongside driven steps', async () => {
    expect(
      calibrationParamError({
        ...params,
        steps: [
          { fan: 3, heat: 5 },
          { fan: 0, heat: 0 },
        ],
      }),
    ).toBeUndefined()
    expect(
      calibrationParamError({ ...params, steps: Array.from({ length: 12 }, () => ({ fan: 3, heat: 1 })) }),
    ).toBeUndefined()
  })

  it('surfaces the firmware rejection message and posts stop without a query', async () => {
    route([
      ['/api/status', json(diagnosticBody())],
      ['/api/calibration/start', json({ ok: false, message: 'Heat is not armed' }, 400)],
    ])
    expect(await new HttpControllerClient().startCalibration(params)).toEqual({
      ok: false,
      message: 'Heat is not armed',
    })

    const stopCalls = route([['/api/calibration/stop', json({ ok: true })]])
    expect(await new HttpControllerClient().stopCalibration()).toEqual({ ok: true, message: undefined })
    expect(stopCalls).toEqual([{ url: '/api/calibration/stop', method: 'POST' }])
  })

  it('posts manual adjustments directly without a full-status preflight', async () => {
    const calls = route([['/api/manual/set', json({ ok: true, message: 'Controls applied' })]])
    expect(await new HttpControllerClient().setManual({ fan: 3, heat: 2 })).toEqual({
      ok: true,
      message: 'Controls applied',
    })
    expect(calls).toEqual([
      {
        url: '/api/manual/set?confirm=MANUAL_CONTROL&fan=3&heat=2',
        method: 'POST',
      },
    ])
  })

  it('passes the direct Controls 0/0 stop pair through to firmware', async () => {
    const calls = route([['/api/manual/set', json({ ok: true, message: 'Controls stopped' })]])
    expect(await new HttpControllerClient().setManual({ fan: 0, heat: 0 })).toEqual({
      ok: true,
      message: 'Controls stopped',
    })
    expect(calls).toEqual([
      {
        url: '/api/manual/set?confirm=MANUAL_CONTROL&fan=0&heat=0',
        method: 'POST',
      },
    ])
  })

  it('does not retry an explicitly transient mutation', async () => {
    const calls = route([
      ['/api/status', json(diagnosticBody())],
      ['/api/calibration/start', () => new Response('nope', { status: 503, headers: { 'Retry-After': '1' } })],
    ])
    expect(await new HttpControllerClient().startCalibration(params)).toEqual({ ok: false, message: 'HTTP 503' })
    expect(calls.filter((call) => call.url.startsWith('/api/calibration/start'))).toHaveLength(1)
  })
})

describe('thermal log download', () => {
  const csv =
    't_ms,thermocouple_c,cold_junction_c,effective_fan,effective_heat\n0,24.75,23.50,0.0,0.0\n1000,,,5.0,0.0\n2000,31.25,23.60,5.0,3.0\n'

  it('round-trips the firmware CSV through the parser', async () => {
    const calls = route([
      ['/thermal.csv', () => new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } })],
    ])
    const samples = parseThermalCsv(await new HttpControllerClient().fetchThermalCsv())
    expect(calls).toEqual([{ url: '/thermal.csv', method: 'GET' }])
    expect(samples).toHaveLength(3)
    expect(samples[0].thermocoupleC).toBe(24.75)
    expect(samples[1].thermocoupleC).toBeUndefined()
    expect(samples[2].effectiveHeat).toBe(3)
  })

  it('explains the 409 the firmware returns while a program is still running', async () => {
    route([['/thermal.csv', () => new Response('', { status: 409 })]])
    await expect(new HttpControllerClient().fetchThermalCsv()).rejects.toThrow(/after the active recording completes/)
  })

  it('reports authentication and other HTTP failures', async () => {
    route([['/thermal.csv', () => new Response('', { status: 401 })]])
    await expect(new HttpControllerClient().fetchThermalCsv()).rejects.toThrow('Sign in required')

    route([['/thermal.csv', () => new Response('', { status: 500 })]])
    await expect(new HttpControllerClient().fetchThermalCsv()).rejects.toThrow('HTTP 500')
  })
})

describe('live WebSocket transport', () => {
  class FakeWebSocket {
    static instances: FakeWebSocket[] = []
    onopen?: () => void
    onmessage?: (event: { data: string }) => void
    onerror?: () => void
    onclose?: () => void
    closed = false

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this)
    }
    close() {
      this.closed = true
      this.onclose?.()
    }
  }

  const browserAt = (hostname: string, port: string, protocol = 'http:') => {
    FakeWebSocket.instances = []
    vi.stubGlobal('window', {
      location: { hostname, host: port ? `${hostname}:${port}` : hostname, port, protocol },
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
  }

  it('uses the same-origin native server and applies sequence-checked live deltas', () => {
    browserAt('crackle.local', '')
    const received: unknown[] = []
    const connections: boolean[] = []
    const unsubscribe = new HttpControllerClient().subscribeLive(
      (snapshot) => received.push(snapshot),
      (connected) => connections.push(connected),
    )
    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toBe('ws://crackle.local/ws/live')
    socket.onopen?.()
    socket.onmessage?.({
      data: JSON.stringify({
        channel: 'live',
        kind: 'snapshot',
        seq: 1,
        payload: { tc_c: 93.25, fan: 4.5, heat: 2.1, mode: 'running', fault: 'none' },
      }),
    })
    socket.onmessage?.({
      data: JSON.stringify({
        channel: 'live',
        kind: 'delta',
        seq: 2,
        base: 1,
        payload: { heat: 3.2 },
      }),
    })
    expect(window.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 12000)
    expect(connections).toEqual([true])
    expect(received).toMatchObject([
      { connected: true, temperatureC: 93.25, effectiveFan: 4.5, effectiveHeat: 2.1, actuatorMode: 'running' },
      { connected: true, temperatureC: 93.25, effectiveFan: 4.5, effectiveHeat: 3.2, actuatorMode: 'running' },
    ])
    unsubscribe()
    expect(socket.closed).toBe(true)
  })

  it('bounds a socket that remains stuck while connecting', () => {
    browserAt('crackle.local', '')
    new HttpControllerClient().subscribeLive(() => {})
    const socket = FakeWebSocket.instances[0]
    const connectTimeout = vi.mocked(window.setTimeout).mock.calls[0]?.[0] as () => void
    connectTimeout()
    expect(socket.closed).toBe(true)
    expect(window.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 750)
  })
  it('uses the same-origin Vite proxy on any 51xx development port', () => {
    browserAt('192.168.4.42', '5176')
    const unsubscribe = new HttpControllerClient().subscribeLive(() => {})
    expect(FakeWebSocket.instances[0].url).toBe('ws://192.168.4.42:5176/ws/live')
    unsubscribe()
  })

  it('resolves the live socket from the configured target rather than the page host', () => {
    browserAt('localhost', '5173')
    const firmware = new HttpControllerClient({ baseUrl: 'http://crackle-kitchen.local' }).subscribeLive(() => {})
    expect(FakeWebSocket.instances[0].url).toBe('ws://crackle-kitchen.local/ws/live')
    firmware()

    const proxied = new HttpControllerClient({ baseUrl: 'http://127.0.0.1:5176' }).subscribeLive(() => {})
    expect(FakeWebSocket.instances[1].url).toBe('ws://127.0.0.1:5176/ws/live')
    proxied()

    const selectedProxy = new HttpControllerClient({
      baseUrl: 'http://127.0.0.1:5173',
      pathPrefix: '/__crackle/physical',
    }).subscribeLive(() => {})
    expect(FakeWebSocket.instances[2].url).toBe('ws://127.0.0.1:5173/__crackle/physical/ws/live')
    selectedProxy()

    const secure = new HttpControllerClient({ baseUrl: 'https://roaster.example' }).subscribeLive(() => {})
    expect(FakeWebSocket.instances[3].url).toBe('wss://roaster.example/ws/live')
    secure()
  })

  it('ignores malformed frames and falls back after a dropped connection', () => {
    browserAt('crackle.local', '')
    const received: unknown[] = []
    const connections: boolean[] = []
    new HttpControllerClient().subscribeLive(
      (snapshot) => received.push(snapshot),
      (connected) => connections.push(connected),
    )
    const socket = FakeWebSocket.instances[0]
    socket.onopen?.()
    socket.onmessage?.({ data: '{bad json' })
    socket.onclose?.()
    expect(received).toEqual([])
    // Opening a socket is not enough to claim live telemetry; only a valid frame does that.
    expect(connections).toEqual([])
    expect(window.setTimeout).toHaveBeenCalledTimes(3)
  })

  /** Timers handed to `window.setTimeout`, so reconnect delays are asserted rather than waited for. */
  const timerCalls = () => vi.mocked(window.setTimeout).mock.calls as unknown as Array<[() => void, number]>
  const frame = (socket: FakeWebSocket, seq: number) =>
    socket.onmessage?.({
      data: JSON.stringify({
        channel: 'live',
        kind: 'snapshot',
        seq,
        payload: { tc_c: 90, fan: 4, heat: 2, mode: 'running', fault: 'none' },
      }),
    })
  const lastReconnect = () =>
    timerCalls()
      .filter(([, delay]) => delay !== 12000 && delay !== 10000)
      .at(-1)!

  it('keeps growing the reconnect backoff for a link that drops right after its first frame', () => {
    browserAt('crackle.local', '')
    new HttpControllerClient().subscribeLive(() => {})
    const first = FakeWebSocket.instances[0]
    first.onopen?.()
    frame(first, 1)
    first.close()
    expect(lastReconnect()[1]).toBe(750)
    lastReconnect()[0]()
    const second = FakeWebSocket.instances[1]
    second.onopen?.()
    frame(second, 1)
    second.close()
    // One frame is not a healthy connection: the backoff does not snap back to 750 ms.
    expect(lastReconnect()[1]).toBe(1500)
    lastReconnect()[0]()
    const third = FakeWebSocket.instances[2]
    third.onopen?.()
    frame(third, 1)
    // The connection stays up long enough to count as stable: the floor is restored.
    const stable = timerCalls()
      .filter(([, delay]) => delay === 10000)
      .at(-1)!
    stable[0]()
    third.close()
    expect(lastReconnect()[1]).toBe(750)
  })

  it('replaces a socket whose close never reports back, as a locked iPhone leaves it', () => {
    // iOS may never deliver `onclose` for a socket that died while the phone was locked, so a
    // reconnect that waited for it would leave the page STALE until the URL was entered again.
    browserAt('crackle.local', '')
    class SilentCloseWebSocket extends FakeWebSocket {
      override close() {
        this.closed = true
      }
    }
    vi.stubGlobal('WebSocket', SilentCloseWebSocket)
    const connections: boolean[] = []
    new HttpControllerClient().subscribeLive(
      () => {},
      (connected) => connections.push(connected),
    )
    const asleep = FakeWebSocket.instances[0]
    asleep.onopen?.()
    frame(asleep, 1)
    const watchdog = timerCalls()
      .filter(([, delay]) => delay === 12000)
      .at(-1)!
    watchdog[0]()
    expect(asleep.closed).toBe(true)
    expect(connections).toEqual([true, false])
    // The retry is scheduled without any close event from the dead socket.
    lastReconnect()[0]()
    expect(FakeWebSocket.instances).toHaveLength(2)
    // Anything the abandoned socket reports later changes nothing.
    asleep.onclose?.()
    asleep.onmessage?.({ data: '{}' })
    expect(connections).toEqual([true, false])
  })

  it('reconnects at once on request, at the shortest backoff, ignoring the old socket', () => {
    browserAt('crackle.local', '')
    const connections: boolean[] = []
    const subscription = new HttpControllerClient().subscribeLive(
      () => {},
      (connected) => connections.push(connected),
    )
    const first = FakeWebSocket.instances[0]
    first.onopen?.()
    frame(first, 1)
    subscription.reconnect()
    expect(first.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(connections).toEqual([true, false])
    const second = FakeWebSocket.instances[1]
    second.onopen?.()
    frame(second, 2)
    expect(connections).toEqual([true, false, true])
    // A dropped replacement retries from the 750 ms floor, not from a grown backoff.
    second.close()
    expect(lastReconnect()[1]).toBe(750)
    subscription()
  })

  it('schedules a retry when the WebSocket constructor throws, instead of ending reconnects', () => {
    browserAt('crackle.local', '')
    let throws = true
    class ThrowingWebSocket extends FakeWebSocket {
      constructor(url: string) {
        if (throws) throw new Error('SecurityError')
        super(url)
      }
    }
    vi.stubGlobal('WebSocket', ThrowingWebSocket)
    const unsubscribe = new HttpControllerClient().subscribeLive(() => {})
    expect(FakeWebSocket.instances).toHaveLength(0)
    const retry = lastReconnect()
    expect(retry[1]).toBe(750)
    throws = false
    retry[0]()
    expect(FakeWebSocket.instances).toHaveLength(1)
    unsubscribe()
  })
})
/**
 * The device log archive, added to the surface in 0.7.0 and feature-detected at every call because
 * the firmware flashed today does not serve it.
 */
describe('storage mutations share the storage lane', () => {
  it('waits out a pre-admission busy refusal on a recording delete instead of failing it', async () => {
    vi.useFakeTimers()
    const busy = new Response(JSON.stringify({ message: 'busy' }), { status: 503, headers: { 'Retry-After': '1' } })
    const replies = [busy, json({ ok: true, state_rev: '12' })()]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => replies.shift()!),
    )
    const pending = new HttpControllerClient().deleteDeviceLog('41')
    await vi.advanceTimersByTimeAsync(1_200)
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('queues a document delete behind a document write already in the lane', async () => {
    const order: string[] = []
    let releaseWrite: (() => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        order.push(`start ${url.split('?')[0]}`)
        if (url.startsWith('/api/data/meta'))
          await new Promise<void>((resolve) => {
            releaseWrite = resolve
          })
        order.push(`end ${url.split('?')[0]}`)
        return new Response(JSON.stringify({ ok: true, version: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const controller = new HttpControllerClient()
    const write = controller.writeDocument('meta', '{}', 2)
    const remove = controller.deleteDocument('runs/r1', 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['start /api/data/meta'])
    releaseWrite!()
    await Promise.all([write, remove])
    expect(order).toEqual([
      'start /api/data/meta',
      'end /api/data/meta',
      'start /api/data/delete',
      'end /api/data/delete',
    ])
  })
})

describe('device log archive', () => {
  it('reads a missing route as an absent feature, not an error', async () => {
    stubFetch(() => new Response('', { status: 404 }))
    const archive = await new HttpControllerClient().deviceLogs()
    expect(archive.state).toBe('unsupported')
    expect(archive.logs).toEqual([])
    expect(archive.message).toContain('cannot keep detailed thermal recordings')
  })

  it('reads an unmounted filesystem as its own state, not as a missing feature', async () => {
    stubFetch(json({ ok: false }, 503))
    const archive = await new HttpControllerClient().deviceLogs()
    expect(archive.state).toBe('unmounted')
    expect(archive.message).toContain('did not mount')
  })

  it('reads a network failure as unreachable, which is a different thing', async () => {
    stubFetch(() => {
      throw new Error('offline')
    })
    expect((await new HttpControllerClient().deviceLogs()).state).toBe('unreachable')
  })

  it('waits through transient storage contention instead of presenting an empty archive', async () => {
    vi.useFakeTimers()
    const busy = new Response(JSON.stringify({ message: 'busy' }), { status: 503, headers: { 'Retry-After': '1' } })
    const available = json({ ok: true, logs: [] }, 200)()
    const replies = [busy, available]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => replies.shift()!),
    )
    const pending = new HttpControllerClient().deviceLogs()
    await vi.advanceTimersByTimeAsync(1_200)
    await expect(pending).resolves.toMatchObject({ state: 'available', logs: [] })
    expect(busy.bodyUsed).toBe(true)
    expect(available.bodyUsed).toBe(true)
    expect(replies).toHaveLength(0)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('lists what the controller is storing, newest first by monotonic id', async () => {
    stubFetch(
      json(
        {
          ok: true,
          total_bytes: 1_441_792,
          used_bytes: 48_000,
          current: { active: false, unsaved: true, samples: 640, source: 'manual' },
          logs: [
            {
              ...testLogProvenance('12'),
              id: 12,
              boot: 7,
              start_epoch: 1_784_000_000,
              duration_ms: 640_000,
              samples: 640,
              interval_ms: 1000,
              source: 'manual',
              bytes: 22_000,
              download: '/logs/12.csv',
            },
            {
              ...testLogProvenance('11'),
              id: 11,
              boot: 6,
              start_epoch: 0,
              duration_ms: 300_000,
              samples: 300,
              interval_ms: 1000,
              source: 'calibration',
              bytes: 11_000,
              download: '/logs/11.csv',
            },
          ],
        },
        200,
      ),
    )
    const archive = await new HttpControllerClient().deviceLogs()
    expect(archive.state).toBe('available')
    expect(archive.logs.map((entry) => entry.id)).toEqual(['12', '11'])
    expect(archive.logs[0]).toMatchObject({ bootId: '7', durationSec: 640, samples: 640, mode: 'manual' })
    // start_epoch 0 means the clock was never synced, which is not 1970.
    expect(archive.logs[1].startedAt).toBeUndefined()
    expect(archive.storage).toMatchObject({ usedBytes: 48_000, totalBytes: 1_441_792 })
    // A log still in RAM is a normal state after a roast, not a fault.
    expect(archive.current).toMatchObject({ active: false, unsaved: true, mode: 'manual' })
  })

  it('fetches one stored log as CSV from the allow-listed prefix', async () => {
    const seen: string[] = []
    stubFetch((input) => {
      seen.push(String(input))
      return new Response('t_ms,thermocouple_c\n0,24.5\n')
    })
    const csv = await new HttpControllerClient().fetchDeviceLogCsv('log 1')
    expect(csv).toContain('t_ms')
    expect(seen[0]).toBe('/logs/log%201.csv')
  })

  it('says plainly when a log has already been deleted on the controller', async () => {
    stubFetch(() => new Response('', { status: 404 }))
    await expect(new HttpControllerClient().fetchDeviceLogCsv('gone')).rejects.toThrow(/no longer on the roaster/)
  })

  it('deletes with the firmware confirmation token, on the allow-listed route', async () => {
    const seen: Array<{ url: string; method?: string }> = []
    stubFetch((input, init) => {
      seen.push({ url: String(input), method: init?.method })
      return new Response('', { status: 200 })
    })
    expect(await new HttpControllerClient().deleteDeviceLog('12')).toMatchObject({ ok: true })
    expect(seen[0]).toEqual({ url: '/api/logs/delete?id=12&confirm=DELETE_LOG', method: 'POST' })
  })

  /**
   * The firmware defers flash writes while the actuator is running, so a 409 on delete means "not
   * now", not "no". Saying which is the difference between waiting a moment and assuming a fault.
   */
  it('explains a deferred delete rather than reporting a bare refusal', async () => {
    stubFetch(() => new Response('', { status: 409 }))
    const result = await new HttpControllerClient().deleteDeviceLog('12')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('defers writes to its own storage until it is idle')

    stubFetch(() => new Response('', { status: 503 }))
    expect((await new HttpControllerClient().deleteDeviceLog('12')).message).toContain('not mounted')
  })

  describe('pushing coefficients to the device', () => {
    const coefficients = {
      heaterGainCPerMinAt10: 58.1234,
      fanCoolingCPerMinAt10: 24.5,
      coolingFanCPerMinAt10: 31,
      thermalLossPerMinPerC: 0.19123456,
    }

    it('sends the firmware precision, so the round trip is byte-identical', async () => {
      const seen: Array<{ url: string; method?: string }> = []
      stubFetch((input, init) => {
        seen.push({ url: String(input), method: init?.method })
        return new Response('', { status: 200 })
      })
      expect(await new HttpControllerClient().applyCalibration(coefficients, 'fit-abc123')).toMatchObject({ ok: true })
      expect(seen[0].method).toBe('POST')
      expect(seen[0].url).toContain('heater_gain=58.123')
      expect(seen[0].url).toContain('loss_per_min=0.1912')
      expect(seen[0].url).toContain('confirm=APPLY_CALIBRATION')
    })

    it('reduces the fit id to the alphabet the firmware sanitizes to, before sending', async () => {
      const seen: string[] = []
      stubFetch((input) => {
        seen.push(String(input))
        return new Response('', { status: 200 })
      })
      await new HttpControllerClient().applyCalibration(coefficients, 'Fitted from roast 20/07 #1')
      expect(seen[0]).toContain('fit_id=Fitted-from-roast-20-07--1')
    })

    it('fails closed on a coefficient outside the firmware range, before anything is sent', async () => {
      const calls: string[] = []
      stubFetch((input) => {
        calls.push(String(input))
        return new Response('', { status: 200 })
      })
      const result = await new HttpControllerClient().applyCalibration(
        { ...coefficients, heaterGainCPerMinAt10: 1200 },
        'x',
      )
      expect(result.ok).toBe(false)
      expect(calls).toEqual([])
      expect(
        (await new HttpControllerClient().applyCalibration({ ...coefficients, thermalLossPerMinPerC: Number.NaN }, 'x'))
          .ok,
      ).toBe(false)
    })

    /**
     * "Present" is not plausible: a zero heater gain is inside 0..1000 but describes a roaster
     * with no heater, and a journey inverting that model saturates heat at the zone maximum.
     * Mirrors the firmware's plausibility gate; the refusal names the field.
     */
    it('fails closed on a physically implausible coefficient, naming the field', async () => {
      const calls: string[] = []
      stubFetch((input) => {
        calls.push(String(input))
        return new Response('', { status: 200 })
      })
      const zeroGain = await new HttpControllerClient().applyCalibration(
        { ...coefficients, heaterGainCPerMinAt10: 0 },
        'x',
      )
      expect(zeroGain.ok).toBe(false)
      expect(zeroGain.message).toContain('heaterGainCPerMinAt10')
      expect(zeroGain.message).toContain('not physically plausible')
      expect(calls).toEqual([])
      expect(
        (await new HttpControllerClient().applyCalibration({ ...coefficients, thermalLossPerMinPerC: 0 }, 'x')).ok,
      ).toBe(false)
      expect(
        (await new HttpControllerClient().applyCalibration({ ...coefficients, heaterGainCPerMinAt10: 0.099 }, 'x')).ok,
      ).toBe(false)
      expect(
        (await new HttpControllerClient().applyCalibration({ ...coefficients, fanCoolingCPerMinAt10: 0.1 }, 'x')).ok,
      ).toBe(false)
    })

    it('accepts a positive low-loss heater gain measured by an empty-chamber pass', async () => {
      const calls: string[] = []
      stubFetch((input) => {
        calls.push(String(input))
        return new Response('', { status: 200 })
      })
      const result = await new HttpControllerClient().applyCalibration(
        {
          ...coefficients,
          heaterGainCPerMinAt10: 4.34,
        },
        'baseline-fit',
      )
      expect(result.ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('heater_gain=4.340')
    })

    it('explains a refusal while the roaster is busy', async () => {
      stubFetch(() => new Response('', { status: 409 }))
      expect((await new HttpControllerClient().applyCalibration(coefficients, 'x')).message).toContain(
        'only be applied while it is idle',
      )
    })

    it('clears the device set with the same confirmation', async () => {
      const seen: string[] = []
      stubFetch((input) => {
        seen.push(String(input))
        return new Response('', { status: 200 })
      })
      expect(await new HttpControllerClient().clearDeviceCalibration()).toMatchObject({ ok: true })
      expect(seen[0]).toBe('/api/calibration/apply?clear=true&confirm=APPLY_CALIBRATION')
    })
  })

  /** The feature detection is the PRESENCE of `log_archive` in the status document. */
  it('reports no archive at all on a firmware that omits the block', async () => {
    stubFetch(json({ lifecycle: 'STANDBY', firmware_version: '2026-07-26.36' }))
    const status = await new HttpControllerClient().status()
    expect(status.logArchive).toBeUndefined()
    expect(status.appliedCoefficients).toBeUndefined()
  })

  it('reads the archive block, the log source, and the unsaved flag', async () => {
    stubFetch(
      json({
        lifecycle: 'STANDBY',
        firmware_version: '2026-07-26.38',
        thermal_log: { active: true, samples: 400, capacity: 2400, source: 'manual', unsaved: true },
        log_archive: {
          mounted: true,
          count: 9,
          used_bytes: 48_000,
          total_bytes: 1_441_792,
          clock_synced: false,
          list: '/api/logs',
        },
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status.logArchive).toMatchObject({ mounted: true, count: 9, clockSynced: false })
    expect(status.thermalLog).toMatchObject({ source: 'manual', unsaved: true })
  })

  it('treats an explicit present:false as the device holding no coefficients', async () => {
    stubFetch(json({ lifecycle: 'STANDBY', applied_calibration: { present: false } }))
    expect((await new HttpControllerClient().status()).appliedCoefficients).toBeUndefined()
  })

  it('parses the applied set, and its unsynced clock, once the device holds one', async () => {
    stubFetch(
      json({
        lifecycle: 'STANDBY',
        applied_calibration: {
          present: true,
          heater_gain: 58.123,
          fan_cooling: 24.5,
          cooling_fan: 31,
          loss_per_min: 0.1912,
          fit_id: 'fit-abc',
          applied_epoch: 0,
        },
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status.appliedCoefficients).toMatchObject({
      heaterGainCPerMinAt10: 58.123,
      thermalLossPerMinPerC: 0.1912,
      fitId: 'fit-abc',
    })
    // applied_epoch 0 means the clock was never synced, so there is no date to show.
    expect(status.appliedCoefficients!.updatedAt).toBeUndefined()
  })
})

/**
 * The on-device roast executor.
 *
 * Two things are being pinned here. First, the `roast` block parses every field the firmware
 * documents, and its PRESENCE is what tells a browser the executor exists at all. Second, the two
 * commands go where they say they go and carry what they say they carry - the request is the entire
 * specification of an unattended run, so a wrong argument name is not a display bug.
 */
describe('the device roast', () => {
  const roastBody = (overrides: Record<string, unknown> = {}) =>
    diagnosticBody({
      roast: {
        active: true,
        mode: 'journey',
        name: 'ethiopia-yirg',
        elapsed_sec: 412,
        session_id: 14,
        started_epoch: 1785000000,
        step_index: 0,
        step_elapsed_sec: 37,
        step_count: 0,
        zone_index: 2,
        zone_count: 5,
        zone_entry_sec: 330,
        zone_elapsed_sec: 82,
        zone_nominal_sec: 135,
        zone_end_c: 196,
        target_c: 187.4,
        commanded_fan: 5.4,
        commanded_heat: 8.1,
        solved_fan: 5.37,
        solved_heat: 8.14,
        correction_total: 2.4,
        integral: 1.1,
        saturated: false,
        holdover: false,
        holdover_ms: 0,
        holdover_limit_ms: 30000,
        ambient_c: 26.31,
        batch_mass_g: 225,
        lease_renewals: 13,
        zone_attained_sec: [121, 328, null, null, null],
        end_reason: 'none',
        ...overrides,
      },
    })

  it('parses every documented field, and treats the idle sentinels as absence', async () => {
    respondWith(roastBody())
    const status = await new HttpControllerClient().status()
    expect(status.roast).toMatchObject({
      active: true,
      mode: 'journey',
      name: 'ethiopia-yirg',
      elapsedSec: 412,
      sessionId: '14',
      startedEpoch: 1785000000,
      stepElapsedSec: 37,
      zoneIndex: 2,
      zoneCount: 5,
      zoneEntrySec: 330,
      zoneElapsedSec: 82,
      zoneNominalSec: 135,
      zoneEndC: 196,
      targetC: 187.4,
      commandedFan: 5.4,
      commandedHeat: 8.1,
      solvedFan: 5.37,
      solvedHeat: 8.14,
      correctionTotal: 2.4,
      integral: 1.1,
      saturated: false,
      holdover: false,
      holdoverMs: 0,
      holdoverLimitMs: 30000,
      ambientC: 26.31,
      batchMassG: 225,
      leaseRenewals: 13,
    })
    expect(status.roast?.zoneAttainedSec).toEqual([121, 328, null, null, null])
    // `none` is the idle sentinel, parsed away like every other one.
    expect(status.roast?.endReason).toBeUndefined()
  })

  /**
   * An executing roast joins the same "something is running" fallback the calibration and manual
   * programs are in. A firmware that reports its own lifecycle still wins, which is the existing
   * rule and is deliberately unchanged - this only covers the case where it reports none.
   */
  it('reads an executing roast as a RUNNING controller when the firmware states no lifecycle', async () => {
    respondWith({ ...roastBody(), lifecycle: undefined })
    expect((await new HttpControllerClient().status()).lifecycle).toBe('RUNNING')
  })

  /** Epoch 0 is "the clock never synced", which is not a date and must never become 1970. */
  it('drops a zero start epoch rather than dating a roast to 1970', async () => {
    respondWith(roastBody({ started_epoch: 0 }))
    expect((await new HttpControllerClient().status()).roast?.startedEpoch).toBeUndefined()
  })

  it('reports an ended roast so a browser that was not here can still find out', async () => {
    respondWith(roastBody({ active: false, mode: 'none', end_reason: 'sensor_lost' }))
    const status = await new HttpControllerClient().status()
    expect(status.roast?.active).toBe(false)
    expect(status.roast?.endReason).toBe('sensor_lost')

    respondWith(roastBody({ active: false, mode: 'none', end_reason: 'telemetry_stale' }))
    expect((await new HttpControllerClient().status()).roast?.endReason).toBe('telemetry_stale')
  })

  /** The absence of the block is the absence of the feature, and reads as exactly that. */
  it('leaves the roast block undefined on firmware without the executor', async () => {
    respondWith(diagnosticBody())
    expect((await new HttpControllerClient().status()).roast).toBeUndefined()
  })

  it('hands the whole plan over in one POST and needs no status pre-flight to do it', async () => {
    const calls = route([['/api/roast/start', json({ ok: true, roast_active: true, mode: 'journey' }, 202)]])
    const result = await new HttpControllerClient().startRoast({
      mode: 'journey',
      confirm: 'START_ROAST',
      name: 'ethiopia-yirg',
      mass: '225',
      zones: '150:210:5:9:3:8;175:120:5:9:3:9',
      start: '24.8',
    })
    expect(result.ok).toBe(true)
    // Exactly one call: the gate ran in the browser against status it already had, and a second
    // round trip would only widen the window between looking and acting.
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toContain('/api/roast/start?')
    expect(calls[0].url).toContain('confirm=START_ROAST')
    expect(calls[0].url).toContain('mode=journey')
    expect(calls[0].url).toContain('mass=225')
    expect(decodeURIComponent(calls[0].url)).toContain('zones=150:210:5:9:3:8;175:120:5:9:3:9')
  })

  it('turns every documented refusal into plain language', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ ok: false, message: 'ESP actuation is disabled until the roaster is power-cycled.' }),
          { status: 423, headers: { 'content-type': 'application/json' } },
        ),
    )
    const latched = await new HttpControllerClient().startRoast({
      mode: 'timed',
      confirm: 'START_ROAST',
      name: 'x',
      mass: '225',
      steps: '8:5:120',
    })
    expect(latched.ok).toBe(false)
    expect(latched.message).toContain('only a power cycle clears it')
    // The controller's own words survive, because they are the most specific thing anyone has.
    expect(latched.message).toContain('until the roaster is power-cycled')
  })

  /**
   * A lost Start acknowledgement is NOT a refusal. The roaster may have committed; the caller must
   * not delete the staged record of a roast that is running. Status is the witness.
   */
  describe('a Start whose acknowledgement was lost', () => {
    const start = () =>
      new HttpControllerClient().startRoast({
        mode: 'journey',
        confirm: 'START_ROAST',
        name: 'ethiopia-yirg',
        mass: '225',
        zones: '150:210:5:9:3:8',
        start: '24.8',
      })

    it('reads an active roast with the requested name as this Start, accepted', async () => {
      stubFetch((url) => {
        if (String(url).startsWith('/api/roast/start')) throw new TypeError('Failed to fetch')
        return json(roastBody())()
      })
      const result = await start()
      expect(result).toMatchObject({ ok: true, name: 'ethiopia-yirg', sessionId: '14', startedEpoch: 1785000000 })
      expect(result.outcomeUnknown).toBeUndefined()
    })

    it('reports the outcome as unknown - never a refusal - when status cannot settle it', async () => {
      stubFetch((url) => {
        if (String(url).startsWith('/api/roast/start'))
          throw new DOMException('The operation timed out.', 'TimeoutError')
        return json(roastBody({ active: false, mode: 'none', name: undefined }))()
      })
      const result = await start()
      expect(result.ok).toBe(false)
      expect(result.outcomeUnknown).toBe(true)
      expect(result.message).toContain('Check the roaster')
    })

    it('does not claim another roast: an active roast with a different name stays unknown', async () => {
      stubFetch((url) => {
        if (String(url).startsWith('/api/roast/start')) throw new TypeError('Failed to fetch')
        return json(roastBody({ name: 'someone-else' }))()
      })
      const result = await start()
      expect(result.ok).toBe(false)
      expect(result.outcomeUnknown).toBe(true)
    })

    it('reconciles a gateway 504 through the request id the roaster committed', async () => {
      stubFetch((url) => {
        if (String(url).startsWith('/api/roast/start')) {
          return new Response(JSON.stringify({ message: 'acknowledgement wait elapsed' }), {
            status: 504,
            headers: { 'content-type': 'application/json', 'X-Crackle-Request-Id': '9' },
          })
        }
        return new Response(JSON.stringify({ ...roastBody(), last_request_id: 9, last_request_status: 202 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
      expect(await start()).toMatchObject({ ok: true, sessionId: '14' })
    })

    it('treats a 504 whose committed request failed as a definite refusal', async () => {
      stubFetch((url) => {
        if (String(url).startsWith('/api/roast/start')) {
          return new Response('{}', {
            status: 504,
            headers: { 'content-type': 'application/json', 'X-Crackle-Request-Id': '9' },
          })
        }
        return new Response(
          JSON.stringify({
            ...roastBody({ active: false, mode: 'none' }),
            last_request_id: 9,
            last_request_status: 409,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })
      const result = await start()
      expect(result.ok).toBe(false)
      expect(result.outcomeUnknown).toBeUndefined()
    })

    it('keeps an HTTP refusal definite: no status read, no unknown', async () => {
      const calls = route([['/api/roast/start', json({ ok: false, message: 'A roast is already running.' }, 409)]])
      const result = await start()
      expect(result.ok).toBe(false)
      expect(result.outcomeUnknown).toBeUndefined()
      expect(calls).toHaveLength(1)
    })
  })

  it('sends the workflow-agnostic Stop with no status pre-flight', async () => {
    const calls = route([['/api/stop', json({ ok: true, was_active: true, heater_off: true })]])
    setControllerMutationGate(() => 'telemetry is stale')
    expect(await new HttpControllerClient().stopAll()).toMatchObject({ ok: true, wasActive: true })
    expect(calls).toEqual([{ url: '/api/stop', method: 'POST' }])
  })

  it('sends Stop with no arguments and no pre-flight, exactly as it sends the manual stop', async () => {
    const calls = route([
      [
        '/api/roast/stop',
        json({ ok: true, roast_active: false, was_active: true, elapsed_sec: 123, end_reason: 'stopped' }),
      ],
    ])
    expect(await new HttpControllerClient().stopRoast()).toMatchObject({
      ok: true,
      wasActive: true,
      elapsedSec: 123,
      endReason: 'stopped',
    })
    expect(calls).toEqual([{ url: '/api/roast/stop', method: 'POST' }])
  })

  it('targets a manual stop at one atomic roast session and parses that identity back', async () => {
    const calls = route([
      ['/api/roast/stop', json({ ok: true, roast_active: false, session_id: 14, end_reason: 'stopped' })],
    ])
    expect(await new HttpControllerClient().stopRoast('14')).toMatchObject({
      ok: true,
      sessionId: '14',
      endReason: 'stopped',
    })
    expect(calls).toEqual([{ url: '/api/roast/stop?expected_session=14', method: 'POST' }])
  })

  it('starts and adjusts a manual roast through the roast command surface', async () => {
    const calls = route([
      [
        '/api/roast/start',
        json(
          {
            ok: true,
            roast_active: true,
            mode: 'manual',
            name: 'manual one',
            session_id: 14,
            log_id: '41',
            boot: 7,
            started_epoch: 1800000000,
            elapsed_sec: 0,
            fan_level: 4,
            heat_level: 0,
            effective_fan: 4,
            effective_heat: 0,
          },
          202,
        ),
      ],
      [
        '/api/roast/set',
        json(
          {
            ok: true,
            roast_active: true,
            mode: 'manual',
            session_id: 14,
            elapsed_sec: 37,
            accepted_fan: 4.5,
            accepted_heat: 7,
            effective_fan: 4.8,
            effective_heat: 7,
          },
          202,
        ),
      ],
    ])
    expect(
      await new HttpControllerClient().startRoast({
        mode: 'manual',
        confirm: 'START_ROAST',
        name: 'manual one',
        mass: '225',
        fan: '4',
        heat: '0',
      }),
    ).toMatchObject({
      ok: true,
      elapsedSec: 0,
      requestedFan: 4,
      requestedHeat: 0,
      effectiveFan: 4,
      effectiveHeat: 0,
      bootId: '7',
      startedEpoch: 1800000000,
      name: 'manual one',
      sessionId: '14',
      logId: '41',
    })
    expect(await new HttpControllerClient().setRoast({ fan: 4.5, heat: 7 }, '14')).toMatchObject({
      ok: true,
      elapsedSec: 37,
      requestedFan: 4.5,
      requestedHeat: 7,
      effectiveFan: 4.8,
      effectiveHeat: 7,
      sessionId: '14',
    })
    expect(calls[0].url).toContain('mode=manual')
    expect(calls[0].url).toContain('fan=4')
    expect(calls[1].url).toContain('/api/roast/set?')
    expect(calls[1].url).toContain('confirm=CONTROL_ROAST')
    expect(calls[1].url).toContain('expected_session=14')
    expect(calls[1].url).toContain('fan=4.5')
    expect(calls[1].url).toContain('heat=7')
  })

  it('reads manual-roast mode and its device-owned instruction lease', async () => {
    respondWith(
      roastBody({
        active: true,
        mode: 'manual',
        commanded_fan: 4.5,
        commanded_heat: 7,
        instruction_age_ms: 12000,
        instruction_limit_ms: 1800000,
      }),
    )
    expect((await new HttpControllerClient().status()).roast).toMatchObject({
      mode: 'manual',
      commandedFan: 4.5,
      commandedHeat: 7,
      instructionAgeMs: 12000,
      instructionLimitMs: 1800000,
    })
  })
})

/**
 * The instruction lease, which renamed these fields one for one. `keepalive_ms_ago` /
 * `keepalive_limit_ms` / `keepalive_lapsed` are the OLD contract and are gone from the firmware; a
 * parser that still read them would silently report "not supported" against a device that does.
 */
describe('the instruction lease in status', () => {
  it('reads the lease figures and the new end reason', async () => {
    respondWith(
      diagnosticBody({
        manual: {
          active: true,
          fan_level: 6,
          heat_level: 7.5,
          since_ms: 40000,
          instruction_age_ms: 12000,
          instruction_limit_ms: 1800000,
        },
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status.manual).toMatchObject({ instructionAgeMs: 12000, instructionLimitMs: 1800000 })

    respondWith(diagnosticBody({ manual: { active: false, end_reason: 'instruction_expired' } }))
    expect((await new HttpControllerClient().status()).manual?.endReason).toBe('instruction_expired')

    respondWith(diagnosticBody({ manual: { active: false, end_reason: 'telemetry_stale' } }))
    expect((await new HttpControllerClient().status()).manual?.endReason).toBe('telemetry_stale')
  })

  it('claims nothing from firmware that predates the lease', async () => {
    respondWith(diagnosticBody({ manual: { active: true, fan_level: 6, heat_level: 7.5, since_ms: 40000 } }))
    const status = await new HttpControllerClient().status()
    expect(status.manual?.instructionAgeMs).toBeUndefined()
    expect(status.manual?.instructionLimitMs).toBeUndefined()
  })

  /** The retired reason is not silently mapped onto anything: it is not a reason this app knows. */
  it('drops the retired keepalive end reason rather than passing it through', async () => {
    respondWith(diagnosticBody({ manual: { active: false, end_reason: 'keepalive_lapsed' } }))
    expect((await new HttpControllerClient().status()).manual?.endReason).toBeUndefined()
  })
})

describe('document store transport', () => {
  it('preserves explicit run-index completeness metadata', async () => {
    respondWith({
      ok: true,
      runs: [{ id: 'manual-41', bytes: 217, version: 3 }],
      total: 401,
      truncated: true,
    })
    expect(await new HttpControllerClient().listRunDocuments()).toEqual({
      kind: 'ok',
      runs: [{ id: 'manual-41', bytes: 217, version: 3 }],
      total: 401,
      truncated: true,
    })
  })

  it('fails legacy indexes safe at the old silent 400-row limit', async () => {
    respondWith({
      ok: true,
      runs: Array.from({ length: 400 }, (_, index) => ({ id: `r${index}`, bytes: 2, version: 1 })),
    })
    expect(await new HttpControllerClient().listRunDocuments()).toMatchObject({
      kind: 'ok',
      total: 400,
      truncated: true,
    })
  })

  it('does not classify a transient HTTP 500 as a corrupt document', async () => {
    respondWith({ error: 'Temporary storage worker failure' }, 500)
    expect(await new HttpControllerClient().readDocument('profiles')).toEqual({
      kind: 'error',
      message: 'Temporary storage worker failure',
    })
  })

  it('recognizes only the explicit unreadable-envelope response as corrupt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'The stored document is unreadable. Delete it, or store it again with base=0.' }),
            { status: 500, headers: { 'content-type': 'application/json', 'X-Doc-Version': '0' } },
          ),
      ),
    )
    expect(await new HttpControllerClient().readDocument('profiles')).toEqual({ kind: 'corrupt', version: 0 })
  })

  it('distinguishes queue contention from an unmounted volume on document mutations', async () => {
    const busy = () =>
      new Response(JSON.stringify({ ok: false, message: 'Another storage transfer is in progress. Retry shortly.' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'Retry-After': '1' },
      })
    // Put the retry budget at its deadline so this assertion covers the terminal classification
    // without making the test wait through the browser's deliberate storage-contention window.
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(15_000)
    stubFetch(busy)
    expect(await new HttpControllerClient().writeDocument('meta', '{}', 2)).toEqual({
      kind: 'busy',
      message: 'Another storage transfer is in progress. Retry shortly.',
    })
    now.mockRestore()
    // Deletes now join the same storage FIFO and busy retry as writes, so the same deadline applies.
    const deleteNow = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(15_000)
    stubFetch(busy)
    expect(await new HttpControllerClient().deleteDocument('meta', 2)).toEqual({
      kind: 'busy',
      message: 'Another storage transfer is in progress. Retry shortly.',
    })
    deleteNow.mockRestore()
    respondWith({ ok: false }, 503)
    expect(await new HttpControllerClient().writeDocument('meta', '{}', 2)).toEqual({ kind: 'unmounted' })
  })

  it('sends the expected base and distinguishes delete conflicts from the idle gate', async () => {
    let requested = ''
    stubFetch((url) => {
      requested = String(url)
      return new Response(JSON.stringify({ ok: false, conflict: true, version: 8 }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    })
    expect(await new HttpControllerClient().deleteDocument('runs/manual-41', 7)).toEqual({
      kind: 'conflict',
      version: 8,
    })
    expect(requested).toContain('/api/data/delete?')
    expect(requested).toContain('target=runs%2Fmanual-41')
    expect(requested).toContain('confirm=DELETE_DATA')
    expect(requested).toContain('base=7')

    respondWith({ ok: false, message: 'Document storage waits until actuation or recording finishes.' }, 409)
    expect(await new HttpControllerClient().deleteDocument('profiles', 2)).toEqual({
      kind: 'busy',
      message: 'Document storage waits until actuation or recording finishes.',
    })
  })
})

describe('document delete failure', () => {
  it('does not mistake an existing-path remove failure for an idempotent delete', async () => {
    respondWith({ ok: false, message: 'The stored document could not be removed.' }, 500)
    expect(await new HttpControllerClient().deleteDocument('runs/manual-41', 3)).toEqual({
      kind: 'error',
      message: 'The stored document could not be removed.',
    })
  })
})

describe('recording restore transport', () => {
  it('uploads the archive byte-for-byte as one raw request body', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    stubFetch((url, init) => {
      requestUrl = String(url)
      requestInit = init
      return new Response(
        JSON.stringify({
          ok: true,
          recording_origin: { deviceId: 'source-device', logId: '41' },
          storage_address: { deviceId: 'active-device', logId: '82' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const bytes = Uint8Array.from([0x43, 0x52, 0x4b, 0x4c, 0x03, 0x00, 0xff])
    expect((await new HttpControllerClient().restoreDeviceLog('auto', bytes)).ok).toBe(true)
    expect(requestUrl).toContain('/api/logs/restore?')
    expect(requestUrl).toContain('id=auto')
    expect(requestUrl).toContain('confirm=RESTORE_LOG')
    expect(requestInit?.headers).toEqual({ 'content-type': 'application/octet-stream' })
    expect(requestInit?.body).toStrictEqual(bytes)
  })

  it('refuses an over-cap recording before constructing a request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const outcome = await new HttpControllerClient().restoreDeviceLog('41', new Uint8Array(RESTORE_MAX_BYTES + 1))
    expect(RESTORE_MAX_BYTES).toBe(121_244)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain(String(RESTORE_MAX_BYTES))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reserves the uint32 ceiling so restore cannot make the next device id wrap to zero', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const outcome = await new HttpControllerClient().restoreDeviceLog('4294967295', new Uint8Array([1]))
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.message).toContain('below 4294967295')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('revisioned controller contract', () => {
  it('preserves uint64 state revisions as decimal text', () => {
    expect(stateRevision('18446744073709551615')).toBe('18446744073709551615')
    expect(stateRevision(42)).toBeUndefined()
    expect(stateRevision('042')).toBeUndefined()
    expect(stateRevision('18446744073709551616')).toBeUndefined()
  })

  it('parses status identity, maintenance, offset, and live sequence fields', async () => {
    respondWith(
      diagnosticBody({
        boot_id: 'boot-a',
        state_rev: '18446744073709551615',
        thermocouple_offset_c: -2.75,
        restore_maintenance: { active: true, incomplete: false, expires_in_ms: 9000 },
        roast: { active: true, mode: 'journey', plan_rev: 7 },
      }),
    )
    const status = await new HttpControllerClient().status()
    expect(status).toMatchObject({
      bootId: 'boot-a',
      stateRev: '18446744073709551615',
      thermocoupleOffsetC: -2.75,
      restoreMaintenance: { active: true, incomplete: false, expiresInMs: 9000 },
      roast: { planRev: 7 },
    })

    respondWith({
      firmware_version: '2026-07-26.55',
      roaster: {
        device_id: 'esp32-aabbcc',
        model_id: 'freshroast-sr800',
        display_name: 'FreshRoast SR800',
        simulated: false,
      },
      capabilities: { api_version: 'diagnostic-v1', diagnostic_tests: true, manual_roast: true },
      manual_conflict_latched: false,
      boot_id: 'boot-a',
      state_rev: '9',
      stream_seq: 41,
      roast_mode: 'manual',
      roast_active: true,
      roast_session_id: 93,
      roast_name: 'Morning roast',
      roast_started_epoch: 1785432000,
      roast_batch_g: 225,
      roast_ambient_c: 24.5,
      roast_saturated: true,
      roast_holdover: false,
      plan_rev: 8,
    })
    await expect(new HttpControllerClient().live()).resolves.toMatchObject({
      firmwareVersion: '2026-07-26.55',
      manualLockout: false,
      roaster: {
        deviceId: 'esp32-aabbcc',
        modelId: 'freshroast-sr800',
        displayName: 'FreshRoast SR800',
        simulated: false,
      },
      capabilities: { apiVersion: 'diagnostic-v1', diagnosticTests: true, manualRoast: true },
      roastMode: 'manual',
      roastActive: true,
      roastSessionId: '93',
      roastName: 'Morning roast',
      roastStartedEpoch: 1785432000,
      roastBatchMassG: 225,
      roastAmbientC: 24.5,
      roastSaturated: true,
      roastHoldover: false,
      bootId: 'boot-a',
      stateRev: '9',
      streamSeq: 41,
      planRev: 8,
    })
  })

  it('parses the per-tick journey progress tuple from the compact live payload', async () => {
    respondWith({
      roast_active: true,
      roast_journey: true,
      roast_mode: 'journey',
      roast_elapsed_s: 400,
      roast_zone: 2,
      roast_zones: 5,
      roast_target_c: 171.4,
      roast_zone_entry_s: 330,
      roast_zone_nominal_s: 135,
      roast_zone_end_c: 196,
      roast_correction: 1.4,
      roast_integral: 0.6,
      roast_solved_fan: 1.7,
      roast_solved_heat: 8.2,
      roast_holdover_ms: 0,
      roast_zones_done: [121, 328, null, null, null],
      roast_end: 'none',
    })
    await expect(new HttpControllerClient().live()).resolves.toMatchObject({
      roastElapsedSec: 400,
      roastZone: 2,
      roastZones: 5,
      roastTargetC: 171.4,
      roastZoneEntrySec: 330,
      roastZoneNominalSec: 135,
      roastZoneEndC: 196,
      roastCorrectionTotal: 1.4,
      roastIntegral: 0.6,
      roastSolvedFan: 1.7,
      roastSolvedHeat: 8.2,
      roastHoldoverMs: 0,
      roastZonesAttained: [121, 328, null, null, null],
      // `none` is the idle sentinel and is parsed away, as in every other block.
      roastEndReason: undefined,
    })
  })

  it('degrades the journey tuple to undefined on firmware before 2026-07-26.107, with nulls staying null', async () => {
    respondWith({
      roast_active: true,
      roast_journey: false,
      roast_mode: 'timed',
      roast_elapsed_s: 40,
      roast_zone_end_c: null,
      roast_correction: null,
      roast_integral: null,
    })
    const snapshot = await new HttpControllerClient().live()
    expect(snapshot.roastZoneEntrySec).toBeUndefined()
    expect(snapshot.roastZoneEndC).toBeUndefined()
    expect(snapshot.roastCorrectionTotal).toBeUndefined()
    expect(snapshot.roastZonesAttained).toBeUndefined()
  })

  it('parses controller-owned calibration progress from the compact live payload', async () => {
    respondWith({
      cal_active: true,
      cal_step: 3,
      cal_count: 12,
      cal_id: '82',
      cal_fan: 4,
      cal_heat: 10,
      cal_elapsed_s: 27,
      cal_settle: 'checking',
      cal_end: 'none',
      log_active: true,
      log_id: '82',
      log_source: 'calibration',
      cal_done: [
        { index: 0, fan: 2, heat: 4, elapsed_sec: 61, temperature_c: 148.26, outcome: 'settled' },
        { index: 1, fan: 2, heat: 7, elapsed_sec: 120, temperature_c: 191.5, outcome: 'capped' },
      ],
    })
    await expect(new HttpControllerClient().live()).resolves.toMatchObject({
      calibrationActive: true,
      calibrationStep: 3,
      calibrationCount: 12,
      calibrationId: '82',
      calibrationFan: 4,
      calibrationHeat: 10,
      calibrationElapsedSec: 27,
      calibrationSettleState: 'checking',
      calibrationEndReason: undefined,
      thermalLogActive: true,
      thermalLogId: '82',
      thermalLogSource: 'calibration',
      calibrationCompletedSteps: [
        { index: 0, fan: 2, heat: 4, elapsedSec: 61, temperatureC: 148.26, outcome: 'settled' },
        { index: 1, fan: 2, heat: 7, elapsedSec: 120, temperatureC: 191.5, outcome: 'capped' },
      ],
    })
  })

  it('keeps compact calibration enrichment optional for older firmware', async () => {
    respondWith({ cal_active: true, cal_step: 1, cal_count: 4 })
    const snapshot = await new HttpControllerClient().live()
    expect(snapshot.calibrationId).toBeUndefined()
    expect(snapshot.calibrationFan).toBeUndefined()
    expect(snapshot.calibrationHeat).toBeUndefined()
    expect(snapshot.calibrationElapsedSec).toBeUndefined()
    expect(snapshot.calibrationSettleState).toBeUndefined()
    expect(snapshot.calibrationCompletedSteps).toBeUndefined()
  })

  it('keeps full status available while compact telemetry reports active work', async () => {
    const responses = [
      {
        boot_id: 'boot-a',
        stream_seq: 1,
        tc_c: 100,
        cal_active: true,
        cal_id: '82',
        cal_step: 3,
        cal_count: 12,
        log_active: true,
      },
      diagnosticBody({ boot_id: 'boot-a', lifecycle: 'RUNNING' }),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(responses.shift()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    const controller = new HttpControllerClient()
    const live = await controller.live()
    expect(live).toMatchObject({ connected: true, calibrationActive: true, calibrationStep: 3 })
    expect(controller.fullStatusDeferred()).toBe(false)
    await expect(controller.status()).resolves.toMatchObject({ connected: true, lifecycle: 'RUNNING' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reconciles a delayed command acknowledgement without replaying the mutation', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            message: 'The controller did not acknowledge this command in time.',
          }),
          {
            status: 504,
            headers: {
              'content-type': 'application/json',
              'X-Crackle-Request-Id': '17',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            diagnosticBody({
              boot_id: 'boot-a',
              state_rev: '7',
              last_request_id: 17,
              last_request_status: 200,
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    const pending = new HttpControllerClient().stopAll()
    await vi.advanceTimersByTimeAsync(150)
    await expect(pending).resolves.toMatchObject({
      ok: true,
      stateRev: '7',
      message: expect.stringMatching(/committed.*acknowledgement/i),
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
  it('parses a cursor page without narrowing opaque cursor text', async () => {
    let requested = ''
    stubFetch((url) => {
      requested = String(url)
      return new Response(
        JSON.stringify({
          ok: true,
          state_rev: '22',
          boot_id: 'boot-b',
          next_cursor: 'opaque:+/=',
          collections: {
            profiles: { bytes: 12, version: 2 },
            beans: null,
            calibrations: null,
            meta: null,
          },
          runs: [{ id: 'run-1', bytes: 40, version: 3 }],
          logs: [{ id: '81', bytes: 90 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const result = await new HttpControllerClient().readManifestPage('page:+/=')
    expect(requested).toContain('cursor=page%3A%2B%2F%3D')
    expect(result).toMatchObject({
      kind: 'ok',
      page: { stateRev: '22', bootId: 'boot-b', nextCursor: 'opaque:+/=', runs: [{ id: 'run-1', version: 3 }] },
    })
  })

  it('uses the firmware restore lease contract for begin and every maintenance write', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        if (String(url).startsWith('/api/restore/begin'))
          return new Response(JSON.stringify({ ok: true, restore_token: 'lease-1', state_rev: '5' }))
        if (String(url).startsWith('/api/restore/commit'))
          return new Response(JSON.stringify({ ok: true, state_rev: '7' }))
        if (String(url).startsWith('/api/logs/restore'))
          return new Response(
            JSON.stringify({
              ok: true,
              state_rev: '6',
              recording_origin: { deviceId: 'source-device', logId: '41' },
              storage_address: { deviceId: 'active-device', logId: '82' },
            }),
          )
        return new Response(JSON.stringify({ ok: true, version: 1, state_rev: '6' }))
      }),
    )
    const client = new HttpControllerClient()
    await expect(client.beginRestoreMaintenance()).resolves.toMatchObject({ ok: true, token: 'lease-1', stateRev: '5' })
    await expect(client.formatDeviceStorage()).resolves.toMatchObject({ ok: true, stateRev: '6' })
    await expect(client.writeDocument('profiles', '{}', 0)).resolves.toMatchObject({ kind: 'ok', stateRev: '6' })
    await expect(client.deleteDocument('beans', 0)).resolves.toMatchObject({ kind: 'ok', stateRev: '6' })
    await expect(client.restoreDeviceLog('41', Uint8Array.from([0x43, 0x52, 0x4b, 0x4c]))).resolves.toMatchObject({
      ok: true,
      stateRev: '6',
    })
    await expect(
      client.applyCalibration(
        {
          heaterGainCPerMinAt10: 100,
          fanCoolingCPerMinAt10: 30,
          coolingFanCPerMinAt10: 40,
          thermalLossPerMinPerC: 0.08,
        },
        'restored-fit',
      ),
    ).resolves.toMatchObject({ ok: true, stateRev: '6' })
    await expect(client.commitRestoreMaintenance()).resolves.toMatchObject({ ok: true, stateRev: '7' })

    const urls = calls.map((call) => new URL(call, 'http://device.local'))
    expect(urls[0].searchParams.get('confirm')).toBe('BEGIN_RESTORE')
    expect(urls[0].searchParams.has('restore_token')).toBe(false)
    for (const url of urls.slice(1)) {
      expect(url.searchParams.get('restore_token')).toBe('lease-1')
      expect(url.searchParams.has('token')).toBe(false)
    }
  })
  it('reconciles a document write whose success acknowledgement was lost', async () => {
    const requested = JSON.stringify({ profiles: [{ id: 'p1' }] })
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        if (call === 1) throw new TypeError('connection reset')
        return new Response(requested, {
          status: 200,
          headers: { 'content-type': 'application/json', 'X-Doc-Version': '14' },
        })
      }),
    )

    await expect(new HttpControllerClient().writeDocument('profiles', requested, 13)).resolves.toEqual({
      kind: 'ok',
      version: 14,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not claim an unacknowledged document write committed when the old copy remains', async () => {
    const requested = JSON.stringify({ profiles: [{ id: 'new' }] })
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        if (call === 1) throw new TypeError('connection reset')
        return new Response(JSON.stringify({ profiles: [{ id: 'old' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'X-Doc-Version': '13' },
        })
      }),
    )

    const result = await new HttpControllerClient().writeDocument('profiles', requested, 13)
    expect(result).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('previous copy is still stored'),
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reads and patches the authoritative active plan and stores the probe correction', async () => {
    const calls: string[] = []
    const plan = {
      ok: true,
      active: true,
      boot_id: '3',
      session_id: 14,
      plan_rev: 2,
      mode: 'journey',
      name: 'Live',
      batch_mass_g: 120,
      steps: [],
      zones: [{ start_c: 100, end_c: 150, duration_sec: 60, fan_min: 4, fan_max: 8, heat_min: 3, heat_max: 9 }],
      initial_zones: [{ start_c: 100, end_c: 145, duration_sec: 60, fan_min: 4, fan_max: 8, heat_min: 3, heat_max: 9 }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        if (String(url).startsWith('/api/settings/thermocouple-offset')) {
          return new Response(JSON.stringify({ ok: true, thermocouple_offset_c: -3, state_rev: '31' }))
        }
        return new Response(
          JSON.stringify({ ...plan, plan_rev: calls.length === 1 ? 2 : 3, immediate_transition: false }),
          { status: calls.length === 1 ? 200 : 202 },
        )
      }),
    )
    const client = new HttpControllerClient()
    await expect(client.fetchActiveRoastPlan()).resolves.toMatchObject({
      sessionId: '14',
      planRev: 2,
      zones: [{ startC: 100, endC: 150 }],
      initialZones: [{ startC: 100, endC: 145 }],
    })
    const active = await client.fetchActiveRoastPlan()
    await expect(client.patchActiveRoastPlan(active.zones, '14', 2)).resolves.toMatchObject({
      ok: true,
      plan: { planRev: 3 },
    })
    await expect(client.setThermocoupleOffset(-3)).resolves.toMatchObject({
      ok: true,
      thermocoupleOffsetC: -3,
      stateRev: '31',
    })
    expect(calls[2]).toContain('confirm=PATCH_ROAST_PLAN')
    expect(calls[2]).toContain('expected_plan_rev=2')
    expect(calls[3]).toContain('offset_c=-3')
  })

  it('blocks persistent mutations while stale but leaves stop commands exempt', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetch)
    setControllerMutationGate(() => 'Sync first')
    await expect(new HttpControllerClient().setThermocoupleOffset(1)).resolves.toEqual({
      ok: false,
      message: 'Sync first',
    })
    expect(fetch).not.toHaveBeenCalled()
    await expect(new HttpControllerClient().stopManual()).resolves.toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
