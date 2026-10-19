import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CALIBRATION_APPLY_URL,
  CALIBRATION_START_URL,
  CALIBRATION_STOP_URL,
  DEV_LIVE_DROP_URL,
  DEV_POWER_CYCLE_URL,
  DEV_PROBE_URL,
  DEVICE_DATA_DELETE_URL,
  DEVICE_DATA_PREFIX,
  DEVICE_LOG_DELETE_URL,
  DEVICE_LOG_FORMAT_URL,
  DEVICE_LOG_PREFIX,
  DEVICE_LOG_RESTORE_URL,
  DEVICE_LOGS_URL,
  DEVICE_MANIFEST_URL,
  LIVE_URL,
  LIVE_WS_PATH,
  MANUAL_SET_URL,
  MANUAL_STOP_URL,
  RESTORE_MAINTENANCE_ABORT_URL,
  RESTORE_MAINTENANCE_BEGIN_URL,
  RESTORE_MAINTENANCE_COMMIT_URL,
  ROAST_ACTIVE_PLAN_URL,
  ROAST_SET_URL,
  ROAST_START_URL,
  ROAST_STOP_URL,
  STATUS_URL,
  STOP_ALL_URL,
  THERMAL_CSV_URL,
  THERMOCOUPLE_OFFSET_URL,
} from './client'

/**
 * Crackle's entire controller surface, by explicit allow-list. `GET /api/status` and `GET /api/live`
 * are observation - the second is the small HTTP fallback added in 0.5.0; `/ws/live` is the 1 Hz push path. The
 * two calibration entries are the deliberate 0.3.0 diagnostic scope change, and the two manual
 * entries are the deliberate 0.5.0 one; all four are capability-gated. Nothing else may be fetched,
 * and no file other than `client.ts` may fetch.
 *
 * Roast execution is explicit rather than per-tick: Start, Stop, manual Set, and active-plan
 * reconciliation/editing. Firmware validates and owns every accepted plan. Any added path remains
 * a contract change and belongs in review, not an incidental patch.
 */
const ALLOWED = [
  STATUS_URL,
  LIVE_URL,
  LIVE_WS_PATH,
  STOP_ALL_URL,
  CALIBRATION_START_URL,
  CALIBRATION_STOP_URL,
  MANUAL_SET_URL,
  MANUAL_STOP_URL,
  THERMAL_CSV_URL,
  // 0.7.0, the device log archive and on-device applied coefficients: four paths, no more.
  DEVICE_LOGS_URL,
  DEVICE_LOG_DELETE_URL,
  DEVICE_LOG_PREFIX,
  CALIBRATION_APPLY_URL,
  // Log-file round trip uses format/restore; device-wide replacement adds the three lease paths.
  // Reading a recording back needed no new path because `/logs/` was already the parent of the
  // per-log fetch and the SUFFIX picks the representation - `.csv` decodes, `.crk` is the file.
  DEVICE_LOG_FORMAT_URL,
  DEVICE_LOG_RESTORE_URL,
  RESTORE_MAINTENANCE_BEGIN_URL,
  RESTORE_MAINTENANCE_COMMIT_URL,
  RESTORE_MAINTENANCE_ABORT_URL,
  // Device-owned roast execution: hand-over, Stop, manual Set, and exact active-plan reconciliation.
  ROAST_START_URL,
  ROAST_SET_URL,
  ROAST_STOP_URL,
  ROAST_ACTIVE_PLAN_URL,
  // 0.9.0, the controller-resident document store: one prefix and one delete. The prefix is the
  // parent of every collection AND of `runs/<id>`, exactly as `/logs/` is the parent of every
  // recording - which is what keeps a parameterised address from becoming an unpoliced path.
  DEVICE_DATA_PREFIX,
  DEVICE_DATA_DELETE_URL,
  DEVICE_MANIFEST_URL,
  THERMOCOUPLE_OFFSET_URL,
  // Vite serve-only recovery surface; never offered for a physical controller.
  DEV_POWER_CYCLE_URL,
  DEV_PROBE_URL,
  DEV_LIVE_DROP_URL,
].sort()

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLIENT = join(SOURCE_ROOT, 'controller', 'client.ts')

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

describe('controller fetch surface', () => {
  const files = sourceFiles(SOURCE_ROOT)

  it('finds the application sources it is meant to police', () => {
    expect(files.length).toBeGreaterThan(15)
    expect(files).toContain(CLIENT)
  })

  it('calls fetch from client.ts and nowhere else', () => {
    const offenders = files
      .filter((path) => path !== CLIENT && /\bfetch\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SOURCE_ROOT, path))
    expect(offenders).toEqual([])
  })

  it('routes every HTTP operation through the selected target resolver', () => {
    const client = readFileSync(CLIENT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    const calls = [...client.matchAll(/fetch\(([^,\n]+)/g)].map((match) => match[1].trim())
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((argument) => argument.startsWith('this.endpoint('))).toBe(true)
  })

  it('uses exactly the production controller paths plus the Vite-only recovery path', () => {
    const client = readFileSync(CLIENT, 'utf8')
    // A route has a path after the slash; a bare '/' is string handling, not a controller path.
    const literals = [...client.matchAll(/'(\/[^']+)'/g)].map((match) => match[1])
    expect([...new Set(literals)].sort()).toEqual(ALLOWED)
    expect(ALLOWED).toEqual([
      '/api/calibration/apply',
      '/api/calibration/start',
      '/api/calibration/stop',
      '/api/data/',
      '/api/data/delete',
      '/api/data/manifest',
      '/api/dev/live-drop',
      '/api/dev/power-cycle',
      '/api/dev/probe',
      '/api/live',
      '/api/logs',
      '/api/logs/delete',
      '/api/logs/format',
      '/api/logs/restore',
      '/api/manual/set',
      '/api/manual/stop',
      '/api/restore/abort',
      '/api/restore/begin',
      '/api/restore/commit',
      '/api/roast/active-plan',
      '/api/roast/set',
      '/api/roast/start',
      '/api/roast/stop',
      '/api/settings/thermocouple-offset',
      '/api/status',
      '/api/stop',
      '/logs/',
      '/thermal.csv',
      '/ws/live',
    ])
  })

  /**
   * Backup and restore cost the allow-list two paths, and the one it did NOT cost is the point.
   *
   * `/logs/` was already the parent of the per-recording fetch, so serving the raw archive file
   * needed no new address - the suffix chooses between the decoded CSV and the stored bytes. Had the
   * firmware put the file at `/api/logs/file` instead, this list would have grown by three, and a
   * parameterised id would have been sitting on a fresh path for no reason.
   */
  it('gives backup and restore exactly a format and a restore, and reuses the log prefix', () => {
    expect(ALLOWED.filter((path) => path.startsWith('/api/logs'))).toEqual([
      '/api/logs',
      '/api/logs/delete',
      '/api/logs/format',
      '/api/logs/restore',
    ])
    const client = readFileSync(CLIENT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    // Both representations compose from the one allow-listed prefix.
    expect(client).toMatch(/\$\{DEVICE_LOG_PREFIX\}\$\{encodeURIComponent\(id\)\}\.csv/)
    expect(client).toMatch(/\$\{DEVICE_LOG_PREFIX\}\$\{encodeURIComponent\(id\)\}\.crk/)
    expect(client).toMatch(/\$\{DEVICE_LOG_RESTORE_URL\}\?/)
    expect(client).toMatch(/\$\{DEVICE_LOG_FORMAT_URL\}\?/)
    // Raw octet-stream is the native binary-safe restore transport.
    expect(client).not.toMatch(/new FormData\(\)/)
    expect(client).not.toMatch(/form\.append\(\s*'recording'/)
    expect(client).toMatch(/'content-type':\s*'application\/octet-stream'/)
  })

  /**
   * The data layer uses a prefix, delete, and revisioned manifest. Every document address
   * - the four collections, the run index, and one run - is composed from it, so a future schema
   * change cannot quietly add a path: it would have to add a literal here first.
   */
  it('gives the document store a prefix, delete, and revisioned manifest', () => {
    expect(ALLOWED.filter((path) => path.startsWith('/api/data'))).toEqual([
      '/api/data/',
      '/api/data/delete',
      '/api/data/manifest',
    ])
    const client = readFileSync(CLIENT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(client).toMatch(/\$\{DEVICE_DATA_PREFIX\}\$\{target\}/)
    expect(client).toMatch(/\$\{DEVICE_DATA_PREFIX\}runs/)
    expect(client).toMatch(/\$\{DEVICE_DATA_DELETE_URL\}\?/)
  })

  it('limits manual control to Set and Stop', () => {
    expect(ALLOWED.filter((path) => path.startsWith('/api/manual/'))).toEqual(['/api/manual/set', '/api/manual/stop'])
  })

  /** Roast execution exposes hand-over, Stop, manual Set, and exact active-plan reconciliation. */
  it('gives roast execution start, active plan, manual Set, and Stop', () => {
    expect(ALLOWED.filter((path) => path.startsWith('/api/roast/'))).toEqual([
      '/api/roast/active-plan',
      '/api/roast/set',
      '/api/roast/start',
      '/api/roast/stop',
    ])
    const client = readFileSync(CLIENT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(client).toMatch(/\$\{ROAST_START_URL\}\?/)
    expect(client).toMatch(/\$\{ROAST_SET_URL\}\?/)
    // Stop takes no arguments at all, so it is issued through the bare command helper.
    expect(client).toMatch(/this\.command\(ROAST_STOP_URL\)/)
  })

  /**
   * The device-archive routes are parameterised, so their ids live in template literals rather than
   * in the quoted literals the check above enumerates. A template that starts with a slash would
   * therefore be a path nothing polices - so no template may start one.
   */
  it('never builds a path from a bare template literal', () => {
    // Comments quote paths for documentation; only executable code is policed.
    const client = readFileSync(CLIENT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(client).not.toMatch(/`\//)
    // Every parameterised route is composed from an allow-listed constant instead.
    expect(client).toMatch(/\$\{DEVICE_LOG_PREFIX\}/)
    expect(client).toMatch(/\$\{DEVICE_LOG_DELETE_URL\}\?/)
    expect(client).toMatch(/\$\{CALIBRATION_APPLY_URL\}\?/)
  })

  it('keeps roast execution capabilities hardcoded false in the client', () => {
    const client = readFileSync(CLIENT, 'utf8')
    expect(client).toMatch(/autonomousTimedPrograms:\s*false/)
    expect(client).toMatch(/thermalExecution:\s*false/)
    expect(client).not.toMatch(/autonomousTimedPrograms:\s*(true|capabilities)/)
    expect(client).not.toMatch(/thermalExecution:\s*(true|capabilities)/)
  })
})
