import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { demoRuns, starterBean } from '../data/demo'
import type { BeanRevision } from '../domain/types'
import { BeansView } from './BeansView'

const noop = () => undefined
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

const revisions: BeanRevision[] = [
  { id: 'b1', beanId: starterBean.id, savedAt: '2026-05-02T09:00:00.000Z', summary: 'Created', bean: starterBean },
  {
    id: 'b2',
    beanId: starterBean.id,
    savedAt: '2026-06-11T09:00:00.000Z',
    summary: 'origins "Colombia, Huila" → "Colombia"; moisture 10.5 → 10.1',
    bean: starterBean,
  },
]

const render = (props: Partial<Parameters<typeof BeansView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(BeansView, {
      beans: [starterBean],
      runs: demoRuns,
      revisions,
      selectedId: starterBean.id,
      onSelect: noop,
      onSave: noop,
      onDelete: noop,
      onDirtyChange: noop,
      onOpenRun: noop,
      ...props,
    }),
  )

/**
 * Clicking a row expands its inline detail; clicking the roast name goes to History focused on that
 * roast. Both tables on this page pass a `detail`, so the row gesture is never inert.
 */
describe('catalog mutation availability', () => {
  it('disables persistent actions with a visible explanation while the roaster is unavailable', () => {
    const reason = 'The roaster library is temporarily unavailable.'
    const markup = render({ mutationBlockedReason: reason })
    expect(markup).toContain(reason)
    // A local New draft is still safe; only a real working edit needs the blocking explanation.
    expect(markup).not.toContain('This bean cannot be saved yet.')
    expect(markup).not.toContain('aria-describedby="bean-save-blocker"')
    expect(markup).not.toMatch(/disabled[^>]*>.*New lot/)
    expect(markup).toMatch(/title="The roaster library is temporarily unavailable\." disabled[^>]*>.*Save/)
  })

  it('uses a full text keyboard so density calculations can contain a slash', () => {
    expect(render()).toMatch(/aria-label="Green bulk density \(g\/ml\)"[^>]*inputmode="text"/)
  })

  it('renders bean rows with the same persisted drag affordance as profiles', () => {
    const markup = render()
    expect(markup).toContain('data-bean-id')
    expect(markup).toContain('Drag or use the arrow keys to reorder')
    expect(markup).toContain(`Reorder ${starterBean.name}`)
  })
})

/**
 * When defining a new bean, the name field belongs inside the create/edit form, not at the top of
 * the lot list. The name is edited with every other field - label above, control, one quiet help
 * line, the app's one form idiom - and the sheet heading only DISPLAYS the name.
 */
describe('the bean name is edited inside the form', () => {
  it('renders the name field inside the bean fields with the shared label idiom', () => {
    const markup = render()
    const fields = markup.slice(markup.indexOf('class="bean-fields"'))
    expect(fields).toContain('aria-label="Bean lot name"')
    expect(fields).toContain('class="bean-name-field">Name<input')
    expect(fields).toContain('class="field-hint"')
  })

  it('leaves the heading as a display of the name, never an input', () => {
    const markup = render()
    const heading = markup.slice(markup.indexOf('bean-editor-heading'), markup.indexOf('class="bean-fields"'))
    expect(heading).toContain(`<h2 class="bean-title">${starterBean.name}</h2>`)
    expect(heading).not.toContain('<input')
    expect(markup).not.toContain('title-input')
  })

  it('gives the name the whole first form row, phone and desktop alike', () => {
    expect(styles).toContain('.bean-fields .bean-name-field { grid-column: 1 / -1; }')
    expect(styles).toContain('.bean-fields .field-hint {')
  })
})

describe('the roast history table on a bean lot', () => {
  /* A static render opens no rows, so what is assertable is that the affordance exists at all -
     which is exactly what was missing: no `detail`, no expand column, no gesture. */
  it('gives each row a detail to expand into', () => {
    const markup = render()
    expect(markup).toContain('row-expand')
    expect(markup).toContain('aria-label="Expand row"')
  })

  it('uses the roast name as the only History action', () => {
    expect(render()).toMatch(/<button type="button" class="link-button" title="Open [^"]+ in History"/)
    const detailSource = readFileSync(new URL('./CatalogRoastDetail.tsx', import.meta.url), 'utf8')
    expect(detailSource).not.toContain('<button type="button" className="compact-button"')
    expect(detailSource).not.toContain('onClick={() => onOpen(run)}')
  })
})

/**
 * The heading is "Revision history". One name for one thing: a bean's saves and a profile's saves
 * are the same idea, and calling them different things on the two catalogs makes the user learn
 * the app's filing rather than their own.
 */
describe('the bean revision history', () => {
  it('is called Revision history, in the same words the profiles page uses', () => {
    const markup = render()
    expect(markup).toContain('Revision history')
    expect(markup).not.toContain('Edit history')
    expect(markup).toContain('2 saved revisions')
  })

  it('shows what a field was and what it became, not only which field moved', () => {
    const markup = render()
    // Quotes arrive HTML-escaped; the pairing is what is being pinned.
    expect(markup).toContain('origins &quot;Colombia, Huila&quot; → &quot;Colombia&quot;')
    expect(markup).toContain('moisture 10.5 → 10.1')
  })

  it('says so plainly when a lot has no history yet', () => {
    const markup = render({ revisions: [] })
    expect(markup).toContain('No revisions recorded yet')
    expect(markup).toContain('0 saved revisions')
  })
})

/**
 * ============================================================================================
 * ONE CONTAINER TREATMENT, ON BOTH CATALOGS
 * ============================================================================================
 *
 * Beans wrapped its whole page - lot fields, roast history, revision history and the delete panel -
 * in one white card; Profiles put the same sections bare on the page tint. The decision, stated in
 * the stylesheet's header, is the device the rest of the app already uses: one sheet per record,
 * white on the tint with a 3 px accent rule. This pins the shared class rather than any pixel, so
 * the two pages cannot drift apart again without the pin noticing.
 */
describe('the catalog sheet', () => {
  it('files each section of a bean lot as its own sheet', () => {
    const markup = render()
    expect(markup).toContain('catalog-sheet bean-details')
    expect(markup).toContain('catalog-sheet bean-roasts')
    expect(markup).toContain('catalog-sheet revision-history')
  })

  it('carries the surface and the accent rule on the sheet, not on the page', () => {
    expect(styles).toMatch(/\.catalog-sheet \{[^}]*background: var\(--surface\)/)
    expect(styles).toMatch(/\.catalog-sheet \{[^}]*border-top: 3px solid var\(--sheet-accent\)/)
    // The page-wide card is gone: the workspace column is a stack, and holds no surface itself.
    expect(styles).toMatch(/\.bean-editor \{ min-width: 0; \}/)
  })

  it('pads the nested count and Filter toolbar inside both catalog sheets', () => {
    expect(styles).toContain('.profile-roasts > .data-table > .data-table-toolbar,')
    expect(styles).toContain('.bean-roasts > .data-table > .data-table-toolbar { padding: 8px 16px 0; }')
  })
})
