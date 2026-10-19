import { describe, expect, it } from 'vitest'
import { recordingKey } from '../domain/provenance'
import type { BeanLot, Profile, RoastRun } from '../domain/types'
import { type BackupSource, buildBackup, type ParsedBackup, parseBackup } from './backupFile'
import {
  incompleteRestoreMessage,
  type RestoreClient,
  restoreBackup,
  restoreLeftDocumentsMissing,
} from './backupRestore'
import type { DocumentWrite } from './deviceStore'
import type { DocumentTarget } from './documentSerializer'
import {
  parseMetaDocument,
  serializeBeansDocument,
  serializeCalibrationsDocument,
  serializeMetaDocument,
  serializeProfilesDocument,
  serializeRunDocument,
} from './documentSerializer'

/**
 * ============================================================================================
 * THE RESTORE SEQUENCE, AND WHAT SURVIVES A FAILURE IN THE MIDDLE OF IT
 * ============================================================================================
 *
 * The firmware's half is stateless on purpose - a restore is N independent, individually confirmed
 * writes, and a failure at N-1 leaves the N-2 that succeeded exactly as they landed. That makes the
 * browser's half responsible for two things this file pins:
 *
 *   1. **The ORDER.** Erase, then ordinary collections, recordings, run documents, meta, then the
 *      calibration. Recordings before their roast records, so a roast never lands pointing at a
 *      recording that is not there yet. Everything at `base=0`, which after a format is the only
 *      base that can be right.
 *   2. **What is fatal and what is not.** Only the erase. If the volume was not erased, everything
 *      after it would be writing at the wrong base against documents that still exist. Every other
 *      failure is counted, named, and does not stop the rest - twenty-two recordings restored plus
 *      one named failure beats a restore that stopped at the ninth. Deterministic raw upload
 *      refusals are not uploaded twice.
 */

const profile = (id: string, name: string): Profile =>
  ({
    id,
    name,
    revision: 1,
    strategy: 'timed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metadata: { intent: '' },
    notes: '',
    points: [],
    coolFan: 9,
    coolDurationSec: 60,
  }) as Profile

const bean = (id: string, name: string): BeanLot => ({
  id,
  name,
  origins: [],
  cultivars: [],
  notes: '',
  createdAt: '',
  updatedAt: '',
})
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
const targetAddress = (logId: string) => ({ deviceId: 'restore-target', logId })
const deviceRoast = (logId: string) => ({
  recordingOrigin: origin(logId),
  storageAddress: origin(logId),
  name: 'recorded roast',
  dateUnknown: false,
  profileLinked: true,
})
const backupRecording = (logId: string, bytes: Uint8Array) => ({
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

const run = (id: string): RoastRun =>
  ({
    id,
    name: `Roast ${id}`,
    startedAt: '2026-03-03T09:00:00.000Z',
    profile: profile('profile-1', 'House espresso'),
    notes: '',
    controllerVersion: 'mock',
    outcome: 'complete',
    recordedOn,
    samples: [],
    events: [],
  }) as RoastRun

const backup = (overrides: Partial<BackupSource> = {}): ParsedBackup => {
  const source: BackupSource = {
    createdAt: '2026-07-28T10:00:00.000Z',
    deviceId: 'test-device',
    modelId: 'freshroast-sr800',
    deviceDisplayName: 'Test SR800',
    appVersion: '0.10.0',
    types: ['profiles', 'beans', 'runs', 'calibrations'],
    collections: {
      profiles: serializeProfilesDocument([profile('p1', 'House espresso')], []),
      beans: serializeBeansDocument([bean('b1', 'Huila')], []),
      calibrations: serializeCalibrationsDocument(undefined, [], []),
      meta: serializeMetaDocument([recordingKey(origin('1')), recordingKey(origin('2'))], []),
    },
    runs: [
      { id: 'run-a', payload: serializeRunDocument(run('run-a')) },
      { id: 'run-b', payload: serializeRunDocument(run('run-b')) },
    ],
    recordings: [
      backupRecording('1', Uint8Array.from([1, 2, 3, 0, 5])),
      backupRecording('2', Uint8Array.from([9, 8, 7])),
    ],
    missingRecordings: [],
    appliedCalibration: {
      heaterGainCPerMinAt10: 66,
      fanCoolingCPerMinAt10: 19,
      coolingFanCPerMinAt10: 28,
      thermalLossPerMinPerC: 0.17,
      fitId: 'fit-2026-07-27',
    },
    ...overrides,
  }
  return parseBackup(buildBackup(source).bytes)
}

interface Recorder {
  client: RestoreClient
  steps: string[]
  written: Map<string, { payload: string; base: number }>
  uploaded: Map<string, Uint8Array>
}

const recorder = (
  fail: {
    format?: boolean
    document?: (target: DocumentTarget) => DocumentWrite | undefined
    /** Answers per attempt for one recording id, consumed in order. */
    recording?: Record<string, boolean[]>
    calibration?: boolean
  } = {},
): Recorder => {
  const steps: string[] = []
  const written = new Map<string, { payload: string; base: number }>()
  const uploaded = new Map<string, Uint8Array>()
  const attempts: Record<string, number> = {}
  let restoreIndex = 0
  return {
    steps,
    written,
    uploaded,
    client: {
      formatDeviceStorage: async () => {
        steps.push('format')
        return fail.format === true ? { ok: false, message: 'busy' } : { ok: true }
      },
      writeDocument: async (target, payload, base) => {
        steps.push(`write ${target}`)
        const refusal = fail.document?.(target)
        if (refusal) return refusal
        written.set(target, { payload, base })
        return { kind: 'ok', version: 1 }
      },
      restoreDeviceLog: async (_id, bytes) => {
        const sourceLogId = String(++restoreIndex)
        steps.push(`recording ${sourceLogId}`)
        const answers = fail.recording?.[sourceLogId]
        const attempt = attempts[sourceLogId] ?? 0
        attempts[sourceLogId] = attempt + 1
        if (answers && answers[attempt] === false) return { ok: false, message: 'volume reserve' }
        uploaded.set(sourceLogId, bytes)
        return { ok: true, recordingOrigin: origin(sourceLogId), storageAddress: targetAddress(sourceLogId) }
      },
      applyCalibration: async () => {
        steps.push('calibration')
        return fail.calibration === true ? { ok: false, message: 'refused' } : { ok: true }
      },
      clearDeviceCalibration: async () => {
        steps.push('clear calibration')
        return { ok: true }
      },
    },
  }
}

describe('the restore sequence', () => {
  it('erases first, then ordinary collections, recordings, run documents, meta, and calibration', async () => {
    const device = recorder()
    await restoreBackup(backup(), device.client)
    expect(device.steps).toEqual([
      'format',
      'write profiles',
      'write beans',
      'write calibrations',
      'recording 1',
      'recording 2',
      'write runs/run-a',
      'write runs/run-b',
      'write meta',
      'calibration',
    ])
  })

  /** After a format nothing exists, and `base=0` is the firmware's "this must not exist". */
  it('writes every document at base 0', async () => {
    const device = recorder()
    await restoreBackup(backup(), device.client)
    for (const entry of device.written.values()) expect(entry.base).toBe(0)
  })

  it('puts back the documents and the recordings byte for byte', async () => {
    const device = recorder()
    const file = backup()
    await restoreBackup(file, device.client)
    expect(device.written.get('profiles')?.payload).toBe(file.collections.profiles)
    expect(device.written.get('runs/run-a')?.payload).toBe(file.runs[0].payload)
    expect([...(device.uploaded.get('1') ?? [])]).toEqual([1, 2, 3, 0, 5])
  })

  it('counts a clean restore and says so in one sentence', async () => {
    const outcome = await restoreBackup(backup(), recorder().client)
    expect(outcome).toMatchObject({ collections: 4, runs: 2, recordings: 2, calibration: 'applied', failures: [] })
    expect(outcome.message).toContain('Restored 4 documents, 2 roast records and 2 recordings')
    expect(outcome.message).toContain("applied the backup's calibration")
  })

  it('reports a progress line per step, naming which recording is in flight', async () => {
    const lines: string[] = []
    await restoreBackup(backup(), recorder().client, (line) => lines.push(line))
    expect(lines[0]).toBe('erasing the roaster')
    expect(lines).toContain('restoring recording 1 of 2')
    expect(lines).toContain('restoring recording 2 of 2')
    expect(lines).toContain('restoring roast record 2 of 2')
  })

  /** A roaster that held no applied set is a fact the backup carries, and restoring it means clearing. */
  it('clears the applied calibration when the backup says there was none', async () => {
    const device = recorder()
    const outcome = await restoreBackup(backup({ appliedCalibration: undefined }), device.client)
    expect(device.steps).toContain('clear calibration')
    expect(outcome.calibration).toBe('cleared')
  })
})

describe('when something goes wrong part-way through', () => {
  /**
   * The one fatal step. Everything after a refused erase would be writing at `base=0` against
   * documents that still exist, so it throws rather than producing a half-restored volume plus a
   * report saying so.
   */
  it('stops dead if the roaster would not erase, and touches nothing else', async () => {
    const device = recorder({ format: true })
    await expect(restoreBackup(backup(), device.client)).rejects.toThrow(/busy/)
    expect(device.steps).toEqual(['format'])
    expect(device.written.size).toBe(0)
  })

  it('does not retry a recording refusal, and continues with the remaining recordings', async () => {
    const device = recorder({ recording: { 1: [false, true] } })
    const outcome = await restoreBackup(backup(), device.client)
    expect(device.steps.filter((step) => step === 'recording 1')).toHaveLength(1)
    expect(device.steps.filter((step) => step === 'recording 2')).toHaveLength(1)
    expect(outcome.recordings).toBe(1)
    expect(outcome.failures).toEqual([
      { kind: 'recording', what: 'recording test-device #1', message: 'volume reserve' },
    ])
  })

  /**
   * One refusal is an answer rather than a moment to retry blindly. It is named at the end and the
   * others carry on - the whole reason the firmware's half is per-recording and stateless.
   */
  it('names a recording that failed, and restores the rest anyway', async () => {
    const device = recorder({ recording: { 1: [false, false] } })
    const outcome = await restoreBackup(backup(), device.client)
    expect(device.steps.filter((step) => step === 'recording 1')).toHaveLength(1)
    expect(outcome.recordings).toBe(1)
    expect(outcome.failures).toEqual([
      { kind: 'recording', what: 'recording test-device #1', message: 'volume reserve' },
    ])
    expect(outcome.message).toContain('1 item could not be written: recording test-device #1 (volume reserve)')
    // And every document still landed. A refused recording is not a reason to abandon the library.
    expect(outcome.collections).toBe(4)
    expect(outcome.runs).toBe(2)
  })

  it('does not write a roast record when its referenced recording failed', async () => {
    const linked = { ...run('linked'), deviceRoast: deviceRoast('1') } as RoastRun
    const independent = run('independent')
    const device = recorder({ recording: { 1: [false] } })
    const outcome = await restoreBackup(
      backup({
        runs: [
          { id: linked.id, payload: serializeRunDocument(linked) },
          { id: independent.id, payload: serializeRunDocument(independent) },
        ],
      }),
      device.client,
    )

    expect(device.written.has('runs/linked')).toBe(false)
    expect(device.written.has('runs/independent')).toBe(true)
    expect(outcome.runs).toBe(1)
    expect(outcome.failures).toContainEqual({
      kind: 'recording',
      what: 'the roast record "linked"',
      message: 'its recording test-device #1 was not restored',
    })
  })

  it('restores a roast whose full recording was already absent when the backup was made', async () => {
    const linked = {
      ...run('fallback-only'),
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
          phase: 'DRYING' as const,
        },
      ],
    } as RoastRun
    const device = recorder()
    const outcome = await restoreBackup(
      backup({
        runs: [{ id: linked.id, payload: serializeRunDocument(linked) }],
        recordings: [],
        missingRecordings: [missingRecording('41', 'the recording had already been pruned')],
      }),
      device.client,
    )

    expect(device.written.has('runs/fallback-only')).toBe(true)
    expect(outcome.runs).toBe(1)
    expect(outcome.failures).toEqual([])
  })

  it('restores a fallback-backed roast even when its included recording is refused', async () => {
    const linked = {
      ...run('fallback-after-refusal'),
      deviceRoast: deviceRoast('1'),
      samples: [
        {
          elapsedSec: 0,
          beanTempC: 25,
          rorCPerMin: 0,
          requestedFan: 4,
          effectiveFan: 4,
          requestedHeat: 5,
          effectiveHeat: 5,
          phase: 'DRYING' as const,
        },
      ],
    } as RoastRun
    const device = recorder({ recording: { 1: [false] } })
    const outcome = await restoreBackup(
      backup({
        runs: [{ id: linked.id, payload: serializeRunDocument(linked) }],
      }),
      device.client,
    )

    expect(device.written.has('runs/fallback-after-refusal')).toBe(true)
    expect(outcome.runs).toBe(1)
    expect(outcome.failures).toContainEqual({
      kind: 'recording',
      what: 'recording test-device #1',
      message: 'volume reserve',
    })
  })

  it('removes only a newly restored recording whose run write failed from the final ledger', async () => {
    const linkedOne = { ...run('linked-one'), deviceRoast: deviceRoast('1') } as RoastRun
    const linkedTwo = { ...run('linked-two'), deviceRoast: deviceRoast('2') } as RoastRun
    const file = backup()
    file.collections.meta = serializeMetaDocument(
      [recordingKey(origin('1')), recordingKey(origin('2')), recordingKey(origin('99'))],
      [],
    )
    file.runs = [
      { id: linkedOne.id, payload: serializeRunDocument(linkedOne) },
      { id: linkedTwo.id, payload: serializeRunDocument(linkedTwo) },
    ]
    const device = recorder({
      document: (target) =>
        target === 'runs/linked-one' ? { kind: 'no-space', message: 'run document did not fit' } : undefined,
    })

    const outcome = await restoreBackup(file, device.client)

    expect(outcome.recordings).toBe(2)
    expect(outcome.runs).toBe(1)
    expect(device.steps.indexOf('write meta')).toBeGreaterThan(device.steps.indexOf('write runs/linked-two'))
    const restoredMeta = device.written.get('meta')?.payload
    expect(restoredMeta).toBeDefined()
    expect(parseMetaDocument(restoredMeta ?? '').importedDeviceLogs).toEqual([
      recordingKey(origin('2')),
      recordingKey(origin('99')),
    ])
    expect(outcome.failures).toContainEqual({
      kind: 'document',
      what: 'the roast record "linked-one"',
      message: 'run document did not fit',
    })
  })

  it('names a document the roaster refused, in the roaster words rather than in a code', async () => {
    const device = recorder({
      document: (target) =>
        target === 'beans' ? { kind: 'no-space', message: 'the roaster is out of room' } : undefined,
    })
    const outcome = await restoreBackup(backup(), device.client)
    expect(outcome.collections).toBe(3)
    expect(outcome.failures).toEqual([
      { kind: 'document', what: 'the beans document', message: 'the roaster is out of room' },
    ])
    expect(outcome.message).toContain('the beans document (the roaster is out of room)')
  })

  /**
   * A partial library must never be committed as the roaster's authoritative one: any DOCUMENT that
   * failed after the erase makes the restore incomplete, and the caller refuses to commit.
   */
  it('marks a restore with a failed document write as incomplete, naming what failed', async () => {
    const device = recorder({
      document: (target) => (target === 'beans' ? { kind: 'busy', message: 'storage busy' } : undefined),
    })
    const outcome = await restoreBackup(backup(), device.client)
    expect(restoreLeftDocumentsMissing(outcome)).toEqual([
      { kind: 'document', what: 'the beans document', message: 'storage busy' },
    ])
    const message = incompleteRestoreMessage(outcome)
    expect(message).toContain('not committed')
    expect(message).toContain('the beans document (storage busy)')
  })

  it('does not treat a refused recording or calibration as a missing document', async () => {
    const recordingOnly = await restoreBackup(backup(), recorder({ recording: { 1: [false] } }).client)
    expect(recordingOnly.failures.length).toBeGreaterThan(0)
    expect(restoreLeftDocumentsMissing(recordingOnly)).toEqual([])
    const calibrationOnly = await restoreBackup(backup(), recorder({ calibration: true }).client)
    expect(restoreLeftDocumentsMissing(calibrationOnly)).toEqual([])
    const clean = await restoreBackup(backup(), recorder().client)
    expect(restoreLeftDocumentsMissing(clean)).toEqual([])
  })

  it('reports a refused calibration without pretending the rest did not happen', async () => {
    const outcome = await restoreBackup(backup(), recorder({ calibration: true }).client)
    expect(outcome.calibration).toBe('failed')
    expect(outcome.runs).toBe(2)
    expect(outcome.message).toContain('the applied calibration (refused)')
  })
})

describe('the format completion signal', () => {
  it('fires exactly once immediately after format, before a later refused write', async () => {
    const device = recorder({
      document: (target) => (target === 'profiles' ? { kind: 'no-space', message: 'full' } : undefined),
    })

    await restoreBackup(backup(), device.client, undefined, () => device.steps.push('formatted'))

    expect(device.steps.slice(0, 3)).toEqual(['format', 'formatted', 'write profiles'])
    expect(device.steps.filter((step) => step === 'formatted')).toHaveLength(1)
  })

  it('remains fired exactly once when a later write throws', async () => {
    const device = recorder()
    device.client.writeDocument = async (target) => {
      device.steps.push(`write ${target}`)
      throw new Error('transport broke')
    }

    await expect(
      restoreBackup(backup(), device.client, undefined, () => device.steps.push('formatted')),
    ).rejects.toThrow(/transport broke/)

    expect(device.steps).toEqual(['format', 'formatted', 'write profiles'])
    expect(device.steps.filter((step) => step === 'formatted')).toHaveLength(1)
  })

  it('never fires when format is refused', async () => {
    const device = recorder({ format: true })
    let formatted = 0

    await expect(
      restoreBackup(backup(), device.client, undefined, () => {
        formatted += 1
      }),
    ).rejects.toThrow(/busy/)

    expect(formatted).toBe(0)
    expect(device.steps).toEqual(['format'])
  })
})
