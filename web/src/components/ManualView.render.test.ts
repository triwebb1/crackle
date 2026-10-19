import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import type { ControllerStatus, ManualEvent, ManualStatus } from '../domain/types'
import { testRecordedOn } from '../testFixtures/provenance'
import { ManualView } from './ManualView'

// Crackle has no DOM test suite yet (README "Known Gaps"). This is the same deliberately narrow
// server-render smoke test the Calibrate screen has: it proves the Manual screen renders its
// command, live, and history panels against real data, and that the gate is visible when it closes.
const NOW = Date.now()
const SOURCE = readFileSync(new URL('./ManualView.tsx', import.meta.url), 'utf8')
const STYLES = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: NOW,
  firmwareVersion: '2026-07-26.36',
  bootId: '4',
  manualLockout: false,
  thermocoupleValid: true,
  temperatureC: 182.4,
  ambientC: 24.5,
  actuatorMode: 'heating',
  effectiveFan: 1.338,
  effectiveHeat: 10,
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  ...overrides,
})

const events: ManualEvent[] = [
  {
    id: 'manual-1',
    atMs: NOW - 300000,
    kind: 'apply',
    fan: 4,
    heat: 0,
    temperatureC: 25.1,
    source: 'local',
    recordedOn: testRecordedOn,
  },
  {
    id: 'manual-2',
    atMs: NOW - 120000,
    kind: 'apply',
    fan: 1,
    heat: 10,
    temperatureC: 60.8,
    source: 'local',
    recordedOn: testRecordedOn,
  },
]

const render = (props: Partial<Parameters<typeof ManualView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ManualView, {
      status: status({ manual: { active: true, fanLevel: 1, heatLevel: 10, sinceMs: 120000 } }),
      nowMs: NOW,
      events,
      onEvent: () => undefined,
      onClearEvents: () => undefined,
      controller: { setManual: async () => ({ ok: true }), stopManual: async () => ({ ok: true }) },
      ...props,
    }),
  )

describe('manual screen render', () => {
  it('renders the command panel, the live panel, and the event history', () => {
    const markup = render()
    expect(markup).toContain('Set levels')
    expect(markup).toContain('Current output')
    expect(markup).toContain('Roaster details')
    expect(markup).toContain('Apply')
    expect(markup).toContain('Stop')
    expect(markup).toContain('Control events')
    expect(markup).toContain('Clear history')
    expect(markup).toContain('182.4 °C')
    expect(markup).toContain('heating')
    // The running timer at the current applied levels.
    expect(markup).toContain('At these levels')
    expect(markup).toContain('2:00')
    // One duration column: each row states how long its own levels were held.
    expect(markup).toContain('Held for')
    expect(markup).not.toContain('Prior levels held')
    expect(markup).toContain('3:00')
    // And the same figure, large, beside the controls.
    expect(markup).toContain('At these levels for')
  })

  it('blocks controls while a roast is active', () => {
    const markup = render({
      status: status({
        roast: { active: true, saturated: false, holdover: false, mode: 'timed' },
      }),
    })
    expect(markup).toContain('Apply unavailable: Controls are unavailable while a roast is active')
    expect(markup).toMatch(/<button type="button" class="primary-button fan-heat-apply" disabled/)
  })
  /**
   * Applied fan, applied heat, effective fan and effective heat as four permanent readouts would
   * repeat the levels already stated above them. The DISTINCTION
   * is real - the heat-on fan floor can make the actuator differ - so it survives, but as a
   * difference reported in words only when there is one.
   */
  it('reports one current output and exposes the accepted command only when the actuator differs', () => {
    // The fixture reports a constrained Fan so the compact difference state is visible.
    const markup = render()
    expect(markup).not.toContain('Running at')
    expect(markup).toContain('Fan 1.3 · Heat 10.0')
    expect(markup).toContain('Fan constrained by roaster')
    expect(markup).not.toContain('Applied command:')
    expect(markup).not.toContain('Fan raised to')
    // The four-field block is gone; what is left is state the levels do not already say.
    expect(markup).not.toContain('Applied fan')
    expect(markup).not.toContain('Effective fan')
    expect(markup).not.toContain('Effective heat')
    expect(markup).toContain('Actuator mode')
    expect(markup).toContain('Lifecycle')
  })

  it('says nothing about effective levels when the actuator is obeying', () => {
    const obeying = render({
      status: status({
        manual: { active: true, fanLevel: 6, heatLevel: 3, sinceMs: 1000 },
        effectiveFan: 6,
        effectiveHeat: 3,
      }),
    })
    expect(obeying).not.toContain('manual-override-note')
    expect(obeying).not.toContain('constrained by roaster')
  })

  it('raises the fan-floor preview only for a combination that will actually be lifted', () => {
    // The form opens at fan 4 / heat 0, which no floor touches, so the preview must stay silent.
    // The floor arithmetic itself is pinned against the firmware config in manualControl.test.ts.
    expect(render()).not.toContain('heat always needs qualified airflow')
  })

  it('shows the reason when a command is blocked, rather than hiding the control', () => {
    const faulted = render({ status: status({ fault: 'overtemperature', lifecycle: 'FAULT' }) })
    expect(faulted).toContain('Apply unavailable: overtemperature')
    // Stop is never withheld for a fault: it is the safe direction.
    expect(faulted).not.toContain('Stop blocked')
    expect(faulted).toContain('Apply')

    const busyProgram = render({ status: status({ calibration: { active: true } }) })
    expect(busyProgram).toContain('A calibration program is running')

    const offline = render({ status: status({ connected: false }) })
    expect(offline).toContain('Stop unavailable: The roaster is not connected')

    const stale = render({ status: status({ receivedAtMs: NOW - 60000 }) })
    expect(stale).toContain('The roaster has stopped reporting')
  })

  /**
   * The page opened with a five-line paragraph of protocol recital, and then with a sentence saying
   * heat needed this page open - which stopped being true. Two short sentences, and the second is
   * the lease, plainly, with nothing asked of the reader.
   */
  it('opens with two short sentences, the second of which states the lease', () => {
    const markup = render()
    const note = markup.slice(markup.indexOf('<p class="manual-command-guidance">'))
    const text = note.slice(note.indexOf('>') + 1, note.indexOf('</p>')).replace(/<[^>]*>/g, '')
    expect(text).toContain('no need to stop first')
    expect(text).toContain('at most 30 minutes')
    expect(text).toContain('send any command to reset the clock')
    // Two sentences, and short ones: the recital of every always-on protocol is gone.
    expect(text.split('. ').length).toBeLessThanOrEqual(2)
    expect(text.length).toBeLessThan(220)
    expect(text).not.toContain('400 °C for 3 s')
    expect(text).not.toContain('thermal gating')
  })

  it('explains the reconciliation limitation instead of overstating the history', () => {
    const markup = render()
    expect(markup).toContain('best effort')
    expect(markup).toContain('end reason')
  })

  /**
   * The draft is never the polled level, pinned at the component boundary. If the input's value
   * were the polled applied level, applying fan 4 and typing 8 would revert on the next live frame,
   * and a stepper click would show 4.1 and snap back. These two renders differ only in what the
   * controller reports, so if the field still tracked status the rendered value would move with it.
   */
  it('never lets a status change rewrite what is in the input', () => {
    const atFour = render({ status: status({ manual: { active: true, fanLevel: 4, heatLevel: 0, sinceMs: 1000 } }) })
    const atNine = render({ status: status({ manual: { active: true, fanLevel: 9, heatLevel: 6, sinceMs: 1000 } }) })
    // The form's own value, both times, whatever the roaster is doing.
    expect(atFour).toContain('value="4"')
    expect(atNine).toContain('value="4"')
    expect(atNine).not.toContain('value="9"')
    // What IS running is reported as device output, after the draft fields where it cannot fight them.
    expect(atNine).toContain('Current output')
    expect(atNine.indexOf('fan-heat-fields')).toBeLessThan(atNine.indexOf('fan-heat-current'))
  })

  it('keeps the command first and collapses secondary roaster diagnostics', () => {
    const markup = render()
    expect(markup.indexOf('fan-heat-fields')).toBeLessThan(markup.indexOf('fan-heat-current'))
    expect(markup.indexOf('fan-heat-current')).toBeLessThan(markup.indexOf('manual-diagnostics'))
    expect(markup).not.toContain('calibration-live manual-live')
    expect(markup).toContain('<details class="manual-diagnostics"><summary>Roaster details')

    const idle = render({ status: status() })
    expect(idle.match(/Controls idle/g)).toHaveLength(1)
  })

  /**
   * The cockpit steppers: the notch buttons and the draft value are real touch targets, Apply
   * takes the full row, and the diagnostics grid keeps its desktop shape.
   */
  it('keeps the steppers thumb-sized and Apply full width', () => {
    expect(STYLES).toMatch(/\.level-step \{[^}]*min-height: 48px/)
    expect(STYLES).toMatch(/\.level-stepper-row \{[^}]*grid-template-columns: 48px minmax\(0, 1fr\) 48px/)
    expect(STYLES).toMatch(/\.fan-heat-apply \{[^}]*flex: 1 1 100%/)
    expect(STYLES).toMatch(/\.fan-heat-apply \{[^}]*min-height: 48px/)
    expect(STYLES).toMatch(/\.manual-diagnostics-grid \{[^}]*grid-template-columns: repeat\(4/)
  })

  it('names the whole command on the button, in both Controls states', () => {
    const active = render()
    expect(active).toContain('>Apply Fan 4.0 · Heat 0.0</button>')
    const idle = render({ status: status() })
    expect(idle).toContain('>Start controls at Fan 4.0 · Heat 0.0</button>')
  })

  it('offers one deliberate way to pull the applied levels back into the form', () => {
    const differing = render({ status: status({ manual: { active: true, fanLevel: 9, heatLevel: 6, sinceMs: 1000 } }) })
    expect(differing).toContain('Not applied')
    expect(differing).toContain('Reset')
    expect(differing).not.toContain('Applied command:')

    // Matching values raise nothing: "4" and "4.0" are the same command, not a conflict.
    const matching = render({ status: status({ manual: { active: true, fanLevel: 4, heatLevel: 0, sinceMs: 1000 } }) })
    expect(matching).not.toContain('>Reset</button>')

    // Nor does an idle controller, which has no applied levels to differ from.
    expect(render({ status: status() })).not.toContain('>Reset</button>')
  })

  it('keeps Apply and Stop request state independent and accepts an injected controller', () => {
    expect(SOURCE).toContain('const [applying, setApplying]')
    expect(SOURCE).toContain('const [stopping, setStopping]')
    expect(SOURCE).toContain('busy: applying')
    expect(SOURCE).toContain('busy: stopping')
    expect(SOURCE).not.toContain('new HttpControllerClient')
  })

  it('renders an empty history without inventing rows', () => {
    const markup = render({ events: [], status: status() })
    expect(markup).toContain('No manual events yet')
    // No retention figure: the browser keeps 500 rows and the roaster's own document keeps far
    // fewer, so a number stated here would be a false promise in one of the two modes.
    expect(markup).toContain('the newest few hundred are kept here')
    expect(markup).not.toContain('newest 500')
  })
})

/**
 * ============================================================================================
 * THE INSTRUCTION LEASE REPLACED THE KEEPALIVE, AND TOOK ITS WHOLE UI WITH IT
 * ============================================================================================
 *
 * Heat here is not conditional on this page. The firmware bounds an instruction at 30 minutes and
 * any command resets that clock, so closing the browser is an ordinary thing to do. The "holding
 * this session alive / budget left" indicator and the blue "Heat needs this page open" explainer
 * were both statements about the previous rule, and there is no re-affirm loop behind them either.
 */
describe('the instruction lease', () => {
  const holding = (manual: Partial<ManualStatus> = {}) =>
    render({
      status: status({
        manual: {
          active: true,
          fanLevel: 6,
          heatLevel: 7.5,
          sinceMs: 120000,
          instructionAgeMs: 4000,
          instructionLimitMs: 1800000,
          ...manual,
        },
      }),
    })

  it('states the rule in one short line and nowhere else', () => {
    const markup = holding()
    expect(markup).toContain('at most 30 minutes')
    expect(markup).toContain('send any command to reset the clock')
    // Once. A lease that is restated in three places reads as three different rules.
    expect(markup.match(/at most 30 minutes/g)).toHaveLength(1)
  })

  it('shows no keepalive indicator, no budget, and no page-open warning', () => {
    for (const markup of [holding(), holding({ instructionAgeMs: 47000 }), holding({ heatLevel: 0 })]) {
      expect(markup).not.toContain('Holding this session alive')
      expect(markup).not.toContain('re-affirmed every')
      expect(markup).not.toContain('budget')
      expect(markup).not.toContain('Heat needs this page open')
      expect(markup).not.toContain('has not heard from this page')
      expect(markup).not.toContain('manual-keepalive')
    }
  })

  it('renders the new end reason in words rather than as its wire value', () => {
    const markup = render({ status: status({ manual: { active: false, endReason: 'instruction_expired' } }) })
    expect(markup).toContain('Ended because no new instruction arrived for 30 minutes')
    expect(markup).not.toContain('instruction_expired')
  })
})

/**
 * No 25 s re-affirm, in the source or on the screen.
 *
 * A re-affirm would be a client keepalive: a background timer re-POSTing the applied levels so the
 * firmware does not release heat. With the lease enforced on the device there is nothing to
 * re-affirm, and a timer that quietly commands the roaster on its own is not something to leave
 * lying around - it is the single worst thing a background task on this page could do.
 */
describe('the manual page never commands the roaster on a timer', () => {
  it('has no interval, and no setManual outside the two things the operator presses', () => {
    expect(SOURCE).not.toContain('setInterval')
    expect(SOURCE).not.toContain('keepalive')
    expect(SOURCE.match(/controller\.setManual/g)).toHaveLength(1)
    expect(SOURCE.match(/controller\.stopManual/g)).toHaveLength(1)
  })
})
