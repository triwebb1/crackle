import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_RETRY_DELAYS_MS,
  archiveImportDisposition,
  archiveRetryDelayMs,
  catalogActivityBlockedReason,
  expectedDocumentStorageDeferral,
  obsoleteRecoveredStorageAlert,
  retryableManualHistoryFailure,
  visibleGlobalStorageError,
} from './App'
import type { ControllerStatus } from './domain/types'

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: Date.now(),
  firmwareVersion: 'test',
  bootId: '1',
  manualLockout: false,
  thermocoupleValid: true,
  capabilities: {
    apiVersion: 'diagnostic-v1',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  ...overrides,
})

describe('catalog write activity gate', () => {
  it('allows an idle roaster with no pending recording', () => {
    expect(catalogActivityBlockedReason(status())).toBeUndefined()
  })

  it('explains every controller activity that temporarily owns flash timing', () => {
    expect(catalogActivityBlockedReason(status({ manual: { active: true } }))).toContain('Manual controls')
    expect(catalogActivityBlockedReason(status({ calibration: { active: true } }))).toContain('calibration pass')
    expect(
      catalogActivityBlockedReason(
        status({ roast: { active: true, mode: 'manual', saturated: false, holdover: false } }),
      ),
    ).toContain('roast')
    expect(catalogActivityBlockedReason(status({ thermalLog: { active: true, unsaved: true } }))).toContain('recording')
  })

  it('classifies routine actuation and recording deferrals as expected working state', () => {
    expect(expectedDocumentStorageDeferral('Document storage waits until actuation finishes.')).toBe(true)
    expect(expectedDocumentStorageDeferral('Document storage waits for the current thermal recording to finish.')).toBe(
      true,
    )
    expect(expectedDocumentStorageDeferral('Bulk data waits for the current actuation or recording to finish.')).toBe(
      true,
    )
    expect(expectedDocumentStorageDeferral('The pending thermal recording could not be saved.')).toBe(false)
    expect(expectedDocumentStorageDeferral('The roaster storage did not mount.')).toBe(false)
  })

  it('retries background Controls history without presenting it as a foreground edit', () => {
    expect(retryableManualHistoryFailure('Another storage transfer is in progress. Retry shortly.')).toBe(true)
    expect(retryableManualHistoryFailure('The connection ended before this change could be confirmed.')).toBe(true)
    expect(retryableManualHistoryFailure('Document storage waits until actuation finishes.')).toBe(true)
    expect(retryableManualHistoryFailure('The roaster is out of room.')).toBe(false)
  })

  it('retries transient archive reads without erasing the last authoritative list', () => {
    expect(archiveImportDisposition('busy')).toBe('deferred')
    expect(archiveImportDisposition('unreachable')).toBe('deferred')
    expect(archiveImportDisposition('available')).toBe('complete')
    expect(archiveImportDisposition('unmounted')).toBe('complete')
    expect(archiveImportDisposition('unsupported')).toBe('complete')
  })
  /**
   * The post-roast wall: the settle-triggered list read can hit a roaster still persisting the
   * recording. A 1.5 s + 3 s budget sits entirely inside that window, and a budget that is never
   * replenished leaves later episodes with no timer at all. The schedule must out-wait a realistic
   * persist, and a browser whose post-roast panel is waiting on reconciliation must never stop
   * retrying.
   */
  it('gives one deferral episode a schedule that survives a realistic persist window', () => {
    expect(ARCHIVE_RETRY_DELAYS_MS).toEqual([1500, 3000, 6000, 12000])
    for (const [attempt, delay] of ARCHIVE_RETRY_DELAYS_MS.entries())
      expect(archiveRetryDelayMs(attempt, false)).toBe(delay)
    // The whole episode spans more than 20 s beyond the settle-triggered read - tens of seconds is
    // what a manual roast's archive takes to land, not the 4.5 s a two-step budget covers.
    expect(ARCHIVE_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThan(20000)
  })

  it('stops an ordinary episode at its budget but never abandons a waiting post-roast panel', () => {
    expect(archiveRetryDelayMs(ARCHIVE_RETRY_DELAYS_MS.length, false)).toBeUndefined()
    expect(archiveRetryDelayMs(ARCHIVE_RETRY_DELAYS_MS.length, true)).toBe(12000)
    expect(archiveRetryDelayMs(99, true)).toBe(12000)
    expect(archiveRetryDelayMs(99, false)).toBeUndefined()
  })

  it('clears only obsolete connectivity sync alerts after authoritative recovery', () => {
    expect(
      obsoleteRecoveredStorageAlert(
        'Wait for the browser to finish syncing the roaster library before making changes.',
      ),
    ).toBe(true)
    expect(obsoleteRecoveredStorageAlert('Reconnect and wait for its library before editing.')).toBe(true)
    expect(obsoleteRecoveredStorageAlert('The roaster storage did not mount.')).toBe(false)
    expect(obsoleteRecoveredStorageAlert('The formatted filesystem failed its health check.')).toBe(false)
  })

  it('never flashes routine synchronization as a global red error', () => {
    expect(
      visibleGlobalStorageError('Wait for the browser to finish syncing the roaster library before making changes.'),
    ).toBeUndefined()
    expect(
      visibleGlobalStorageError('Document storage waits for the current thermal recording to finish.'),
    ).toBeUndefined()
    expect(visibleGlobalStorageError('The roaster storage did not mount.')).toBe('The roaster storage did not mount.')
  })
})
