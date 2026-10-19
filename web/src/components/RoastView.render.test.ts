import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { demoRuns, overrunJourneyRun, starterBean, starterProfile, starterThermalIntent } from '../data/demo'
import { DEMO_RECORDED_ON } from '../data/demoIdentity'
import type { ControllerStatus, RoastRun } from '../domain/types'
import { manualStepTimeError, nextManualStepRemainingSec, RoastView } from './RoastView'

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'READY',
  connected: true,
  stale: false,
  receivedAtMs: Date.now(),
  firmwareVersion: '2026-07-26.36',
  bootId: '4',
  manualLockout: false,
  thermocoupleValid: true,
  temperatureC: 24.6,
  roaster: {
    deviceId: DEMO_RECORDED_ON.deviceId,
    modelId: DEMO_RECORDED_ON.modelId,
    displayName: DEMO_RECORDED_ON.displayNameAtCapture,
    simulated: DEMO_RECORDED_ON.simulated,
    simulatesModelId: DEMO_RECORDED_ON.simulatesModelId,
  },
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  ...overrides,
})

const noop = () => undefined

// A roast of THIS profile with THIS lot, which is what a usage-derived recommendation is made of.
const priorRoast: RoastRun = {
  ...demoRuns[0],
  id: 'prior',
  profile: starterProfile,
  beanLotId: starterBean.id,
  startedAt: '2026-07-01T09:00:00.000Z',
}

const render = (props: Partial<Parameters<typeof RoastView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(RoastView, {
      profile: starterProfile,
      profiles: [starterProfile, starterThermalIntent],
      beans: [starterBean],
      runs: [priorRoast, ...demoRuns],
      status: status(),
      calibration: defaultCalibration,
      ambientC: 24.5,
      elapsedSec: 0,
      samples: [],
      events: [],
      defaultMassG: 225,
      selectedBeanId: starterBean.id,
      onBean: noop,
      onProfile: noop,
      onOverlay: noop,
      onStart: noop,
      onMeasurements: noop,
      onNotes: noop,
      onCloseSession: noop,
      onAbandonSession: noop,
      onStopDeviceRoast: noop,
      revisionAvailable: false,
      onSaveRevision: noop,
      onDismissRevision: noop,
      ...props,
    }),
  )

describe('the roast page as a setup experience', () => {
  /**
   * Not two same-colored buttons, one behind the other, for a single action. The setup IS the page,
   * and there is exactly one Start.
   */
  it('renders the setup inline with a single Start, and no intermediate button', () => {
    const markup = render()
    expect(markup).toContain('Bean lot')
    expect(markup).toContain('Profile')
    expect(markup).toContain('Batch weight (g)')
    expect(markup).toContain('Start roast')
    expect(markup).not.toContain('Set up roast')
    // One Start, once.
    expect(markup.split('Start roast')).toHaveLength(2)
  })

  it('describes the device-owned event feed without promising unsupported user markers', () => {
    const markup = render()
    expect(markup).toContain('Safety and program events land here as the roast runs.')
    expect(markup).not.toContain('Markers and safety events')
  })

  it('seeds a repeated roast with the stored starting mass and volume without starting it', () => {
    const markup = render({ setupMeasurements: { startingMassG: 168, startingVolumeMl: 312 } })
    expect(markup).toContain('value="168"')
    expect(markup).toContain('value="312"')
    expect(markup).toContain('Start roast')
  })

  it('gates Start on what is actually missing, and never hides the button', () => {
    // A healthy controller with a mass in the field: nothing missing, nothing said.
    const ready = render()
    expect(ready).not.toContain('Start needs')
    expect(ready).not.toContain('disabled')

    // A blocked roaster states its own reason, and only that.
    const blocked = render({ startBlockedReason: 'The roaster has stopped reporting' })
    expect(blocked).toContain('Start needs the roaster has stopped reporting.')
    expect(blocked).toContain('Start roast')
    expect(blocked).toContain('disabled')

    // A missing batch weight is the other requirement, and it reads as itself.
    const noMass = render({ defaultMassG: 0 })
    expect(noMass).toContain('Start needs a batch weight for this roast.')

    // Both missing: one sentence, both needs, nothing satisfied mentioned.
    const neither = render({ defaultMassG: 0, startBlockedReason: 'The roaster is not connected' })
    expect(neither).toContain('Start needs a batch weight for this roast and the roaster is not connected.')
  })

  it('keeps the roaster-owned profile order instead of silently re-ranking by past use', () => {
    const markup = render({ profiles: [starterThermalIntent, starterProfile] })
    const select = markup.slice(
      markup.indexOf('<select', markup.indexOf('>Profile<')),
      markup.indexOf('</select>', markup.indexOf('>Profile<')),
    )
    expect(select.indexOf(starterThermalIntent.name)).toBeLessThan(select.indexOf(starterProfile.name))
    expect(markup).not.toContain('Recommended - roasted with this lot before')
    expect(markup).not.toContain('previously roasted with this lot')
  })

  /** A comparison overlay is a charting option, scoped silently to this installed roaster. */
  it('puts a single-machine comparison control on the chart, not in the roast attributes', () => {
    const foreign: RoastRun = {
      ...demoRuns[0],
      id: 'foreign-roast',
      name: 'Foreign roast',
      outcome: 'complete',
      recordedOn: { ...demoRuns[0].recordedOn, deviceId: 'other-device', displayNameAtCapture: 'Other roaster' },
    }
    const markup = render({ runs: [priorRoast, ...demoRuns, foreign] })
    expect(markup).toContain('chart-toolbar')
    expect(markup).toContain('Compare with')
    expect(markup).not.toContain('Comparison source')
    expect(markup).not.toContain('Foreign roast')
    expect(markup).not.toContain('Other roaster')
    expect(markup).not.toContain('Physical roasters')
    expect(markup).not.toContain('Development mock')
    expect(markup).not.toContain('Comparison overlay')
    const summary = markup.slice(markup.indexOf('run-summary'))
    expect(summary).not.toContain('Comparison')
  })

  it('withholds the comparison selector while a roast is running, keeping a chosen overlay drawn', () => {
    const running = status({
      lifecycle: 'RUNNING',
      roast: { active: true, mode: 'manual', commandedFan: 6, commandedHeat: 7, saturated: false, holdover: false },
    })
    const markup = render({ status: running, overlay: priorRoast })
    expect(markup).not.toContain('Compare with')
    expect(markup).toContain('overlay-trace')
    expect(markup).toContain('>Comparison<')
  })

  it('offers no comparison selector when no finished roast exists', () => {
    expect(render({ runs: [] })).not.toContain('Compare with')
  })

  it('switches to the session panel once a roast exists', () => {
    const session: RoastRun = { ...demoRuns[0], outcome: 'running' }
    const markup = render({ activeSession: session })
    expect(markup).toContain('Open roast session')
    expect(markup).not.toContain('Start roast')
  })
})

describe('manual roast step timing', () => {
  const step = { id: 1, fan: 6, heat: 7, atElapsedSec: 160 }

  it('counts down from device-owned roast elapsed time and stops at due', () => {
    expect(nextManualStepRemainingSec(step, 115)).toBe(45)
    expect(nextManualStepRemainingSec(step, 160)).toBe(0)
    expect(nextManualStepRemainingSec(step, 190)).toBe(0)
  })

  it('does not invent a countdown without the device roast clock', () => {
    expect(nextManualStepRemainingSec(step, undefined)).toBeUndefined()
    expect(manualStepTimeError(60)).toBeUndefined()
    expect(manualStepTimeError(-1)).toContain('whole number')
    expect(manualStepTimeError(60.5)).toContain('whole number')
  })
})

describe('manual roasting on the roast page', () => {
  it('states the post-stop cooling tail and no retired cooldown after Stop', () => {
    const source = readFileSync(new URL('./RoastView.tsx', import.meta.url), 'utf8')
    // Stop commands Fan 10 / Heat 0 for 10 seconds, then outputs off.
    expect(source).toContain('Stop acknowledged. Heat is off; the fan is cooling for 10 seconds.')
    expect(source).not.toContain('Fan and Heat are off.')
    expect(source).not.toContain('heater-element hold')
    expect(source).not.toContain('three-second')
  })

  it('offers Manual beside saved profiles and reveals safe initial controls in setup', () => {
    const markup = render({ manualMode: true })
    expect(markup).toContain('Manual roast / Fan and heat')
    expect(markup).toContain('Initial fan')
    expect(markup).toContain('aria-label="Initial manual fan"')
    expect(markup).toContain('value="4"')
    expect(markup).toContain('Initial heat')
    expect(markup).toContain('aria-label="Initial manual heat"')
    expect(markup).toContain('Start manual roast')
    expect(markup).toContain('Adjust fan and heat yourself while the temperature curve records.')
  })

  it('does not require the legacy diagnostic capability to start a first-class manual roast', () => {
    const markup = render({
      manualMode: true,
      status: status({
        capabilities: {
          apiVersion: 'roast-v1',
          autonomousTimedPrograms: false,
          thermalExecution: false,
          diagnosticTests: false,
        },
        roast: { active: false, mode: 'manual', saturated: false, holdover: false },
      }),
    })
    expect(markup).toContain('Start manual roast')
    expect(markup).not.toContain('This firmware does not offer direct control of the roaster')
    const labelAt = markup.indexOf('Start manual roast')
    const buttonAt = markup.lastIndexOf('<button', labelAt)
    expect(buttonAt).toBeGreaterThanOrEqual(0)
    expect(markup.slice(buttonAt, labelAt)).not.toContain('disabled')
  })

  it('renders direct controls, an always-visible Stop, actual traces, and accepted changes while running', () => {
    const run: RoastRun = {
      ...demoRuns[0],
      outcome: 'running',
      events: [{ id: 'change', elapsedSec: 90, type: 'OVERRIDE', label: 'Fan 6.0 / Heat 7.0' }],
      manualRoast: { changes: [] },
    }
    const markup = render({
      manualMode: true,
      activeSession: run,
      samples: demoRuns[0].samples,
      events: run.events,
      elapsedSec: demoRuns[0].samples.at(-1)?.elapsedSec ?? 0,
      status: status({
        lifecycle: 'RUNNING',
        roast: { active: true, mode: 'manual', commandedFan: 6, commandedHeat: 7, saturated: false, holdover: false },
      }),
    })
    expect(markup).toContain('aria-label="Manual roast controls"')
    expect(markup).toContain('<h2>Fan and heat</h2>')
    expect(markup).not.toContain('Direct fan and heat')
    expect(markup).toContain('aria-label="Fan"')
    expect(markup).toContain('aria-label="Heat"')
    expect(markup).toContain('Step or type new levels, then Apply.')
    // The steppers: one notch each way per channel, and Apply reads back the draft it will send.
    expect(markup).toContain('aria-label="Fan up 0.5"')
    expect(markup).toContain('aria-label="Fan down 0.5"')
    expect(markup).toContain('aria-label="Heat up 0.5"')
    expect(markup).toContain('aria-label="Heat down 0.5"')
    expect(markup).toContain('Apply Fan 4.0 · Heat 0.0')
    // The glance numbers stay pinned above the steppers while the page scrolls.
    expect(markup).toContain('cockpit-live-bar')
    expect(markup).toContain('Bean temp')
    expect(markup).toContain('Elapsed')
    expect(markup).toContain('RoR')
    expect(markup).toContain('Optional plan')
    expect(markup).toContain('Next steps')
    expect(markup).toContain('New planned step at elapsed seconds')
    expect(markup).toContain('Add row')
    expect(markup).toContain('Give each row an exact roast elapsed time')
    expect(markup).toContain('never sends heat commands on its own')
    expect(markup).toContain('visible reminder, not an automatic controller')
    expect(markup).toContain('Stop roast')
    expect(markup).toContain('Current output')
    expect(markup).toContain('Applied command: Fan 6.0 · Heat 7.0')
    expect(markup).toContain('bt-trace')
    expect(markup).toContain('fan-trace')
    expect(markup).toContain('heat-trace')
    expect(markup).not.toContain('planned-trace')
    expect(markup).not.toContain('target-trace')
    expect(markup).not.toContain('control-dock')
    expect(markup).not.toContain('Drop / Cool')
  })

  it('blocks Apply but never authoritative Stop when the browser record belongs to another roast', () => {
    const mismatch = 'This browser session belongs to an earlier controller boot'
    const run: RoastRun = { ...demoRuns[0], outcome: 'running', manualRoast: { changes: [] } }
    const markup = render({
      manualMode: true,
      activeSession: run,
      manualControlBlockedReason: mismatch,
      manualOwnershipBlockedReason: mismatch,
      status: status({
        lifecycle: 'RUNNING',
        roast: { active: true, mode: 'manual', commandedFan: 6, commandedHeat: 7, saturated: false, holdover: false },
      }),
    })
    const apply = markup.match(
      /<button type="button" class="primary-button fan-heat-apply"[^>]*>.*?Apply Fan.*?<\/button>/,
    )?.[0]
    const stop = markup.match(
      /<button type="button" class="command-button stop-command manual-roast-stop"[^>]*>.*?Stop roast<\/button>/,
    )?.[0]
    expect(apply).toContain('disabled')
    expect(stop).not.toContain('disabled')
    expect(markup).toContain(mismatch)
  })

  /**
   * A browser without this roast's own running session is a spectator. Its Apply would be refused
   * by session-fenced command gating, so the interactive cockpit would present a dead control as
   * live; what a spectator gets is the authoritative device-roast panel - clock, accepted levels,
   * and the one command it must always have, Stop.
   */
  it('gives a browser without a roast record the device panel with Stop, not a dead cockpit', () => {
    const device = status({
      lifecycle: 'RUNNING',
      roast: {
        active: true,
        mode: 'manual',
        elapsedSec: 481,
        commandedFan: 4,
        commandedHeat: 6,
        saturated: false,
        holdover: false,
      },
    })
    const spectator = render({ status: device, manualBusy: true })
    expect(spectator).not.toContain('aria-label="Manual roast controls"')
    expect(spectator).toContain('aria-label="Roast running on the roaster"')
    expect(spectator).toContain('Stop roast')
    expect(spectator).toContain('8:01')
    // Operator-directed levels are the story; no fictitious timed step or control-law tracking.
    expect(spectator).toContain('Operator-directed')
    expect(spectator).not.toContain('Target tracking')
    // And no locally selected profile drawn over a roast the roaster is not steering by it.
    expect(spectator).not.toContain('planned-trace')
    expect(spectator).not.toContain('target-trace')
    expect(spectator).not.toContain('Planned finish')
    const spectatorStop = spectator.match(
      /<button type="button" class="command-button stop-command"[^>]*>.*?Stop roast<\/button>/,
    )?.[0]
    expect(spectatorStop).not.toContain('disabled')
  })

  it('keeps the running cockpit Stop busy state independent of an Apply in flight', () => {
    const device = status({
      lifecycle: 'RUNNING',
      roast: { active: true, mode: 'manual', commandedFan: 4, commandedHeat: 6, saturated: false, holdover: false },
    })
    const session: RoastRun = { ...demoRuns[0], outcome: 'running', manualRoast: { changes: [] } }
    const applying = render({ status: device, activeSession: session, manualBusy: true })
    expect(applying).toContain('aria-label="Manual roast controls"')
    const applyingStop = applying.match(
      /<button type="button" class="command-button stop-command manual-roast-stop"[^>]*>.*?Stop roast<\/button>/,
    )?.[0]
    expect(applyingStop).not.toContain('disabled')

    const stopping = render({ status: device, activeSession: session, manualStopBusy: true })
    const stoppingButton = stopping.match(
      /<button type="button" class="command-button stop-command manual-roast-stop"[^>]*>.*?Stop roast<\/button>/,
    )?.[0]
    expect(stoppingButton).toContain('disabled')
  })

  it('shows a stored score as chosen, and no picker while the roast runs', () => {
    const done = render({ activeSession: { ...demoRuns[0], outcome: 'complete', score: 7 } })
    expect(done).toContain('7 of 10 · tap again to clear')
    expect(done).toMatch(
      /aria-pressed="true"[^>]*aria-label="Score 7 of 10"|aria-label="Score 7 of 10"[^>]*aria-pressed="true"/,
    )
    const running = render({ activeSession: { ...demoRuns[0], outcome: 'running' } })
    expect(running).not.toContain('score-picker')
  })

  it('separates profile, calibration, and completion choices after a manual roast', () => {
    const markup = render({
      manualMode: true,
      activeSession: { ...demoRuns[0], outcome: 'complete', manualRoast: { changes: [] } },
      manualProfileDraftName: 'Saturday manual profile',
    })
    expect(markup).toContain('Completed manual roast session')
    expect(markup).toContain('Save these instructions for reuse')
    expect(markup).toContain('0 accepted commands become timed profile steps.')
    expect(markup).toContain('Roast details saved')
    expect(markup).toContain('New profile name')
    expect(markup).toContain('value="Saturday manual profile"')
    expect(markup).toContain('How much you liked this bean and roast')
    expect(markup).toContain('aria-label="Score 10 of 10"')
    expect(markup).toContain('Save new profile')
    expect(markup).toContain('Use this roast as measurement data')
    expect(markup).toContain('Use as calibration evidence')
    expect(markup).toContain('This roast is already saved in History.')
    expect(markup).toContain('Done reviewing')
    expect(markup).not.toContain('Manual roast controls')
  })

  it('visibly blocks completed roast and profile writes when the roaster library is read-only', () => {
    const reason = 'The roaster is not connected. Reconnect and wait for its library before making changes.'
    const markup = render({
      manualMode: true,
      activeSession: {
        ...demoRuns[0],
        outcome: 'complete',
        manualRoast: { changes: [], incomplete: false, logId: 'device:mock#81' },
      },
      manualProfileDraftName: 'Saturday manual profile',
      detailsSaveBlockedReason: reason,
      manualProfileBlockedReason: reason,
    })
    expect(markup).toContain(`title="${reason}"`)
    expect(markup).toContain(`class="session-save-blocked" role="status">${reason}`)
    const profileButton = markup.match(
      /<button type="button" class="primary-button"[^>]*>.*?Save new profile<\/button>/,
    )?.[0]
    expect(profileButton).toContain('disabled')
    expect(markup).toContain('Use as calibration evidence')
  })

  it('keeps a stopped manual roast open only while its recording is committed', () => {
    const markup = render({
      manualMode: true,
      activeSession: { ...demoRuns[0], outcome: 'complete', manualRoast: { changes: [], incomplete: true } },
      manualMessage: 'Heat is off; the fan is cooling for 10 seconds.',
      manualRecordingFinalization: {
        phase: 'finishing',
        detail: 'Heat is off. The roaster is finishing this recording.',
      },
    })
    expect(markup).toContain('Finalizing the roaster recording')
    expect(markup).toContain('Finalizing manual roast recording')
    expect(markup).toContain('The roaster is finishing this recording')
    expect(markup).toContain('Waiting for roast record')
    expect(markup).not.toContain('Roast details saved')
    expect(markup).toContain('Save and close options appear after the roaster-owned recording is verified in History.')
    expect(markup).not.toContain('Done will appear')
    expect(markup).not.toContain('Completed manual roast session')
    expect(markup).not.toContain('Save these instructions for reuse')
    expect(markup).not.toContain('>Done</button>')
  })
  it('does not turn a completed profiled session into a manual session from the setup toggle alone', () => {
    const markup = render({
      manualMode: true,
      activeSession: { ...demoRuns[0], outcome: 'complete', manualRoast: undefined },
    })
    expect(markup).not.toContain('Save these instructions as a new profile?')
    expect(markup).not.toContain('Completed manual roast session')
    expect(markup).toContain('Completed roast session')
    expect(markup).toContain('Done')
  })
})

/**
 * The A4 bug: selecting a timed profile left the previous journey's target line on the chart. The
 * rule is now the profile's own strategy, so the two cases cannot both be true at once.
 */
describe('what the roast chart draws for each strategy', () => {
  it('draws planned fan and heat lanes for a timed profile, and no target line', () => {
    const markup = render({ profile: starterProfile, targetIntent: starterThermalIntent })
    expect(markup).toContain('planned-trace')
    expect(markup).toContain('dashed = planned')
    expect(markup).not.toContain('target-trace')
    expect(markup).not.toContain('ideal-target-node')
  })

  it('draws the target line for a temperature journey, and no planned lanes', () => {
    const markup = render({ profile: starterThermalIntent, targetIntent: starterThermalIntent })
    expect(markup).toContain('target-trace')
    expect(markup).toContain('ideal-target-node')
    expect(markup).toContain('ideal-target-trace')
    expect(markup).not.toContain('planned-trace')
  })

  it('leaves no journey figures in the phase strip for a timed profile', () => {
    const markup = render({ profile: starterProfile, targetIntent: starterThermalIntent })
    const strip = markup.slice(markup.indexOf('phase-strip'))
    expect(strip).toContain('Zones complete')
    // Nothing to report, and it says so rather than reporting the previous journey's numbers.
    expect(strip.slice(0, strip.indexOf('Curve error'))).toContain('--')
  })
})

/**
 * THE PANEL THAT IS NOT THERE ANY MORE.
 *
 * Journey control has no place on an idle Roast page whose roast has not started. Such a panel would
 * be the shared control law folded over idle telemetry as though a roast were at t = 0 - a zone, a
 * target, recommended levels and a correction, all of them drifting with the room, none of them
 * describing anything that is happening.
 *
 * There is exactly one journey-control panel and it is fed by `status.roast`, which exists only
 * while the controller is executing (`RoastView.device.render.test.ts`). The browser never computes
 * a rival one. What the local fold still does is draw the CHART, which is asserted below and in
 * `liveJourney.test.ts`.
 */
describe("journey control is the controller's, or it is nothing", () => {
  const live = (props: Partial<Parameters<typeof RoastView>[0]> = {}) =>
    render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      activeSession: { ...overrunJourneyRun, outcome: 'running' as const },
      samples: overrunJourneyRun.samples,
      elapsedSec: 600,
      status: status({ lifecycle: 'RUNNING', temperatureC: 181.9 }),
      ...props,
    })

  it('renders no control panel before a roast is started', () => {
    const idle = render({ profile: starterThermalIntent, targetIntent: starterThermalIntent })
    expect(idle).not.toContain('Journey control')
    expect(idle).not.toContain('Recommended fan')
    expect(idle).not.toContain('Recommended heat')
    expect(idle).not.toContain('Entered zone')
  })

  /** Nor for a session on firmware with no executor: a browser-computed panel is gone outright. */
  it('renders no control panel for a session either', () => {
    const markup = live()
    expect(markup).not.toContain('Journey control')
    expect(markup).not.toContain('Recommended fan')
    expect(markup).not.toContain('model alone')
  })

  /**
   * The controller executes every roast, so there is no advice-only mode. An "advice only" tag would
   * tell the operator to go to the machine and drive it by hand - the opposite of what the page does -
   * so it appears on no state of the page.
   */
  it('carries no advice-only tag anywhere, on any state of the page', () => {
    for (const markup of [
      render(),
      live(),
      render({ profile: starterThermalIntent, targetIntent: starterThermalIntent }),
    ]) {
      expect(markup).not.toContain('Advice only')
      expect(markup).not.toContain('nothing is commanded')
      expect(markup).not.toContain('advisory-tag')
    }
  })

  /** The fold still runs - it is what the zone bands and the stretched target line are drawn from. */
  it('still draws the chart from the shared control law', () => {
    const markup = live()
    expect(markup).toContain('target-trace')
    expect(markup).toContain('Zones complete')
  })
})

/**
 * A zone that takes longer than planned keeps the planned target curve and shows how much longer the
 * actual roast took. The demo run is exactly that case: zone 2 runs three minutes longer than the
 * profile expected.
 */
describe('a zone that ran three minutes long', () => {
  const markup = render({
    profile: starterThermalIntent,
    targetIntent: starterThermalIntent,
    activeSession: { ...overrunJourneyRun, outcome: 'running' as const },
    samples: overrunJourneyRun.samples,
    elapsedSec: 600,
    status: status({ lifecycle: 'RUNNING', temperatureC: 181.9 }),
  })

  it('states the overrun in words, on the chart, where the reader is already looking', () => {
    expect(markup).toContain('Zone 2 +3:05')
    expect(markup).toContain('zone-overrun-bar')
    expect(markup).toContain('zone-overrun-label')
  })

  it('leaves the planned curve exactly where the profile drew it', () => {
    // The nominal boundary nodes are still at the PLAN's times, not at the measured ones.
    expect(markup).toContain('Zone 2 original boundary: 175 °C at 5:30')
    // And the attainment marker says both, so the pairing is explicit rather than inferred.
    expect(markup).toContain('Zone 2 reached 175 °C at 8:35, planned 5:30 (+3:05)')
  })

  it('draws the adjusted schedule as the primary line, distinguishable from the original', () => {
    expect(markup).toContain('target-trace')
    expect(markup).toContain('ideal-target-trace')
    expect(markup).toContain('Adjusted plan')
    expect(markup).toContain('Original plan')
  })

  it('stays out of the way when every zone runs on time', () => {
    // Two samples, nothing attained, nothing overrun: no bars, no labels, no overrun key.
    const onPlan = render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      samples: [],
      elapsedSec: 0,
    })
    expect(onPlan).not.toContain('zone-overrun-bar')
    expect(onPlan).not.toContain('Zone overrun')
  })
})

/** The legend may only name traces that are actually on the plot. */
describe('the chart legend names what is drawn and nothing else', () => {
  it('does not claim a planned temperature curve for a timed profile, which has none', () => {
    const markup = render({ profile: starterProfile, targetIntent: starterThermalIntent })
    // The dashed lines a timed profile really has are its planned actuator lanes, so that is what
    // the key says. A bare "dashed = planned" would name a curve that does not exist.
    expect(markup).toContain('dashed = planned Fan / Heat')
    expect(markup).not.toContain('>Adjusted plan<')
    expect(markup).not.toContain('>Original plan<')
  })

  it('names the adjusted and original paths only for a temperature journey', () => {
    const markup = render({ profile: starterThermalIntent, targetIntent: starterThermalIntent })
    expect(markup).toContain('>Adjusted plan<')
    expect(markup).toContain('>Original plan<')
    expect(markup).not.toContain('dashed = planned')
  })

  it('names the comparison overlay when one is on the plot', () => {
    const withOverlay = render({ overlay: demoRuns[0] })
    expect(withOverlay).toContain('>Comparison<')
    expect(render()).not.toContain('>Comparison<')
  })
})

/**
 * The executability warning belongs on the Roast page, not in the profile editor: it applies when a
 * temperature journey is selected and the thermocouple is not working.
 */
describe('the temperature-journey probe warning', () => {
  it('appears only when a journey is selected and the probe is actually unusable', () => {
    const faulted = render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: status({ thermocoupleValid: false, temperatureC: undefined }),
    })
    expect(faulted).toContain('No bean temperature, so this journey cannot steer')
    expect(faulted).toContain('The thermocouple is not reporting a temperature.')

    // Healthy probe, same journey: nothing said. A satisfied requirement is never announced.
    const healthy = render({ profile: starterThermalIntent, targetIntent: starterThermalIntent })
    expect(healthy).not.toContain('cannot steer')

    // Timed profile with a dead probe: not this warning's business.
    const timed = render({
      profile: starterProfile,
      status: status({ thermocoupleValid: false, temperatureC: undefined }),
    })
    expect(timed).not.toContain('cannot steer')
  })

  it('names the most fundamental failure rather than listing all of them', () => {
    const gone = render({
      profile: starterThermalIntent,
      targetIntent: starterThermalIntent,
      status: status({ connected: false, stale: true, thermocoupleValid: false, temperatureC: undefined }),
    })
    expect(gone).toContain('The roaster is not connected.')
    expect(gone).not.toContain('stale')
  })
})
