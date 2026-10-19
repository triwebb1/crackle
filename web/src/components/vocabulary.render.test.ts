import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { demoBeans, demoProfiles, demoRuns, starterBean, starterProfile, starterThermalIntent } from '../data/demo'
import type { DataSyncState } from '../data/deviceStore'
import type { DeviceLogEntry } from '../domain/deviceLogs'
import type { ControllerStatus } from '../domain/types'
import { testLogProvenance } from '../testFixtures/provenance'
import { AppShell, LiveStrip } from './AppShell'
import { BeansView } from './BeansView'
import { CalibrationView } from './CalibrationView'
import { DeleteImpactPanel } from './DeleteImpactPanel'
import { HistoryView } from './HistoryView'
import { ManualView } from './ManualView'
import { ProfileEditor } from './ProfileEditor'
import { ReferenceView } from './ReferenceView'
import { RoastView } from './RoastView'
import { SettingsView } from './SettingsView'
import { LifecycleBadge } from './Status'
import { StoragePanel } from './StoragePanel'

/**
 * ============================================================================================
 * THE WORD THE USER NEVER SEES
 * ============================================================================================
 *
 * From the user's perspective there is no controller. There is Crackle, and the roaster machine it
 * controls.
 *
 * There are two nouns in this product's world and "controller" is neither of them. The machine is
 * the roaster; the app is Crackle, and usually needs no name at all because the user is looking
 * straight at it. "Controller" is the third thing - the board inside the roaster - and it is a fact
 * about how this was built rather than about anything the user does.
 *
 * This is the enforcement, and it is deliberately at the RENDER boundary rather than over source
 * text. Many strings that reach a screen are built in `domain/`, assembled from status fields, or
 * interpolated from a firmware message, so a grep over components would miss exactly those. What
 * is asserted is what a person can read: the text between the tags, plus every attribute a browser
 * will speak or show - `aria-label`, `title`, `placeholder`, `alt`. Class names and element names
 * are the machine's business and are excluded, which is the only exclusion here.
 *
 * There is no allow-list. If a screen has something to say about the board inside the roaster, it
 * has to find words for it - which is the whole point of the rule.
 */

const BANNED = /controller/i

const noop = () => undefined

/** Rendered text: everything between the tags, with the tags themselves removed. */
const textOf = (markup: string) => markup.replace(/<[^>]*>/g, ' ')

/** Every attribute a browser reads out loud or shows on hover. */
const spokenAttributes = (markup: string): string[] =>
  [...markup.matchAll(/\b(?:aria-label|title|placeholder|alt|aria-description)="([^"]*)"/g)].map((match) => match[1])

const readable = (markup: string): string[] => [textOf(markup), ...spokenAttributes(markup)]

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'READY',
  connected: true,
  stale: false,
  receivedAtMs: Date.now(),
  firmwareVersion: '2026-07-26.39',
  bootId: '7',
  manualLockout: false,
  thermocoupleValid: true,
  temperatureC: 24.6,
  capabilities: {
    apiVersion: 'diagnostic-v1',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  ...overrides,
})

/** The states where the old vocabulary lived: unreachable, stale, faulted, latched, mid-cool. */
const TROUBLE: Array<Partial<ControllerStatus>> = [
  {},
  { connected: false, stale: true, lifecycle: 'DISCONNECTED', thermocoupleValid: false, temperatureC: undefined },
  { stale: true, receivedAtMs: 0 },
  { fault: 'overtemperature', lifecycle: 'FAULT' },
  { manualLockout: true, lifecycle: 'MANUAL_LOCKOUT' },
  { lifecycle: 'STANDBY' },
  {
    capabilities: {
      apiVersion: 'diagnostic-v1',
      autonomousTimedPrograms: false,
      thermalExecution: false,
      diagnosticTests: false,
    },
  },
]

const LOGS: DeviceLogEntry[] = [
  { id: '41', mode: 'roast', bytes: 100 * 1024, startedAt: '2026-07-01T09:00:00.000Z', ...testLogProvenance('41') },
  { id: '42', mode: 'roast', bytes: 90 * 1024, ...testLogProvenance('42') },
]

const sync = (overrides: Partial<DataSyncState> = {}): DataSyncState => ({
  mode: 'device',
  attached: true,
  offline: false,
  waitingForIdle: false,
  queued: 0,
  runBytes: { 'roast-1': 2048 },
  ...overrides,
})

const deviceStatus = (overrides: Partial<ControllerStatus> = {}) =>
  status({
    thermocoupleOffsetC: -3,
    logArchive: { mounted: true, count: 2, usedBytes: 190 * 1024, totalBytes: 896 * 1024, clockSynced: true },
    dataStore: {
      mounted: true,
      usedBytes: 8 * 1024,
      totalBytes: 896 * 1024,
      freeBytes: 600 * 1024,
      collections: { profiles: { bytes: 4096, version: 4 } },
      runs: { count: 2, bytes: 4096 },
    },
    ...overrides,
  })

describe('connection state says what is live rather than repeating the last lifecycle', () => {
  it('labels disconnected and stale badges directly', () => {
    const disconnected = renderToStaticMarkup(createElement(LifecycleBadge, { lifecycle: 'READY', connected: false }))
    const stale = renderToStaticMarkup(
      createElement(LifecycleBadge, { lifecycle: 'READY', connected: true, stale: true }),
    )
    expect(textOf(disconnected)).toContain('OFFLINE')
    expect(textOf(disconnected)).not.toContain('READY')
    expect(textOf(stale)).toContain('STALE')
    expect(textOf(stale)).not.toContain('READY')
  })

  it('distinguishes a stale status stream from a disconnected roaster', () => {
    const stale = renderToStaticMarkup(
      createElement(LiveStrip, {
        status: status({ connected: true, stale: true }),
        nowMs: Date.now(),
        target: 'roast',
        onOpen: noop,
      }),
    )
    expect(textOf(stale)).toContain('status stale')
    expect(textOf(stale)).not.toContain('not connected')
  })
})

const roastView = (patch: Partial<ControllerStatus>, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(RoastView, {
      profile: starterProfile,
      profiles: demoProfiles,
      beans: demoBeans,
      runs: demoRuns,
      status: status(patch),
      calibration: defaultCalibration,
      ambientC: 24.5,
      elapsedSec: 0,
      samples: [],
      events: [],
      defaultMassG: 225,
      selectedBeanId: starterBean.id,
      onBean: noop,
      onProfile: noop,
      onOverlay: noop,
      onStart: noop,
      onMeasurements: noop,
      onNotes: noop,
      onCloseSession: noop,
      onAbandonSession: noop,
      revisionAvailable: true,
      onSaveRevision: noop,
      onDismissRevision: noop,
      deviceLogs: LOGS,
      importedLogIds: ['41'],
      nowMs: Date.now(),
      onRefreshStatus: noop,
      onOpenCalibrate: noop,
      ...extra,
    } as never),
  )

const settingsView = (patch: Partial<ControllerStatus>, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(SettingsView, {
      status: deviceStatus(patch),
      liveConnection: 'websocket',
      browserStorage: { usageBytes: 3 * 1024 * 1024, quotaBytes: 60 * 1024 * 1024 },
      profiles: demoProfiles,
      beans: demoBeans,
      runs: demoRuns,
      calibrationPasses: [],
      calibrationSnapshots: [],
      deviceLogs: LOGS,
      importedLogIds: ['41'],
      onExportEverything: async () => 'done',
      // Backup, restore and the per-kind transfers, so their copy is swept too - the restore block in
      // particular has the most to say about the machine, which is exactly where the word would creep in.
      onExportType: async () => 'done',
      onImportBackup: async () => 'done',
      onRestoreBackup: async () => 'done',
      prunableLogIds: ['41'],
      onPruneDeviceLogs: noop,
      storedCalibration: defaultCalibration,
      onCalibrationChange: noop,
      onOpenCalibrate: noop,
      dataSync: sync(),
      onAdoptData: async () => undefined,
      onDismissAdoption: noop,
      ...extra,
    } as never),
  )

describe('Settings routes measured calibration work to Calibrate', () => {
  it('explains the current mass-only model boundary and offers the calibration workflow', () => {
    const markup = textOf(settingsView({}))
    expect(markup).toContain('Thermal response time scales by batch mass')
    expect(markup).toContain('Volume and density are recorded as evidence')
    expect(markup).toContain('Open Calibrate')
  })
})

describe('Settings treats production as one installed roaster', () => {
  const physical = { id: 'current', name: 'This roaster', model: 'freshroast-sr800', simulated: false, connected: true }
  const mock = { id: 'mock', name: 'Development mock', model: 'crackle-sim-sr800', simulated: true, connected: true }

  it('hides target management and the redundant Physical badge when there is no choice', () => {
    const markup = settingsView(
      {},
      {
        activeRoaster: physical,
        roasterTargets: [physical],
        onActiveRoasterChange: noop,
        activeRoasterChangeBlockedReason: 'Finish cooling before switching roasters.',
      },
    )
    expect(textOf(markup)).toContain('Installed roaster')
    expect(textOf(markup)).not.toContain('Choose a roaster')
    expect(textOf(markup)).not.toContain('Physical')
    expect(textOf(markup)).not.toContain('Finish cooling before switching roasters.')
  })

  it('retains the explicit mock label and chooser when local development has two targets', () => {
    const markup = settingsView(
      {},
      {
        activeRoaster: mock,
        roasterTargets: [mock, physical],
        onActiveRoasterChange: noop,
      },
    )
    expect(textOf(markup)).toContain('Installed roaster')
    expect(textOf(markup)).toContain('Mock')
    expect(textOf(markup)).toContain('Choose a roaster')
    expect(textOf(markup)).toContain('Development mock')
    expect(textOf(markup)).toContain('This roaster')
  })
})
describe('Settings keeps thermocouple correction on the roaster', () => {
  it('shows the value reported by the roaster and explains that the browser does not apply it again', () => {
    const markup = textOf(settingsView({}, { onThermocoupleOffsetChange: async () => 'saved' }))
    expect(markup).toContain('-3.00 °C')
    expect(markup).toContain('The roaster applies this correction once')
    expect(markup).toContain('before reporting or recording temperature')
  })

  it('does not invent a value or enable editing when firmware omits the setting', () => {
    const markup = settingsView({ thermocoupleOffsetC: undefined }, { onThermocoupleOffsetChange: async () => 'saved' })
    expect(textOf(markup)).toContain('This firmware does not report its thermocouple correction')
    expect(textOf(markup)).toContain('cannot be edited here')
    expect(markup).toMatch(/aria-label="Correction \(°C\)"[^>]*disabled/)
  })

  it('states the current idle gate beside the disabled device setting', () => {
    const markup = settingsView(
      {},
      {
        onThermocoupleOffsetChange: async () => 'saved',
        thermocoupleOffsetBlockedReason: 'The roaster is cooling. Change this setting after cooling finishes.',
      },
    )
    expect(textOf(markup)).toContain('The roaster is cooling')
    expect(markup).not.toMatch(/aria-label="Correction \(°C\)"[^>]*disabled/)
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Save correction<\/button>/)
  })
})
describe('primary workflows name their scope consistently', () => {
  it('distinguishes a history transfer from a whole-device backup', () => {
    const markup = renderToStaticMarkup(
      createElement(HistoryView, {
        runs: demoRuns,
        onOverlay: noop,
        onDelete: noop,
        onSaveDetails: async () => undefined,
        onImport: async () => '',
        onUseAsProfile: noop,
      }),
    )
    expect(textOf(markup)).toContain('Import history')
    expect(textOf(markup)).toContain('Export history')
    expect(textOf(markup)).not.toContain('Export all')
    expect(spokenAttributes(markup)).toContain('Import roast history JSON')
  })

  it('gives Profiles the same page-level heading contract as every other route', () => {
    const markup = renderToStaticMarkup(
      createElement(ProfileEditor, {
        profiles: demoProfiles,
        selectedId: starterProfile.id,
        suggestions: { intents: [] },
        runs: demoRuns,
        calibration: defaultCalibration,
        revisions: [],
        snapshots: [],
        defaultMassG: 225,
        runBytes: {},
        deviceLogs: [],
        onRevisionConsumed: noop,
        onSelect: noop,
        onSave: noop,
        onExport: noop,
        onDirtyChange: noop,
        onReorder: noop,
        onOpenRun: noop,
        onDeleteProfile: noop,
        onCascadeDelete: async () => '',
      } as never),
    )
    expect(markup).toContain('<h1 class="sr-only">Profiles</h1>')
  })
})

const screens = (): Array<[string, string]> => {
  const rendered: Array<[string, string]> = []

  for (const patch of TROUBLE) {
    rendered.push([`roast ${JSON.stringify(patch)}`, roastView(patch)])
    rendered.push([`settings ${JSON.stringify(patch)}`, settingsView(patch)])
    rendered.push([
      `manual ${JSON.stringify(patch)}`,
      renderToStaticMarkup(
        createElement(ManualView, {
          status: status(patch),
          nowMs: Date.now(),
          events: [],
          onEvent: noop,
          onClearEvents: noop,
        }),
      ),
    ])
    rendered.push([
      `calibrate ${JSON.stringify(patch)}`,
      renderToStaticMarkup(
        createElement(CalibrationView, {
          status: status(patch),
          nowMs: Date.now(),
          runs: [],
          snapshots: [],
          appliedPatch: {} as never,
          appliedCalibration: defaultCalibration,
          roasts: demoRuns,
          onSaveRun: noop,
          onDeleteRun: noop,
          onSaveSnapshot: noop,
          onDeleteSnapshot: noop,
          onFetchCalibrationRecording: async () => '',
          onApply: async () => ({ ok: true }),
        } as never),
      ),
    ])
    rendered.push([
      `live strip ${JSON.stringify(patch)}`,
      renderToStaticMarkup(
        createElement(LiveStrip, {
          status: status(patch),
          nowMs: Date.now(),
          target: 'roast',
          onOpen: noop,
        }),
      ),
    ])
  }

  // A journey needs a probe and a calibration; both absent is the loudest state this screen has.
  rendered.push([
    'roast journey, no probe',
    roastView(
      { thermocoupleValid: false, temperatureC: undefined },
      { profile: starterThermalIntent, targetIntent: starterThermalIntent },
    ),
  ])

  rendered.push([
    'history',
    renderToStaticMarkup(
      createElement(HistoryView, {
        runs: demoRuns,
        onOverlay: noop,
        onDelete: noop,
        onSaveDetails: async () => undefined,
        onImport: async () => '',
        onUseAsProfile: noop,
      }),
    ),
  ])
  rendered.push([
    'history empty',
    renderToStaticMarkup(
      createElement(HistoryView, {
        runs: [],
        onOverlay: noop,
        onDelete: noop,
        onSaveDetails: async () => undefined,
        onImport: async () => '',
        onUseAsProfile: noop,
      }),
    ),
  ])

  rendered.push([
    'beans',
    renderToStaticMarkup(
      createElement(BeansView, {
        beans: [starterBean],
        runs: demoRuns,
        revisions: [],
        selectedId: starterBean.id,
        runBytes: { 'roast-1': 2048 },
        deviceLogs: LOGS,
        onSelect: noop,
        onSave: noop,
        onDelete: noop,
        onCascadeDelete: async () => 'done',
        onDirtyChange: noop,
        onOpenRun: noop,
      } as never),
    ),
  ])

  for (const profile of [starterProfile, starterThermalIntent]) {
    rendered.push([
      `profiles ${profile.id}`,
      renderToStaticMarkup(
        createElement(ProfileEditor, {
          profiles: demoProfiles,
          selectedId: profile.id,
          suggestions: { intents: [] },
          runs: demoRuns,
          calibration: defaultCalibration,
          revisions: [],
          snapshots: [],
          defaultMassG: 225,
          runBytes: { 'roast-1': 2048 },
          deviceLogs: LOGS,
          onRevisionConsumed: noop,
          onSelect: noop,
          onSave: noop,
          onExport: noop,
          onDirtyChange: noop,
          onReorder: noop,
          onOpenRun: noop,
          onDeleteProfile: noop,
          onCascadeDelete: async () => 'done',
        } as never),
      ),
    ])
  }

  rendered.push(['reference', renderToStaticMarkup(createElement(ReferenceView, {}))])

  rendered.push([
    'app shell',
    renderToStaticMarkup(
      createElement(AppShell, {
        view: 'roast',
        onView: noop,
        lifecycle: 'READY',
        status: status(),
        nowMs: Date.now(),
        readoutTarget: 'roast',
        children: null,
      }),
    ),
  ])

  // Storage, in both worlds: a roaster that keeps a library, and one that does not.
  for (const dataStore of [deviceStatus().dataStore, undefined]) {
    rendered.push([
      `storage ${dataStore ? 'device' : 'browser'}`,
      renderToStaticMarkup(
        createElement(StoragePanel, {
          status: deviceStatus({ dataStore }),
          dataSync: sync(),
          deviceLogs: LOGS,
          importedLogIds: ['41'],
          runs: demoRuns,
          profiles: demoProfiles,
          beans: demoBeans,
          calibrationPasses: [],
          snapshots: [],
          browserStorage: { usageBytes: 3 * 1024 * 1024, quotaBytes: 60 * 1024 * 1024 },
          onExportEverything: async () => 'done',
          prunableLogIds: ['41'],
          onPruneDeviceLogs: noop,
          onExportType: async () => 'done',
          onImportBackup: async () => 'done',
          onRestoreBackup: async () => 'done',
        } as never),
      ),
    ])
  }
  // And the state where a restore is refused, because the refusal is a sentence ABOUT the machine.
  rendered.push([
    'storage restore blocked',
    renderToStaticMarkup(
      createElement(StoragePanel, {
        status: deviceStatus(),
        dataSync: sync(),
        deviceLogs: LOGS,
        importedLogIds: ['41'],
        runs: demoRuns,
        profiles: demoProfiles,
        beans: demoBeans,
        calibrationPasses: [],
        snapshots: [],
        onExportEverything: async () => 'done',
        onExportType: async () => 'done',
        onImportBackup: async () => 'done',
        onRestoreBackup: async () => 'done',
        restoreBlockedReason:
          'A roast is running. Restoring erases the roaster, so it waits until the roast and its cooling have finished.',
      } as never),
    ),
  ])

  rendered.push([
    'delete impact',
    renderToStaticMarkup(
      createElement(DeleteImpactPanel, {
        subject: 'profile',
        id: starterProfile.id,
        name: starterProfile.name,
        runs: demoRuns,
        runBytes: { 'roast-1': 2048 },
        deviceLogs: LOGS,
        onDeleteEntity: noop,
        onCascade: async () => 'done',
      } as never),
    ),
  ])

  // The one offer the data layer can still raise, and the likeliest place to name the board.
  rendered.push([
    'settings adoption',
    settingsView(
      {},
      {
        dataSync: sync({ adoption: { profiles: 2, beans: 1, runs: 5, calibrationRuns: 1, snapshots: 1 } }),
      },
    ),
  ])
  rendered.push([
    'settings offline and queued',
    settingsView(
      {},
      {
        dataSync: sync({ offline: true, queued: 2, waitingForIdle: true, message: 'The roaster is out of room.' }),
      },
    ),
  ])
  rendered.push([
    'settings browser mode',
    settingsView(
      { dataStore: undefined },
      {
        dataSync: sync({ mode: 'browser', attached: false }),
      },
    ),
  ])

  return rendered
}

describe('no screen ever says "controller"', () => {
  for (const [name, markup] of screens()) {
    it(`keeps it out of every readable string on ${name}`, () => {
      for (const text of readable(markup)) {
        const offending = text.match(new RegExp(`.{0,60}${BANNED.source}.{0,60}`, 'i'))
        expect(offending?.[0], `"${name}" renders: ...${offending?.[0] ?? ''}...`).toBeUndefined()
      }
    })
  }

  /**
   * The guard would be worthless if it were passing because nothing was being rendered. Two of the
   * loudest states are checked for the words that SHOULD be there, so a screen that silently
   * stopped rendering its trouble could not also silently pass the sweep above.
   */
  it('is checking screens that actually have something to say', () => {
    // Manual computes its own blocked reason from the domain gate, so this proves the sweep reaches
    // strings that are BUILT in `domain/` rather than only the ones typed into a component.
    const manual = renderToStaticMarkup(
      createElement(ManualView, {
        status: status({ connected: false, stale: true, lifecycle: 'DISCONNECTED' }),
        nowMs: Date.now(),
        events: [],
        onEvent: noop,
        onClearEvents: noop,
      }),
    )
    expect(textOf(manual)).toContain('Controls are not connected to the roaster')
    expect(textOf(settingsView({}))).toContain('roaster')
    expect(spokenAttributes(manual).length).toBeGreaterThan(0)
  })
})
