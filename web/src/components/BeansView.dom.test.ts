// @vitest-environment jsdom

import { createElement, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BeanLot } from '../domain/types'
import { BeansView } from './BeansView'

let root: HTMLDivElement | undefined

const mount = (onSave = vi.fn()) => {
  root = document.createElement('div')
  document.body.append(root)
  act(() =>
    render(
      createElement(BeansView, {
        beans: [],
        runs: [],
        revisions: [],
        onSelect: vi.fn(),
        onSave,
        onDelete: vi.fn(),
        onDirtyChange: vi.fn(),
        onOpenRun: vi.fn(),
        onReorder: vi.fn(),
      }),
      root!,
    ),
  )
  return { root, onSave }
}

afterEach(() => {
  if (!root) return
  act(() => render(null, root!))
  root.remove()
  root = undefined
})

describe('empty bean catalog draft', () => {
  it('starts as a local draft and never persists a blank lot when New lot is clicked', () => {
    const { root, onSave } = mount()
    const save = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Save')!
    const create = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes('New lot'))!
    expect((root.querySelector('[aria-label="Bean lot name"]') as HTMLInputElement).value).toBe('New bean lot')
    expect(save.disabled).toBe(true)

    act(() => {
      create.click()
    })
    expect(onSave).not.toHaveBeenCalled()
    expect(root.querySelectorAll('[data-bean-id]')).toHaveLength(0)
  })

  it('treats a valid density expression as a saveable edit without requiring a name change', async () => {
    const onSave = vi.fn(async (_bean: BeanLot) => true)
    const { root } = mount(onSave)
    const density = root.querySelector('[aria-label="Green bulk density (g/ml)"]') as HTMLInputElement

    act(() => {
      density.value = '225/350'
      density.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Save')!
    expect(save.disabled).toBe(false)

    await act(async () => {
      save.click()
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0].greenDensityGPerMl).toBeCloseTo(225 / 350)
  })
})
