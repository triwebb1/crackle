import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { demoRuns, starterThermalIntent } from '../data/demo'
import type { RoastRun } from '../domain/types'
import { HistoryView } from './HistoryView'

const noop = () => undefined
const SOURCE = readFileSync(new URL('./HistoryView.tsx', import.meta.url), 'utf8')
const deviceRun: RoastRun = {
  ...demoRuns[0],
  id: 'device-roast-41',
  name: 'ethiopia-yirg',
  profile: starterThermalIntent,
  recordedOn: {
    deviceId: 'physical-1',
    modelId: 'freshroast-sr800',
    displayNameAtCapture: 'Kitchen SR800',
    simulated: false,
    firmwareVersion: '2026.07',
    identitySource: 'roaster',
  },
  deviceRoast: {
    recordingOrigin: { deviceId: 'physical-1', logId: '41' },
    storageAddress: { deviceId: 'physical-1', logId: '41' },
    name: 'ethiopia-yirg',
    bootId: '7',
    dateUnknown: true,
    zoneAttainedSec: [121, 328, null],
    profileLinked: false,
  },
}
const render = (props: Partial<Parameters<typeof HistoryView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(HistoryView, {
      runs: [deviceRun],
      onOverlay: noop,
      onDelete: noop,
      onSaveDetails: async () => undefined,
      onImport: async () => '',
      onUseAsProfile: noop,
      onRoastAgain: noop,
      ...props,
    }),
  )

describe('legacy history import acknowledgement', () => {
  it('waits for the roaster before reporting success and exposes an honest in-flight state', () => {
    expect(SOURCE).toContain('const message = await onImport(archive)')
    expect(SOURCE.indexOf('const message = await onImport(archive)')).toBeLessThan(
      SOURCE.indexOf("setImportMessage(message || 'No new roast records were added')"),
    )
    expect(SOURCE).toContain("setImportMessage('Adding history to the roaster...')")
    expect(SOURCE).toContain('disabled={importInFlight}')
    expect(SOURCE).toContain("importInFlight ? 'Adding history...' : 'Import history'")
    expect(SOURCE).toContain('finally {')
  })
})

describe('device roasts read as ordinary roast records', () => {
  it('renders the roast without imported or technical provenance banners', () => {
    const markup = render({ activeRoasterId: 'physical-1' })
    expect(markup).toContain('ethiopia-yirg')
    expect(markup).not.toContain('came in from the roaster')
    expect(markup).not.toContain('boot 7')
    expect(markup).not.toContain('date is when it was imported')
  })

  it('removes recording ids, unmatched-profile repair, and copy deletion from History', () => {
    expect(SOURCE).not.toContain('Recording {run.deviceRoast.logId}')
    expect(SOURCE).not.toContain('No profile matched its name')
    expect(SOURCE).not.toContain('Remove this copy from the roaster')
    expect(SOURCE).not.toContain('onPruneDeviceLogs([run.deviceRoast')
  })

  it('defaults to the active roaster and gives every visible row textual provenance', () => {
    const mockRun: RoastRun = {
      ...deviceRun,
      id: 'mock-roast',
      name: 'mock-only-roast',
      recordedOn: {
        ...deviceRun.recordedOn,
        deviceId: 'mock-1',
        displayNameAtCapture: 'Development mock',
        simulated: true,
      },
    }
    const markup = render({
      runs: [deviceRun, mockRun],
      activeRoasterId: 'physical-1',
      activeRoasterName: 'Kitchen SR800',
    })
    expect(markup).toContain('ethiopia-yirg')
    expect(markup).toContain('Physical')
    expect(markup).not.toContain('mock-only-roast')
    expect(markup).toContain('Roast history source')
    expect(markup.indexOf('>Filter</button>')).toBeLessThan(markup.indexOf('Roast history source'))
  })
  it('reveals a catalog-linked roast from another roaster instead of hiding the deep link', () => {
    const otherRun: RoastRun = {
      ...deviceRun,
      id: 'other-roast',
      name: 'other-roaster-roast',
      recordedOn: { ...deviceRun.recordedOn, deviceId: 'physical-2', displayNameAtCapture: 'Other SR800' },
    }
    const markup = render({ runs: [deviceRun, otherRun], activeRoasterId: 'physical-1', focusRunId: otherRun.id })
    expect(markup).toContain('other-roaster-roast')
    expect(markup).toContain('Opened from a catalog link')
    expect(markup).toContain('<option selected value="all">All roasters</option>')
  })
  it('still opens a catalog-linked roast and preserves ordinary review tools', () => {
    const markup = render({ focusRunId: deviceRun.id })
    expect(markup).toContain('expanded below')
    expect(markup).toContain('Peak temp')
    expect(SOURCE).toContain('Use as profile')
    expect(SOURCE).toContain('focusKey={focusRunId}')
  })

  it('puts the recorded live chart and a prefill-only replay action in expanded History', () => {
    expect(SOURCE).toContain('<LiveChart')
    expect(SOURCE).toContain('samples={run.samples}')
    expect(SOURCE).toContain('Temperature over time')
    expect(SOURCE).toContain('Roast again')
    expect(SOURCE).toContain('onClick={() => onRoastAgain(run)}')
  })

  it('clarifies roast-record deletion separately from detailed thermal data and keeps it on the collapsed row', () => {
    const markup = render({ activeRoasterId: 'physical-1' })
    expect(SOURCE).toContain(
      'Delete this roast record? Its detailed thermal recording, if present, remains on the roaster.',
    )
    expect(markup).toContain('aria-label="Delete roast ethiopia-yirg"')
    expect(SOURCE.indexOf("id: 'delete'")).toBeLessThan(SOURCE.indexOf('detail={(run) =>'))
    expect(SOURCE.slice(SOURCE.indexOf('detail={(run) =>'))).not.toContain('aria-label="Delete roast"')
  })

  it('still invites the first roast when history is empty', () => {
    expect(render({ runs: [] })).toContain('Start one on the Roast page')
  })
})
describe('history detail save contract', () => {
  it('keeps one merged draft until an explicit acknowledged save', () => {
    expect(SOURCE).toContain('const draft = pending.current[run.id]')
    expect(SOURCE).toContain(
      'queueDetails(run, measurements, draft?.notes ?? run.notes, draft ? draft.score : runScore(run))',
    )
    expect(SOURCE).toContain(
      'queueDetails(run, { ...(draft?.measurements ?? run.measurements) }, notes, draft ? draft.score : runScore(run))',
    )
    expect(SOURCE).toContain('await saveDetailsRef.current(runId, { ...draft.measurements }, draft.notes, draft.score)')
    // An edit returned to the stored values is not unsaved work, and History reports its dirty
    // state to the app-wide leave guard.
    expect(SOURCE).toContain('stableEquals(measurements, run.measurements ?? {})')
    expect(SOURCE).toContain('onDirtyChange?.(dirty)')
    expect(SOURCE).toContain('Save changes')
    expect(SOURCE).toContain('Try save again')
    expect(SOURCE).toContain("latest.revision === revision ? 'failed' : 'unsaved'")
    expect(SOURCE).toContain('Not saved — {saveErrors[runId]}')
    expect(SOURCE).not.toContain('SAVE_DEBOUNCE_MS')
    expect(SOURCE).not.toContain('Retrying…')
    expect(SOURCE).not.toContain('void flushPending')
  })
})
