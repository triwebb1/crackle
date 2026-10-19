// @vitest-environment jsdom

import { createElement, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterBean, starterProfile, starterThermalIntent } from '../data/demo'
import type { BeanLot } from '../domain/types'
import { BeansView } from './BeansView'
import { keyboardReorder, orderChanged } from './catalogStrip'
import { ProfileEditor } from './ProfileEditor'

/*
 * Reordering writes to the roaster, so a drag that ends where it began must write nothing, and a
 * focusable grip must move its item from the keyboard.
 */
let root: HTMLDivElement | undefined
beforeAll(() => {
  // jsdom has no pointer capture; the grips call it on pointerdown.
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => undefined
})
afterEach(() => {
  if (root) {
    act(() => render(null, root!))
    root.remove()
    root = undefined
  }
})

const host = () => {
  root = document.createElement('div')
  document.body.append(root)
  return root
}
const pointer = (target: Element, type: string) =>
  act(() => {
    target.dispatchEvent(new Event(type, { bubbles: true }))
  })
const key = (target: Element, name: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })

const beans: BeanLot[] = [
  { ...starterBean, id: 'bean-a', name: 'Alpha' },
  { ...starterBean, id: 'bean-b', name: 'Bravo' },
  { ...starterBean, id: 'bean-c', name: 'Charlie' },
]
const mountBeans = (mutationBlockedReason?: string) => {
  const onReorder = vi.fn()
  const element = host()
  act(() =>
    render(
      createElement(BeansView, {
        beans,
        runs: [],
        revisions: [],
        selectedId: 'bean-a',
        onSelect: vi.fn(),
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onDirtyChange: vi.fn(),
        onOpenRun: vi.fn(),
        onReorder,
        mutationBlockedReason,
      }),
      element,
    ),
  )
  return { element, onReorder }
}
const mountProfiles = (mutationBlockedReason?: string) => {
  const onReorder = vi.fn()
  const element = host()
  act(() =>
    render(
      createElement(ProfileEditor, {
        profiles: [starterProfile, starterThermalIntent],
        selectedId: starterProfile.id,
        suggestions: { intents: [] },
        runs: [],
        calibration: defaultCalibration,
        revisions: [],
        snapshots: [],
        defaultMassG: 225,
        mutationBlockedReason,
        onRevisionConsumed: vi.fn(),
        onSelect: vi.fn(),
        onSave: vi.fn(),
        onExport: vi.fn(),
        onDirtyChange: vi.fn(),
        onReorder,
        onOpenRun: vi.fn(),
      }),
      element,
    ),
  )
  return { element, onReorder }
}

describe('order helpers', () => {
  it('detects an unchanged order and moves one place by arrow key', () => {
    expect(orderChanged(['a', 'b'], ['a', 'b'])).toBe(false)
    expect(orderChanged(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(keyboardReorder(['a', 'b', 'c'], 'b', 'ArrowUp')).toEqual(['b', 'a', 'c'])
    expect(keyboardReorder(['a', 'b', 'c'], 'b', 'ArrowRight')).toEqual(['a', 'c', 'b'])
    expect(keyboardReorder(['a', 'b', 'c'], 'a', 'ArrowLeft')).toBeUndefined()
    expect(keyboardReorder(['a', 'b', 'c'], 'b', 'Enter')).toBeUndefined()
  })
})

describe('bean lot reorder', () => {
  it('writes nothing for a drag that ends where it began', () => {
    const { element, onReorder } = mountBeans()
    const grip = element.querySelector('[aria-label="Reorder Bravo"]')!
    pointer(grip, 'pointerdown')
    pointer(element.querySelector('.bean-list')!, 'pointerup')
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('moves a lot one place from the keyboard, and not while mutation is blocked', () => {
    const { element, onReorder } = mountBeans()
    key(element.querySelector('[aria-label="Reorder Bravo"]')!, 'ArrowDown')
    expect(onReorder).toHaveBeenCalledWith(['bean-a', 'bean-c', 'bean-b'])
    act(() => render(null, element))
    element.remove()
    root = undefined
    const blocked = mountBeans('Roaster busy')
    key(blocked.element.querySelector('[aria-label="Reorder Bravo"]')!, 'ArrowUp')
    expect(blocked.onReorder).not.toHaveBeenCalled()
  })
})

describe('profile reorder', () => {
  it('writes nothing for a drag that ends where it began', () => {
    const { element, onReorder } = mountProfiles()
    const grip = element.querySelector(`[aria-label="Reorder ${starterProfile.name}"]`)!
    pointer(grip, 'pointerdown')
    pointer(element.querySelector('.profile-list')!, 'pointerup')
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('moves a profile one place from the keyboard', () => {
    const { element, onReorder } = mountProfiles()
    key(element.querySelector(`[aria-label="Reorder ${starterThermalIntent.name}"]`)!, 'ArrowUp')
    expect(onReorder).toHaveBeenCalledWith([starterThermalIntent.id, starterProfile.id])
  })
})
