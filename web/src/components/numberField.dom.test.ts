// @vitest-environment jsdom

import { createElement, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NumberField } from './NumberField'

let root: HTMLDivElement | undefined

const mount = (onCommit: (value: number | undefined) => void) => {
  root = document.createElement('div')
  document.body.append(root)
  act(() => render(createElement(NumberField, { label: 'Mass', value: 225, onCommit }), root!))
  return root.querySelector('input') as HTMLInputElement
}

afterEach(() => {
  if (root) {
    act(() => render(null, root!))
    root.remove()
    root = undefined
  }
})

describe('NumberField commit boundary', () => {
  it('keeps input as a text draft until blur', () => {
    const onCommit = vi.fn()
    const input = mount(onCommit)

    act(() => {
      input.value = '240'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('240')
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      input.dispatchEvent(new FocusEvent('blur'))
    })
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenLastCalledWith(240)
  })

  it('commits the draft on Enter without waiting for blur', () => {
    const onCommit = vi.fn()
    const input = mount(onCommit)

    act(() => {
      input.value = '230'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenLastCalledWith(230)

    act(() => {
      input.dispatchEvent(new FocusEvent('blur'))
    })
    expect(onCommit).toHaveBeenCalledOnce()
  })

  it('reports uncommitted text until it is committed, and not for text equal to the committed value', () => {
    const onUncommittedChange = vi.fn()
    root = document.createElement('div')
    document.body.append(root)
    act(() =>
      render(createElement(NumberField, { label: 'Mass', value: 225, onCommit: vi.fn(), onUncommittedChange }), root!),
    )
    const input = root.querySelector('input') as HTMLInputElement
    const type = (text: string) =>
      act(() => {
        input.value = text
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    type('196')
    expect(onUncommittedChange).toHaveBeenLastCalledWith(true)
    type('225.0')
    expect(onUncommittedChange).toHaveBeenLastCalledWith(false)
    type('196')
    act(() => {
      input.dispatchEvent(new FocusEvent('blur'))
    })
    expect(onUncommittedChange).toHaveBeenLastCalledWith(false)
    type('180')
    act(() => render(null, root!))
    expect(onUncommittedChange).toHaveBeenLastCalledWith(false)
  })
})
