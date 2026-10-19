import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const roast = readFileSync(new URL('./RoastView.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

describe('completed roast details have a real commit boundary', () => {
  it('claims success only after roaster acknowledgement and guards the working draft', () => {
    // The payload is read from the ref AFTER the blur that commits the focused field, and exactly
    // that payload is what is then marked saved.
    const blur = roast.indexOf('document.activeElement.blur()', roast.indexOf('const saveCompletedDetails'))
    const readRef = roast.indexOf('const sent = detailsDraftRef.current', blur)
    const awaitAck = roast.indexOf('await onSaveDetails(sentMeasurements, sent.notes, sent.score)')
    const claimSaved = roast.indexOf("setDetailsSaveState(draftIsWhatWasSent ? 'saved' : 'dirty')", awaitAck)
    expect(blur).toBeGreaterThan(-1)
    expect(readRef).toBeGreaterThan(blur)
    expect(awaitAck).toBeGreaterThan(readRef)
    expect(claimSaved).toBeGreaterThan(awaitAck)
    expect(roast).toContainCode('savedMeasurements: sentMeasurements, savedNotes: sent.notes, savedScore: sent.score')
    expect(roast).not.toContainCode('setDetailsSaved(true)')
    expect(roast).toContainCode('Saved on the roaster</span>')
    expect(roast).toContainCode('detailsDirty && !window.confirm(LEAVE_WITHOUT_SAVING)')
    // Key order is not a change: clearing and re-entering a field must not read as dirty.
    expect(roast).toContainCode('!stableEquals(detailsDraft.measurements, detailsDraft.savedMeasurements)')
    expect(roast).not.toContainCode('JSON.stringify(detailsDraft.measurements)')

    expect(app).toContainCode('const accepted = await updateRun(id, { measurements, notes, score }, true)')
    expect(app).toContainCode("(view === 'roast' && (roastDetailsDirty || manualPlanDirty))")
    expect(app).toContainCode("(view === 'history' && historyDirty)")
    expect(app).toContainCode('onDirtyChange={setHistoryDirty}')
    expect(app).toContainCode('onDetailsDirtyChange={setRoastDetailsDirty}')
    expect(roast).toContainCode('onPlannedStepsDirtyChange?.(manualRunning && plannedManualSteps.length > 0)')
    expect(roast).toContainCode('onPlannedStepsDirtyChange?.(false)')
    expect(app).toContainCode('onPlannedStepsDirtyChange={setManualPlanDirty}')
  })
})
