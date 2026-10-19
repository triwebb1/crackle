// @vitest-environment jsdom

import { createElement, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoRuns } from '../data/demo'
import type { BatchMeasurements, RoastRun } from '../domain/types'
import { HistoryView } from './HistoryView'

/*
 * Saved details must not produce "leave without saving?" anywhere. History reports its own dirty
 * state, and that state must clear on an acknowledged save and when an edit is put back - and must
 * be raised by a real unsaved score.
 */
let root: HTMLDivElement | undefined
afterEach(() => {
  if (root) {
    render(null, root)
    root.remove()
    root = undefined
  }
})

type SaveDetails = (
  id: string,
  measurements: BatchMeasurements,
  notes: string,
  score: number | undefined,
) => Promise<void>
const baseRun: RoastRun = { ...demoRuns[0], score: undefined }
const mount = (onSaveDetails: ReturnType<typeof vi.fn<SaveDetails>> = vi.fn<SaveDetails>(async () => undefined)) => {
  const onDirtyChange = vi.fn()
  root = document.createElement('div')
  document.body.append(root)
  const rerender = (runs: RoastRun[]) =>
    act(() =>
      render(
        createElement(HistoryView, {
          runs,
          onOverlay: vi.fn(),
          onDelete: vi.fn(),
          onSaveDetails,
          onDirtyChange,
          onImport: async () => '',
          onUseAsProfile: vi.fn(),
          activeRoasterId: baseRun.recordedOn.deviceId,
        }),
        root!,
      ),
    )
  rerender([baseRun])
  act(() => {
    root!.querySelector<HTMLButtonElement>('button[aria-label="Expand row"]')!.click()
  })
  return { root: root!, onDirtyChange, onSaveDetails, rerender }
}
const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const lastDirty = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0]
const scoreButton = (host: HTMLElement, score: number) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="Score ${score} of 10"]`)!
const saveButton = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>('.history-actions button')].find((button) =>
    /Save|Saved/.test(button.textContent ?? ''),
  )!

describe('History details and the leave guard', () => {
  it('is dirty after a score is picked and clean again when it is put back', () => {
    const { root: host, onDirtyChange } = mount()
    expect(lastDirty(onDirtyChange)).toBe(false)
    expect(saveButton(host).disabled).toBe(true)
    act(() => scoreButton(host, 8).click())
    expect(lastDirty(onDirtyChange)).toBe(true)
    expect(saveButton(host).disabled).toBe(false)
    act(() => scoreButton(host, 8).click())
    expect(lastDirty(onDirtyChange)).toBe(false)
  })

  it('clears after the roaster acknowledges the save, sending the score', async () => {
    const { root: host, onDirtyChange, onSaveDetails } = mount()
    act(() => scoreButton(host, 9).click())
    await act(async () => {
      saveButton(host).click()
    })
    expect(onSaveDetails).toHaveBeenCalledWith(demoRuns[0].id, expect.any(Object), demoRuns[0].notes, 9)
    expect(lastDirty(onDirtyChange)).toBe(false)
    expect(host.textContent).toContain('Saved on the roaster')
  })

  it('stays dirty when the save is refused', async () => {
    const { root: host, onDirtyChange } = mount(
      vi.fn(async () => {
        throw new Error('refused')
      }),
    )
    act(() => scoreButton(host, 4).click())
    await act(async () => {
      saveButton(host).click()
    })
    expect(lastDirty(onDirtyChange)).toBe(true)
    expect(host.textContent).toContain('Not saved')
  })

  it('enables Save for a number still being typed and saves the typed value', async () => {
    const { root: host, onDirtyChange, onSaveDetails } = mount()
    const finalMass = host.querySelector<HTMLInputElement>('input[aria-label="Final g"]')!
    act(() => {
      finalMass.focus()
      finalMass.value = '196'
      finalMass.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(saveButton(host).disabled).toBe(false)
    expect(lastDirty(onDirtyChange)).toBe(true)
    await act(async () => {
      saveButton(host).click()
    })
    expect(onSaveDetails).toHaveBeenCalledWith(
      baseRun.id,
      expect.objectContaining({ finalMassG: 196 }),
      baseRun.notes,
      undefined,
    )
    expect(lastDirty(onDirtyChange)).toBe(false)
  })

  it('releases the leave guard when a run holding an unsaved draft is deleted', () => {
    const { root: host, onDirtyChange, rerender } = mount()
    act(() => scoreButton(host, 8).click())
    expect(lastDirty(onDirtyChange)).toBe(true)
    rerender([])
    expect(lastDirty(onDirtyChange)).toBe(false)
  })

  it('drops an idle draft once the stored run says the same thing, and keeps one that still differs', () => {
    const { root: host, onDirtyChange, rerender } = mount()
    act(() => scoreButton(host, 8).click())
    rerender([{ ...baseRun, notes: 'Changed in another tab' }])
    expect(lastDirty(onDirtyChange)).toBe(true)
    rerender([{ ...baseRun, notes: 'Changed in another tab', score: 8 }])
    // The draft was compared against the new stored values: score 8 but the OLD notes still differ.
    expect(lastDirty(onDirtyChange)).toBe(true)
    rerender([{ ...baseRun, score: 8 }])
    expect(lastDirty(onDirtyChange)).toBe(false)
    expect(saveButton(host).disabled).toBe(true)
  })

  it('shows a refused save even when a newer edit was made while it was in flight', async () => {
    const pendingSave = deferred()
    const { root: host, onDirtyChange } = mount(vi.fn<SaveDetails>(() => pendingSave.promise))
    act(() => scoreButton(host, 4).click())
    await act(async () => {
      saveButton(host).click()
    })
    act(() => scoreButton(host, 6).click())
    await act(async () => {
      pendingSave.reject(new Error('roaster busy'))
      await pendingSave.promise.catch(() => undefined)
    })
    expect(host.textContent).toContain('Not saved — roaster busy')
    expect(lastDirty(onDirtyChange)).toBe(true)
    expect(saveButton(host).disabled).toBe(false)
  })
})
