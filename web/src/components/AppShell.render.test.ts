import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it, vi } from 'vitest'
import type { ControllerStatus } from '../domain/types'
import { AppShell, DeviceHeartbeat, deviceHeartbeatState, GlobalStopButton } from './AppShell'

const status = (roast?: ControllerStatus['roast']): ControllerStatus => ({
  lifecycle: 'READY',
  connected: true,
  stale: false,
  receivedAtMs: Date.now(),
  firmwareVersion: 'test',
  bootId: '1',
  manualLockout: false,
  thermocoupleValid: true,
  capabilities: {
    apiVersion: 'diagnostic-v1',
    autonomousTimedPrograms: false,
    thermalExecution: true,
    diagnosticTests: true,
  },
  roast,
})
const render = (value: ControllerStatus, onStopAll?: () => Promise<{ ok: boolean; message?: string }>) =>
  renderToStaticMarkup(
    createElement(AppShell, {
      view: 'roast',
      onView: () => undefined,
      lifecycle: value.lifecycle,
      status: value,
      nowMs: value.receivedAtMs,
      readoutTarget: 'roast',
      onStopAll,
      children: null,
    }),
  )

describe('device heartbeat', () => {
  it('uses the requested three- and five-second freshness boundaries', () => {
    const value = status()
    value.receivedAtMs = 10_000
    expect(deviceHeartbeatState(value, 13_000)).toBe('healthy')
    expect(deviceHeartbeatState(value, 13_001)).toBe('delayed')
    expect(deviceHeartbeatState(value, 15_000)).toBe('delayed')
    expect(deviceHeartbeatState(value, 15_001)).toBe('lost')
    value.connected = false
    expect(deviceHeartbeatState(value, 10_000)).toBe('lost')
  })

  it('labels healthy, delayed, and disconnected states', () => {
    const value = status()
    value.receivedAtMs = 10_000
    const healthy = renderToStaticMarkup(createElement(DeviceHeartbeat, { status: value, nowMs: 12_000 }))
    expect(healthy).toContain('class="device-heartbeat healthy"')
    expect(healthy).toContain('title="Device heartbeat healthy. Last device report 2 seconds ago."')

    const delayed = renderToStaticMarkup(createElement(DeviceHeartbeat, { status: value, nowMs: 14_000 }))
    expect(delayed).toContain('class="device-heartbeat delayed"')

    value.connected = false
    const lost = renderToStaticMarkup(createElement(DeviceHeartbeat, { status: value, nowMs: 10_000 }))
    expect(lost).toContain('class="device-heartbeat lost"')
    expect(lost).toContain('The roaster is not connected.')
  })
})

describe('global header Stop', () => {
  it('stays beside live output on every route even when status is stale or faulted', () => {
    const value = status()
    value.effectiveFan = 4
    value.effectiveHeat = 6
    value.stale = true
    value.fault = 'overtemperature'
    const markup = render(value, async () => ({ ok: true }))
    expect(markup).toContain('class="global-stop"')
    expect(markup).toContain('class="stop-icon"')
    expect(markup).toContain('<rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor"></rect>')
    expect(markup).toContain('>Stop</button>')
    expect(markup).not.toMatch(/class="global-stop"[^>]*disabled/)

    value.connected = false
    expect(render(value, async () => ({ ok: true }))).not.toContain('class="global-stop"')
  })

  it('remains available while a zero-output workflow still owns the roaster', () => {
    const workflows: ControllerStatus[] = [
      status({ active: true } as ControllerStatus['roast']),
      { ...status(), calibration: { active: true } as ControllerStatus['calibration'] },
      { ...status(), manual: { active: true } as ControllerStatus['manual'] },
    ]
    for (const value of workflows) {
      value.effectiveFan = 0
      value.effectiveHeat = 0
      expect(render(value, async () => ({ ok: true }))).toContain('class="global-stop"')
    }
  })

  it('shows Stop for a minimal live-only running shell, but not for a passive log alone', () => {
    const running = status()
    running.lifecycle = 'RUNNING'
    expect(render(running, async () => ({ ok: true }))).toContain('class="global-stop"')
    const tail = status()
    tail.lifecycle = 'STANDBY'
    tail.thermalLog = { active: true, source: 'calibration' }
    expect(render(tail, async () => ({ ok: true }))).not.toContain('class="global-stop"')
  })

  it('renders the single-tap stop control and arms it only for an active roast', () => {
    // Tap behavior (single-tap without a roast; arm-then-confirm with one) executes in
    // armedConfirm.dom.test.ts. Here: markup renders unarmed, and the header wires the
    // confirmation exactly from live roast activity.
    const markup = renderToStaticMarkup(createElement(GlobalStopButton, { busy: false, onStop: vi.fn() }))
    expect(markup).toContain('class="global-stop"')
    expect(markup).not.toContain('Tap again')
    const source = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8')
    expect(source).toContain('confirmRoastStop={status.roast?.active === true}')
  })
})

describe('header live temperature', () => {
  /**
   * At 390 px the unit must not wrap away from the value ("231.4" with "°C" alone on a second
   * line). The unit is its own quieter span inside a nowrap strong, so the reading is one object at
   * any width and any value the probe can produce.
   */
  it('keeps the value and its unit as one unbreakable reading', () => {
    const value = status()
    value.temperatureC = 231.4
    const markup = render(value)
    expect(markup).toContain('231.4<span class="live-strip-unit">°C</span>')
    expect(markup).not.toContain('231.4 °C')
    const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(styles).toMatch(/\.live-strip-item strong \{[^}]*white-space: nowrap/)
    expect(styles).toMatch(/\.live-strip-unit \{[^}]*font-size: var\(--t-micro\)/)
  })

  it('shows a plain placeholder without a dangling unit when there is no reading', () => {
    const markup = render(status())
    expect(markup).not.toContain('live-strip-unit')
  })
})

/**
 * A running timer is visible from every screen while a roast is underway.
 * It is the DEVICE clock - `status.roast.elapsedSec` arrives on every 1 Hz live frame - so the
 * strip re-renders it each frame and never runs a browser interval that could drift from the
 * roaster's own count.
 */
describe('header elapsed clock', () => {
  it('shows the device roast clock as mm:ss while a roast is underway', () => {
    const value = status({ active: true, mode: 'journey', elapsedSec: 754 } as ControllerStatus['roast'])
    const markup = render(value)
    expect(markup).toContain('live-strip-item elapsed')
    expect(markup).toContain('<small>Time</small><strong>12:34</strong>')
  })

  it('covers an idle Controls session with the same clock ManualView reports', () => {
    const value = status()
    value.manual = { active: true, fanLevel: 4, heatLevel: 0, sinceMs: 65_000 } as ControllerStatus['manual']
    // nowMs equals receivedAtMs in this render, so the firmware's own 65 s stands unadvanced.
    expect(render(value)).toContain('<small>Time</small><strong>1:05</strong>')
  })

  it('is absent while nothing runs, and while the roaster is offline or stale', () => {
    expect(render(status())).not.toContain('live-strip-item elapsed')
    const offline = status({ active: true, mode: 'journey', elapsedSec: 30 } as ControllerStatus['roast'])
    offline.connected = false
    expect(render(offline)).not.toContain('live-strip-item elapsed')
    const stale = status({ active: true, mode: 'journey', elapsedSec: 30 } as ControllerStatus['roast'])
    stale.stale = true
    expect(render(stale)).not.toContain('live-strip-item elapsed')
  })

  it('ticks from the 1 Hz device frames rather than a browser timer', () => {
    const source = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8')
    expect(source).toContain('status.roast.elapsedSec')
    expect(source).not.toContain('setInterval')
  })
})

describe('Crackle wordmark', () => {
  it('uses a coffee bean with sound rays rather than a cup', () => {
    const markup = render(status())
    expect(markup).toContain('class="crackle-mark"')
    expect(markup).toContain('class="crackle-mark-bean"')
    expect(markup).toContain('class="crackle-mark-sound"')
    expect(markup).not.toContain('lucide-coffee')
  })
})

describe('Controls navigation', () => {
  it('uses Controls consistently instead of Direct', () => {
    const markup = render(status())
    expect(markup).toContain('Controls')
    expect(markup).not.toContain('Direct')
  })

  it('shows the installed roaster as status, not as an app-wide target selector', () => {
    const value = status()
    value.roaster = {
      deviceId: 'mock-1',
      modelId: 'crackle-sim-sr800',
      displayName: 'Development mock',
      simulated: true,
    }
    const markup = renderToStaticMarkup(
      createElement(AppShell, {
        view: 'roast',
        onView: () => undefined,
        lifecycle: value.lifecycle,
        status: value,
        nowMs: value.receivedAtMs,
        readoutTarget: 'roast',
        activeRoaster: { id: 'mock-1', name: 'Development mock', model: 'crackle-sim-sr800', simulated: true },
        roasterTargets: [
          { id: 'mock-1', name: 'Development mock', model: 'crackle-sim-sr800', simulated: true },
          { id: 'physical-1', name: 'Kitchen SR800', model: 'freshroast-sr800', simulated: false },
        ],
        onActiveRoasterChange: () => undefined,
        children: null,
      }),
    )
    expect(markup).toContain('aria-label="Installed roaster"')
    expect(markup).toContain('Development mock')
    expect(markup).toContain('Mock')
    expect(markup).toContain('Connected')
    expect(markup).not.toContain('Choose active roaster')
    expect(markup).not.toContain('Kitchen SR800')
    expect(markup).not.toContain('aria-expanded')
  })

  it('does not label the ordinary installed machine as Physical', () => {
    const value = status()
    value.roaster = {
      deviceId: 'physical-1',
      modelId: 'freshroast-sr800',
      displayName: 'Kitchen SR800',
      simulated: false,
    }
    const markup = renderToStaticMarkup(
      createElement(AppShell, {
        view: 'roast',
        onView: () => undefined,
        lifecycle: value.lifecycle,
        status: value,
        nowMs: value.receivedAtMs,
        readoutTarget: 'roast',
        activeRoaster: { id: 'physical-1', name: 'Kitchen SR800', model: 'freshroast-sr800', simulated: false },
        children: null,
      }),
    )
    expect(markup).toContain('Kitchen SR800')
    expect(markup).not.toContain('Physical')
  })
  it('is unavailable in both navigation surfaces during an active roast', () => {
    const roast = { active: true, saturated: false, holdover: false, mode: 'timed' as const }
    const markup = render(status(roast))
    expect(markup.match(/title="Controls are unavailable while a roast is active\."/g)).toHaveLength(2)
    expect(markup.match(/<button[^>]*disabled[^>]*title="Controls are unavailable/g)).toHaveLength(2)
  })
})

/**
 * A phone header cannot hold the logo, four live numbers, Stop, and a worded lifecycle badge. While
 * Stop is shown, the header is marked so the phone stylesheet can collapse the badge to its state
 * icon; the badge's word stays in the markup for screen readers.
 */
describe('phone header while Stop is shown', () => {
  it('marks the header only while the global Stop is present', () => {
    const running = status({ active: true, mode: 'journey', elapsedSec: 754 } as ControllerStatus['roast'])
    running.effectiveFan = 6
    running.effectiveHeat = 8
    running.lifecycle = 'RUNNING'
    expect(render(running, async () => ({ ok: true }))).toContain('class="app-header stop-visible"')
    expect(render(status(), async () => ({ ok: true }))).toContain('class="app-header"')
  })

  it('keeps the lifecycle word as its own collapsible label', () => {
    expect(render(status())).toContain('<span class="lifecycle-label">READY</span>')
  })

  it('collapses the badge and yields the logo only inside the phone media queries', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/@media \(max-width: 560px\) \{\s*\.app-header\.stop-visible \.lifecycle-badge/)
    expect(css).toMatch(/\.app-header\.stop-visible \.lifecycle-label \{ position: absolute; width: 1px; height: 1px;/)
    expect(css).toMatch(/@media \(max-width: 400px\) \{\s*\.app-header\.stop-visible \.wordmark \{ display: none; \}/)
  })
})
