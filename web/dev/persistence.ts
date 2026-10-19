/**
 * The mock's state, across dev-server restarts.
 *
 * A controller that forgot its recordings and its applied coefficients every time Vite restarted
 * would be a worse development target than no controller at all: the History and Calibration screens
 * are largely about things the DEVICE remembers, and a device with amnesia cannot exercise them.
 *
 * The file is JSON, gitignored (`web/.gitignore`), and safe to delete - deleting it is how you ask
 * for a freshly seeded archive. Writes are debounced and atomic (temp file, then rename), because a
 * dev server killed with Ctrl-C mid-write must not leave a state file that cannot be parsed.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StoredLog } from './archive'
import { STATE_FILE } from './config'
import type { StoredDocument } from './dataStore'
import type { AppliedCoefficients } from './host'

export const PERSISTED_STATE_VERSION = 11 as const

export interface PersistedState {
  /** 11 reseeds the mock archive with the measured-timescale empty-chamber plant. */
  version: typeof PERSISTED_STATE_VERSION
  bootCount: number
  /** Decimal uint64, matching the device's JSON representation without precision loss. */
  stateRev?: string
  thermocoupleOffsetC?: number
  /** True means the previous process died inside a restore transaction. */
  restoreIncomplete?: boolean
  /** True once that transaction changed device-owned data and can no longer be aborted. */
  restoreDirty?: boolean
  nextLogId: number
  /** Firmware `logseq`; optional so state files written before rollover support still load. */
  lastIssuedLogId?: number
  lostLogs: number
  seeded: boolean
  logs: StoredLog[]
  applied?: AppliedCoefficients
  /** `/data`, as `[key, document]` pairs - a Map does not survive `JSON.stringify`. */
  documents?: Array<[string, StoredDocument]>
}

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const statePath = () => resolve(WEB_ROOT, STATE_FILE)

export const parsePersistedState = (text: string): PersistedState | undefined => {
  try {
    const parsed = JSON.parse(text) as PersistedState
    return parsed.version === PERSISTED_STATE_VERSION && Array.isArray(parsed.logs) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const loadState = (): PersistedState | undefined => {
  try {
    return parsePersistedState(readFileSync(statePath(), 'utf8'))
  } catch {
    // A missing file is not an error: it means "seed a fresh controller".
    return undefined
  }
}

export const saveState = (state: PersistedState) => {
  const path = statePath()
  const temporary = `${path}.tmp`
  try {
    /*
     * A superseded generation must never clobber a newer one. Editing a file under `web/dev/`
     * restarts the dev server, and for a moment the outgoing device is still shutting down while
     * the incoming one is already running - and the incoming one has the higher boot count by
     * construction, because it is the one that just read this file and added to it.
     */
    const existing = loadState()
    if (existing && existing.bootCount > state.bootCount) return
    writeFileSync(temporary, JSON.stringify(state))
    renameSync(temporary, path)
  } catch {
    // Persistence is a convenience here. A dev server must never fail because it could not write it.
  }
}

export const statePathForDisplay = () => STATE_FILE
