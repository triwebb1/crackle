import { describe, expect, it } from 'vitest'
import { backupExportCompletion, recordingIdsForBackup } from './backupExportCompletion'

describe('backup export completion', () => {
  it('requires a fresh whole-volume inventory and does not refetch references already pruned from it', () => {
    expect(() => recordingIdsForBackup(true, false, [], ['41'])).toThrow(
      /recording list.*complete backup was not created/i,
    )
    expect(recordingIdsForBackup(true, true, ['7', '8'], ['8', '41'])).toEqual(['7', '8'])
    expect(recordingIdsForBackup(false, true, ['7', '8'], ['8', '41'])).toEqual(['8'])
    expect(recordingIdsForBackup(false, false, [], ['41'])).toEqual(['41'])
  })

  it('stamps only a whole backup that captured every recording', () => {
    expect(backupExportCompletion(true, 0)).toEqual({ shouldMarkExported: true, notice: '' })
    expect(backupExportCompletion(false, 0)).toEqual({ shouldMarkExported: false, notice: '' })
  })

  it('calls an export incomplete and withholds the stamp when any recording was unreadable', () => {
    const result = backupExportCompletion(true, 2)
    expect(result.shouldMarkExported).toBe(false)
    expect(result.notice).toMatch(/Incomplete backup: 2 recordings.*named in the manifest.*not marked/i)
  })
})
