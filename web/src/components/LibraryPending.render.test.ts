import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { libraryPendingReason } from '../App'
import { LibraryPending } from './LibraryPending'

/**
 * An unopened library is not an empty one. A browser opened while the roaster is running gets the
 * live-only shell, and the library is read only after the roast and its recording finish; until then
 * the catalog screens must say they are waiting instead of rendering a starter draft or "nothing
 * stored yet".
 */
describe('catalog screens before the roaster library opens', () => {
  it('names the reason only while the library is unopened', () => {
    expect(libraryPendingReason(true, true)).toBeUndefined()
    expect(libraryPendingReason(true, false)).toBeUndefined()
    expect(libraryPendingReason(false, true)).toMatch(/once the roast and its recording finish/)
    expect(libraryPendingReason(false, false)).toBe('Opening the roaster library.')
  })

  it('renders a loading state under the screen heading, with no empty-library wording', () => {
    const markup = renderToStaticMarkup(
      createElement(LibraryPending, {
        eyebrow: 'Profile workshop',
        title: 'Profiles',
        reason: libraryPendingReason(false, true)!,
      }),
    )
    expect(markup).toContainCode('<h1>Profiles</h1>')
    expect(markup).toContainCode('role="status"')
    expect(markup).toContainCode('Loading the roaster library')
    expect(markup).not.toMatch(/No profiles saved|starter draft|No roasts stored/)
  })

  it('gates Profiles, Beans, and History but leaves live screens ungated', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    for (const view of ['profiles', 'beans', 'history']) {
      expect(app).toContainCode(`{view === '${view}' && catalogPendingReason && <LibraryPending`)
      expect(app).toContainCode(`{view === '${view}' && !catalogPendingReason && `)
    }
    for (const view of ['roast', 'manual', 'calibrate', 'settings']) {
      expect(app).not.toContainCode(`{view === '${view}' && catalogPendingReason`)
    }
  })
})
