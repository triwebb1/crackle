// @vitest-environment jsdom

import { createElement, render } from 'preact'
import { useState } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FanHeatEditor, steppedLevel } from './FanHeatEditor'

let root: HTMLDivElement | undefined

/**
 * A stateful harness, because the editor is controlled: the stepper emits a draft string and the
 * owner of the draft renders it back, exactly as RoastView and ManualView do.
 */
function Harness({
  onApply,
  allowZeroFanWhenHeatOff = false,
}: {
  onApply: () => void
  allowZeroFanWhenHeatOff?: boolean
}) {
  const [fanRaw, setFanRaw] = useState('4')
  const [heatRaw, setHeatRaw] = useState('0')
  return createElement(FanHeatEditor, {
    id: 'cockpit',
    fanRaw,
    heatRaw,
    onFanInput: setFanRaw,
    onHeatInput: setHeatRaw,
    draftDiffers: false,
    onReset: () => undefined,
    onApply,
    applyLabel: 'Apply',
    allowZeroFanWhenHeatOff,
  })
}

const mount = (onApply: () => void, allowZeroFanWhenHeatOff = false) => {
  root = document.createElement('div')
  document.body.append(root)
  act(() => render(createElement(Harness, { onApply, allowZeroFanWhenHeatOff }), root!))
  return root
}

const button = (label: string) => root!.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
const input = (label: string) => root!.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
const apply = () => root!.querySelector('.fan-heat-apply') as HTMLButtonElement

afterEach(() => {
  if (root) {
    act(() => render(null, root!))
    root.remove()
    root = undefined
  }
})

describe('the half-level notch', () => {
  it('steps the draft by 0.5 without sending anything to the roaster', () => {
    const onApply = vi.fn()
    mount(onApply)
    act(() => {
      button('Fan up 0.5').click()
    })
    expect(input('Fan').value).toBe('4.5')
    act(() => {
      button('Fan up 0.5').click()
    })
    expect(input('Fan').value).toBe('5')
    act(() => {
      button('Heat up 0.5').click()
    })
    expect(input('Heat').value).toBe('0.5')
    // A notch is a draft edit, never a command. Only Apply commands, and only when pressed.
    expect(onApply).not.toHaveBeenCalled()
    // And the readback button already names the new command.
    expect(apply().textContent).toContain('Apply Fan 5.0 · Heat 0.5')
    act(() => {
      apply().click()
    })
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('clamps at the top of the range and at the roast fan floor', () => {
    mount(vi.fn())
    for (let presses = 0; presses < 14; presses += 1)
      act(() => {
        button('Fan up 0.5').click()
      })
    expect(input('Fan').value).toBe('10')
    for (let presses = 0; presses < 25; presses += 1)
      act(() => {
        button('Fan down 0.5').click()
      })
    // A recordable manual roast never drafts Fan 0: Stop is the way to end it.
    expect(input('Fan').value).toBe('0.1')
    for (let presses = 0; presses < 3; presses += 1)
      act(() => {
        button('Heat down 0.5').click()
      })
    expect(input('Heat').value).toBe('0')
  })

  it('lets direct Controls step fan all the way to its 0/0 stop pair', () => {
    mount(vi.fn(), true)
    for (let presses = 0; presses < 10; presses += 1)
      act(() => {
        button('Fan down 0.5').click()
      })
    expect(input('Fan').value).toBe('0')
  })

  /**
   * Tapping into the field selects the whole value, so typing a digit REPLACES it - otherwise a
   * mid-roast "4" becomes "41" because the caret lands after the old value. Selection never edits
   * the draft: the value is untouched until the operator actually types.
   */
  it('selects the whole value on focus so the first typed digit replaces it', () => {
    mount(vi.fn())
    const selected = vi.spyOn(HTMLInputElement.prototype, 'select')
    act(() => {
      input('Fan').focus()
    })
    expect(selected).toHaveBeenCalledTimes(1)
    expect(input('Fan').value).toBe('4')
    act(() => {
      input('Heat').focus()
    })
    expect(selected).toHaveBeenCalledTimes(2)
    selected.mockRestore()
  })

  it('keeps typed entry alive as the secondary path and snaps the next notch to the grid', () => {
    mount(vi.fn())
    act(() => {
      input('Fan').value = '4.3'
      input('Fan').dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input('Fan').value).toBe('4.3')
    act(() => {
      button('Fan up 0.5').click()
    })
    expect(input('Fan').value).toBe('5')
    act(() => {
      button('Fan down 0.5').click()
    })
    expect(input('Fan').value).toBe('4.5')
  })
})

describe('steppedLevel arithmetic', () => {
  it('snaps off-grid drafts onto the half-level grid in the pressed direction', () => {
    expect(steppedLevel('4.3', 1, 0.1)).toBe('5')
    expect(steppedLevel('4.3', -1, 0.1)).toBe('4')
    expect(steppedLevel('4', 1, 0.1)).toBe('4.5')
    expect(steppedLevel('4', -1, 0.1)).toBe('3.5')
  })

  it('clamps to the channel range and recovers from an emptied field', () => {
    expect(steppedLevel('10', 1, 0.1)).toBe('10')
    expect(steppedLevel('0.5', -1, 0.1)).toBe('0.1')
    expect(steppedLevel('0.1', 1, 0.1)).toBe('0.5')
    expect(steppedLevel('0', -1, 0)).toBe('0')
    expect(steppedLevel('', 1, 0.1)).toBe('0.5')
    expect(steppedLevel('garbage', -1, 0)).toBe('0')
  })
})
