import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { demoRuns, starterProfile, starterThermalIntent } from '../data/demo'
import type { ProfileRevision } from '../domain/types'
import {
  COOLING_BAND_LABEL,
  caretRun,
  coolingLabelFits,
  coolingLabelWidth,
  LIMIT_CARET_PITCH,
  ProfileEditor,
} from './ProfileEditor'

// The same deliberately narrow server-render smoke test the Calibrate and Manual screens have.
// There is no controller status here at all: authoring a profile does not touch hardware, which is
// exactly why the executability banner lives on the Roast page.
const revisions: ProfileRevision[] = [
  {
    id: 'r1',
    profileId: starterThermalIntent.id,
    revision: 1,
    savedAt: '2026-05-01T09:00:00.000Z',
    summary: 'Created',
    profile: starterThermalIntent,
  },
  {
    id: 'r2',
    profileId: starterThermalIntent.id,
    revision: 2,
    savedAt: '2026-06-14T09:00:00.000Z',
    summary: 'zone 2 duration 2:00 → 2:30; notes (none) → "Softer approach."',
    profile: starterThermalIntent,
  },
  {
    id: 'r3',
    profileId: starterProfile.id,
    revision: 4,
    savedAt: '2026-06-20T09:00:00.000Z',
    summary: 'Heat step 3: 5.0 → 6.5',
    profile: starterProfile,
  },
]

const render = (props: Partial<Parameters<typeof ProfileEditor>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ProfileEditor, {
      profiles: [starterProfile, starterThermalIntent],
      selectedId: starterProfile.id,
      suggestions: { intents: ['Medium espresso'] },
      runs: demoRuns,
      calibration: defaultCalibration,
      revisions,
      snapshots: [],
      defaultMassG: 225,
      onRevisionConsumed: () => undefined,
      onSelect: () => undefined,
      onSave: () => undefined,
      onExport: () => undefined,
      onDirtyChange: () => undefined,
      onReorder: () => undefined,
      onOpenRun: () => undefined,
      ...props,
    }),
  )

const journey = (props: Partial<Parameters<typeof ProfileEditor>[0]> = {}) =>
  render({ selectedId: starterThermalIntent.id, ...props })

describe('profiles screen render', () => {
  it('keeps working edits local and explains why persistent actions are unavailable', () => {
    const reason = 'Waiting for the roaster to confirm its current library.'
    const markup = render({ mutationBlockedReason: reason })
    expect(markup).not.toContainCode('<span class="dirty-tag"')
    expect(markup).not.toContainCode('Your working edits remain in this browser.')
    expect(markup).toContainCode('aria-label="Duplicate profile" title="Duplicate into a local draft"')
    expect(markup).toContainCode('title="Create a new timed-control draft"')
    expect(markup).toContainCode('title="Create a new temperature-journey draft"')
  })
  it('opens an unsaved temperature-journey draft when the controller library has no profiles', () => {
    const markup = render({ profiles: [], selectedId: '' })
    expect(markup).toContainCode('New temperature journey')
    expect(markup).toContainCode('No profiles saved')
    expect(markup).toContainCode('This is an untouched starter draft.')
    expect(markup).not.toContainCode('Unsaved working edits')
    expect(markup).toMatch(/class="secondary-button profile-save"[^>]*disabled[^>]*>.*Save profile/)
    expect(markup).not.toContainCode('Save revision</button>')
  })

  it('treats only an edited or explicitly created empty-catalog profile as dirty', () => {
    const source = readFileSync(new URL('./ProfileEditor.tsx', import.meta.url), 'utf8')
    expect(source).toContainCode('const dirty = explicitNewDraft || profileIsDirty(draft, selectedProfile) || fromRun')
    expect(source).toContainCode('setExplicitNewDraft(true)')
    expect(source).toContainCode('{dirty && mutationBlockedReason && <span')
  })
  it('makes Save the only ordinary dirty-state emphasis', () => {
    const markup = render()
    expect(markup).toMatch(/class="secondary-button profile-save"[^>]*disabled[^>]*>.*Save revision/)
    expect(markup).not.toContainCode('Unsaved working edits')
  })
  it('puts creating a profile in plain sight, both strategies', () => {
    const markup = render()
    expect(markup).toContainCode('New timed')
    expect(markup).toContainCode('New journey')
    expect(markup).toContainCode('Create a new timed-control draft')
    expect(markup).toContainCode('Create a new temperature-journey draft')
  })

  it('labels the duplicate action rather than leaving a bare copy glyph', () => {
    expect(render()).toContainCode('title="Duplicate into a local draft"')
  })

  it('edits timed durations as m:ss and actuator levels in half steps', () => {
    const markup = render()
    expect(markup).toContainCode('Duration (m:ss)')
    expect(markup).toContainCode('aria-label="Step 1 duration"')
    expect(markup).toContainCode('step="0.5"')
    expect(markup).not.toContainCode('Duration (min)')
  })

  it('explains timed-chart insertion and removal without hiding explicit controls', () => {
    const markup = render()
    expect(markup).toContainCode('Double-click empty chart space to insert a step')
    expect(markup).toContainCode('double-click a point to delete it')
    expect(markup).toContainCode('double-click to delete</title>')
    expect(markup).toContainCode('Add step')
    expect(markup).toContainCode('Delete step 1')
  })

  it('paints the black drag time readout over the ordinary white axis label', () => {
    const source = readFileSync(new URL('./ProfileEditor.tsx', import.meta.url), 'utf8')
    const timedEditor = source.slice(source.indexOf('function TimedLaneEditor'), source.indexOf('/** Limit fields'))
    const ordinaryTimeLabels = timedEditor.indexOf('point-time-label')
    const dragReadout = timedEditor.indexOf('drag-guides')
    expect(ordinaryTimeLabels).toBeGreaterThan(-1)
    expect(dragReadout).toBeGreaterThan(ordinaryTimeLabels)
  })

  it('renders the journey as an editable chart plus a plain zone table', () => {
    const markup = journey()
    expect(markup).toContainCode('journey-chart')
    // The chart carries a time scale and both editing affordances.
    expect(markup).toContainCode('Elapsed (m:ss)')
    expect(markup).toContainCode('Double-click empty chart to insert a zone boundary')
    // Double-click on a POINT is the delete gesture, and both the hint and the point say so.
    expect(markup).toContainCode('double-click a point to delete it')
    expect(markup).toContainCode('double-click to delete</title>')
    expect(markup).toContainCode('Add a zone at the end')
    /**
     * Limit-line grabbing, pinned at the markup boundary. A per-line pointer handler lets any filled
     * mark drawn later swallow the lines under it, making a channel's pair ungrabbable. Hit-testing
     * happens once, on the SVG, against a `limit-hit` layer that is inert to the pointer and
     * reachable by keyboard.
     */
    expect(markup).toContainCode('limit-hit')
    expect(markup).toContainCode('role="slider"')
    expect(markup).toContainCode('tabindex="0"')
    expect(markup).toContainCode('Zone 2 fan maximum')
    for (const label of [
      'Zone',
      'Start °C',
      'End °C',
      'Duration',
      'Fan min',
      'Fan max',
      'Heat min',
      'Heat max',
      'Actions',
    ]) {
      expect(markup).toContainCode(`data-label="${label}"`)
    }
    expect(markup).toContainCode('Add zone')
    // One row per zone, replacing the four-column card strip.
    expect(markup).toContainCode('zones-table')
    expect(markup).not.toContainCode('segment-strip')
    expect(markup).toContainCode('Zone 1 start C')
    expect(markup).toContainCode('Zone 5 duration')
    expect(markup).toContainCode('Delete zone 3')
    // The deferred zone limit editors landed with the table.
    expect(markup).toContainCode('Zone 2 fan minimum')
    expect(markup).toContainCode('Zone 2 heat maximum')
  })

  it('draws a real temperature y-axis: a rule, tick marks, values, and the unit once', () => {
    const markup = journey()
    expect(markup).toContainCode('temperature-axis')
    expect(markup).toContainCode('axis-rule')
    expect(markup).toContainCode('axis-tick')
    expect(markup).toContainCode('axis-unit')
    // 50° majors across the same 50-250 domain the path is drawn against.
    for (const tick of [50, 100, 150, 200, 250]) {
      expect(markup, `no ${tick} °C tick`).toContainCode(`text-anchor="end">${tick}</text>`)
    }
  })

  it('hangs the roast-color scale off that axis, from the reference data', () => {
    const markup = journey()
    // The gradient is in user space, so its endpoints are the axis scale itself.
    expect(markup).toContainCode('gradientUnits="userSpaceOnUse"')
    expect(markup).toContainCode('id="journey-roast-color"')
    // Reference colors verbatim wherever a reference stop falls inside the 50-250 °C domain.
    expect(markup).toContainCode('stop-color="#c6a85a"')
    expect(markup).toContainCode('stop-color="#211a17"')
    // The strip is the only rendering: there is no in-plot ambient tint.
    expect(markup).toContainCode('roast-color-strip')
    expect(markup).not.toContainCode('roast-color-tint')
    expect(markup).not.toContainCode('roast-color-mat')
  })

  /**
   * Defining a temperature journey needs no hardware, so the editor says nothing about whether the
   * profile is executable. The equivalent warning is pinned on the Roast page instead -
   * see `RoastView.render.test.ts`.
   */
  it('says nothing about executability, because defining a profile does not execute one', () => {
    const markup = journey()
    expect(markup).not.toContainCode('Not executable')
    expect(markup).not.toContainCode('Execution requirements met')
    expect(markup).not.toContainCode('a healthy thermocouple')
    expect(markup).not.toContainCode('comparison target only')
    // The one banner the editor still has is about the draft in front of you, not about hardware.
    expect(markup).not.toContainCode('temperature-journey runner')
  })

  /** The journey chart labels its axis per point, the same way the timed chart does. */
  it('labels the journey axis at every zone boundary, with quieter round fillers between', () => {
    const markup = journey()
    // starterThermalIntent's boundaries: 0:00, 3:30, 5:30, 7:45, 9:45, 12:45.
    for (const label of ['0:00', '3:30', '5:30', '7:45', '9:45', '12:45']) {
      expect(markup, `no ${label} boundary label`).toContainCode(`>${label}</text>`)
    }
    // Point labels are marked as such, so the styling can tell them from scaffolding.
    expect(markup).toContainCode('point-time-label')
  })

  /** Profiles carry neither explicit bean links nor a batch mass. */
  it('carries no bean-link list and no batch-mass field', () => {
    const markup = render()
    expect(markup).not.toContainCode('Linked beans')
    expect(markup).not.toContainCode('Compatible bean lots')
    expect(markup).not.toContainCode('Batch g')
    // What replaced them: the roasts this profile has actually been used for.
    expect(markup).toContainCode('Roast history')
    expect(markup).toContainCode('Which beans this profile has actually been used on')
    expect(markup).toContainCode('Revision used')
  })

  it('offers the nav as reorderable rows', () => {
    const markup = render()
    expect(markup).toContainCode('data-profile-id')
    expect(markup).toContainCode('Drag or use the arrow keys to reorder')
  })

  it('shows this profile revision history, and only this profile', () => {
    const markup = journey()
    expect(markup).toContainCode('Revision history')
    expect(markup).toContainCode('zone 2 duration 2:00 → 2:30')
    expect(markup).toContainCode('2 saved revisions')
    // The timed profile's row belongs to the timed profile.
    expect(markup).not.toContainCode('Heat step 3')
    expect(render()).toContainCode('Heat step 3: 5.0 → 6.5')
  })

  it('says so when a profile has no history yet, rather than rendering an empty table', () => {
    const markup = render({ revisions: [] })
    expect(markup).toContainCode('No revisions recorded yet')
    expect(markup).toContainCode('0 saved revisions')
  })
})

/**
 * The cooling watermark.
 *
 * A cooling zone carries a subtle "cooling" label that overlaps nothing else on the chart and is
 * layered below everything. Both halves are checkable in markup: SVG has no z-index, so "layered
 * below" is document order, and "overlaps nothing" is a fit decision taken before anything draws.
 */
describe('the cooling band watermark', () => {
  it('names the cooling band in one quiet word', () => {
    const markup = journey()
    expect(markup).toContainCode('cooling-band-label')
    expect(markup).toContainCode(`>${COOLING_BAND_LABEL}</text>`)
    // Not in the accessibility tree: the zone table already says "cooling" in readable words.
    expect(markup).toContainCode('class="cooling-zone" aria-hidden="true"')
  })

  it('paints it under every mark on the chart, which in SVG means first', () => {
    const markup = journey()
    const watermark = markup.indexOf('cooling-band-label')
    expect(watermark).toBeGreaterThan(-1)
    for (const later of ['grid-line', 'limit-carets', 'thermal-target', 'thermal-node', 'limit-hit']) {
      expect(markup.indexOf(later), `${later} is painted before the watermark`).toBeGreaterThan(watermark)
    }
  })

  it('demands clear air either side rather than filling its band edge to edge', () => {
    expect(coolingLabelFits(coolingLabelWidth() + 40)).toBe(true)
    expect(coolingLabelFits(coolingLabelWidth())).toBe(false)
  })

  /**
   * A phone narrows the viewBox instead of the glyphs, so a band that holds the word at 1000 units
   * across may not hold it at 560. Where it does not fit there is no word, which is the only reading
   * of "should not overlap with anything else" that survives every width.
   */
  it('is withheld from a band too narrow to hold it', () => {
    expect(coolingLabelFits(40)).toBe(false)
    expect(coolingLabelFits(0)).toBe(false)
  })
})

/**
 * Limit lines as carets.
 *
 * Limits draw as carets and inverted carets, like arrows pointing into the zone, with no shading.
 * The marks are presentation only; the gesture is defined by the level: `pickLimit` hit-tests the level, the invisible `limit-hit` strip sits at the level, and
 * the callout reports the level. So the carets are centred on it.
 */
describe('the journey chart limit carets', () => {
  const carets = (d: string) => d.split('M').filter((part) => part.trim().length > 0)
  const coordinates = (d: string) =>
    [...d.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))

  it('replaces the shaded range and the dashes entirely', () => {
    const markup = journey()
    expect(markup).not.toContainCode('limit-range')
    expect(markup).not.toContainCode('limit-line')
    expect(markup).toContainCode('limit-carets')
    expect(markup).toContainCode('class="limit-band fan"')
    expect(markup).toContainCode('class="limit-band heat"')
  })

  it('leaves the grab layer exactly as it was, because only the paint changed', () => {
    const markup = journey()
    expect(markup).toContainCode('limit-hit')
    expect(markup).toContainCode('role="slider"')
    expect(markup).toContainCode('aria-valuenow')
    expect(markup).toContainCode('Zone 2 fan maximum')
    // The value callout still answers hover, focus and drag, and the hint still says so.
    expect(markup).toContainCode('it shows its value on hover, focus and drag')
    expect(markup).toContainCode('the rows of carets, which point into the range that limit allows')
  })

  it('points a minimum up into what it allows and a maximum down into it', () => {
    const options = { pitch: 40, halfWidth: 5, height: 8 }
    const minimum = coordinates(caretRun(0, 100, 50, 'up', options))
    const maximum = coordinates(caretRun(0, 100, 50, 'down', options))
    // Apex above the level for a minimum: that is the arrow pointing into the allowed range.
    expect(minimum[1].y).toBe(46)
    expect(minimum[0].y).toBe(54)
    expect(maximum[1].y).toBe(54)
    expect(maximum[0].y).toBe(46)
  })

  it('centres each caret on the level, so the mark still means what pickLimit tests', () => {
    for (const direction of ['up', 'down'] as const) {
      const points = coordinates(caretRun(0, 200, 120, direction))
      const middle = (Math.min(...points.map((point) => point.y)) + Math.max(...points.map((point) => point.y))) / 2
      expect(middle).toBe(120)
    }
  })

  it('repeats along the whole line and overhangs neither end', () => {
    const run = caretRun(100, 300, 50, 'up')
    const xs = coordinates(run).map((point) => point.x)
    expect(carets(run).length).toBeGreaterThan(4)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(100)
    expect(Math.max(...xs)).toBeLessThanOrEqual(300)
  })

  /** A limit that draws nothing is a limit nobody can see or aim at, however short its zone. */
  it('still marks a zone too narrow for one whole caret', () => {
    const run = caretRun(100, 104, 50, 'down')
    expect(carets(run)).toHaveLength(1)
    const xs = coordinates(run).map((point) => point.x)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(100)
    expect(Math.max(...xs)).toBeLessThanOrEqual(104)
  })

  /** Fan max and Heat max routinely sit on the same level; a dash simply covered the dash below. */
  it('interleaves the two channels so a shared level shows both', () => {
    const apexes = (phase: number) =>
      coordinates(caretRun(0, 200, 50, 'up', { phase }))
        .filter((point) => point.y < 50)
        .map((point) => point.x)
    expect(apexes(0).length).toBeGreaterThan(2)
    expect(apexes(0)).not.toEqual(apexes(LIMIT_CARET_PITCH / 2))
    for (const at of apexes(LIMIT_CARET_PITCH / 2)) expect(apexes(0)).not.toContain(at)
  })
})

/**
 * Intent and profile notes come before the simulation snapshot, and opening the snapshot must not
 * push them to the bottom.
 *
 * The panel is mounted inside `.simulation-slot`, which is in the document whether the simulation is
 * open or shut. That is what makes the order assertable without a browser: the slot is where the
 * snapshot lands, so a slot after the fields is a snapshot after the fields in both states.
 */
describe('where the simulation snapshot lands', () => {
  for (const [name, markup] of Object.entries({ 'timed profile': render(), 'temperature journey': journey() })) {
    it(`keeps intent and notes above the snapshot on the ${name}`, () => {
      const meta = markup.indexOf('class="profile-meta"')
      const slot = markup.indexOf('class="simulation-slot"')
      expect(meta).toBeGreaterThan(-1)
      expect(markup).toContainCode('Profile notes')
      expect(slot).toBeGreaterThan(meta)
      expect(markup.indexOf('profile-roasts')).toBeGreaterThan(slot)
    })
  }

  it('never offers simulation or a goal journey for a timed profile', () => {
    const markup = render()
    expect(markup).not.toContainCode('profile-simulation-panel')
    expect(markup).not.toContainCode('Simulation goal journey')
    expect(markup).not.toContainCode('>Simulation</button>')
  })

  it('always shows simulation for a temperature journey', () => {
    expect(journey()).toContainCode('profile-simulation-panel')
  })
})

/**
 * ============================================================================================
 * LOADING A REVISION IS AN EXPLICIT ACT, AND IT LEAVES UNSAVED WORK BEHIND
 * ============================================================================================
 *
 * The row does not run the load. Reading the table is the common reason to be in it and loading is
 * the rare one, so the common gesture - a click to look, a drag to copy a summary, a stray click on
 * the way past - must never fire the destructive one. Loading is one labelled button per row and
 * nothing else.
 *
 * Loading a revision changes the current working profile, which is an unsaved change: nothing
 * reaches the roaster until Save revision, so the control says
 * what it actually touches - the editor - rather than "Restore", which would claim otherwise.
 */
describe('loading a revision back into the editor', () => {
  it('offers one labelled control per row, reachable by pointer and by keyboard', () => {
    const markup = journey()
    expect(markup).toContainCode('Load into editor')
    expect(markup).toContainCode('aria-label="Load revision 2 into the editor"')
    expect(markup).toContainCode('title="Load revision 2 into the editor"')
  })

  /**
   * The pin with teeth: the whole-row target is GONE. A static render cannot see a click handler,
   * but it can see the two things that made the row look and behave like one - the class that
   * carried the pointer cursor, and the row-level tooltip that promised the gesture.
   */
  it('leaves blank row space inert rather than making the row the target', () => {
    const markup = journey()
    expect(markup).not.toContainCode('revision-row')
    expect(markup).not.toContainCode('Click a revision to load it back into the editor')
    // The tooltip belongs to the button now, so no `<tr>` carries one.
    expect(markup).not.toMatch(/<tr[^>]*title=/)
  })

  it('says plainly that loading edits the working copy and rewrites no history', () => {
    const markup = journey()
    expect(markup).toContainCode('replaces the working copy on this page')
    expect(markup).toContainCode('an unsaved change like any other, until you press Save revision')
    expect(markup).toContainCode('never rewrites the history')
  })

  it('offers none of that when there is no history to offer', () => {
    const markup = render({ revisions: [] })
    expect(markup).not.toContainCode('Load into editor')
    expect(markup).not.toContainCode('replaces the working copy')
  })
})

/**
 * Clicking a row expands its inline detail; clicking the roast name goes to History focused on
 * that roast. Each catalog table must pass a `detail`, or the row gesture lands on nothing. `DataTable`'s interactive-descendant rule is what keeps the two apart.
 */
describe('the roast history table on a profile', () => {
  // The journey is the profile the demo archive actually has a roast against.
  it('gives each row a detail to expand into', () => {
    const markup = journey()
    expect(markup).toContainCode('row-expand')
    expect(markup).toContainCode('aria-label="Expand row"')
  })

  it('makes the roast name a link to that roast in History, not a second expand target', () => {
    const markup = journey()
    expect(markup).toMatch(/<button type="button" class="link-button" title="Open [^"]+ in History"/)
    // The opt-out is by element kind, in DataTable, so the link is a real button.
    expect(readFileSync(new URL('./DataTable.tsx', import.meta.url), 'utf8')).toContainCode(
      'closest(\'button, a, input, select, textarea, label, summary, [role="button"], [contenteditable="true"]\')',
    )
  })
})
