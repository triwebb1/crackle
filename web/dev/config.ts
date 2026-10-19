/**
 * ============================================================================================
 * THE MOCK CONTROLLER - constants, tokens and tunables
 * ============================================================================================
 *
 * Everything under `web/dev/` is DEV-SERVER ONLY. It is loaded by `vite.config.ts` (which esbuild
 * bundles at config load, so it runs in Node) and it is never imported by anything under `web/src/`.
 * Nothing here reaches the production bundle, and nothing here may ever be imported by the app.
 *
 * The mock READS from `web/src/domain` on purpose: the plant coefficients, the actuator floors, the
 * roast argument limits and the whole journey control law are imported rather than re-typed, so the
 * simulated roaster cannot drift away from the app's own model the way a hand-written fixture would.
 *
 * The confirmation tokens below are the one thing that IS duplicated, and deliberately: they are
 * private to `src/controller/client.ts` (which cannot be imported here - it needs the DOM lib), and
 * a mock that accepted any token would stop being a test of the contract.
 */
import {
  ESTIMATED_BASELINE_AMBIENT_C,
  ESTIMATED_BASELINE_COEFFICIENTS,
  ESTIMATED_BASELINE_MASS_G,
} from '../src/domain/estimatedBaseline'
import { ROAST_ENVELOPE_MARGIN_SEC } from '../src/domain/roastProgram'
import { MOCK_SENSOR_MODEL, MOCK_SENSOR_NOISE_C } from './mockDeviceModel'

/** Mirrored from `client.ts`, which keeps them private. A mock that skipped them tests nothing. */
export const CONFIRM = {
  calibration: 'FOUR_DASHES_CALIBRATION',
  manual: 'MANUAL_CONTROL',
  roast: 'START_ROAST',
  roastControl: 'CONTROL_ROAST',
  deleteLog: 'DELETE_LOG',
  applyCalibration: 'APPLY_CALIBRATION',
  formatLogs: 'FORMAT_LOGS',
  restoreLog: 'RESTORE_LOG',
} as const

/**
 * The firmware's physical-plausibility gate, mirrored from `PLAUSIBLE_COEFFICIENTS` in `client.ts`
 * in the firmware's own argument names. Enforced at `/api/calibration/apply` and at journey start,
 * exactly as the device enforces it, so the browser's own mirror can be tested against a refusal.
 */
export const PLAUSIBLE = {
  heater_gain: { min: 5, max: 500 },
  fan_cooling: { min: 0.5, max: 200 },
  cooling_fan: { min: 1, max: 300 },
  loss_per_min: { min: 0.005, max: 2 },
} as const

/** What this mock claims to be. Suffixed so a real device can never be confused for it. */
export const FIRMWARE_VERSION = '2026-07-26.40-mock'
export const API_VERSION = 'diagnostic-v1'

/** The simulation ticks on this cadence, and integrates in sub-steps no longer than it. */
export const TICK_MS = 250

/** Match the production controller's 1 Hz live WebSocket publication contract. */
export const LIVE_STREAM_MS = 1000

/** Detailed and compact roast cadences, the RAM ceiling, and the non-roast archival floor. */
export const LOG_INTERVAL_MS = 1000
export const COMPACT_ROAST_LOG_INTERVAL_MS = 10_000
export const LOG_CAPACITY_SAMPLES = 4800
export const MIN_ARCHIVED_SAMPLES = 30

/** The stored-log geometry, so `bytes` and the volume accounting are the firmware's own arithmetic. */
export const LOG_HEADER_BYTES = 92
export const LOG_SAMPLE_BYTES = 12
export const ARCHIVE_TOTAL_BYTES = 917504
export const ARCHIVE_RESERVE_BYTES = 98304

/** Flash slot figures, reported by `/api/status` so the Settings storage panel has real numbers. */
export const OTA_SLOT_BYTES = 1572864
export const APP_USED_BYTES = 1364069

/** The room the simulated roaster sits in, and the probe's own first-order lag. */
export const AMBIENT_C = ESTIMATED_BASELINE_AMBIENT_C
export const SENSOR_LAG_SEC = MOCK_SENSOR_MODEL.sensorLagSec
/** Peak-to-peak thermocouple noise, in C. Small enough to be realistic, large enough to be visible. */
export const SENSOR_NOISE_C = MOCK_SENSOR_NOISE_C

/**
 * The LOADED plant is deliberately 10% weaker than the model the controller inverts.
 *
 * This applies to the bean regime only, which is the only regime a journey is ever run in. The
 * empty-chamber regime is a different plant on a different scale (`src/data/chamberPlant.ts`) and is
 * not an offset version of anything the app inverts.
 *
 * The estimated baseline is an estimate - that is its whole documented character - so a mock whose
 * plant matched it exactly would run every journey with a correction of zero and would never
 * exercise the in-roast PI, the integral display, the saturation flag, or the residual the refit
 * consumes. A 10% gain error is the size of error the coefficients honestly carry, and it makes the
 * feedback layer visibly do its job in the dev app.
 */
export const PLANT_HEATER_SCALE = 0.9

export const BASELINE = ESTIMATED_BASELINE_COEFFICIENTS
export const BASELINE_MASS_G = ESTIMATED_BASELINE_MASS_G

/** Actuator behaviour: fan qualification, the renewable heat lease, and the overtemperature latch. */
export const FAN_QUALIFY_MS = 1500
export const QUALIFICATION_TIMEOUT_MS = 10000
export const HEAT_LEASE_MS = 30000
export const OVERTEMP_C = 260
export const OVERTEMP_HOLD_MS = 1000
/** After an overtemperature trip: Fan 10 / Heat 0 until the reading has been below the limit this long. */
export const OVERTEMP_COOLDOWN_MS = 180_000

/**
 * A Stop that interrupts an active roast runs Fan 10 / Heat 0 for ten
 * seconds before the outputs go off, so residual element heat never sits against stationary beans.
 * Any newly accepted instruction preempts the tail immediately.
 */
export const COOLING_TAIL_MS = 10000

/**
 * The instruction lease. An instruction is good for 30 minutes; any new `set` resets the clock, and
 * nothing about a browser being open enters into it. This is the firmware's `instruction_limit_ms`.
 */
export const MANUAL_INSTRUCTION_LIMIT_MS = 1800000

/** Roast holdover: a reading older than this is stale, and 30 s of that is `sensor_lost`. */
export const READING_STALE_MS = 900
export const HOLDOVER_LIMIT_MS = 30000

/** `envelope_sec` = 2x the plan's nominal seconds + this. */
export const ENVELOPE_MARGIN_SEC = ROAST_ENVELOPE_MARGIN_SEC

/**
 * How long the recording keeps running after the outputs stop - the firmware's `kLogIdleFinalizeMs`,
 * three minutes, at its real length and NOT compressed.
 *
 * This window is the entire passive fan-off tail. The thermal loss coefficient is derivable from
 * this portion of the trace. Three minutes is the length the firmware settled on, and it was chosen
 * against the plant rather than the clock -
 * roughly 30 s of heat-soak rebound, which `afterRebound` trims, then ~150 s of clean exponential
 * decay to fit. Shortening it here would leave the mock producing passes that no analysis can stage a
 * loss from, which is what it did before this existed.
 */
export const LOG_TAIL_MS = 180000

/**
 * A finished log closes after the firmware's three-minute passive tail, then persists while idle.
 * The mock compresses the post-close persist delay to five seconds, because a developer
 * refreshing History should not have to wait out a firmware timer to see the recording appear.
 */
export const IDLE_PERSIST_MS = 5000

/**
 * How long `GET /api/logs` keeps answering an explicit `503 + Retry-After` busy after a finished
 * recording persists. On the device the roast's settle moment is a storage pile-up: the archive
 * write itself plus the batched Controls-history and run-document writes all share one storage
 * worker, so the browser's settle-triggered list read is routinely deferred for seconds to tens of
 * seconds. The mock's synchronous routes could never say busy at all, which made the app's archive
 * retry path (and the stuck post-roast panel a broken retry produces) invisible in dev. Four
 * seconds is compressed like `IDLE_PERSIST_MS`, but long enough that the retry schedule's early
 * attempts genuinely land inside it.
 */
export const ARCHIVE_LIST_BUSY_MS = 4000

const positiveNumber = (raw: string | undefined, fallback: number) => {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * How fast simulated time runs against wall-clock time.
 *
 * `CRACKLE_MOCK_SPEED` scales everything (a 20 minute roast in 2 minutes at 10x). The calibration
 * program carries its own multiplier because a full grid pass is 30+ minutes of dwell that nobody
 * wants to sit through, and reviewing one is the single most common reason to run the mock at all.
 */
export const GLOBAL_SPEED = positiveNumber(process.env.CRACKLE_MOCK_SPEED, 1)
export const CALIBRATION_SPEED = positiveNumber(process.env.CRACKLE_MOCK_CALIBRATION_SPEED, 10)

/** Where the mock keeps its state between dev-server restarts. Gitignored; see `web/.gitignore`. */
export const STATE_FILE = process.env.CRACKLE_MOCK_STATE ?? 'dev/.mock-controller-state.json'

export const round1 = (value: number) => Math.round(value * 10) / 10
export const round2 = (value: number) => Math.round(value * 100) / 100
export const round3 = (value: number) => Math.round(value * 1000) / 1000
export const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value))
