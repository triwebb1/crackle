import { defineConfig } from 'vitest/config'
import { crackleDeviceBanner, crackleMockController } from './dev/mockController'

/**
 * Two dev modes, one line of output each.
 *
 *   `npm run dev`         the simulated controller in `web/dev/` - the default
 *   `npm run dev:device`  the real roaster, over the proxy this config has always carried
 *
 * The switch is `npm_lifecycle_event`, which npm sets to the name of the script being run. That
 * avoids both an inline environment variable (which does not work in a Windows npm script without a
 * dependency) and `--mode`, which would change `import.meta.env.MODE` and so silently disable the
 * app's own rich development dataset. `CRACKLE_CONTROLLER=device` is the escape hatch for anyone
 * running `npx vite` directly.
 *
 * The mock is dev-server only: its plugin is `apply: 'serve'`, and nothing under `web/dev/` is ever
 * imported by anything under `web/src/`, so `vite build` produces the same bytes with or without it.
 */
const useDevice = process.env.CRACKLE_CONTROLLER === 'device' || process.env.npm_lifecycle_event === 'dev:device'

const controller = process.env.CRACKLE_CONTROLLER_URL ?? 'http://crackle.local'
const controllerUrl = new URL(controller)
// The live socket shares the native server's port (firmware 2026-07-26.70 and later); a port-81 target would leave
// device-mode development on HTTP polling.
const liveController = `${controllerUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${controllerUrl.host}`

export default defineConfig({
  plugins: [
    useDevice
      ? crackleDeviceBanner(controller)
      : crackleMockController({ physicalUpdateUrl: new URL('/update', controllerUrl).toString() }),
  ],
  build: {
    // The web bundle lives in both OTA slots, so compressed bytes matter more than build speed.
    // Terser with three passes saves about 5.7 kB gzip over esbuild on the current application.
    minify: 'terser',
    terserOptions: {
      compress: { passes: 3 },
      format: { comments: false },
    },
  },
  server: {
    proxy: {
      // The normal dev server keeps the simulator at the same-origin root while also exposing the
      // configured physical roaster behind a fixed prefix. The SPA can therefore preflight and
      // switch targets without CORS, without restarting Vite, and without ever treating an endpoint
      // label as device identity. A full-page handoff tears down every old poll/socket/write queue.
      '/__crackle/physical/ws/live': {
        target: liveController,
        ws: true,
        rewrite: (path) => path.replace(/^\/__crackle\/physical/, ''),
      },
      '/__crackle/physical': {
        target: controller,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__crackle\/physical/, ''),
      },
      ...(useDevice
        ? {
            '/update': { target: controller, changeOrigin: true },
            '/api': { target: controller, changeOrigin: true },
            // Recordings are served outside /api; without these the device-mode app could not hydrate or
            // import a single recording.
            '/logs': { target: controller, changeOrigin: true },
            '/thermal.csv': { target: controller, changeOrigin: true },
            '/ws/live': { target: liveController, ws: true },
          }
        : {}),
    },
  },
  test: {
    environment: 'node',
    // Bound the release suite so repeated edits do not create an aggressive child-process burst.
    // Four workers preserve useful parallelism and avoid the intermittent closed-IPC failure seen
    // when Vitest inferred a larger pool on this development machine.
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
    // `dev/` is tested too, and only for one thing: that the mock answers the firmware's documented
    // contract. A mock that drifts from the README is worse than no mock, because every feature
    // reviewed against it looks finished.
    include: ['src/**/*.test.ts', 'dev/**/*.test.ts'],
    // Registers `toContainCode` for the tests that assert on source text.
    setupFiles: ['src/testFixtures/sourceCode.ts'],
  },
})
