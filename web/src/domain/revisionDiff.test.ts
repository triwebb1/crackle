import { describe, expect, it, vi } from 'vitest'
import {
  beanIsDirty,
  LEAVE_WITHOUT_SAVING,
  profileFromRevision,
  profileIsDirty,
  restoreRevision,
  summarizeBeanChange,
  summarizeProfileChange,
} from './revisionDiff'
import type { BeanLot, ProfileRevision, ThermalIntent, TimedProfile } from './types'

const timed = (): TimedProfile => ({
  id: 'profile-1',
  name: 'House espresso',
  revision: 3,
  strategy: 'timed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  metadata: { intent: 'Medium espresso' },
  notes: 'Reliable.',
  points: [
    { id: 'p0', timeSec: 0, fan: 8.2, heat: 4.6 },
    { id: 'p1', timeSec: 135, fan: 7.8, heat: 5.8 },
    { id: 'p2', timeSec: 285, fan: 7.2, heat: 5 },
  ],
  coolFan: 9,
  coolDurationSec: 90,
})

const journey = (): ThermalIntent => ({
  id: 'intent-1',
  name: 'Gentle journey',
  revision: 2,
  strategy: 'thermal-intent',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  metadata: { intent: '' },
  notes: '',
  calibrationStatus: 'unavailable',
  segments: [
    { id: 'z0', startC: 25, endC: 150, durationSec: 210, fanMin: 5, fanMax: 9, heatMin: 3, heatMax: 8 },
    { id: 'z1', startC: 150, endC: 175, durationSec: 120, fanMin: 5, fanMax: 9, heatMin: 3, heatMax: 9 },
  ],
})

const bean = (): BeanLot => ({
  id: 'bean-1',
  name: 'House Huila',
  origins: ['Colombia', 'Huila'],
  lotId: 'huila-2026',
  species: 'Arabica',
  cultivars: ['Caturra'],
  process: 'Washed',
  greenDensityGPerMl: 0.55,
  moisturePercent: 10.5,
  notes: 'Starter lot.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
})

/**
 * The dirty flag decides whether the user is interrupted on the way out of a screen, so a false
 * positive is worse than no guard at all: prompting about a profile nobody touched trains people to
 * dismiss the prompt. Saving bumps `updatedAt` and `revision` on every save, so neither may count.
 */
describe('dirty detection', () => {
  it('is false for an untouched clone, whatever its save stamps say', () => {
    const stored = timed()
    expect(profileIsDirty(structuredClone(stored), stored)).toBe(false)
    expect(
      profileIsDirty({ ...structuredClone(stored), updatedAt: '2026-06-01T00:00:00.000Z', revision: 9 }, stored),
    ).toBe(false)
  })

  it('is true for any real edit, however small and however deep', () => {
    const stored = timed()
    expect(profileIsDirty({ ...structuredClone(stored), name: 'Renamed' }, stored)).toBe(true)
    const moved = structuredClone(stored)
    moved.points[1].heat = 6.2
    expect(profileIsDirty(moved, stored)).toBe(true)
    const reintented = structuredClone(stored)
    reintented.metadata.intent = 'Filter'
    expect(profileIsDirty(reintented, stored)).toBe(true)
  })

  it('treats a draft with nothing stored behind it as dirty', () => {
    expect(profileIsDirty(timed(), undefined)).toBe(true)
    expect(beanIsDirty(bean(), undefined)).toBe(true)
  })

  it('applies the same rule to bean lots', () => {
    const stored = bean()
    expect(beanIsDirty(structuredClone(stored), stored)).toBe(false)
    expect(beanIsDirty({ ...structuredClone(stored), updatedAt: '2026-07-01T00:00:00.000Z' }, stored)).toBe(false)
    expect(beanIsDirty({ ...structuredClone(stored), moisturePercent: 11 }, stored)).toBe(true)
    expect(beanIsDirty({ ...structuredClone(stored), origins: ['Colombia'] }, stored)).toBe(true)
  })
})

/**
 * Requirement: "what changed" states exactly what was and what it became, not only which field
 * changed. So every assertion below is on BOTH sides of a move. A summary that named the
 * field and stopped - `notes edited`, `Changed origins, notes` - is the defect these pin shut.
 */
describe('revision summaries', () => {
  it('names the step and the channel that moved, not just that something did', () => {
    const before = timed()
    const after = structuredClone(before)
    after.points[2].heat = 6.5
    expect(summarizeProfileChange(before, after)).toBe('Heat step 3: 5.0 → 6.5')
  })

  it('reports zone durations and endpoints in the units they are edited in', () => {
    const before = journey()
    const after = structuredClone(before)
    after.segments[1].durationSec = 150
    expect(summarizeProfileChange(before, after)).toBe('zone 2 duration 2:00 → 2:30')

    const warmer = structuredClone(before)
    warmer.segments[0].endC = 155
    warmer.segments[1].startC = 155
    expect(summarizeProfileChange(before, warmer)).toBe('zone 1 end 150 °C → 155 °C; zone 2 start 150 °C → 155 °C')
  })

  it('quotes the old and the new name rather than only the new one', () => {
    const before = timed()
    expect(summarizeProfileChange(before, { ...structuredClone(before), name: 'House filter' })).toBe(
      'name "House espresso" → "House filter"',
    )
  })

  it('shows what the notes said and what they now say', () => {
    const before = timed()
    const after = { ...structuredClone(before), notes: 'Reliable, with more development.' }
    expect(summarizeProfileChange(before, after)).toBe('notes "Reliable." → "Reliable, with more development."')
  })

  /**
   * A notes field holds four thousand characters. Both sides still have to be stated, so the SIDES
   * are what get shortened - the summary is one table row and stays one table row.
   */
  it('truncates a long text value instead of pasting it into the history', () => {
    const before = { ...timed(), notes: 'A'.repeat(200) }
    const after = { ...structuredClone(before), notes: 'B'.repeat(200) }
    const summary = summarizeProfileChange(before, after)
    expect(summary).toBe(`notes "${'A'.repeat(40)}..." → "${'B'.repeat(40)}..."`)
    expect(summary.length).toBeLessThan(120)
  })

  /** An empty value is named, because a bare pair of quotes is invisible on a screen. */
  it('says (none) for a value that was or became empty', () => {
    const before = journey()
    expect(summarizeProfileChange(before, { ...structuredClone(before), notes: 'First pass.' })).toBe(
      'notes (none) → "First pass."',
    )
    const filled = { ...journey(), metadata: { intent: 'Filter' } }
    expect(summarizeProfileChange(filled, { ...structuredClone(filled), metadata: { intent: '' } })).toBe(
      'intent "Filter" → (none)',
    )
  })

  it('combines several changes into one readable line', () => {
    const before = timed()
    const after = structuredClone(before)
    after.points[2].heat = 6.5
    after.notes = 'Reliable, with more development.'
    after.metadata.intent = 'Filter'
    expect(summarizeProfileChange(before, after)).toBe(
      'intent "Medium espresso" → "Filter"; notes "Reliable." → "Reliable, with more development."; Heat step 3: 5.0 → 6.5',
    )
  })

  it('records added and removed structure with the values that arrived or went', () => {
    const before = journey()
    const grown = structuredClone(before)
    grown.segments.push({
      id: 'z2',
      startC: 175,
      endC: 205,
      durationSec: 150,
      fanMin: 4,
      fanMax: 8,
      heatMin: 3,
      heatMax: 9,
    })
    expect(summarizeProfileChange(before, grown)).toBe('zone 3 added (175 °C → 205 °C over 2:30)')

    const shrunk = structuredClone(before)
    shrunk.segments.pop()
    expect(summarizeProfileChange(before, shrunk)).toBe('zone 2 removed (was 150 °C → 175 °C over 2:00)')

    const stepped = timed()
    const trimmed = structuredClone(stepped)
    trimmed.points.pop()
    expect(summarizeProfileChange(stepped, trimmed)).toBe('step 3 removed (was 4:45, fan 7.2, heat 5.0)')
  })

  it('condenses a sweeping edit instead of printing an essay', () => {
    const before = timed()
    const after = structuredClone(before)
    after.name = 'Renamed'
    after.metadata.intent = 'Filter'
    after.notes = 'New'
    after.coolFan = 10
    after.points = after.points.map((point) => ({ ...point, fan: point.fan + 1, heat: point.heat + 1 }))
    const summary = summarizeProfileChange(before, after)
    expect(summary).toContain('and 4 more changes')
    expect(summary.split('; ')).toHaveLength(7)
  })

  it('says so plainly when a save changed nothing', () => {
    expect(summarizeProfileChange(timed(), structuredClone(timed()))).toBe('Saved with no field changes')
    expect(summarizeBeanChange(bean(), structuredClone(bean()))).toBe('Saved with no field changes')
  })

  it('gives a bean lot the same treatment as a profile: the value, not the field name', () => {
    const before = bean()
    const after = { ...structuredClone(before), notes: 'Second bag', origins: ['Colombia'] }
    expect(summarizeBeanChange(before, after)).toBe(
      'origins "Colombia, Huila" → "Colombia"; notes "Starter lot." → "Second bag"',
    )
  })

  /** A measurement is a reading, not prose, so it is not dressed up in quotation marks. */
  it('leaves a measured bean value unquoted and names an absent one', () => {
    const before = bean()
    expect(summarizeBeanChange(before, { ...structuredClone(before), greenDensityGPerMl: 0.61 })).toBe(
      'green density 0.55 → 0.61',
    )
    expect(summarizeBeanChange(before, { ...structuredClone(before), moisturePercent: undefined })).toBe(
      'moisture 10.5 → (none)',
    )
  })
})

/**
 * Restoring a profile from its own history.
 *
 * Requirement: clicking a revision reverts the profile to that version, and if unsaved changes would
 * be lost, the same are-you-sure prompt appears.
 *
 * Both halves are pinned here, because both are decisions rather than rendering: which prompt is
 * raised and when, and what the editor is left holding afterwards. The second is the one with teeth
 * - a restore that carried the OLD revision number back into the draft would make the next save
 * append a duplicate of a number already in the table and bury everything saved since.
 */
describe('restoring a saved revision', () => {
  const stored = (): TimedProfile => ({ ...timed(), revision: 7, notes: 'Current notes.' })
  const entry = (): ProfileRevision => ({
    id: 'rev-2',
    profileId: 'profile-1',
    revision: 2,
    savedAt: '2026-02-01T00:00:00.000Z',
    summary: 'Heat step 2: 5.0->5.8',
    profile: { ...timed(), revision: 2, notes: 'How it was in February.' },
  })

  it('loads the revision content and leaves the profile identity where it is', () => {
    const restored = profileFromRevision(entry(), stored())
    expect(restored.notes).toBe('How it was in February.')
    expect(restored.id).toBe('profile-1')
    // The number the editor counts up from, so the next save appends rather than rewriting.
    expect(restored.revision).toBe(7)
    expect(restored.createdAt).toBe(stored().createdAt)
  })

  it('hands back a copy, so editing the draft cannot rewrite the history it came from', () => {
    const source = entry()
    const restored = profileFromRevision(source, stored()) as TimedProfile
    restored.points[0].heat = 9.9
    expect((source.profile as TimedProfile).points[0].heat).not.toBe(9.9)
  })

  it('reads as an ordinary unsaved edit, which is what makes Save the only way to keep it', () => {
    const current = stored()
    expect(profileIsDirty(profileFromRevision(entry(), current), current)).toBe(true)
    // Restoring what is already loaded changes nothing, and is not pretended to.
    const same = { ...entry(), profile: { ...stored(), revision: 5 } }
    expect(profileIsDirty(profileFromRevision(same, current), current)).toBe(false)
  })

  it('asks before discarding unsaved work, in the same words as leaving the screen', () => {
    const confirm = vi.fn(() => true)
    expect(restoreRevision(entry(), stored(), true, confirm)?.notes).toBe('How it was in February.')
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITHOUT_SAVING)
  })

  it('does nothing at all when that question is declined', () => {
    const confirm = vi.fn(() => false)
    expect(restoreRevision(entry(), stored(), true, confirm)).toBeUndefined()
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('never interrupts a clean draft, because there is nothing to lose', () => {
    const confirm = vi.fn(() => true)
    expect(restoreRevision(entry(), stored(), false, confirm)?.revision).toBe(7)
    expect(confirm).not.toHaveBeenCalled()
  })
})
