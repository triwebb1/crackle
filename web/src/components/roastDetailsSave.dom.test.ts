// @vitest-environment jsdom

import { createElement, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { demoRuns, starterBean, starterProfile, starterThermalIntent } from '../data/demo'
import { DEMO_RECORDED_ON } from '../data/demoIdentity'
import type { BatchMeasurements, ControllerStatus, RoastRun } from '../domain/types'
import { RoastView } from './RoastView'

/*
 * Completed roast details on the Roast page (the leave guard fires only for work that exists
 * nowhere but this tab, and Save never claims "Saved" before the roaster acknowledged).
 */
type SaveDetails = (measurements: BatchMeasurements, notes: string, score: number | undefined) => Promise<void>

let root: HTMLDivElement | undefined
afterEach(() => {
  if (root) {
    act(() => render(null, root!))
    root.remove()
    root = undefined
  }
})

const noop = () => undefined
const status: ControllerStatus = {
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
}
const session: RoastRun = {
  ...demoRuns[0],
  outcome: 'complete',
  score: undefined,
  notes: 'First notes',
  measurements: { startingMassG: 225 },
}

const props = (activeSession: RoastRun, onSaveDetails: SaveDetails, onDetailsDirtyChange: (dirty: boolean) => void) =>
  ({
    profile: starterProfile,
    profiles: [starterProfile, starterThermalIntent],
    beans: [starterBean],
    runs: [...demoRuns],
    status,
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
    activeSession,
    onSaveDetails,
    onDetailsDirtyChange,
  }) as unknown as Parameters<typeof RoastView>[0]

const mount = (onSaveDetails: SaveDetails, activeSession = session) => {
  const onDetailsDirtyChange = vi.fn()
  root = document.createElement('div')
  document.body.append(root)
  const rerender = (next: RoastRun) =>
    act(() => render(createElement(RoastView, props(next, onSaveDetails, onDetailsDirtyChange)), root!))
  rerender(activeSession)
  return { host: root, onDetailsDirtyChange, rerender }
}
const saveButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.session-save-actions button')!
const scoreButton = (host: HTMLElement, score: number) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="Score ${score} of 10"]`)!
const lastDirty = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0]
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Roast page details save', () => {
  it('keeps Save disabled while a save is in flight, even after a further edit, and does not claim saved for that edit', async () => {
    const pendingSave = deferred()
    const onSaveDetails = vi.fn<SaveDetails>(() => pendingSave.promise)
    const { host, onDetailsDirtyChange } = mount(onSaveDetails)

    act(() => scoreButton(host, 7).click())
    expect(saveButton(host).disabled).toBe(false)
    await act(async () => {
      saveButton(host).click()
    })
    expect(saveButton(host).disabled).toBe(true)

    // An edit made while the save is in flight must not re-enable Save.
    act(() => scoreButton(host, 9).click())
    expect(saveButton(host).disabled).toBe(true)
    expect(saveButton(host).textContent).toContain('Saving to roaster')
    act(() => saveButton(host).click())
    expect(onSaveDetails).toHaveBeenCalledOnce()

    await act(async () => {
      pendingSave.resolve()
      await pendingSave.promise
    })
    expect(onSaveDetails).toHaveBeenCalledWith({ startingMassG: 225 }, 'First notes', 7)
    // The draft now says 9, which the roaster has not acknowledged: still unsaved, never "Saved".
    expect(host.textContent).not.toContain('Saved on the roaster')
    expect(host.textContent).toContain('Unsaved changes')
    expect(saveButton(host).disabled).toBe(false)
    expect(lastDirty(onDetailsDirtyChange)).toBe(true)
  })

  it('shows saved only when the acknowledged payload is what the draft still says', async () => {
    const onSaveDetails = vi.fn<SaveDetails>(async () => undefined)
    const { host, onDetailsDirtyChange } = mount(onSaveDetails)
    act(() => scoreButton(host, 6).click())
    await act(async () => {
      saveButton(host).click()
    })
    expect(host.textContent).toContain('Saved on the roaster')
    expect(saveButton(host).disabled).toBe(true)
    expect(lastDirty(onDetailsDirtyChange)).toBe(false)
  })

  it('enables Save for a number still being typed and saves the typed value', async () => {
    const onSaveDetails = vi.fn<SaveDetails>(async () => undefined)
    const { host, onDetailsDirtyChange } = mount(onSaveDetails)
    expect(saveButton(host).disabled).toBe(true)
    const finalMass = host.querySelector<HTMLInputElement>('input[aria-label="Final weight (g)"]')!
    act(() => {
      finalMass.focus()
      finalMass.value = '196'
      finalMass.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Not committed yet (no blur), but it is unsaved work: Save is live and the leave guard is up.
    expect(saveButton(host).disabled).toBe(false)
    expect(lastDirty(onDetailsDirtyChange)).toBe(true)

    await act(async () => {
      saveButton(host).click()
    })
    expect(onSaveDetails).toHaveBeenCalledWith({ startingMassG: 225, finalMassG: 196 }, 'First notes', undefined)
    expect(lastDirty(onDetailsDirtyChange)).toBe(false)
  })

  it('re-seeds a clean draft when the stored run changes under the same id and outcome', async () => {
    const onSaveDetails = vi.fn<SaveDetails>(async () => undefined)
    const { host, rerender } = mount(onSaveDetails)
    rerender({ ...session, notes: 'Saved from another tab', score: 8, measurements: { startingMassG: 230 } })
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Roast notes"]')!.value).toBe(
      'Saved from another tab',
    )
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Starting weight (g)"]')!.value).toBe('230')
    expect(saveButton(host).disabled).toBe(true)

    // A later edit saves on top of the new stored values, never the stale ones.
    act(() => scoreButton(host, 5).click())
    await act(async () => {
      saveButton(host).click()
    })
    expect(onSaveDetails).toHaveBeenCalledWith({ startingMassG: 230 }, 'Saved from another tab', 5)
  })

  it('leaves a dirty draft alone when the stored run changes underneath it', () => {
    const { host, rerender } = mount(vi.fn<SaveDetails>(async () => undefined))
    act(() => scoreButton(host, 4).click())
    rerender({ ...session, notes: 'Saved from another tab' })
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Roast notes"]')!.value).toBe('First notes')
    expect(
      host.querySelector<HTMLButtonElement>('button[aria-label="Score 4 of 10"]')!.getAttribute('aria-pressed'),
    ).toBe('true')
  })
})
