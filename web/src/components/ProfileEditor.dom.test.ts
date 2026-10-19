// @vitest-environment jsdom

import { createElement, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterThermalIntent } from '../data/demo'
import type { Profile } from '../domain/types'
import { ProfileEditor } from './ProfileEditor'

let root: HTMLDivElement | undefined

const mount = ({
  profiles = [],
  selectedId = '',
  blocked = true,
}: {
  profiles?: Profile[]
  selectedId?: string
  blocked?: boolean
} = {}) => {
  const onDirtyChange = vi.fn()
  const onSave = vi.fn()
  root = document.createElement('div')
  document.body.append(root)
  act(() =>
    render(
      createElement(ProfileEditor, {
        profiles,
        selectedId,
        suggestions: { intents: [] },
        runs: [],
        calibration: defaultCalibration,
        revisions: [],
        snapshots: [],
        defaultMassG: 225,
        mutationBlockedReason: blocked ? 'The latest thermal recording is still being finalized.' : undefined,
        onRevisionConsumed: vi.fn(),
        onSelect: vi.fn(),
        onSave,
        onExport: vi.fn(),
        onDirtyChange,
        onReorder: vi.fn(),
        onOpenRun: vi.fn(),
      }),
      root!,
    ),
  )
  return { root, onDirtyChange, onSave }
}

afterEach(() => {
  if (!root) return
  act(() => render(null, root!))
  root.remove()
  root = undefined
})

describe('empty profile catalog draft', () => {
  it('opens clean and does not present a recording-finalization warning', () => {
    const { root, onDirtyChange, onSave } = mount()
    const save = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Save profile')!

    expect(root.textContent).toContain('No profiles saved')
    expect(root.textContent).not.toContain('latest thermal recording')
    expect(save.disabled).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('makes New timed a local unsaved draft without writing to the roaster', () => {
    const { root, onDirtyChange, onSave } = mount()
    const create = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes('New timed'))!

    act(() => {
      create.click()
    })

    expect(onSave).not.toHaveBeenCalled()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    expect(root.textContent).toContain('latest thermal recording')
    const save = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Save profile')!
    expect(save.disabled).toBe(true)
  })
})

describe('profile duration fields', () => {
  const commit = (input: HTMLInputElement, value: string) => {
    act(() => {
      input.focus()
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Input state must render before the separate browser blur/commit event.
    act(() => input.blur())
  }

  it('reads a bare whole number as minutes and updates the journey draft', () => {
    const profile = structuredClone(starterThermalIntent)
    const { root, onDirtyChange } = mount({
      profiles: [profile],
      selectedId: profile.id,
      blocked: false,
    })
    const input = root.querySelector<HTMLInputElement>('[aria-label="Zone 1 duration"]')!

    commit(input, '3')

    expect(input.value).toBe('3:00')
    expect(root.textContent).toContain('Journey duration 12:15')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('normalizes decimal minutes without dirtying an unchanged duration', () => {
    const profile = structuredClone(starterThermalIntent)
    const { root, onDirtyChange } = mount({
      profiles: [profile],
      selectedId: profile.id,
      blocked: false,
    })
    const input = root.querySelector<HTMLInputElement>('[aria-label="Zone 1 duration"]')!

    commit(input, '3.5')

    expect(input.value).toBe('3:30')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })
})
