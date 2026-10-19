import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(new URL('./SettingsView.tsx', import.meta.url), 'utf8')

describe('Settings device authority', () => {
  it('does not expose an operator refresh action', () => {
    expect(SOURCE).not.toContainCode('Refresh from the roaster')
    expect(SOURCE).not.toContainCode('void onRefreshData()')
  })

  it('keeps only the live thermocouple correction and routes measured work to Calibrate', () => {
    expect(SOURCE).toContainCode('Save correction')
    expect(SOURCE).not.toContainCode('Device setting')
    expect(SOURCE).not.toContainCode('Simulation sensor bias')
    expect(SOURCE).not.toContainCode('Sensor lag')
    expect(SOURCE).not.toContainCode('Reference batch')
    expect(SOURCE).not.toContainCode('Electrical mapping')
    expect(SOURCE).not.toContainCode('Heat gain at 10')
    expect(SOURCE).toContainCode('Open Calibrate')
    expect(SOURCE).toContainCode('Volume and density are recorded as evidence')
  })

  it('presents the installed roaster quietly and only exposes target management when there is a choice', () => {
    expect(SOURCE).toContainCode('Installed roaster')
    expect(SOURCE).toContainCode('activeRoaster?: ActiveRoasterTarget')
    expect(SOURCE).toContainCode('const canChooseRoaster = roasterTargets.length > 1')
    expect(SOURCE).toContainCode('canChooseRoaster && <section className="roaster-targets-settings"')
    expect(SOURCE).toContainCode('activeRoaster?.simulated === true && <TargetKindBadge simulated />')
    expect(SOURCE).toContainCode('onActiveRoasterChange')
  })

  it('identifies controller-owned roaster facts and disables unsupported correction editing', () => {
    expect(SOURCE).toContainCode('Reported by roaster · ${activeRoaster.model}')
    expect(SOURCE).toContainCode('· device ${activeRoaster.id}')
    expect(SOURCE).toContainCode(
      'disabled={authoritativeThermocoupleOffset === undefined || !onThermocoupleOffsetChange || thermocoupleOffsetBusy}',
    )
  })
  it('removes browser quota and repeated library-location copy', () => {
    expect(SOURCE).not.toContainCode('Browser cache:')
    expect(SOURCE).not.toContainCode('Where the library lives')
  })

  it('uses the shared decimal storage formatter', () => {
    expect(SOURCE).toContainCode("import { formatBytes } from '../domain/storage'")
    expect(SOURCE).not.toContainCode('KiB')
    expect(SOURCE).not.toContainCode('MiB')
  })
})
