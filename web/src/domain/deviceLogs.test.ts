import { describe, expect, it } from 'vitest'
import { testLogProvenance, testRecordedOn, testRecordingOrigin, testStorageAddress } from '../testFixtures/provenance'
import {
  ARCHIVE_MESSAGES,
  archiveStateFromStatus,
  coefficientDivergence,
  deviceArchive,
  epochToIso,
  FIT_ID_MAX,
  orderDeviceLogs,
  parseArchiveStorage,
  parseDeviceCoefficients,
  parseDeviceCurrentLog,
  parseDeviceLogEntry as parseDeviceLogEntryRaw,
  parseDeviceLogList as parseDeviceLogListRaw,
  sanitizeFitId,
} from './deviceLogs'

const rawLog = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (record.id === undefined || record.id === null) return value
  const id = String(record.id)
  return {
    recorded_on: testRecordedOn,
    recording_origin: testRecordingOrigin(id),
    storage_address: testStorageAddress(id),
    ...record,
  }
}

const parseDeviceLogEntry = (value: unknown) => parseDeviceLogEntryRaw(rawLog(value))
const parseDeviceLogList = (value: unknown) => {
  if (Array.isArray(value)) return parseDeviceLogListRaw(value.map(rawLog))
  if (typeof value !== 'object' || value === null) return parseDeviceLogListRaw(value)
  const record = value as Record<string, unknown>
  return parseDeviceLogListRaw({
    ...record,
    ...(Array.isArray(record.logs) ? { logs: record.logs.map(rawLog) } : {}),
    ...(Array.isArray(record.entries) ? { entries: record.entries.map(rawLog) } : {}),
    ...(Array.isArray(record.files) ? { files: record.files.map(rawLog) } : {}),
  })
}

/**
 * The archive is feature-detected because the firmware flashed today does not have it. A missing
 * feature has to read as a fact about the roaster, never as a broken screen.
 */
describe('feature detection', () => {
  it('treats a missing route as an absent feature, not a failure', () => {
    expect(archiveStateFromStatus(404)).toBe('unsupported')
    expect(archiveStateFromStatus(501)).toBe('unsupported')
    expect(archiveStateFromStatus(405)).toBe('unsupported')
  })

  it('separates an unmounted filesystem from a missing feature', () => {
    expect(archiveStateFromStatus(503)).toBe('unmounted')
    expect(deviceArchive('unmounted').message).toContain('did not mount')
  })
  it('identifies a timing-sensitive archive deferral without calling it damaged or offline', () => {
    expect(archiveStateFromStatus(409)).toBe('busy')
    expect(deviceArchive('busy').message).toContain('still capturing')
    expect(deviceArchive('busy').logs).toEqual([])
  })

  it('treats a real failure as a reachability problem, which is a different thing', () => {
    expect(archiveStateFromStatus(500)).toBe('unreachable')
    expect(archiveStateFromStatus(401)).toBe('unreachable')
    expect(archiveStateFromStatus(undefined)).toBe('unreachable')
  })

  it('accepts any success', () => {
    expect(archiveStateFromStatus(200)).toBe('available')
    expect(archiveStateFromStatus(204)).toBe('available')
  })

  it('carries plain wording for whichever state it is, and shows no logs unless it can', () => {
    expect(deviceArchive('unsupported').message).toBe(ARCHIVE_MESSAGES.unsupported)
    expect(deviceArchive('unsupported').message).toContain('cannot keep detailed thermal recordings')
    expect(deviceArchive('unsupported', [{ id: 'a', mode: 'manual', ...testLogProvenance('a') }]).logs).toEqual([])
    expect(deviceArchive('unreachable').logs).toEqual([])
    expect(deviceArchive('available', [{ id: 'a', mode: 'manual', ...testLogProvenance('a') }]).logs).toHaveLength(1)
  })
})

/**
 * Built against the final firmware contract, and still parsed defensively: a status document is a
 * contract with a device that may be mid-upgrade, not a type guarantee. An entry that cannot even
 * produce an id is dropped rather than rendered as a row that cannot be fetched.
 */
describe('parsing whatever shape the firmware sends', () => {
  it('reads the contract fields, converting milliseconds and epoch seconds', () => {
    expect(
      parseDeviceLogEntry({
        id: 12,
        boot: 7,
        start_epoch: 1_784_000_000,
        duration_ms: 640_000,
        samples: 640,
        interval_ms: 1000,
        source: 'manual',
        bytes: 22_000,
        download: '/logs/12.csv',
      }),
    ).toMatchObject({
      id: '12',
      bootId: '7',
      durationSec: 640,
      samples: 640,
      intervalMs: 1000,
      mode: 'manual',
      bytes: 22_000,
      download: '/logs/12.csv',
    })
  })

  it('reads the roast control mode and infers older roast headers without promoting diagnostics', () => {
    expect(
      parseDeviceLogEntry({
        id: 41,
        source: 'roast',
        roast_mode: 'manual',
        roast_stop_sec: 527,
        roast_end_reason: 'stopped',
        passive_tail_complete: false,
      }),
    ).toMatchObject({ roastMode: 'manual', roastStopSec: 527, roastEndReason: 'stopped', passiveTailComplete: false })
    expect(parseDeviceLogEntry({ id: 42, source: 'roast', zone_count: 3 })!.roastMode).toBe('journey')
    expect(parseDeviceLogEntry({ id: 43, source: 'roast', zone_count: 0 })!.roastMode).toBe('timed')
    expect(parseDeviceLogEntry({ id: 44, source: 'manual', roast_mode: 'manual' })!.roastMode).toBeUndefined()
    expect(
      parseDeviceLogEntry({
        id: 45,
        source: 'roast',
        roast_mode: 'manual',
        roast_stop_sec: 0,
        roast_end_reason: 'future_reason',
      }),
    ).toMatchObject({ roastStopSec: 0, roastEndReason: undefined })
    expect(parseDeviceLogEntry({ id: 46, source: 'roast', roast_end_reason: 'telemetry_stale' })!.roastEndReason).toBe(
      'telemetry_stale',
    )
  })

  /** 0 means the device clock had never synced. It is "date unknown", not 1970. */
  it('treats a zero epoch as no date at all', () => {
    expect(parseDeviceLogEntry({ id: 1, start_epoch: 0 })!.startedAt).toBeUndefined()
    expect(parseDeviceLogEntry({ id: 1, start_epoch: 1_784_000_000 })!.startedAt).toBe(
      new Date(1_784_000_000_000).toISOString(),
    )
    expect(epochToIso(0)).toBeUndefined()
    expect(epochToIso(-5)).toBeUndefined()
    expect(epochToIso('nope')).toBeUndefined()
  })

  /**
   * The v2 header's batch mass. `0` is the firmware's "not a roast, or mass unknown" - it lives in
   * two former reserved bytes and has no other way to spell absence - so it is treated exactly like
   * a zero epoch: unknown, never a measurement of nothing.
   */
  it('reads the batch mass, and treats the firmware zero as unknown rather than as zero grams', () => {
    expect(parseDeviceLogEntry({ id: '41', version: 2, batch_mass_g: 225 })!.batchMassG).toBe(225)
    expect(parseDeviceLogEntry({ id: '41', version: 2, batchMassG: 225 })!.batchMassG).toBe(225)
    expect(parseDeviceLogEntry({ id: '41', version: 2, batch_mass_g: 0 })!.batchMassG).toBeUndefined()
    expect(parseDeviceLogEntry({ id: '41', version: 2, batch_mass_g: -3 })!.batchMassG).toBeUndefined()
    // A v1 header has no such field at all, and keeps validating.
    expect(parseDeviceLogEntry({ id: '41', version: 1 })!.batchMassG).toBeUndefined()
  })

  it('reads what the controller is recording right now', () => {
    expect(parseDeviceCurrentLog({ active: true, unsaved: false, samples: 120, source: 'calibration' })).toEqual({
      active: true,
      unsaved: false,
      samples: 120,
      mode: 'calibration',
    })
    // A log still in RAM after a roast is normal, not a fault.
    expect(parseDeviceCurrentLog({ active: false, unsaved: true, source: 'manual' })!.unsaved).toBe(true)
    expect(parseDeviceCurrentLog(undefined)).toBeUndefined()
  })

  it('reads the archive block that IS the feature detection', () => {
    expect(
      parseArchiveStorage({ mounted: true, count: 9, used_bytes: 48_000, total_bytes: 1_441_792, clock_synced: false }),
    ).toEqual({ mounted: true, count: 9, usedBytes: 48_000, totalBytes: 1_441_792, clockSynced: false })
    expect(parseArchiveStorage(undefined)).toBeUndefined()
    expect(parseArchiveStorage({ mounted: false })).toMatchObject({ mounted: false })
  })

  it('accepts a list under any of the plausible envelopes', () => {
    const row = { id: 'a', mode: 'manual' }
    expect(parseDeviceLogList([row])).toHaveLength(1)
    expect(parseDeviceLogList({ logs: [row] })).toHaveLength(1)
    expect(parseDeviceLogList({ entries: [row] })).toHaveLength(1)
    expect(parseDeviceLogList({ files: [row] })).toHaveLength(1)
  })

  it('drops an entry it could never fetch, rather than rendering a dead row', () => {
    expect(parseDeviceLogEntry({ boot: 7 })).toBeUndefined()
    expect(parseDeviceLogEntry(null)).toBeUndefined()
    expect(parseDeviceLogEntry('log-1')).toBeUndefined()
    expect(parseDeviceLogList([{ id: 'good', mode: 'manual' }, { nope: true }])).toHaveLength(1)
  })

  it('never throws on nonsense', () => {
    expect(parseDeviceLogList(undefined)).toEqual([])
    expect(parseDeviceLogList('not json')).toEqual([])
    expect(parseDeviceLogList({ logs: 'nope' })).toEqual([])
  })

  it('reads an unrecognised mode as unknown instead of guessing', () => {
    expect(parseDeviceLogEntry({ id: 'a', mode: 'something-new' })!.mode).toBe('unknown')
    expect(parseDeviceLogEntry({ id: 'a' })!.mode).toBe('unknown')
    expect(parseDeviceLogEntry({ id: 'a', mode: 'proof' })!.mode).toBe('proof')
  })

  /** Ids are monotonic across boots, so newest-first needs no clock - which the device may lack. */
  it('orders by descending id, needing no wall clock at all', () => {
    const ordered = orderDeviceLogs([
      { id: '9', mode: 'manual', ...testLogProvenance('9') },
      { id: '12', mode: 'manual', ...testLogProvenance('12') },
      { id: '10', mode: 'calibration', ...testLogProvenance('10') },
    ])
    expect(ordered.map((entry) => entry.id)).toEqual(['12', '10', '9'])
  })
})

describe('coefficients the device reports', () => {
  const app = {
    heaterGainCPerMinAt10: 66,
    fanCoolingCPerMinAt10: 19,
    coolingFanCPerMinAt10: 28,
    thermalLossPerMinPerC: 0.17,
  }

  it('stays undefined on a firmware that reports nothing', () => {
    expect(parseDeviceCoefficients(undefined)).toBeUndefined()
    expect(parseDeviceCoefficients({})).toBeUndefined()
    expect(parseDeviceCoefficients({ unrelated: 1 })).toBeUndefined()
  })

  it('reads the contract block, fit id and applied epoch included', () => {
    expect(
      parseDeviceCoefficients({
        present: true,
        heater_gain: 66,
        fan_cooling: 19,
        cooling_fan: 28,
        loss_per_min: 0.17,
        fit_id: 'fit-abc',
        applied_epoch: 1_784_000_000,
      }),
    ).toMatchObject({
      heaterGainCPerMinAt10: 66,
      fanCoolingCPerMinAt10: 19,
      coolingFanCPerMinAt10: 28,
      thermalLossPerMinPerC: 0.17,
      fitId: 'fit-abc',
    })
  })

  /** `{present: false}` and an absent block mean the same thing: the device holds nothing. */
  it('treats an explicit absence the same as a missing block', () => {
    expect(parseDeviceCoefficients({ present: false })).toBeUndefined()
  })

  /**
   * The firmware sanitizes `fit_id` and echoes what it stored. An id sent outside that alphabet
   * comes back different, and a divergence check comparing them would fire forever.
   */
  it('reduces a fit id to the alphabet that round-trips byte-identically', () => {
    expect(sanitizeFitId('fit-abc123')).toBe('fit-abc123')
    expect(sanitizeFitId('Fitted from roast 20/07 #1')).toBe('Fitted-from-roast-20-07--1')
    expect(sanitizeFitId('a'.repeat(80))).toHaveLength(FIT_ID_MAX)
    expect(sanitizeFitId('ok._:-')).toBe('ok._:-')
  })

  it('reports no divergence when there is nothing to compare', () => {
    expect(coefficientDivergence(undefined, app)).toEqual({ diverged: false, fields: [] })
    expect(coefficientDivergence({ heaterGainCPerMinAt10: 66 }, app).diverged).toBe(false)
  })

  it('flags exactly the coefficients that differ', () => {
    const divergence = coefficientDivergence({ heaterGainCPerMinAt10: 58, thermalLossPerMinPerC: 0.17 }, app)
    expect(divergence.diverged).toBe(true)
    expect(divergence.fields).toEqual([{ field: 'heaterGainCPerMinAt10', device: 58, app: 66 }])
  })

  /** Compared at the precision the firmware serializes at: 3 decimals, and 4 on the loss. */
  it('does not call a faithful round trip a divergence', () => {
    expect(coefficientDivergence({ heaterGainCPerMinAt10: 66.00001 }, app).diverged).toBe(false)
    expect(coefficientDivergence({ thermalLossPerMinPerC: 0.170004 }, app).diverged).toBe(false)
    // But a real difference at the reported precision is a divergence.
    expect(coefficientDivergence({ thermalLossPerMinPerC: 0.1712 }, app).diverged).toBe(true)
    expect(coefficientDivergence({ heaterGainCPerMinAt10: 66.002 }, app).diverged).toBe(true)
  })
})
