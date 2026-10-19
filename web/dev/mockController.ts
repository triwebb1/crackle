/**
 * ============================================================================================
 * THE MOCK CONTROLLER - a simulated Crackle roaster, served by the Vite dev server
 * ============================================================================================
 *
 * `npm run dev` connects the app to this. `npm run dev:device` connects it to the real roaster
 * instead, over the proxy that was here before. Exactly one line is printed at startup saying which.
 *
 * **Nothing here reaches the production bundle.** The plugin is `apply: 'serve'`, no file under
 * `web/dev/` is imported by anything under `web/src/`, and the dependency arrow points the other way
 * on purpose: the mock imports the app's own domain code - the estimated baseline coefficients, the
 * actuator floors, the roast argument limits, and the whole journey control law - so the simulated
 * roaster cannot drift away from the model the app reasons about.
 *
 * Module map:
 *
 *   `config.ts`      constants, confirm tokens, plausibility ranges, speed multipliers
 *   `plant.ts`       the thermal plant and the simulated thermocouple
 *   `actuator.ts`    level floors, fan qualification, and the renewable Heat lease
 *   `manual.ts`      the manual session and the 30-minute instruction lease
 *   `roast.ts`       argument parsing and the roast executor (timed, and journey via the real law)
 *   `calibration.ts` the diagnostic program, and the applied-coefficient store with its 400 gate
 *   `archive.ts`     the 1 Hz thermal log and the recordings archive behind it
 *   `dataStore.ts`   `/data`: the CDOC envelope semantics, the idle gate, the caps and the floor
 *   `seed.ts`        a first-run history, produced by actually running the programs
 *   `device.ts`      the device: one clock, one actuator, arbitration between the three programs
 *   `documents.ts`   `/api/status` and `/api/live`, field for field against `client.ts`
 *   `routes.ts`      the HTTP surface
 *   `liveSocket.ts`  `/ws/live`, the 1 Hz push stream
 *   `persistence.ts` state across dev-server restarts
 */
import type { Plugin, ViteDevServer } from 'vite'
import { CALIBRATION_SPEED, GLOBAL_SPEED, LIVE_STREAM_MS, TICK_MS } from './config'
import { MockDevice } from './device'
import { liveDocument } from './documents'
import { type LiveSocketServer, serveLiveSocket } from './liveSocket'
import { loadState, saveState, statePathForDisplay } from './persistence'
import { powerCycleMockDevice } from './powerCycle'
import { createRouter } from './routes'

const LIVE_WS_PATH = '/ws/live'
const PERSIST_INTERVAL_MS = 5000

const portOf = (server: ViteDevServer): number | undefined => {
  const address = server.httpServer?.address()
  return address !== null && typeof address === 'object' ? address.port : undefined
}

/** The single startup line. It has to say which controller is connected, and what is unusual about it. */
const banner = (device: MockDevice, live: boolean) => {
  const speeds = [
    GLOBAL_SPEED === 1 ? undefined : `sim ${GLOBAL_SPEED}x`,
    `calibration fast-forward ${CALIBRATION_SPEED}x`,
  ]
    .filter(Boolean)
    .join(', ')
  const stream = live ? `${LIVE_WS_PATH} streaming at 1 Hz` : `${LIVE_WS_PATH} unserved, 1 Hz /api/live fallback`
  return (
    `controller: MOCK (simulated SR800 + MAX31856, boot ${device.bootCount}, ` +
    `${device.archive.logs.length} stored recordings, ${speeds}, ${stream}, state ${statePathForDisplay()})`
  )
}

export interface MockControllerOptions {
  /** Serve the firmware-parity 1 Hz push stream. Off leaves the app on its 1 Hz `/api/live` fallback. */
  liveSocket?: boolean
  /** Physical updater destination used when Settings is opened against the development mock. */
  physicalUpdateUrl?: string
}

/** The dev-server plugin. Installs the simulated controller on this server's own HTTP surface. */
/**
 * The device installed on the CURRENT dev server, so a restart can retire it deterministically.
 *
 * Vite restarts the whole server when anything the config imports changes - which is every file in
 * this directory - and it does not guarantee that the outgoing server has finished closing before
 * the incoming one is built. An old device left ticking would keep simulating, keep persisting, and
 * would be a second controller answering nobody. It is retired here, in order, instead.
 *
 * The handle lives on `globalThis` rather than in a module variable because a config reload
 * re-evaluates this module from a freshly bundled copy: module state does not survive a restart,
 * and the whole point is to reach across one.
 */
const RETIRE_KEY = '__crackleMockControllerRetire__'
type Registry = typeof globalThis & { [RETIRE_KEY]?: () => void }

export const crackleMockController = ({
  liveSocket = true,
  physicalUpdateUrl,
}: MockControllerOptions = {}): Plugin => ({
  name: 'crackle-mock-controller',
  apply: 'serve',
  configureServer(server) {
    const registry = globalThis as Registry
    registry[RETIRE_KEY]?.()
    let device = new MockDevice()
    const restored = loadState()
    if (restored) device.restore(restored)
    device.seed()
    saveState(device.snapshot())

    let stream: LiveSocketServer | undefined
    const routerOptions = {
      websocketPort: () => (stream ? portOf(server) : undefined),
      websocketClients: () => stream?.clients ?? 0,
    }
    let router = createRouter(device, routerOptions)

    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://mock.local')
      // Firmware updates always belong to the configured physical roaster. Redirect the entire
      // updater surface so its version fetch and absolute form POST stay on that same origin.
      if (url.pathname === '/update' && physicalUpdateUrl) {
        response.statusCode = request.method === 'GET' || request.method === 'HEAD' ? 302 : 307
        response.setHeader('location', physicalUpdateUrl)
        response.end()
        return
      }

      if ((request.method ?? 'GET').toUpperCase() === 'POST' && url.pathname === '/api/dev/probe') {
        const available = url.searchParams.get('available') === 'true'
        device.setProbeAvailable(available)
        response.statusCode = 200
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(
          JSON.stringify({
            ok: true,
            available,
            message: `Mock probe ${available ? 'reconnected' : 'disconnected'}.`,
          }),
        )
        return
      }
      if ((request.method ?? 'GET').toUpperCase() === 'POST' && url.pathname === '/api/dev/live-drop') {
        // The phone-lock discontinuity on demand: every attached browser loses its stream and must
        // reconnect, which is what the trace resync is there to notice. The plant keeps ticking and
        // the recording keeps growing underneath, exactly as on the roaster.
        const dropped = stream?.dropClients() ?? 0
        response.statusCode = 200
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(
          JSON.stringify({
            ok: true,
            dropped,
            message: stream
              ? `Dropped ${dropped} live stream ${dropped === 1 ? 'subscriber' : 'subscribers'}; browsers reconnect on their own.`
              : 'The mock is serving the HTTP live fallback only; there is no stream to drop.',
          }),
        )
        return
      }
      if ((request.method ?? 'GET').toUpperCase() === 'POST' && url.pathname === '/api/dev/power-cycle') {
        const previousBoot = device.bootCount
        device = powerCycleMockDevice(device)
        router = createRouter(device, routerOptions)
        saveState(device.snapshot())
        response.statusCode = 200
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(
          JSON.stringify({
            ok: true,
            previous_boot_id: String(previousBoot),
            boot_id: String(device.bootCount),
            message: `Mock roaster power-cycled. Boot ${device.bootCount} is now running; device-stored data was preserved.`,
          }),
        )
        return
      }
      router(request, response)
        .then((handled) => {
          if (!handled) next()
        })
        .catch(next)
    })

    // The plant ticks whether or not anybody is asking. A request only ever observes it.
    let lastTickMs = Date.now()
    const ticker = setInterval(() => {
      const nowMs = Date.now()
      const elapsed = nowMs - lastTickMs
      lastTickMs = nowMs
      // A suspended laptop must not replay an hour of simulation in one pass.
      device.advance(Math.min(elapsed, 2000))
    }, TICK_MS)
    ticker.unref?.()

    const persister = setInterval(() => {
      if (!device.dirty) return
      device.dirty = false
      saveState(device.snapshot())
    }, PERSIST_INTERVAL_MS)
    persister.unref?.()

    const httpServer = server.httpServer
    if (liveSocket && httpServer) {
      stream = serveLiveSocket(httpServer, LIVE_WS_PATH, () => liveDocument(device), LIVE_STREAM_MS)
    }

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(ticker)
      clearInterval(persister)
      stream?.close()
      saveState(device.snapshot())
    }
    registry[RETIRE_KEY] = stop
    httpServer?.once('close', stop)
    process.once('exit', stop)

    // One line, once, after the server is up - so it lands under Vite's own banner.
    const announce = () => server.config.logger.info(banner(device, stream !== undefined))
    if (httpServer?.listening) announce()
    else httpServer?.once('listening', announce)
  },
})

/**
 * The device-mode counterpart. The proxy itself stays in `vite.config.ts` where it has always been;
 * this exists so that BOTH modes print exactly one line saying what the app is talking to.
 */
export const crackleDeviceBanner = (target: string): Plugin => ({
  name: 'crackle-device-banner',
  apply: 'serve',
  configureServer(server) {
    const announce = () =>
      server.config.logger.info(`controller: DEVICE (proxying /api, /update and /ws/live to ${target})`)
    if (server.httpServer?.listening) announce()
    else server.httpServer?.once('listening', announce)
  },
})
