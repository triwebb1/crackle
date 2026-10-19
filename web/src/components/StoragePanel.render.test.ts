import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import type { DataSyncState } from '../data/deviceStore'
import type { DeviceLogEntry } from '../domain/deviceLogs'
import type { BeanLot, ControllerStatus, Profile, RoastRun } from '../domain/types'
import { testDeviceRoastOrigin, testLogProvenance, testRecordedOn } from '../testFixtures/provenance'
import { DeleteImpactPanel } from './DeleteImpactPanel'
import { backupSummary, replacementUnitRestoreWarning, StoragePanel } from './StoragePanel'

/**
 * What these two panels are REQUIRED to say, at the markup boundary. The arithmetic behind every
 * figure is pinned in `domain/storage.test.ts`; what is asserted here is the part a user reads:
 *
 *   - free space is never presented as the leftover bytes, and the withheld part is named - in both
 *     of its halves, because a retention reserve and room for the next recording are different
 *     promises, and because drawing them as two separate charges double-counts them against a
 *     write floor that no firmware enforces;
 *   - the capacity translation is in roasts, not in kilobytes;
 *   - lost recordings are stated plainly rather than folded into a total;
 *   - and the delete flow offers BOTH options, with the survival of historical roasts said out loud
 *     rather than implied by their absence from a warning.
 */

const SOURCE = readFileSync(new URL('./StoragePanel.tsx', import.meta.url), 'utf8')

const MB = 896 * 1024

const log = (id: string, bytes: number, startedAt?: string): DeviceLogEntry => ({
  id,
  mode: 'roast',
  bytes,
  startedAt,
  ...testLogProvenance(id),
})

const profile = (id: string, name: string): Profile =>
  ({
    id,
    name,
    revision: 1,
    strategy: 'timed',
    createdAt: '',
    updatedAt: '',
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

const run = (id: string, profileId: string, startedAt: string, logId?: string): RoastRun =>
  ({
    id,
    name: `Roast ${id}`,
    startedAt,
    profile: profile(profileId, `Profile ${profileId}`),
    beanLotId: 'bean-1',
    notes: '',
    outcome: 'complete',
    samples: [],
    events: [],
    controllerVersion: 'mock',
    recordedOn: testRecordedOn,
    ...(logId === undefined ? {} : { deviceRoast: testDeviceRoastOrigin(logId) }),
  }) as RoastRun

const RUNS = [
  run('run-a', 'profile-1', '2026-03-03T09:00:00.000Z', '1'),
  run('run-b', 'profile-1', '2026-04-01T09:00:00.000Z', '2'),
]
const LOGS = [log('1', 100 * 1024, '2026-03-03T09:00:00.000Z'), log('2', 90 * 1024, '2026-04-01T09:00:00.000Z')]

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'READY',
  connected: true,
  stale: false,
  receivedAtMs: Date.now(),
  firmwareVersion: '2026-07-26.39',
  bootId: '7',
  manualLockout: false,
  thermocoupleValid: true,
  capabilities: {
    apiVersion: 'diagnostic-v1',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  // Volume-wide, exactly as the firmware reports it: 8 KB of documents plus 190 KB of recordings.
  logArchive: { mounted: true, count: 2, usedBytes: 198 * 1024, totalBytes: MB, clockSynced: true },
  dataStore: {
    mounted: true,
    usedBytes: 8 * 1024,
    totalBytes: MB,
    freeBytes: MB - 198 * 1024,
    // What the firmware derives and sends: 96 KB archive reserve + 121,244 worst-case recording.
    writeFloorBytes: 219548,
    collections: { profiles: { bytes: 4096, version: 4 }, calibrations: { bytes: 12 * 1024, version: 2 } },
    runs: { count: 2, bytes: 4096 },
  },
  ...overrides,
})

const sync = (overrides: Partial<DataSyncState> = {}): DataSyncState => ({
  mode: 'device',
  attached: true,
  offline: false,
  waitingForIdle: false,
  queued: 0,
  runBytes: { 'run-a': 2048, 'run-b': 2048 },
  ...overrides,
})

const render = (props: Partial<Parameters<typeof StoragePanel>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(StoragePanel, {
      status: status(),
      dataSync: sync(),
      deviceLogs: LOGS,
      importedLogIds: ['1'],
      runs: RUNS,
      profiles: [profile('profile-1', 'House espresso')],
      beans: [bean('bean-1', 'House Huila')],
      calibrationPasses: [{ samples: new Array(400) }] as never,
      snapshots: [] as never,
      onExportEverything: async () => 'done',
      ...props,
    }),
  )

describe('backup summaries', () => {
  it('names the validated contents before confirmation', () => {
    const summary = backupSummary({
      manifest: {
        counts: { profiles: 2, beans: 1, runs: 3, recordings: 3, calibrationPasses: 0, calibrationSnapshots: 1 },
      },
    } as never)
    expect(summary).toContainCode('2 profiles')
    expect(summary).toContainCode('1 bean lot')
    expect(summary).toContainCode('3 roast records')
    expect(summary).toContainCode('3 thermal recordings')
    expect(summary).toContainCode('1 saved calibration')
  })

  it('warns before restoring same-model data onto a replacement unit', () => {
    const backup = {
      manifest: {
        device: {
          deviceId: 'source-unit',
          modelId: 'freshroast-sr800',
          displayName: 'Original SR800',
        },
      },
    } as never
    const target = {
      deviceId: 'replacement-unit',
      modelId: 'freshroast-sr800',
      displayName: 'Replacement SR800',
      simulated: false,
    }
    expect(replacementUnitRestoreWarning(backup, target)).toContainCode('Replacement unit')
    expect(replacementUnitRestoreWarning(backup, target)).toContainCode('device-specific calibration')
    expect(replacementUnitRestoreWarning(backup, { ...target, deviceId: 'source-unit' })).toBe('')
    expect(replacementUnitRestoreWarning(backup, { ...target, modelId: 'different-model' })).toBe('')
  })
})

describe('the storage panel', () => {
  it('uses decimal storage units and distinguishes thermal recordings from roast records', () => {
    const markup = render()
    expect(markup).toContainCode('203 KB used of 918 KB')
    expect(markup).toContainCode('Thermal recordings')
    expect(markup).toContainCode('Roast records')
    expect(markup).toContainCode('Detailed recordings sample every second')
    expect(markup).toContainCode('compact review curve')
    expect(markup).not.toContainCode(' KiB')
    expect(markup).not.toContainCode(' MiB')
  })

  it('keeps the thermal manager bounded when dozens are present', () => {
    const logs = Array.from({ length: 55 }, (_, index) => log(String(index + 1), 400, '2026-04-01T09:00:00.000Z'))
    const markup = render({ deviceLogs: logs, importedLogIds: [], prunableLogIds: [] })
    expect(markup).toContainCode('55 thermal recordings')
    expect(markup).toContainCode('Page 1 of 6')
    expect(markup).toContainCode('#55')
    expect(markup).toContainCode('#46')
    expect(markup).not.toContainCode('<td>#45</td>')
    expect(markup).not.toContainCode('Find a thermal recording')
  })

  it('labels one-second and ten-second archives without hiding compact records', () => {
    const detailed = { ...log('detail', 400), intervalMs: 1000 }
    const compact = { ...log('compact', 120), intervalMs: 10_000 }
    const markup = render({ deviceLogs: [detailed, compact], importedLogIds: [], prunableLogIds: [] })
    expect(markup).toContainCode('#detail')
    expect(markup).toContainCode('#compact')
    expect(markup).toContainCode('Detailed · every 1 s')
    expect(markup).toContainCode('Compact · every 10 s')
  })

  it('states exactly what deleting detailed data does', () => {
    const markup = render({ prunableLogIds: ['1'], onPruneDeviceLogs: () => undefined })
    expect(markup).toContainCode('aria-label="Delete thermal recording #1"')
    expect(markup).toContainCode(
      'Deletes the thermal recording from the roaster; the roast record and compact curve remain.',
    )
    expect(markup).not.toContainCode('remove this copy')
    expect(markup).not.toContainCode('Already imported')
    expect(markup).not.toContainCode('In this library')
  })

  it('directs an unsaved roast recording to the retry that makes deletion safe', () => {
    const markup = render({ prunableLogIds: [], onPruneDeviceLogs: () => undefined })
    expect(markup).toContainCode('Not ready to delete')
    expect(markup).toContainCode('Open History to preserve its compact curve first.')
    expect(markup).toContainCode('Open History to retry that save, then return here to delete the thermal recording.')
    expect(markup).not.toContainCode('>Retained<')
  })

  it('directs calibration evidence to Calibrate before allowing its detail to be deleted', () => {
    const calibrationLog = { ...log('cal-1', 400, '2026-04-01T09:00:00.000Z'), mode: 'calibration' as const }
    const markup = render({
      deviceLogs: [calibrationLog],
      importedLogIds: [],
      prunableLogIds: [],
      onPruneDeviceLogs: () => undefined,
    })
    expect(markup).toContainCode('Preserve it in Calibrate first.')
    expect(markup).toContainCode('Open Calibrate and add this recording as evidence first.')
  })

  it('says preserved calibration evidence remains when its detailed recording is deletable', () => {
    const calibrationLog = { ...log('cal-1', 400, '2026-04-01T09:00:00.000Z'), mode: 'calibration' as const }
    const markup = render({
      deviceLogs: [calibrationLog],
      importedLogIds: [],
      prunableLogIds: ['cal-1'],
      onPruneDeviceLogs: () => undefined,
    })
    expect(markup).toContainCode('aria-label="Delete thermal recording #cal-1"')
    expect(markup).toContainCode('the preserved calibration evidence row remains')
    expect(markup).not.toContainCode('the roast record and compact curve remain')
  })
  it('explains when deletion support is unavailable instead of offering a false action', () => {
    const markup = render({ prunableLogIds: [], onPruneDeviceLogs: undefined })
    expect(markup).toContainCode('>Unavailable</strong>')
    expect(markup).toContainCode('This firmware cannot delete recordings.')
    expect(markup).toContainCode('does not provide a recording-delete action')
  })

  it('keeps exactly three bounded storage groups', () => {
    expect(render().match(/<details class="storage-group">/g)).toHaveLength(3)
  })

  it('shows device reservations and measured roast capacity', () => {
    const markup = render()
    expect(markup).toContainCode('Retention reserve')
    expect(markup).toContainCode('Room for the next recording')
    expect(markup).toContainCode('Room for roughly')
    expect(markup).toContainCode('more recorded roasts')
  })

  it('surfaces failed thermal storage without changing the roast result', () => {
    const markup = render({ status: status({ logArchive: { ...status().logArchive!, lostLogs: 2 } }) })
    expect(markup).toContainCode('2 recordings could not be saved')
    expect(markup).toContainCode('The roasts ran')
  })

  it('offers one explicit format action only when the device says the volume needs it', () => {
    const needsFormat = status({
      logArchive: { ...status().logArchive!, mounted: false, needsFormat: true },
      dataStore: { ...status().dataStore!, mounted: false },
    })
    const markup = render({ status: needsFormat, onFormatStorage: async () => 'formatted' })
    expect(markup.match(/Format storage/g)).toHaveLength(2)
    expect(markup).toContainCode('Format storage before recording')
    expect(markup).toContainCode('profiles, beans, roasts, recordings, and calibrations')
    expect(markup).not.toContainCode('Back up now')
    expect(markup).not.toContainCode('Retention reserve')
    expect(SOURCE).toContainCode('window.confirm(')
    expect(SOURCE).toContainCode(
      'This permanently erases all profiles, beans, roasts, recordings, and calibrations on the roaster',
    )
    expect(render({ onFormatStorage: async () => 'formatted' })).not.toContainCode('Format storage')
  })

  it('fails closed on generic incomplete maintenance because it may be a partial backup restore', () => {
    const recovering = status({
      restoreMaintenance: { active: false, incomplete: true },
    })
    const markup = render({ status: recovering, onFormatStorage: async () => 'recovered' })
    expect(markup).toContainCode('Storage maintenance was interrupted')
    expect(markup).toContainCode('partial backup restore')
    expect(markup).toContainCode('Restart storage setup')
    expect(markup).not.toContainCode('Back up now')
    expect(SOURCE).toContainCode('A fresh format safely starts over')
  })

  it('uses the restore idle gate for recovery formatting', () => {
    const markup = render({
      status: status({ logArchive: { ...status().logArchive!, needsFormat: true } }),
      onFormatStorage: async () => 'formatted',
      restoreBlockedReason: 'Wait until cooling finishes.',
    })
    expect(markup).toContainCode('Wait until cooling finishes.')
    expect(markup).toMatch(/<button type="button" class="secondary-button" disabled>Format storage<\/button>/)
  })

  it('offers one complete backup action', () => {
    const markup = render({ dataSync: sync({ lastExportedAt: '2026-07-27T12:00:00.000Z' }) })
    expect(markup.match(/Back up now/g)).toHaveLength(1)
    expect(markup).toContainCode('One zip file containing every profile')
    expect(markup).not.toContainCode('Last backed up: never')
  })

  it('uses one persistent restore button, then a validated modal confirmation', () => {
    const markup = render({ onRestoreBackup: async () => 'restored' })
    expect(markup.match(/Restore from backup/g)).toHaveLength(1)
    expect(markup).toMatch(/<input type="file"[^>]*hidden[^>]*aria-label="Backup file to restore"/)
    expect(markup).toContainCode('validates it and shows its contents before anything can be written')
    expect(markup).not.toContainCode('Confirm restore')
    expect(SOURCE).toContainCode('ref={restoreDialog} className="diff-dialog storage-confirm-dialog" role="dialog"')
    expect(SOURCE).toContainCode('querySelectorAll<HTMLElement>')
    expect(SOURCE).toContainCode("event.key !== 'Tab'")
    expect(SOURCE).toContainCode('Replace data and restore')
    expect(markup).not.toContainCode('RESTORE')
    expect(markup).not.toContainCode('type="text"')
  })

  it('disables restore while the roaster is busy', () => {
    const markup = render({
      onRestoreBackup: async () => 'restored',
      restoreBlockedReason: 'Wait until cooling finishes.',
    })
    expect(markup).toContainCode('Wait until cooling finishes.')
    expect(markup).toMatch(/aria-label="Backup file to restore"[^>]*disabled/)
  })

  it('uses one compact type selector and one persistent import button', () => {
    const markup = render({ onExportType: async () => 'exported', onImportBackup: async () => 'imported' })
    expect(markup).toContainCode('<select aria-label="Data type"')
    expect(markup.split('>Export</button>').length - 1).toBe(1)
    expect(markup).toMatch(/<input type="file"[^>]*hidden[^>]*aria-label="Data export to import"/)
    expect(markup.split('>Import</button>').length - 1).toBe(1)
    expect(markup).not.toContainCode('Confirm import')
    expect(SOURCE).toContainCode('ref={importDialog} className="diff-dialog storage-confirm-dialog" role="dialog"')
    expect(SOURCE).toContainCode('Existing records with matching identities will be updated')
  })

  it('omits browser quota because only roaster capacity is actionable', () => {
    const markup = render()
    expect(markup).not.toContainCode('Browser cache:')
    expect(markup).not.toContainCode('quota')
  })

  it('offers accessible item-level deletion for every stored data kind', () => {
    const markup = render({
      prunableLogIds: ['1'],
      onPruneDeviceLogs: () => undefined,
      onDeleteRun: () => undefined,
      onDeleteProfile: () => undefined,
      onDeleteBean: () => undefined,
      onDeleteCalibrationSnapshot: () => undefined,
      snapshots: [
        {
          id: 'cal-1',
          name: '225 g baseline',
          createdAt: '2026-07-20T00:00:00.000Z',
          runIds: [],
          patch: {},
          curves: [],
        },
      ] as never,
    })
    expect(markup).toContainCode('aria-label="Delete thermal recording #1"')
    expect(markup).toContainCode('aria-label="Delete roast record Roast run-a"')
    expect(markup).toContainCode('aria-label="Delete profile House espresso"')
    expect(markup).toContainCode('aria-label="Delete bean lot House Huila"')
    expect(markup).toContainCode('aria-label="Delete saved calibration 225 g baseline"')
  })

  it('does not invent a browser library when device storage is absent', () => {
    const markup = render({ status: status({ dataStore: undefined }) })
    expect(markup).toContainCode('did not report its storage details')
    expect(markup).not.toContainCode('Back up now')
  })
})

describe('the delete impact panel', () => {
  const impact = (props: Partial<Parameters<typeof DeleteImpactPanel>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(DeleteImpactPanel, {
        subject: 'profile',
        id: 'profile-1',
        name: 'House espresso',
        runs: RUNS,
        runBytes: { 'run-a': 2048, 'run-b': 2048 },
        deviceLogs: LOGS,
        onDeleteEntity: () => undefined,
        onCascade: async () => 'done',
        ...props,
      }),
    )

  /**
   * Not "0 linked roasts, 0 B on the roaster". "Linked" is the schema's word for a relationship
   * nobody made, and a row of zeroes reports storage as though it were an impact. Both cases are
   * pinned here as SENTENCES.
   */
  it('leads with what has used this profile, then with what that costs', () => {
    const markup = impact()
    expect(markup).toContainCode('2 roasts used this profile')
    expect(markup).toContainCode('on the roaster')
    expect(markup).not.toContainCode('linked roast')
    // Both ends of the range, because "2 roasts" is not something anyone can weigh.
    expect(markup).toContainCode('2026')
  })

  it('is a summary until it is asked, so a delete is never one click away', () => {
    const markup = impact()
    expect(markup).toContainCode('Delete this profile')
    expect(markup).not.toContainCode('cannot be undone')
  })

  it('says the empty case in words rather than reporting a pair of zeroes', () => {
    const markup = impact({ id: 'profile-9', name: 'Unused' })
    expect(markup).toContainCode('No roasts have used this profile yet')
    expect(markup).toContainCode('Nothing is stored on the roaster for it')
    expect(markup).not.toContainCode('0 linked roasts')
    expect(markup).not.toContainCode('0 B on the roaster')
  })

  it('uses the same wording for a bean lot, because it is the same sentence', () => {
    const markup = impact({ subject: 'bean', id: 'bean-9', name: 'Unused lot' })
    expect(markup).toContainCode('No roasts have used this bean lot yet')
  })
})

/**
 * All-or-nothing rendering: until the roaster's recording list has been read once, the recordings
 * section is an explicit loading state - never an empty archive that
 * later mutates into a populated one.
 */
describe('recordings render all-or-nothing', () => {
  it('says it is reading the list instead of claiming no recordings exist', () => {
    const markup = render({ deviceLogs: [], deviceLogsListed: false })
    expect(markup).toContainCode('Reading the roaster')
    expect(markup).toContainCode('Reading…')
    expect(markup).not.toContainCode('No thermal recordings.')
  })

  it('renders the complete list once it has been read, and an honest empty state when truly empty', () => {
    expect(render()).toContainCode('thermal recording')
    expect(render({ deviceLogs: [], importedLogIds: [], runs: [] })).toContainCode('No thermal recordings.')
  })
})
