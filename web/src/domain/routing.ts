import type { AppView } from './types'

/**
 * ==============================================================================================
 * THE ADDRESS BAR IS PART OF THE APP
 * ==============================================================================================
 *
 * Requirement: the browser Back button returns to the tab or page the user was just on, rather than
 * leaving the Crackle site.
 *
 * A tabbed app that never touches history has exactly one entry in it - the load - so Back is
 * always "leave". Every in-app move writes one, and this module is the whole of the mapping
 * between what the app is showing and what the address bar says. It is pure on purpose: the
 * round trip is the part that breaks, and it is the part no browser is needed to test.
 *
 * WHY THE HASH, and not a path. The built bundle is served from the roaster's flash by a web
 * server that registers exactly three handlers - `/`, `/update` and the `/api` + `/logs` families.
 * There is no catch-all and no rewrite, so a path-style deep link (`/history/run-12`) would 404 on
 * reload or on paste, which is precisely the case a shareable URL exists for. The fragment is never
 * sent to the server at all, so `#/history/run-12` is served by `/` on every roaster, every dev
 * server and every static host, and needs no firmware change to keep working.
 *
 * WHAT IS IN A ROUTE. The screen, and the one piece of focus that is genuinely a place rather than
 * a preference: the roast a catalog link opened History on. Selections that survive navigation -
 * which profile is open in the editor, which lot is open in Beans - are workspace state and stay
 * out, because they would make the Back button undo a click on a list.
 */
export interface Route {
  view: AppView
  /** The roast a catalog link opened History on. History is the only screen that takes one. */
  runId?: string
}

const VIEWS: readonly AppView[] = [
  'roast',
  'history',
  'beans',
  'profiles',
  'manual',
  'calibrate',
  'reference',
  'settings',
]

/** Where an unrecognised, empty or hand-mangled address lands. The same screen a cold load opens. */
export const HOME: Route = { view: 'roast' }

const isView = (value: string): value is AppView => (VIEWS as readonly string[]).includes(value)

/** A malformed percent-escape throws rather than decoding; a bad link is not worth a blank app. */
const decode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value) || undefined
  } catch {
    return undefined
  }
}

export const routeHash = (route: Route): string =>
  route.view === 'history' && route.runId ? `#/history/${encodeURIComponent(route.runId)}` : `#/${route.view}`

export const parseRoute = (hash: string): Route => {
  const [view, focus] = hash.replace(/^#\/?/, '').split('/')
  if (!isView(view)) return HOME
  const runId = view === 'history' && focus ? decode(focus) : undefined
  return runId ? { view, runId } : { view }
}

/** Whether two routes are the same place, so a repeat gesture cannot stack duplicate entries. */
export const sameRoute = (a: Route, b: Route): boolean => a.view === b.view && a.runId === b.runId
