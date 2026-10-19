import { describe, expect, it } from 'vitest'
import { recordingKey } from '../domain/provenance'
import type { Profile, RoastRun } from '../domain/types'
import { v4Recording } from '../testFixtures/crk'
import type { ParsedBackup } from './backupFile'
import type { ImportChanges } from './backupImport'
import { applyBackupImport, type ImportDataWriter, requireWholeBackupForRestore } from './backupImportApply'
import { crkCrc32 } from './crkValidator'
import { COLLECTION_CAP_BYTES, RUN_CAP_BYTES, serializeRunDocument } from './documentSerializer'

const recordedOn = {
  deviceId: 'test-device',
  modelId: 'freshroast-sr800',
  displayNameAtCapture: 'Test SR800',
  simulated: true,
  simulatesModelId: 'freshroast-sr800',
  firmwareVersion: 'test',
  identitySource: 'roaster' as const,
}
const origin = (logId: string) => ({ deviceId: recordedOn.deviceId, logId })
const recording = (logId: string, bytes: Uint8Array) => ({
  key: recordingKey(origin(logId)),
  origin: origin(logId),
  storageAddress: origin(logId),
  bytes,
})
const missingRecording = (logId: string, reason: string) => ({
  key: recordingKey(origin(logId)),
  origin: origin(logId),
  storageAddress: origin(logId),
  reason,
})
const deviceRoast = (logId: string) => ({
  recordingOrigin: origin(logId),
  storageAddress: origin(logId),
  name: 'recorded roast',
  dateUnknown: false,
  profileLinked: true,
})
const roast = (id: string, extra: Partial<RoastRun> = {}): RoastRun => ({
  id,
  name: id,
  startedAt: '2026-01-01T00:00:00.000Z',
  profile: {
    id: 'p',
    name: 'P',
    revision: 1,
    strategy: 'timed',
    createdAt: '',
    updatedAt: '',
    metadata: { intent: '' },
    notes: '',
    points: [],
    coolFan: 9,
    coolDurationSec: 60,
  } as Profile,
  notes: '',
  controllerVersion: 'test',
  outcome: 'complete',
  recordedOn,
  samples: [],
  events: [],
  ...extra,
})

const parsedBackup = (whole = true, rawRecordings = new Map<string, Uint8Array>()): ParsedBackup => {
  const recordings = new Map(
    [...rawRecordings].map(([logId, bytes]) => {
      const value = recording(logId, bytes)
      return [value.key, value]
    }),
  )
  return {
    manifest: {
      whole,
      recordings: [...recordings.values()].map(({ bytes: _bytes, ...descriptor }) => descriptor),
    } as ParsedBackup['manifest'],
    collections: {},
    runs: [],
    recordings,
  }
}

const deltaRecording = (headerId: number, payload = Uint8Array.of(0, 0, 0, 0, 0), sampleCount = 1) =>
  v4Recording({ id: headerId, payload, sampleCount })

const backupWithRecording = (manifestId: string, bytes: Uint8Array): ParsedBackup =>
  parsedBackup(true, new Map([[manifestId, bytes]]))

const changes = (overrides: Partial<ImportChanges> = {}): ImportChanges => ({
  profiles: [],
  profileRevisions: [],
  beans: [],
  beanRevisions: [],
  runs: [],
  snapshots: [],
  calibrationPasses: [],
  recordings: [],
  addedDocumentKeys: [],
  replacedDocumentKeys: [],
  addedCount: 0,
  replacedCount: 0,
  keptCount: 0,
  ...overrides,
})

const writer = (overrides: Partial<ImportDataWriter> = {}): ImportDataWriter => ({
  saveProfile: async () => {},
  saveProfileRevision: async () => {},
  saveBean: async () => {},
  saveBeanRevision: async () => {},
  saveRun: async () => {},
  saveCalibrationSnapshot: async () => {},
  saveCalibrationRun: async () => {},
  flushPending: async () => {},
  syncState: () => ({ queued: 0 }),
  ...overrides,
})

describe('applying a backup import', () => {
  it('uses the firmware archive CRC32 wire format', () => {
    expect(crkCrc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('routes partial exports to Import instead of destructive Restore', () => {
    expect(() => requireWholeBackupForRestore(parsedBackup(false))).toThrow(/partial export.*Use Import/)
    expect(() => requireWholeBackupForRestore(parsedBackup(true))).not.toThrow()
  })

  it('refuses execution preflight when the connected controller has no stable identity', () => {
    expect(() => requireWholeBackupForRestore(parsedBackup(true), { totalBytes: 800_000 })).toThrow(
      /stable device and model identity.*before anything was erased/i,
    )
  })

  it('refuses a restore onto a different roaster model before erasing anything', () => {
    const backup = parsedBackup(true)
    backup.manifest.device = { deviceId: 'source', modelId: 'freshroast-sr800', displayName: 'FreshRoast SR800' }
    expect(() =>
      requireWholeBackupForRestore(backup, {
        identity: { deviceId: 'target', modelId: 'other-model', displayName: 'Other roaster', simulated: false },
      }),
    ).toThrow(/not the connected Other roaster.*before anything was erased/i)
  })

  it('refuses a whole backup that names recordings it could not capture', () => {
    const backup = parsedBackup(true)
    backup.manifest.missingRecordings = [
      missingRecording('4', 'read failed'),
      missingRecording('9', 'the roaster did not answer'),
    ]
    expect(() => requireWholeBackupForRestore(backup)).toThrow(
      /missing 2 recordings \(test-device #4, test-device #9\).*use Import/i,
    )
  })

  it('accepts a firmware-valid recording before destructive restore', () => {
    expect(() => requireWholeBackupForRestore(backupWithRecording('41', deltaRecording(41)))).not.toThrow()
  })

  it('refuses a manifest origin that disagrees with the immutable archive header', () => {
    const backup = backupWithRecording('41', deltaRecording(41))
    const descriptor = backup.manifest.recordings![0]
    descriptor.origin = { deviceId: 'claimed-other-device', logId: '41' }
    expect(() => requireWholeBackupForRestore(backup)).toThrow(
      /claimed-other-device #41 does not match the immutable origin.*test-device #41.*before anything was erased/i,
    )
  })
  it('refuses a recording whose archive header carries another id before destructive restore', () => {
    expect(() => requireWholeBackupForRestore(backupWithRecording('41', deltaRecording(42)))).toThrow(
      /Recording test-device #41 failed log_id.*header carries id 42.*before anything was erased/i,
    )
  })

  it('refuses a corrupted recording before destructive restore', () => {
    const bytes = deltaRecording(41)
    bytes[bytes.length - 1] ^= 1
    expect(() => requireWholeBackupForRestore(backupWithRecording('41', bytes))).toThrow(
      /Recording test-device #41 failed crc_mismatch.*checksum.*before anything was erased/i,
    )
  })

  it('refuses a checksummed but malformed delta stream before destructive restore', () => {
    const bytes = deltaRecording(41, Uint8Array.of(0x80))
    expect(() => requireWholeBackupForRestore(backupWithRecording('41', bytes))).toThrow(
      /Recording test-device #41 failed payload_undecodable.*does not decode.*before anything was erased/i,
    )
  })

  it('refuses documents above the firmware caps before destructive restore', () => {
    const collection = parsedBackup(true)
    collection.collections.profiles = 'x'.repeat(COLLECTION_CAP_BYTES + 1)
    expect(() => requireWholeBackupForRestore(collection)).toThrow(
      /profiles document.*accepts at most 12288.*before anything was erased/i,
    )

    const run = parsedBackup(true)
    run.runs = [{ id: 'large', payload: 'x'.repeat(RUN_CAP_BYTES + 1) }]
    expect(() => requireWholeBackupForRestore(run)).toThrow(
      /Roast record.*accepts at most 8192.*before anything was erased/i,
    )
  })

  it('refuses implausible applied coefficients before destructive restore', () => {
    const backup = parsedBackup(true)
    backup.appliedCalibration = {
      present: true,
      coefficients: {
        heaterGainCPerMinAt10: 0.01,
        fanCoolingCPerMinAt10: 19,
        coolingFanCPerMinAt10: 28,
        thermalLossPerMinPerC: 0.17,
      },
    }
    expect(() => requireWholeBackupForRestore(backup)).toThrow(
      /not safe.*heaterGainCPerMinAt10.*not physically plausible.*before anything was erased/i,
    )
  })

  it('refuses a legacy roast record with neither its referenced recording nor a fallback curve', () => {
    const backup = parsedBackup(true)
    backup.runs = [
      {
        id: 'linked',
        payload: serializeRunDocument(roast('linked', { name: 'Linked', deviceRoast: deviceRoast('41') })),
      },
    ]
    expect(() => requireWholeBackupForRestore(backup)).toThrow(
      /Linked.*recording test-device #41.*neither.*fallback curve.*before anything was erased/i,
    )
  })

  it('accepts a roast whose recording was intentionally pruned when its fallback curve remains', () => {
    const backup = parsedBackup(true)
    backup.runs = [
      {
        id: 'fallback',
        payload: serializeRunDocument(
          roast('fallback', {
            name: 'Fallback roast',
            deviceRoast: deviceRoast('41'),
            samples: [
              {
                elapsedSec: 0,
                beanTempC: 25,
                rorCPerMin: 0,
                requestedFan: 4,
                effectiveFan: 4,
                requestedHeat: 5,
                effectiveHeat: 5,
                phase: 'DRYING',
              },
            ],
          }),
        ),
      },
    ]
    expect(() => requireWholeBackupForRestore(backup)).not.toThrow()
  })
  it('uses measured source footprint and refuses a restore that cannot preserve the target floor', () => {
    const measuredTooLarge = parsedBackup(true)
    measuredTooLarge.manifest.device = {
      deviceId: 'test-device',
      modelId: 'freshroast-sr800',
      displayName: 'Test SR800',
      usedBytes: 710_000,
      totalBytes: 1_400_000,
    }
    expect(() =>
      requireWholeBackupForRestore(measuredTooLarge, {
        totalBytes: 800_000,
        writeFloorBytes: 218_408,
        identity: { deviceId: 'target', modelId: 'freshroast-sr800', displayName: 'Test SR800', simulated: false },
      }),
    ).toThrow(/conservatively needs.*before anything was erased/i)

    const largerButSparse = parsedBackup(true)
    largerButSparse.manifest.device = {
      deviceId: 'test-device',
      modelId: 'freshroast-sr800',
      displayName: 'Test SR800',
      usedBytes: 100_000,
      totalBytes: 1_400_000,
    }
    expect(() =>
      requireWholeBackupForRestore(largerButSparse, {
        totalBytes: 800_000,
        writeFloorBytes: 218_408,
        identity: { deviceId: 'target', modelId: 'freshroast-sr800', displayName: 'Test SR800', simulated: false },
      }),
    ).not.toThrow()

    const noHeadroom = parsedBackup(true)
    noHeadroom.manifest.device = { deviceId: 'test-device', modelId: 'freshroast-sr800', displayName: 'Test SR800' }
    expect(() =>
      requireWholeBackupForRestore(noHeadroom, {
        totalBytes: 200_000,
        writeFloorBytes: 218_408,
        identity: { deviceId: 'target', modelId: 'freshroast-sr800', displayName: 'Test SR800', simulated: false },
      }),
    ).toThrow(/conservatively needs.*before anything was erased/i)
  })

  it('does nothing when a required recording cannot be restored safely right now', async () => {
    const calls: string[] = []
    await expect(
      applyBackupImport(
        changes({ recordings: [recordingKey(origin('1'))], profiles: [{ id: 'p', name: 'Profile' } as Profile] }),
        parsedBackup(true, new Map([['1', Uint8Array.from([1, 2, 3])]])),
        {
          restoreDeviceLog: async () => {
            calls.push('recording')
            return { ok: true, storageAddress: origin('101'), recordingOrigin: origin('1') }
          },
        },
        writer({
          saveProfile: async () => {
            calls.push('profile')
          },
        }),
        false,
      ),
    ).rejects.toThrow(/connected.*fully stopped/)
    expect(calls).toEqual([])
  })

  it('names a recording refusal and skips only the run that depends on it', async () => {
    const savedRuns: string[] = []
    const linked = roast('linked', { name: 'Linked roast', deviceRoast: deviceRoast('1') })
    const independent = roast('independent', { name: 'Independent roast' })
    const outcome = await applyBackupImport(
      changes({ recordings: [recordingKey(origin('1'))], runs: [linked, independent] }),
      parsedBackup(true, new Map([['1', Uint8Array.from([0, 1, 0])]])),
      { restoreDeviceLog: async () => ({ ok: false, message: 'Rejected: checksum did not match.' }) },
      writer({
        saveRun: async (run) => {
          savedRuns.push(run.id)
        },
      }),
      true,
    )

    expect(savedRuns).toEqual(['independent'])
    expect(outcome.skippedRunIds).toEqual(['linked'])
    expect(outcome.failures).toEqual([
      { what: 'recording test-device #1', message: 'Rejected: checksum did not match.' },
    ])
  })

  it('keeps a fallback-backed run when its full recording restore is refused', async () => {
    const savedRuns: string[] = []
    const linked = roast('linked', {
      name: 'Linked roast',
      deviceRoast: deviceRoast('1'),
      samples: [{ elapsedSec: 0 } as never],
    })
    const outcome = await applyBackupImport(
      changes({ recordings: [recordingKey(origin('1'))], runs: [linked] }),
      parsedBackup(true, new Map([['1', Uint8Array.from([0, 1, 0])]])),
      { restoreDeviceLog: async () => ({ ok: false, message: 'volume reserve' }) },
      writer({
        saveRun: async (run) => {
          savedRuns.push(run.id)
        },
      }),
      true,
    )

    expect(savedRuns).toEqual(['linked'])
    expect(outcome.skippedRunIds).toEqual([])
    expect(outcome.failures).toEqual([{ what: 'recording test-device #1', message: 'volume reserve' }])
  })

  it('waits for every save before flushing and reporting completion', async () => {
    const order: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const applying = applyBackupImport(
      changes({ profiles: [{ id: 'p', name: 'Profile' } as Profile], addedDocumentKeys: ['profile:p'] }),
      parsedBackup(),
      { restoreDeviceLog: async () => ({ ok: true }) },
      writer({
        saveProfile: async () => {
          order.push('save-start')
          await gate
          order.push('save-end')
        },
        flushPending: async () => {
          order.push('flush')
        },
      }),
      true,
    )

    await Promise.resolve()
    expect(order).toEqual(['save-start'])
    release?.()
    const outcome = await applying
    expect(order).toEqual(['save-start', 'save-end', 'flush'])
    expect(outcome.documentsSaved).toBe(1)
    expect(outcome.addedDocumentsSaved).toBe(1)
  })

  it('does not count a rejected document save as added or replaced', async () => {
    const outcome = await applyBackupImport(
      changes({
        profiles: [{ id: 'p', name: 'Profile' } as Profile],
        addedDocumentKeys: ['profile:p'],
      }),
      parsedBackup(),
      { restoreDeviceLog: async () => ({ ok: true }) },
      writer({
        saveProfile: async () => {
          throw new Error('cache full')
        },
      }),
      true,
    )
    expect(outcome).toMatchObject({ documentsSaved: 0, addedDocumentsSaved: 0, replacedDocumentsSaved: 0 })
    expect(outcome.failures[0]).toMatchObject({ what: 'profile “Profile”', message: 'cache full' })
  })
})
