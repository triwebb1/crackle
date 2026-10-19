import { describe, expect, it } from 'vitest'
import { starterBean, starterProfile, starterThermalIntent } from '../data/demo'
import { v4Recording } from '../testFixtures/crk'
import { testLogProvenance, testRecordingOrigin, testStorageAddress } from '../testFixtures/provenance'
import type { DeviceLogEntry } from './deviceLogs'
import * as deviceRoastImport from './deviceRoastImport'
import {
  attainmentAnnotations,
  deviceRoastRun,
  deviceRoastSamples,
  deviceRunId,
  duplicateRecordingMerges,
  importableDeviceRoasts,
  matchProfileByName,
  orphanedStagedRunNote,
  orphanedStagedRuns,
  profileFromArchivedPlan,
  reconcileManualArchiveRun,
  reconcileProfiledArchiveRun,
  SAME_BOOT_START_WINDOW_MS,
  unlinkedProfile,
  withStagedProfileIdentity,
} from './deviceRoastImport'
import { provisionalDeviceRoastRun } from './deviceRoastStart'
import { recordingKey } from './provenance'
import { thermalCsvHeader } from './thermalLog'
import type { Profile, RoastRun } from './types'

const IMPORTED_AT = Date.UTC(2026, 6, 27, 18, 30, 0)

/** A 1 Hz recording: a climb under heat, then a cooling tail with the element off. */
const csv = (rows: Array<[number, number | '', number, number]>) =>
  [thermalCsvHeader, ...rows.map(([tMs, tc, fan, heat]) => `${tMs},${tc},24.5,${fan},${heat}`)].join('\n')

const climb = csv([
  [0, 24.6, 8, 6],
  [1000, 30.2, 8, 6],
  [2000, 40.9, 8, 6],
  [3000, 55.4, 8, 7],
  [4000, 70.1, 8, 7],
  [5000, 90.5, 8, 7],
  [6000, 120.3, 9, 0],
  [7000, 100.1, 9, 0],
])

const entry = (overrides: Partial<DeviceLogEntry> = {}): DeviceLogEntry => ({
  id: '41',
  bootId: '7',
  mode: 'roast',
  version: 2,
  name: 'Gentle espresso journey',
  samples: 8,
  intervalMs: 1000,
  durationSec: 7,
  startedAt: '2026-07-27T09:15:00.000Z',
  zoneCount: 3,
  zoneAttainedSec: [120, 305, null],
  ...testLogProvenance(String(overrides.id ?? '41')),
  ...overrides,
})

const key = (logId: string) => recordingKey(testRecordingOrigin(logId))

const library: Profile[] = [starterProfile, starterThermalIntent]

describe('which recordings are worth importing', () => {
  const logs: DeviceLogEntry[] = [
    entry({ id: '43' }),
    entry({ id: '42', mode: 'calibration', name: undefined }),
    entry({ id: '41' }),
    entry({ id: '40', mode: 'manual', name: undefined }),
  ]

  it('takes roast-source recordings and leaves standalone manual diagnostics alone', () => {
    expect(importableDeviceRoasts(logs, []).map((row) => row.id)).toEqual(['43', '41'])
  })

  /**
   * The idempotency property, stated as a property. Re-visiting History runs this again with the
   * ledger from the first run, and it must come back empty.
   */
  it('returns nothing on a second pass, which is what makes revisiting History a no-op', () => {
    const first = importableDeviceRoasts(logs, [])
    const ledger = first.map((row) => key(row.id))
    expect(importableDeviceRoasts(logs, ledger)).toEqual([])
    // And a recording that appears later is still picked up: the ledger is a filter, not a cutoff.
    expect(importableDeviceRoasts([entry({ id: '44' }), ...logs], ledger).map((row) => row.id)).toEqual(['44'])
  })

  it('never touches the recording that is still being written', () => {
    expect(importableDeviceRoasts(logs, [], '43').map((row) => row.id)).toEqual(['41'])
  })

  it('leaves reboot-surviving plan-only provisional roasts in the device listing, not History', () => {
    const provisional = entry({ id: '44', samples: 0, roastEndReason: undefined })
    const completedWithoutSamples = entry({ id: '45', samples: 0, roastEndReason: 'stopped' })
    expect(importableDeviceRoasts([provisional, completedWithoutSamples], []).map((row) => row.id)).toEqual(['45'])
  })
})

describe('the samples reconstructed from the CSV', () => {
  it('rebases the clock, carries effective levels as requested levels, and derives rate of rise', () => {
    const samples = deviceRoastSamples(climb)
    expect(samples).toHaveLength(8)
    expect(samples[0].elapsedSec).toBe(0)
    expect(samples.at(-1)?.elapsedSec).toBe(7)
    // The log records EFFECTIVE levels and nothing else, so requested is set equal rather than
    // invented - the gap between the two is a firmware floor, not something to manufacture.
    expect(samples[0].requestedFan).toBe(samples[0].effectiveFan)
    expect(samples[0].requestedHeat).toBe(samples[0].effectiveHeat)
    expect(samples[0].rorCPerMin).toBe(0)
    expect(samples[2].rorCPerMin).toBeCloseTo(((40.9 - 24.6) / 2) * 60, 5)
  })

  /** Phase comes from the actuator history, never from an annotation - see `eventPolicy.test.ts`. */
  it('marks the trailing heat-off run as the cooling tail and nothing earlier', () => {
    const samples = deviceRoastSamples(climb)
    expect(samples.map((sample) => sample.phase)).toEqual([
      'DRYING',
      'DRYING',
      'DRYING',
      'DRYING',
      'DRYING',
      'DRYING',
      'COOLING',
      'COOLING',
    ])
  })

  /**
   * A faulted row has no temperature, and `TelemetrySample.beanTempC` has no way to say "missing".
   * Dropping it is the only option that does not put a fabricated reading into the archive.
   */
  it('drops a faulted row rather than carrying a substitute reading', () => {
    const samples = deviceRoastSamples(
      csv([
        [0, 24.6, 8, 6],
        [1000, '', 8, 6],
        [2000, 40.9, 8, 6],
      ]),
    )
    expect(samples).toHaveLength(2)
    expect(samples.every((sample) => Number.isFinite(sample.beanTempC))).toBe(true)
    expect(samples.some((sample) => sample.beanTempC === 0)).toBe(false)
  })

  it('produces nothing at all from an empty recording', () => {
    expect(deviceRoastSamples('')).toEqual([])
    expect(deviceRoastSamples(thermalCsvHeader)).toEqual([])
  })
})

describe('zone attainments become annotations', () => {
  it('records where each boundary actually fell, and says so when one never did', () => {
    const events = attainmentAnnotations([120, 305, null])
    expect(events.map((event) => event.label)).toEqual([
      'Zone 1 attained',
      'Zone 2 attained',
      'Zone 3 never reached its endpoint',
    ])
    expect(events[1].elapsedSec).toBe(305)
    // A zone that never arrived did not arrive at second 0, and is not drawn as if it had.
    expect(events[2].elapsedSec).toBe(0)
    // Annotations, never inputs: they carry no type any model reads.
    expect(events.every((event) => event.type === 'SYSTEM')).toBe(true)
  })

  it('has nothing to say about a timed roast, which has no zones', () => {
    expect(attainmentAnnotations(undefined)).toEqual([])
    expect(attainmentAnnotations([])).toEqual([])
  })
})

describe('linking a recording to the profile it ran', () => {
  it('matches on the exact sanitized name', () => {
    expect(matchProfileByName(library, 'Gentle espresso journey')?.id).toBe(starterThermalIntent.id)
    expect(matchProfileByName(library, 'House espresso')?.id).toBe(starterProfile.id)
  })

  it('refuses anything that is not exactly one match', () => {
    expect(matchProfileByName(library, 'Gentle espresso')).toBeUndefined()
    expect(matchProfileByName(library, undefined)).toBeUndefined()
    // Two profiles that sanitize to the same name are ambiguous by construction, so neither wins.
    const twin: Profile = { ...starterProfile, id: 'twin', name: 'House espresso' }
    expect(matchProfileByName([...library, twin], 'House espresso')).toBeUndefined()
  })

  it('gives an unmatched recording an inert placeholder rather than a borrowed recipe', () => {
    const placeholder = unlinkedProfile('41', 'unknown roast')
    expect(placeholder.strategy).toBe('timed')
    expect(placeholder.points).toEqual([])
    expect(placeholder.revision).toBe(0)
  })
})

describe('the whole reconstructed run', () => {
  const run = () =>
    deviceRoastRun({
      entry: entry(),
      csv: climb,
      profiles: library,
      firmwareVersion: '2026-07-27.39',
      importedAtMs: IMPORTED_AT,
    })

  it('is keyed on the controller log id, so a second import overwrites rather than duplicates', () => {
    expect(run().id).toBe(deviceRunId(testRecordingOrigin('41')))
    // Two imports of the same recording produce the same key, which is the structural half of the
    // idempotency rule - `saveRun` is a put, so the second write replaces the first.
    expect(run().id).toBe(run().id)
    expect(deviceRunId(testRecordingOrigin('41'))).not.toBe(deviceRunId(testRecordingOrigin('42')))
  })

  it('describes an incomplete passive tail without inventing its cause', () => {
    const imported = deviceRoastRun({
      entry: entry({ passiveTailComplete: false }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'x',
      importedAtMs: IMPORTED_AT,
    })
    expect(imported.notes).toContain('passive decay tail did not complete')
    expect(imported.notes).toContain('does not identify')
    expect(imported.notes).not.toContain('takeover')
  })
  it('carries the controller name, the link state, and the attainments as origin', () => {
    const imported = run()
    expect(imported.deviceRoast).toEqual({
      recordingOrigin: testRecordingOrigin('41'),
      storageAddress: testStorageAddress('41'),
      name: 'Gentle espresso journey',
      bootId: '7',
      dateUnknown: false,
      zoneAttainedSec: [120, 305, null],
      profileLinked: true,
    })
    expect(imported.profile.id).toBe(starterThermalIntent.id)
    expect(imported.controllerVersion).toBe('2026-07-27.39')
    expect(imported.samples).toHaveLength(8)
    expect(imported.events).toHaveLength(3)
  })

  /**
   * The mass the device sends. The operator should not type a number the controller was handed at
   * the start of the roast and has been planning against ever since.
   */
  it('takes the batch mass from the header, and stays silent when the device has none', () => {
    const weighed = deviceRoastRun({
      entry: entry({ batchMassG: 225 }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'x',
      importedAtMs: IMPORTED_AT,
    })
    expect(weighed.measurements).toEqual({ startingMassG: 225 })
    // No mass in the header - a v1 recording, or a v2 one that sent the unknown sentinel - leaves
    // measurements absent entirely, rather than present and empty.
    expect(run().measurements).toBeUndefined()
    // The bean lot is never inferred: the controller was handed a name and a mass, and was never
    // told what went in the chamber.
    expect(weighed.beanLotId).toBeUndefined()
    expect(weighed.beanLotSnapshot).toBeUndefined()
  })

  /** A journey that left a zone unattained did not finish it, and the header is what says so. */
  it('derives the outcome from the attainments rather than inventing one', () => {
    expect(run().outcome).toBe('aborted')
    const finished = deviceRoastRun({
      entry: entry({ zoneAttainedSec: [120, 305, 590] }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'x',
      importedAtMs: IMPORTED_AT,
    })
    expect(finished.outcome).toBe('complete')
    // A timed roast has no zones to miss, so it reads as complete.
    const timed = deviceRoastRun({
      entry: entry({ zoneAttainedSec: undefined, zoneCount: 0, name: 'House espresso' }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'x',
      importedAtMs: IMPORTED_AT,
    })
    expect(timed.outcome).toBe('complete')
    expect(timed.profile.id).toBe(starterProfile.id)
    for (const reason of ['stopped', 'fault', 'sensor_lost', 'telemetry_stale'] as const) {
      const failed = deviceRoastRun({
        entry: entry({ zoneAttainedSec: undefined, zoneCount: 0, name: 'House espresso', roastEndReason: reason }),
        csv: climb,
        profiles: library,
        firmwareVersion: 'x',
        importedAtMs: IMPORTED_AT,
      })
      expect(failed.outcome, reason).toBe('aborted')
    }
  })

  /**
   * The reported requirement, in the negative: `start_epoch` 0 means the clock never synced, which
   * is "date unknown". Rendering that as 1970 would sort every unsynced roast before every real one
   * for the life of the archive.
   */
  it('never dates an unsynced recording to 1970', () => {
    const undated = deviceRoastRun({
      entry: entry({ startedAt: undefined }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'x',
      importedAtMs: IMPORTED_AT,
    })
    expect(undated.startedAt).toBe(new Date(IMPORTED_AT).toISOString())
    expect(new Date(undated.startedAt).getUTCFullYear()).toBe(2026)
    expect(undated.deviceRoast?.dateUnknown).toBe(true)
    // It remains an ordinary roast name; the explanatory note carries the uncertainty.
    expect(undated.name).toBe('Gentle espresso journey')
    expect(undated.notes).toContain('recorded date is unknown')
    expect(undated.notes).not.toContain('boot 7')
  })

  it('imports unlinked, and says so, when no unique profile matched', () => {
    const orphan = deviceRoastRun({
      entry: entry({ name: 'something else entirely' }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'x',
      importedAtMs: IMPORTED_AT,
    })
    expect(orphan.deviceRoast?.profileLinked).toBe(false)
    // An inert placeholder, so nothing downstream derives anything from a profile it never ran.
    expect(orphan.profile.strategy).toBe('timed')
    expect(orphan.profile.strategy === 'timed' && orphan.profile.points).toEqual([])
    expect(orphan.notes).toContain('not linked to one')
    // The run is still complete in every other respect: the missing link is one field, not a hole.
    expect(orphan.samples).toHaveLength(8)
    expect(orphan.name).toBe('something else entirely')
  })

  it('imports a manual recording as a manual roast with a synthetic instruction snapshot', () => {
    const imported = deviceRoastRun({
      entry: entry({
        mode: 'roast',
        roastMode: 'manual',
        roastStopSec: 7,
        roastEndReason: 'stopped',
        name: undefined,
        zoneCount: undefined,
        zoneAttainedSec: undefined,
      }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'x',
      importedAtMs: IMPORTED_AT,
    })
    expect(imported.manualRoast).toMatchObject({ stoppedElapsedSec: 7, logId: key('41') })
    expect(imported.completedAt).toBe('2026-07-27T09:15:06.000Z')
    expect(imported.manualRoast?.endReason).toBe('stopped')
    expect(
      imported.manualRoast?.changes.map(({ elapsedSec, requestedFan, requestedHeat }) => ({
        elapsedSec,
        requestedFan,
        requestedHeat,
      })),
    ).toEqual([
      { elapsedSec: 0, requestedFan: 8, requestedHeat: 6 },
      { elapsedSec: 3, requestedFan: 8, requestedHeat: 7 },
      { elapsedSec: 6, requestedFan: 9, requestedHeat: 0 },
    ])
    expect(imported.profile).toMatchObject({
      id: deviceRunId(testRecordingOrigin('41')).replace('devrun-', 'manual-'),
      name: 'manual roast 41 instructions',
      revision: 1,
      strategy: 'timed',
    })
    expect(
      imported.profile.strategy === 'timed' &&
        imported.profile.points.map(({ timeSec, fan, heat }) => ({ timeSec, fan, heat })),
    ).toEqual([
      { timeSec: 0, fan: 8, heat: 6 },
      { timeSec: 3, fan: 8, heat: 7 },
      { timeSec: 6, fan: 9, heat: 0 },
    ])
    expect(imported.deviceRoast?.profileLinked).toBe(true)
    expect(imported.notes).toContain('effective levels')
  })

  it('closes the run at its recorded duration rather than leaving it open', () => {
    const imported = run()
    expect(imported.completedAt).toBe(new Date(Date.parse('2026-07-27T09:15:00.000Z') + 7000).toISOString())
    expect(imported.outcome).not.toBe('running')
  })

  /**
   * The end-to-end idempotency property, replayed the way the app actually replays it: import,
   * merge into an archive, then reconcile again with the ledger from the first pass.
   */
  it('cannot duplicate a roast however many times History is revisited', () => {
    const logs = [entry({ id: '41' }), entry({ id: '42', name: 'House espresso', zoneAttainedSec: undefined })]
    let ledger: string[] = []
    // Keyed exactly as the repository keys it, so a re-import shows up as a replacement or not at all.
    const stored: Record<string, ReturnType<typeof deviceRoastRun>> = {}

    for (let visit = 0; visit < 3; visit += 1) {
      for (const pending of importableDeviceRoasts(logs, ledger)) {
        const imported = deviceRoastRun({
          entry: pending,
          csv: climb,
          profiles: library,
          firmwareVersion: 'x',
          importedAtMs: IMPORTED_AT,
        })
        // A put by key: a second import of the same recording replaces rather than appends.
        stored[imported.id] = imported
        ledger = [...ledger, key(pending.id)]
      }
    }
    expect(Object.keys(stored).sort()).toEqual([
      deviceRunId(testRecordingOrigin('41')),
      deviceRunId(testRecordingOrigin('42')),
    ])
    expect(ledger.sort()).toEqual([key('41'), key('42')].sort())
  })
})

/**
 * Design rule: a device-executed roast's setup stages on the ROASTER at Start as a
 * complete run record, and reconciliation completes THAT record from the recording instead of
 * synthesizing a second one from the header. These tests pin both halves of the cross-browser
 * property: browser B, which never saw Start, holds the same staged record via the device library
 * and reconciles it identically - and no browser localStorage stash is involved.
 */
describe('completing the record staged on the roaster at Start', () => {
  const staged = (overrides: Partial<RoastRun> = {}): RoastRun => ({
    ...provisionalDeviceRoastRun({
      id: 'run-staged-1',
      name: 'Gentle espresso journey',
      profile: starterThermalIntent,
      measurements: { startingMassG: 225, startingVolumeMl: 350, ambientC: 24.5 },
      beanLotId: starterBean.id,
      beanLot: starterBean,
      recordedOn: testLogProvenance('41').recordedOn,
      firmwareVersion: 'x',
      bootId: '7',
      startedAt: '2026-07-27T09:14:58.000Z',
    }),
    ...overrides,
  })
  const imported = (batchMassG?: number, overrides: Partial<DeviceLogEntry> = {}) =>
    deviceRoastRun({
      entry: entry(batchMassG === undefined ? overrides : { batchMassG, ...overrides }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'x',
      importedAtMs: IMPORTED_AT,
    })

  it('stages the COMPLETE setup at Start: volume, ambient, bean lot and snapshot, mass, name, running outcome', () => {
    const run = staged()
    expect(run.measurements).toEqual({ startingMassG: 225, startingVolumeMl: 350, ambientC: 24.5 })
    expect(run.beanLotId).toBe(starterBean.id)
    expect(run.beanLotSnapshot?.id).toBe(starterBean.id)
    expect(run.name).toBe('Gentle espresso journey')
    expect(run.outcome).toBe('running')
    expect(run.profile.id).toBe(starterThermalIntent.id)
    expect(run.deviceRoastPending).toEqual({ bootId: '7' })
  })

  it('completes the staged record in place on any browser: same id, staged setup kept, header facts win', () => {
    // Browser B's world: only the shared staged record (no in-memory recording join).
    const reconciliation = reconcileProfiledArchiveRun({
      entry: entry({ batchMassG: 230 }),
      reconstructed: imported(230),
      localRuns: [staged()],
    })
    expect(reconciliation.kind).toBe('merge')
    if (reconciliation.kind !== 'merge') return
    expect(reconciliation.run.id).toBe('run-staged-1')
    // The header mass is what the firmware planned against for the whole roast, so it wins the one
    // overlapping field; the staged record keeps what the device had no way to know.
    expect(reconciliation.run.measurements).toEqual({ startingMassG: 230, startingVolumeMl: 350, ambientC: 24.5 })
    expect(reconciliation.run.beanLotId).toBe(starterBean.id)
    expect(reconciliation.run.beanLotSnapshot?.id).toBe(starterBean.id)
    expect(reconciliation.run.outcome).not.toBe('running')
    expect(reconciliation.run.samples.length).toBeGreaterThan(0)
    expect(reconciliation.run.deviceRoast?.recordingOrigin).toEqual(testRecordingOrigin('41'))
    expect(reconciliation.run.deviceRoastPending).toBeUndefined()
  })

  it('keeps the profile the operator chose, on the plan the roaster executed', () => {
    const reconciliation = reconcileProfiledArchiveRun({
      entry: entry(),
      reconstructed: imported(),
      localRuns: [staged()],
    })
    expect(reconciliation.kind).toBe('merge')
    if (reconciliation.kind !== 'merge') return
    const executed = imported().profile
    expect(reconciliation.run.profile).toMatchObject({
      id: starterThermalIntent.id,
      name: starterThermalIntent.name,
      revision: starterThermalIntent.revision,
    })
    // The zones are what ran (mid-roast edits included), not the saved recipe.
    if (executed.strategy === 'thermal-intent' && reconciliation.run.profile.strategy === 'thermal-intent') {
      expect(reconciliation.run.profile.segments).toEqual(executed.segments)
    }
  })

  it('leaves the executed plan alone when the staged profile is of another kind', () => {
    const executed = imported().profile
    const other = executed.strategy === 'timed' ? starterThermalIntent : starterProfile
    expect(withStagedProfileIdentity(other, executed)).toBe(executed)
  })

  it('prefers the exact recording identity the starting browser observed', () => {
    const decoy = staged({ id: 'run-staged-2', startedAt: '2026-07-27T09:14:57.000Z' })
    const reconciliation = reconcileProfiledArchiveRun({
      entry: entry(),
      reconstructed: imported(),
      localRuns: [decoy, staged()],
      pendingRecordingByRunId: new Map([['run-staged-1', testRecordingOrigin('41')]]),
    })
    expect(reconciliation.kind).toBe('merge')
    if (reconciliation.kind === 'merge') expect(reconciliation.localRunId).toBe('run-staged-1')
  })

  it('falls back to name and bounded start time, and refuses a mismatch of either', () => {
    const matched = reconcileProfiledArchiveRun({ entry: entry(), reconstructed: imported(), localRuns: [staged()] })
    expect(matched.kind).toBe('merge')
    const wrongName = reconcileProfiledArchiveRun({
      entry: entry(),
      reconstructed: imported(),
      localRuns: [staged({ name: 'Another roast' })],
    })
    expect(wrongName.kind).toBe('standalone')
    const wrongTime = reconcileProfiledArchiveRun({
      entry: entry(),
      reconstructed: imported(),
      localRuns: [staged({ startedAt: '2026-07-27T08:00:00.000Z' })],
    })
    expect(wrongTime.kind).toBe('standalone')
    const claimed = reconcileProfiledArchiveRun({
      entry: entry(),
      reconstructed: imported(),
      localRuns: [staged()],
      claimedLocalRunIds: new Set(['run-staged-1']),
    })
    expect(claimed.kind).toBe('standalone')
  })

  it('joins a clocked recording by boot and name when the start clocks disagree beyond ten seconds', () => {
    // The staged startedAt is the browser clock read BEFORE the staged write, which can wait and
    // retry; with a reloaded phone (no exact identity) a 10 s window alone would miss and the
    // recording would be reconstructed as a second History row.
    const skewed = reconcileProfiledArchiveRun({
      entry: entry(),
      reconstructed: imported(),
      localRuns: [staged({ startedAt: '2026-07-27T09:14:20.000Z' })],
    })
    expect(skewed.kind).toBe('merge')
    // Another boot, or a same-name roast far outside the window, is a different roast.
    expect(
      reconcileProfiledArchiveRun({
        entry: entry({ bootId: '8' }),
        reconstructed: imported(),
        localRuns: [staged({ startedAt: '2026-07-27T09:14:20.000Z' })],
      }).kind,
    ).toBe('standalone')
    const outside = new Date(
      new Date('2026-07-27T09:15:00.000Z').getTime() - SAME_BOOT_START_WINDOW_MS - 1000,
    ).toISOString()
    expect(
      reconcileProfiledArchiveRun({
        entry: entry(),
        reconstructed: imported(),
        localRuns: [staged({ startedAt: outside })],
      }).kind,
    ).toBe('standalone')
    // Two same-name staged records in that boot are ambiguous: keep the records separate.
    expect(
      reconcileProfiledArchiveRun({
        entry: entry(),
        reconstructed: imported(),
        localRuns: [
          staged({ startedAt: '2026-07-27T09:14:20.000Z' }),
          staged({ id: 'run-staged-2', startedAt: '2026-07-27T09:13:40.000Z' }),
        ],
      }).kind,
    ).toBe('standalone')
  })

  it('joins the same-name staged record whose start is closest, not the first one listed', () => {
    // A retried Start leaves two same-name staged records seconds apart.
    const leftover = staged({ id: 'run-staged-early', startedAt: '2026-07-27T09:14:52.000Z' })
    const retried = staged({ id: 'run-staged-late', startedAt: '2026-07-27T09:14:59.000Z' })
    const result = reconcileProfiledArchiveRun({
      entry: entry(),
      reconstructed: imported(),
      localRuns: [leftover, retried],
    })
    expect(result.kind).toBe('merge')
    expect(result.kind === 'merge' ? result.localRunId : undefined).toBe('run-staged-late')
  })

  it('folds two records of one recording into the staged one, keeping what the user typed on either', () => {
    // A duplicated pair, reduced: the staged record (bean, starting volume, ambient) and a
    // standalone reconstruction where the final weight and volume were then entered.
    const origin = testRecordingOrigin('44')
    const deviceRoast = {
      ...imported().deviceRoast!,
      recordingOrigin: origin,
      storageAddress: testStorageAddress('44'),
    }
    const completedStaged: RoastRun = {
      ...staged({ id: 'run-muohntyoo00jr' }),
      outcome: 'complete',
      deviceRoastPending: undefined,
      deviceRoast,
      measurements: { startingMassG: 220, startingVolumeMl: 310, ambientC: 37.2 },
    }
    const standalone: RoastRun = {
      ...imported(),
      id: 'devrun-8e83b5c57449d9c1',
      deviceRoast,
      beanLotId: undefined,
      beanLotSnapshot: undefined,
      measurements: { startingMassG: 220, finalVolumeMl: 570, finalMassG: 187, startingVolumeMl: 310 },
      score: 8,
    }
    const unrelated: RoastRun = {
      ...imported(),
      id: 'devrun-other',
      deviceRoast: { ...deviceRoast, recordingOrigin: testRecordingOrigin('43') },
    }

    const merges = duplicateRecordingMerges([standalone, unrelated, completedStaged])
    expect(merges).toHaveLength(1)
    expect(merges[0].removeIds).toEqual(['devrun-8e83b5c57449d9c1'])
    expect(merges[0].keep.id).toBe('run-muohntyoo00jr')
    expect(merges[0].keep.beanLotId).toBe(starterBean.id)
    expect(merges[0].keep.measurements).toEqual({
      startingMassG: 220,
      startingVolumeMl: 310,
      ambientC: 37.2,
      finalMassG: 187,
      finalVolumeMl: 570,
    })
    expect(merges[0].keep.score).toBe(8)
    expect(merges[0].basis).toBe(completedStaged)
    expect(duplicateRecordingMerges([completedStaged, unrelated])).toEqual([])
    // Notes typed on both copies are both kept; a copy of the same note is not repeated.
    const noted = duplicateRecordingMerges([
      { ...standalone, notes: 'Tasting: cocoa, low acidity' },
      { ...completedStaged, notes: 'Dry beans' },
    ])
    expect(noted[0].keep.notes).toBe('Dry beans\n\nTasting: cocoa, low acidity')
    expect(
      duplicateRecordingMerges([
        { ...standalone, notes: 'Dry beans' },
        { ...completedStaged, notes: 'Dry beans' },
      ])[0].keep.notes,
    ).toBe('Dry beans')
  })

  it('joins a clockless recording by boot and name only when that is unambiguous', () => {
    const clockless = { startedAt: undefined, bootId: '7' } satisfies Partial<DeviceLogEntry>
    const single = reconcileProfiledArchiveRun({
      entry: entry(clockless),
      reconstructed: imported(undefined, clockless),
      localRuns: [staged()],
    })
    expect(single.kind).toBe('merge')
    if (single.kind === 'merge') {
      // The staged record's browser clock at Start is a true reading; the import moment is not.
      expect(single.run.startedAt).toBe('2026-07-27T09:14:58.000Z')
      expect(single.run.notes).toContain('the date shown is when this roast was started')
    }
    const ambiguous = reconcileProfiledArchiveRun({
      entry: entry(clockless),
      reconstructed: imported(undefined, clockless),
      localRuns: [staged(), staged({ id: 'run-staged-2' })],
    })
    expect(ambiguous.kind).toBe('standalone')
  })

  it('imports a roast with no staged record exactly as before', () => {
    const reconciliation = reconcileProfiledArchiveRun({ entry: entry(), reconstructed: imported(225), localRuns: [] })
    expect(reconciliation.kind).toBe('standalone')
    if (reconciliation.kind === 'standalone') expect(reconciliation.run.id).toBe(deviceRunId(testRecordingOrigin('41')))
  })

  it('has deleted the browser-side stash machinery entirely', () => {
    expect('applyPendingRoastSetup' in deviceRoastImport).toBe(false)
    expect('pendingSetupMatchesRecording' in deviceRoastImport).toBe(false)
  })
})

describe('reconciling a manual recording with its browser-owned run', () => {
  const manualEntry = () =>
    entry({
      mode: 'roast',
      roastMode: 'manual',
      name: 'Counter culture',
      roastStopSec: 7,
      roastEndReason: 'stopped',
      zoneCount: undefined,
      zoneAttainedSec: undefined,
    })
  const reconstructed = () =>
    deviceRoastRun({
      entry: manualEntry(),
      csv: climb,
      profiles: library,
      firmwareVersion: 'archive-version',
      importedAtMs: IMPORTED_AT,
    })
  const local = (overrides: Partial<RoastRun> = {}): RoastRun => {
    const archive = reconstructed()
    return {
      ...archive,
      id: 'run-local',
      name: 'Counter culture',
      completedAt: undefined,
      beanLotId: 'bean-user-picked',
      notes: 'Tasting note.',
      controllerVersion: 'start-version',
      deviceRoast: undefined,
      outcome: 'running',
      samples: archive.samples.slice(4),
      events: [{ id: 'joined', elapsedSec: 4, type: 'SYSTEM', label: 'Joined late' }],
      manualRoast: {
        changes: [
          {
            id: 'local-incomplete',
            elapsedSec: 0,
            requestedFan: 5,
            requestedHeat: 4,
            effectiveFan: 5,
            effectiveHeat: 4,
            source: 'firmware',
          },
        ],
        deviceBootId: '7',
        deviceName: 'Counter culture',
        deviceSessionId: '14',
        deviceStartedEpoch: 1_753_607_700,
        incomplete: true,
      },
      ...overrides,
    }
  }

  it('keeps user-entered identity and metadata while the archive closes and completes a recovered run', () => {
    const archive = reconstructed()
    const result = reconcileManualArchiveRun({
      entry: manualEntry(),
      reconstructed: archive,
      localRuns: [local()],
    })

    expect(result.kind).toBe('merge')
    if (result.kind !== 'merge') throw new Error(`Expected merge, received ${result.kind}`)
    expect(result.localRunId).toBe('run-local')
    expect(result.run).toMatchObject({
      id: 'run-local',
      beanLotId: 'bean-user-picked',
      notes: 'Tasting note.',
      controllerVersion: 'archive-version',
      completedAt: archive.completedAt,
      outcome: 'complete',
      events: [{ id: 'joined', elapsedSec: 4, type: 'SYSTEM', label: 'Joined late' }],
    })
    expect(result.run.samples).toEqual(archive.samples)
    expect(result.run.manualRoast).toMatchObject({
      changes: archive.manualRoast?.changes,
      deviceBootId: '7',
      deviceName: 'Counter culture',
      deviceSessionId: '14',
      deviceStartedEpoch: 1_753_607_700,
      logId: key('41'),
      incomplete: false,
    })
  })

  it('completes a bare staged-at-Start manual record and drops the staged marker', () => {
    // The record staged on the roaster before Start: no session identity yet, no browser journal.
    const staged = local({
      manualRoast: { changes: [], deviceName: 'Counter culture', incomplete: true },
      deviceRoastPending: { bootId: '7' },
      samples: [],
      events: [],
    })
    const result = reconcileManualArchiveRun({
      entry: manualEntry(),
      reconstructed: reconstructed(),
      localRuns: [staged],
    })
    expect(result.kind).toBe('merge')
    if (result.kind !== 'merge') return
    expect(result.run.id).toBe('run-local')
    expect(result.run.beanLotId).toBe('bean-user-picked')
    expect(result.run.outcome).toBe('complete')
    expect(result.run.deviceRoastPending).toBeUndefined()
    expect(Object.keys(result.run)).not.toContain('deviceRoastPending')
  })

  it('replaces a completed browser projection with the roaster command journal', () => {
    const base = local()
    const completedLocal = local({
      outcome: 'complete',
      manualRoast: {
        ...base.manualRoast!,
        incomplete: false,
        changes: [
          {
            id: 'browser-only',
            elapsedSec: 0,
            requestedFan: 1,
            requestedHeat: 1,
            effectiveFan: 1,
            effectiveHeat: 1,
            source: 'local',
          },
        ],
      },
    })
    const archive = reconstructed()
    const result = reconcileManualArchiveRun({
      entry: manualEntry(),
      reconstructed: archive,
      localRuns: [completedLocal],
    })
    expect(result.kind).toBe('merge')
    expect(result.run.manualRoast?.changes).toEqual(archive.manualRoast?.changes)
    expect(result.run.manualRoast?.changes).not.toEqual(completedLocal.manualRoast?.changes)
  })

  it('repairs only the ledger when the durable local run already carries this log id', () => {
    const base = local()
    const linked = local({
      outcome: 'complete',
      deviceRoast: reconstructed().deviceRoast,
      manualRoast: { ...base.manualRoast!, logId: key('41'), incomplete: false },
    })
    const result = reconcileManualArchiveRun({
      entry: manualEntry(),
      reconstructed: reconstructed(),
      localRuns: [linked],
    })

    expect(result).toEqual({
      kind: 'ledger-repair',
      run: linked,
      logId: key('41'),
      localRunId: 'run-local',
    })
    expect(result.run).toBe(linked)
  })

  it('returns the deterministic standalone import when no local run can be identified safely', () => {
    const archive = reconstructed()
    const result = reconcileManualArchiveRun({
      entry: manualEntry(),
      reconstructed: archive,
      localRuns: [local({ name: 'A different roast' })],
    })

    expect(result).toEqual({ kind: 'standalone', run: archive, logId: key('41') })
    expect(result.run.id).toBe(deviceRunId(testRecordingOrigin('41')))
  })

  it('keeps an unsynced same-name recording separate rather than overwriting an ambiguous local run', () => {
    const undatedEntry = manualEntry()
    undatedEntry.startedAt = undefined
    const archive = deviceRoastRun({
      entry: undatedEntry,
      csv: climb,
      profiles: library,
      firmwareVersion: 'archive-version',
      importedAtMs: IMPORTED_AT,
    })
    const result = reconcileManualArchiveRun({
      entry: undatedEntry,
      reconstructed: archive,
      localRuns: [local()],
    })

    expect(result).toEqual({ kind: 'standalone', run: archive, logId: key('41') })
    expect(result.run.id).toBe(deviceRunId(testRecordingOrigin('41')))
  })

  it('reconciles a clock-unsynced roast by its exact reserved recording identity', () => {
    const undatedEntry = manualEntry()
    undatedEntry.startedAt = undefined
    const archive = deviceRoastRun({
      entry: undatedEntry,
      csv: climb,
      profiles: library,
      firmwareVersion: 'archive-version',
      importedAtMs: IMPORTED_AT,
    })
    const base = local()
    const browserRun = local({
      name: 'Renamed this roast',
      manualRoast: {
        ...base.manualRoast!,
        pendingRecording: {
          recordingOrigin: undatedEntry.recordingOrigin,
          storageAddress: undatedEntry.storageAddress,
        },
      },
    })

    const result = reconcileManualArchiveRun({
      entry: undatedEntry,
      reconstructed: archive,
      localRuns: [browserRun],
    })

    expect(result.kind).toBe('merge')
    if (result.kind !== 'merge') throw new Error('Expected merge')
    expect(result.localRunId).toBe('run-local')
    expect(result.run.samples).toEqual(archive.samples)
    expect(result.run.manualRoast).toMatchObject({ stoppedElapsedSec: 7, logId: key('41') })
    expect(result.run.manualRoast?.pendingRecording).toBeUndefined()
  })

  it('keeps a recovered run blocked when an old archive has no terminal boundary metadata', () => {
    const completeArchive = reconstructed()
    const oldArchive: RoastRun = {
      ...completeArchive,
      manualRoast: {
        ...completeArchive.manualRoast!,
        stoppedElapsedSec: undefined,
        endReason: undefined,
        incomplete: true,
      },
    }
    const result = reconcileManualArchiveRun({
      entry: manualEntry(),
      reconstructed: oldArchive,
      localRuns: [local()],
    })

    expect(result.kind).toBe('merge')
    expect(result.run.manualRoast).toMatchObject({ logId: key('41'), incomplete: true })
    expect(result.run.manualRoast?.stoppedElapsedSec).toBeUndefined()
    expect(result.run.manualRoast?.endReason).toBeUndefined()
  })
})

describe('device-owned codec-2 instructions', () => {
  const varint = (out: number[], value: number) => {
    let remaining = value >>> 0
    while (remaining >= 0x80) {
      out.push((remaining & 0x7f) | 0x80)
      remaining >>>= 7
    }
    out.push(remaining)
  }
  const signed = (out: number[], value: number) => varint(out, (value << 1) ^ (value >> 31))
  const archive = () => {
    const envelope = [0xc7, 1, 2, 1, 1, 0, 0]
    signed(envelope, 250)
    signed(envelope, 1500)
    varint(envelope, 120)
    envelope.push(40, 90, 30, 80)
    varint(envelope, 60)
    varint(envelope, 2)
    envelope.push(1, 1, 0, 0x42)
    signed(envelope, 1600)
    envelope.push(90)
    envelope[5] = envelope.length & 0xff
    envelope[6] = envelope.length >>> 8
    return v4Recording({ payload: Uint8Array.from(envelope), sampleCount: 0, codec: 2 })
  }

  const manualArchive = () => {
    const envelope = [0xc7, 1, 3, 1, 3, 0, 0, 40, 0]
    varint(envelope, 0)
    varint(envelope, 1)
    envelope.push(40, 0, 40, 0)
    varint(envelope, 1)
    varint(envelope, 2)
    envelope.push(50, 20, 50, 0)
    varint(envelope, 2)
    varint(envelope, 3)
    envelope.push(60, 30, 60, 30)
    envelope[5] = envelope.length & 0xff
    envelope[6] = envelope.length >>> 8
    return v4Recording({ payload: Uint8Array.from(envelope), sampleCount: 0, codec: 2 })
  }

  it('imports exact manual instructions even when compact samples miss both changes', () => {
    const imported = deviceRoastRun({
      entry: entry({
        version: 4,
        mode: 'roast',
        roastMode: 'manual',
        roastStopSec: 7,
        roastEndReason: 'stopped',
        name: 'manual journal',
      }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'codec-2',
      importedAtMs: IMPORTED_AT,
      archive: manualArchive(),
    })
    expect(
      imported.manualRoast?.changes.map(({ elapsedSec, requestedFan, requestedHeat, effectiveHeat }) => ({
        elapsedSec,
        requestedFan,
        requestedHeat,
        effectiveHeat,
      })),
    ).toEqual([
      { elapsedSec: 0, requestedFan: 4, requestedHeat: 0, effectiveHeat: 0 },
      { elapsedSec: 1, requestedFan: 5, requestedHeat: 2, effectiveHeat: 0 },
      { elapsedSec: 2, requestedFan: 6, requestedHeat: 3, effectiveHeat: 3 },
    ])
    expect(imported.deviceRoast?.planJournal).toHaveLength(3)
  })

  it('uses the recorded plan and final accepted edit, never a same-name catalog profile', () => {
    const changedLibrary = structuredClone(library)
    const sameName = changedLibrary.find((profile) => profile.name === 'Gentle espresso journey')!
    if (sameName.strategy !== 'thermal-intent') throw new Error('Expected journey fixture')
    sameName.segments[0].endC = 299
    const imported = deviceRoastRun({
      entry: entry({ version: 4, zoneCount: 1, zoneAttainedSec: [120] }),
      csv: climb,
      profiles: changedLibrary,
      firmwareVersion: 'codec-2',
      importedAtMs: IMPORTED_AT,
      archive: archive(),
    })
    expect(imported.profile).toMatchObject({ strategy: 'thermal-intent', revision: 2 })
    expect(imported.profile.strategy === 'thermal-intent' && imported.profile.segments[0].endC).toBe(160)
    expect(imported.deviceRoast?.initialPlan).toMatchObject({ mode: 'journey', zones: [{ endC: 150 }] })
    expect(imported.deviceRoast?.planJournal).toMatchObject([{ elapsedSec: 60, planRev: 2, zones: [{ endC: 160 }] }])
    expect(imported.deviceRoast?.planEnvelope).toBeTruthy()
    expect(imported.notes).toContain('1 accepted live edit')
  })

  it('preserves codec-1 compatibility when the v4 archive has no plan envelope', () => {
    const legacy = v4Recording({ payload: new Uint8Array(), sampleCount: 0, codec: 1 })
    const imported = deviceRoastRun({
      entry: entry({ version: 4 }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'codec-1',
      importedAtMs: IMPORTED_AT,
      archive: legacy,
    })
    expect(imported.profile.id).toBe(starterThermalIntent.id)
    expect(imported.deviceRoast?.profileLinked).toBe(true)
    expect(imported.deviceRoast?.initialPlan).toBeUndefined()
  })

  it('does not guess from a current same-name profile when a v4 archive cannot be read', () => {
    const imported = deviceRoastRun({
      entry: entry({ version: 4 }),
      csv: climb,
      profiles: library,
      firmwareVersion: 'codec-2',
      importedAtMs: IMPORTED_AT,
    })
    expect(imported.deviceRoast?.profileLinked).toBe(false)
    expect(imported.profile.strategy === 'timed' && imported.profile.points).toEqual([])
    expect(imported.notes).toContain('remains unlinked rather than guessing')
  })

  it('round-trips a heated final timed step without replacing it with implicit cooling', () => {
    const profile = profileFromArchivedPlan(
      '9',
      'Recorded timed',
      '2026-07-29T00:00:00.000Z',
      {
        mode: 'timed',
        steps: [
          { fan: 5, heat: 6, durationSec: 30 },
          { fan: 7, heat: 8, durationSec: 45 },
        ],
      },
      [],
    )
    expect(profile?.strategy).toBe('timed')
    if (profile?.strategy !== 'timed') throw new Error('Expected timed profile')
    expect(profile.points.map(({ timeSec, fan, heat }) => ({ timeSec, fan, heat }))).toEqual([
      { timeSec: 0, fan: 5, heat: 6 },
      { timeSec: 30, fan: 7, heat: 8 },
      { timeSec: 75, fan: 7, heat: 0 },
    ])
    expect(profile.coolDurationSec).toBe(0)
    expect(
      profileFromArchivedPlan(
        '9',
        'Broken timed',
        '2026-07-29T00:00:00.000Z',
        {
          mode: 'timed',
          steps: [{ fan: 5, heat: 6, durationSec: 30 }],
        },
        [{ elapsedSec: 4, planRev: 2, stepIndex: 2, step: { fan: 7, heat: 0, durationSec: 20 } }],
      ),
    ).toBeUndefined()
  })
})
describe('settling staged records that can never be completed', () => {
  // Two records staged on an earlier boot would wait as "running" forever - the roaster restarted
  // mid-roast (header-only recording) and an earlier Start was never confirmed.
  const stagedOn = (bootId: string, name: string): RoastRun =>
    provisionalDeviceRoastRun({
      id: `run-${name.slice(-2)}`,
      name,
      profile: starterThermalIntent,
      measurements: { startingMassG: 224, startingVolumeMl: 330 },
      beanLotId: starterBean.id,
      beanLot: starterBean,
      recordedOn: testLogProvenance('41').recordedOn,
      firmwareVersion: 'x',
      bootId,
      startedAt: '2026-09-10T19:39:00.000Z',
    })
  const headerOnly = entry({
    id: '41',
    bootId: '683',
    name: '2026-09-10 15:39 - Kenya Nyeri',
    samples: 0,
    roastEndReason: undefined,
    startedAt: '2026-09-10T19:40:09.000Z',
  })

  it('settles a record whose roast restarted the roaster, and one whose Start was never confirmed', () => {
    const restarted = stagedOn('683', '2026-09-10 15:39 - Kenya Nyeri')
    const unconfirmed = stagedOn('683', '2026-09-10 15:36 - Kenya Nyeri')
    const result = orphanedStagedRuns([restarted, unconfirmed], [headerOnly], '706')
    expect(result.map((orphan) => [orphan.run.id, orphan.reason])).toEqual([
      [restarted.id, 'restarted'],
      [unconfirmed.id, 'unconfirmed'],
    ])
    expect(orphanedStagedRunNote('restarted')).toMatch(/restarted during this roast/)
  })

  it('leaves records of the current boot, and records a real recording can still complete', () => {
    const current = stagedOn('706', '2026-09-30 15:18 - Brazil Cerrado')
    expect(orphanedStagedRuns([current], [], '706')).toEqual([])
    const joinable = stagedOn('683', '2026-09-10 15:39 - Kenya Nyeri')
    const real = { ...headerOnly, samples: 900, roastEndReason: 'completed' as const }
    expect(orphanedStagedRuns([joinable], [real], '706')).toEqual([])
    expect(orphanedStagedRuns([joinable], [headerOnly], undefined)).toEqual([])
  })

  it('settles the leftover of a retried Start once the other record holds the recording', () => {
    // Start's acknowledgement was lost, Start was pressed again, and the second
    // staged record was completed by the recording. The first can never be completed.
    const name = '2026-09-10 15:39 - Kenya Nyeri'
    const leftover = stagedOn('683', name)
    const real = { ...headerOnly, samples: 900, roastEndReason: 'completed' as const }
    const completed: RoastRun = {
      ...stagedOn('683', name),
      id: 'run-completed',
      outcome: 'complete',
      deviceRoastPending: undefined,
      deviceRoast: {
        recordingOrigin: real.recordingOrigin,
        storageAddress: real.storageAddress,
        bootId: '683',
      } as RoastRun['deviceRoast'],
    }
    const result = orphanedStagedRuns([leftover, completed], [real], '706')
    expect(result.map((orphan) => [orphan.run.id, orphan.reason])).toEqual([[leftover.id, 'superseded']])
    expect(orphanedStagedRunNote('superseded')).toMatch(/Start was pressed again/)
  })
})
