// @vitest-environment jsdom

import { createElement, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControllerStatus } from '../domain/types'
import { AdvancedStatusSnapshot, TransportDiagnostics } from './SettingsView'

const status = (temperatureC: number): ControllerStatus => ({
  lifecycle: 'READY',
  connected: true,
  stale: false,
  receivedAtMs: 100,
  firmwareVersion: 'test',
  bootId: 'boot-a',
  manualLockout: false,
  thermocoupleValid: true,
  temperatureC,
  capabilities: {
    apiVersion: 'test',
    autonomousTimedPrograms: true,
    thermalExecution: true,
    diagnosticTests: true,
  },
})

let root: HTMLDivElement | undefined
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

const mount = (value: ControllerStatus) => {
  root = document.createElement('div')
  document.body.append(root)
  act(() => render(createElement(AdvancedStatusSnapshot, { status: value }), root!))
  return root
}

afterEach(() => {
  if (root) {
    act(() => render(null, root!))
    root.remove()
    root = undefined
  }
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else delete (navigator as unknown as { clipboard?: Clipboard }).clipboard
})

describe('Advanced status snapshot', () => {
  it('keeps the same selectable snapshot until the operator refreshes it', () => {
    const mounted = mount(status(20))
    const original = mounted.querySelector('[aria-label="Status snapshot"]')!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(original)
    selection.removeAllRanges()
    selection.addRange(range)

    act(() => render(createElement(AdvancedStatusSnapshot, { status: status(21) }), mounted))
    expect(mounted.querySelector('[aria-label="Status snapshot"]')).toBe(original)
    expect(original.textContent).toContain('"temperatureC": 20')
    expect(selection.toString()).toContain('"temperatureC": 20')

    const refresh = [...mounted.querySelectorAll('button')].find((button) => button.textContent === 'Refresh snapshot')!
    act(() => refresh.click())
    expect(original.textContent).toContain('"temperatureC": 21')
    expect(mounted.textContent).toContain('Status snapshot refreshed.')
  })

  it('copies the exact displayed snapshot and announces success', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const mounted = mount(status(42))
    const snapshot = mounted.querySelector('[aria-label="Status snapshot"]')!.textContent!
    const copy = [...mounted.querySelectorAll('button')].find((button) => button.textContent === 'Copy status')!

    await act(async () => {
      copy.click()
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith(snapshot)
    expect(mounted.querySelector('[role="status"]')?.textContent).toBe('Status snapshot copied.')
  })
})
describe('Transport diagnostics', () => {
  it('shows subscriber occupancy, rejected work, failures, and stack reserves', () => {
    const value = status(20)
    value.liveTransport = {
      websocketAvailable: true,
      websocketClientCount: 2,
      websocketClientCapacity: 4,
      httpRejectedRequestCount: 9,
      httpWorkerFailureCount: 1,
      httpWorkerStackLowWaterBytes: 6_000,
      storageWorkerStackLowWaterBytes: 7_000,
    }
    root = document.createElement('div')
    document.body.append(root)
    act(() => render(createElement(TransportDiagnostics, { status: value }), root!))
    expect(root.textContent).toContain('2 / 4')
    expect(root.textContent).toContain('Refused requests9')
    expect(root.textContent).toContain('Worker failures1')
    expect(root.textContent).toContain('6.0 KB')
    expect(root.textContent).toContain('7.0 KB')

    value.liveTransport.httpWorkerStackLowWaterBytes = 0
    value.liveTransport.storageWorkerStackLowWaterBytes = 0
    act(() => render(createElement(TransportDiagnostics, { status: value }), root!))
    expect(root.textContent?.match(/Not measured/g)).toHaveLength(2)
  })
})
