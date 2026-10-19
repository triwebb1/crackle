import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { navigationClearsDirty, navigationNeedsConfirm } from './App'

const SOURCE = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

/** The body of one `const name = ...` declaration in App.tsx, up to the next blank-line-separated declaration. */
const declaration = (name: string, until: string): string => {
  const start = SOURCE.indexOf(`const ${name} = `)
  expect(start, `${name} is declared`).toBeGreaterThanOrEqual(0)
  const end = SOURCE.indexOf(until, start + 1)
  expect(end, `${name} ends before ${until}`).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

/**
 * Design rule: the unsaved-changes guard fires only for work that exists nowhere but the open tab,
 * and that work lives in the editor of the CURRENT VIEW. Moving within one view keeps the editor.
 */
describe('the unsaved-work guard is about leaving a view', () => {
  it('asks only when the view changes and something is unsaved', () => {
    expect(navigationNeedsConfirm('history', 'history', true)).toBe(false)
    expect(navigationNeedsConfirm('history', 'profiles', true)).toBe(true)
    expect(navigationNeedsConfirm('history', 'profiles', false)).toBe(false)
  })

  it('keeps the dirty flags for History-to-History navigation, so the next real leave still asks', () => {
    // #/history/run-A -> #/history: the view is unchanged, the editor's dirty flag must survive.
    expect(navigationClearsDirty('history', 'history')).toBe(false)
    expect(navigationClearsDirty('history', 'roast')).toBe(true)
  })

  it('applies the same rule on Back/Forward as on in-app navigation', () => {
    const popstate = declaration('restore', "window.addEventListener('popstate', restore)")
    expect(popstate).toContainCode('navigationNeedsConfirm(current.view, next.view, unsavedRef.current)')
    expect(popstate).toContainCode('if (navigationClearsDirty(current.view, next.view)) clearDirtyFlags()')
    const navigate = declaration('navigate', 'Back and Forward')
    expect(navigate).toContainCode('if (navigationClearsDirty(current.view, next)) clearDirtyFlags()')
    expect(navigate).toContainCode('return false')
    expect(navigate).toContainCode('return true')
  })
})

/** A hand-off must ask BEFORE it changes anything, so Cancel leaves nothing applied. */
describe('hand-offs ask before they mutate', () => {
  it('Use as profile asks before staging the revision', () => {
    const body = declaration('useRunAsProfile', 'const roastAgain')
    expect(body.indexOf("leaveAllowed('profiles')")).toBeGreaterThan(-1)
    expect(body.indexOf("leaveAllowed('profiles')")).toBeLessThan(body.indexOf('setPendingRevision(run)'))
    expect(body).toContainCode("navigate('profiles', undefined, { confirmed: true })")
  })

  it('Roast again asks before it closes the session or changes selections', () => {
    const body = declaration('roastAgain', 'const abandonSession')
    const ask = body.indexOf("leaveAllowed('roast')")
    expect(ask).toBeGreaterThan(-1)
    for (const effect of [
      'setRepeatRoastSetup(',
      'setSelectedRoastId(',
      'setActiveRunId(undefined)',
      'setManualMode(false)',
    ]) {
      expect(body.indexOf(effect), effect).toBeGreaterThan(ask)
    }
    expect(body).toContainCode("navigate('roast', undefined, { confirmed: true })")
  })

  it('Use as calibration evidence asks before recording the pending roast', () => {
    expect(SOURCE).toContainCode(
      "onUseManualAsCalibrationEvidence={() => { if (activeSession && leaveAllowed('calibrate')) { setPendingCalibrationRoastId(activeSession.id); navigate('calibrate', undefined, { confirmed: true }) } }}",
    )
  })

  it('Save new profile asks about unsaved roast details before saving or closing anything', () => {
    const body = declaration('saveManualProfile', '/** Reconcile a fault/lease/expiry ending')
    const ask = body.indexOf("if (!leaveAllowed('profiles')) return")
    expect(ask).toBeGreaterThan(-1)
    expect(ask).toBeLessThan(body.indexOf('await saveProfile(profile)'))
    expect(ask).toBeLessThan(body.indexOf('setActiveRunId(undefined)'))
    expect(body).toContainCode("navigate('profiles', undefined, { confirmed: true })")
  })
})

describe('a Start whose outcome is unknown keeps its staged record', () => {
  it('handles cleanup "kept" before any removal branch, in both Start paths', () => {
    const matches = SOURCE.match(/cleanup === 'kept'/g) ?? []
    expect(matches.length).toBe(2)
    const device = declaration('startDeviceRoast', 'Attach the recording identity')
    const kept = device.indexOf("outcome.cleanup === 'kept'")
    expect(kept).toBeGreaterThan(-1)
    expect(kept).toBeLessThan(device.indexOf("outcome.cleanup === 'removed'"))
    // Marked started, so a retry never reuses - and a refused retry never deletes - that record.
    expect(device.slice(kept, device.indexOf("outcome.cleanup === 'removed'"))).toContainCode('started: true')
  })
})

describe('manual working overlay composes against the latest run', () => {
  it('reads the latest run through refs, never the render-time runs closure', () => {
    const body = declaration('updateRun', 'const saveMeasurements')
    expect(body).toContainCode('manualWorkingRunRef.current')
    expect(body).toContainCode('runsRef.current.find(')
    expect(body).not.toMatch(/\bruns\.find\(/)
    expect(body).toContainCode("typeof patchOrBuild === 'function' ? patchOrBuild(current) : patchOrBuild")
  })

  it('builds the Apply patch from the latest working run, so a late ack cannot undo Stop', () => {
    expect(SOURCE).toContainCode('const patch = (latest: RoastRun): Partial<RoastRun> => ({')
    expect(SOURCE).toContainCode('changes: [...(latest.manualRoast?.changes ?? appliedSession.changes), change]')
  })
})

describe('restore refuses to commit a partial library', () => {
  it('throws into the incomplete-maintenance path before committing when a document failed', () => {
    const body = declaration('restoreFromBackup', 'Merge a file into the library')
    const refuse = body.indexOf(
      'if (restoreLeftDocumentsMissing(outcome).length > 0) throw new Error(incompleteRestoreMessage(outcome))',
    )
    expect(refuse).toBeGreaterThan(-1)
    expect(refuse).toBeLessThan(body.indexOf('await crackleData.reconcileDeviceRestore()'))
  })
})

describe('the cascade reports a failed final delete', () => {
  it('propagates a false entity delete as a failure and reads deletes through a ref', () => {
    const body = declaration('cascadeDelete', 'BACKUP, RESTORE, AND ONE KIND AT A TIME')
    expect(body).toContainCode('entityDeleteRef.current.deleteProfile(plan.id)')
    expect(body).toContainCode('if (!entityDeleted)')
    expect(body).toContainCode('throw new Error(')
  })
})
