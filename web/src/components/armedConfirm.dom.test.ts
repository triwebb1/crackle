// @vitest-environment jsdom

import { createElement, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalStopButton } from './AppShell'
import { ARMED_STOP_DECAY_MS } from './armedConfirm'

let root: HTMLDivElement | undefined

const mount = (confirmRoastStop: boolean, onStop: () => void) => {
  root = document.createElement('div')
  document.body.append(root)
  act(() => {
    render(createElement(GlobalStopButton, { busy: false, confirmRoastStop, onStop }), root!)
  })
  return root.querySelector('button')!
}

afterEach(() => {
  if (root) {
    render(null, root)
    root.remove()
    root = undefined
  }
})

describe('roast-stop confirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms on the first tap and stops only on the second', () => {
    const onStop = vi.fn()
    const button = mount(true, onStop)
    expect(button.textContent).toContain('Stop')
    act(() => {
      button.click()
    })
    expect(onStop).not.toHaveBeenCalled()
    expect(button.textContent).toContain('Tap again to stop')
    expect(button.className).toContain('armed')
    act(() => {
      button.click()
    })
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(button.textContent).not.toContain('Tap again')
  })

  it('disarms by itself so a stray tap never leaves a hair trigger', () => {
    const onStop = vi.fn()
    const button = mount(true, onStop)
    act(() => {
      button.click()
    })
    expect(button.textContent).toContain('Tap again to stop')
    act(() => {
      vi.advanceTimersByTime(ARMED_STOP_DECAY_MS + 50)
    })
    expect(button.textContent).not.toContain('Tap again')
    act(() => {
      button.click()
    })
    expect(onStop).not.toHaveBeenCalled()
  })

  it('keeps non-roast stops single-tap', () => {
    const onStop = vi.fn()
    const button = mount(false, onStop)
    act(() => {
      button.click()
    })
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
