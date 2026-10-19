import { describe, expect, it } from 'vitest'
import { HOME, parseRoute, type Route, routeHash, sameRoute } from './routing'
import type { AppView } from './types'

const VIEWS: AppView[] = ['roast', 'history', 'beans', 'profiles', 'manual', 'calibrate', 'reference', 'settings']

/**
 * The round trip is the contract. Everything the Back button does rests on "the address the app
 * wrote is the address it reads back", so that is what is pinned here rather than any DOM call.
 */
describe('view addresses', () => {
  it('gives every screen an address, and reads every one of them back', () => {
    for (const view of VIEWS) {
      expect(routeHash({ view })).toBe(`#/${view}`)
      expect(parseRoute(routeHash({ view }))).toEqual({ view })
    }
  })

  it('carries the History deep link, which is the one focus that is a place', () => {
    const route: Route = { view: 'history', runId: 'run-2026-07-14-a' }
    expect(routeHash(route)).toBe('#/history/run-2026-07-14-a')
    expect(parseRoute('#/history/run-2026-07-14-a')).toEqual(route)
  })

  it('escapes and unescapes an id rather than trusting it to be URL-safe', () => {
    const route: Route = { view: 'history', runId: 'run/one two' }
    expect(routeHash(route)).toBe('#/history/run%2Fone%20two')
    expect(parseRoute(routeHash(route))).toEqual(route)
  })

  /**
   * A focus id only means something on History. Left on any other address it would be a value the
   * app could not act on and would silently carry around, so it is dropped where it is written.
   */
  it('refuses a focus id on a screen that has nothing to focus', () => {
    expect(routeHash({ view: 'beans', runId: 'run-1' })).toBe('#/beans')
    expect(parseRoute('#/beans/run-1')).toEqual({ view: 'beans' })
  })

  it('lands a cold, empty or mangled address on the same screen a cold load opens', () => {
    for (const hash of ['', '#', '#/', '#/nowhere', '#/history-ish', 'garbage', '#/%E0%A4%A']) {
      expect(parseRoute(hash), hash).toEqual(HOME)
    }
    // A broken escape inside a real view is a broken link, not a broken app: the screen still opens.
    expect(parseRoute('#/history/%E0%A4%A')).toEqual({ view: 'history' })
  })

  it('tolerates the fragment with or without its leading slash', () => {
    expect(parseRoute('#roast')).toEqual({ view: 'roast' })
    expect(parseRoute('#/roast')).toEqual({ view: 'roast' })
  })

  /**
   * The push-loop guard, stated as data. Navigating to where you already are must write no history
   * entry at all, or a Back press would appear to do nothing while the app quietly unwound a stack
   * of identical states.
   */
  it('knows when two routes are the same place', () => {
    expect(sameRoute({ view: 'beans' }, { view: 'beans' })).toBe(true)
    expect(sameRoute({ view: 'beans' }, { view: 'profiles' })).toBe(false)
    expect(sameRoute({ view: 'history' }, { view: 'history', runId: 'run-1' })).toBe(false)
    expect(sameRoute({ view: 'history', runId: 'run-1' }, { view: 'history', runId: 'run-2' })).toBe(false)
    expect(sameRoute({ view: 'history', runId: 'run-1' }, { view: 'history', runId: 'run-1' })).toBe(true)
  })
})
