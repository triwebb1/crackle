import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { setupBindsToSessionPlan } from './App'

/**
 * After a profiled roast ends, the roaster keeps reporting that session's plan until the next Start.
 * The setup may keep showing it, but an operator's explicit choice for the next roast must win, or
 * Start would quietly run the previous plan again.
 */
describe('roast setup after a profiled roast ends', () => {
  it('binds to the device plan while the roast runs, whatever was chosen', () => {
    expect(setupBindsToSessionPlan(true, 's1', 's1')).toBe(true)
  })

  it('keeps showing the ended plan until a choice is made for that session', () => {
    expect(setupBindsToSessionPlan(false, 's1', undefined)).toBe(true)
    expect(setupBindsToSessionPlan(false, 's2', 's1')).toBe(true)
  })

  it('lets a choice made after the session ended take over', () => {
    expect(setupBindsToSessionPlan(false, 's1', 's1')).toBe(false)
  })

  it('records the choice from the profile picker and from Roast again', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(app).toMatch(
      /onProfile=\{\(id\) => \{[^}]*setSetupChoiceAfterSession\(liveStatus\.roast\?\.active \? undefined : liveStatus\.roast\?\.sessionId\)/,
    )
    expect(app).toContain('setSetupChoiceAfterSession(current.roast?.sessionId)')
    expect(app).toContain('profiledDeviceSession && sessionPlanBindsSetup && displayedActiveRoastPlan')
  })
})
