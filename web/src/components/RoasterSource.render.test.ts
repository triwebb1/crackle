import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import type { RecordedOn } from '../domain/types'
import { RoasterSourceBadge, RoasterTargetList, type RoasterTargetPresentation, sourceMatches } from './RoasterSource'

const physical: RecordedOn = {
  deviceId: 'physical-1',
  modelId: 'freshroast-sr800',
  displayNameAtCapture: 'Kitchen SR800',
  simulated: false,
  firmwareVersion: '2026.07',
  identitySource: 'roaster',
}

const mock: RecordedOn = {
  ...physical,
  deviceId: 'mock-1',
  modelId: 'crackle-sim-sr800',
  displayNameAtCapture: 'Development mock',
  simulated: true,
}

describe('record source presentation', () => {
  it('uses textual physical, mock, and other-roaster labels', () => {
    expect(
      renderToStaticMarkup(
        createElement(RoasterSourceBadge, {
          recordedOn: physical,
          activeDeviceId: physical.deviceId,
        }),
      ),
    ).toContain('Physical')
    expect(
      renderToStaticMarkup(
        createElement(RoasterSourceBadge, {
          recordedOn: mock,
          activeDeviceId: physical.deviceId,
        }),
      ),
    ).toContain('Mock')
    expect(
      renderToStaticMarkup(
        createElement(RoasterSourceBadge, {
          recordedOn: { ...physical, deviceId: 'physical-2' },
          activeDeviceId: physical.deviceId,
        }),
      ),
    ).toContain('Other roaster')
  })

  it('defaults source matching to the active roaster without conflating mock and physical', () => {
    expect(sourceMatches(physical, 'active', physical.deviceId)).toBe(true)
    expect(sourceMatches(physical, 'active', undefined)).toBe(false)
    expect(sourceMatches(mock, 'active', physical.deviceId)).toBe(false)
    expect(sourceMatches(mock, 'mock', physical.deviceId)).toBe(true)
    expect(sourceMatches(physical, 'physical', mock.deviceId)).toBe(true)
  })
})

describe('target list presentation', () => {
  const targets: RoasterTargetPresentation[] = [
    { id: 'physical-1', name: 'Kitchen SR800', model: 'freshroast-sr800', simulated: false, connected: true },
    { id: 'mock-1', name: 'Development mock', model: 'crackle-sim-sr800', simulated: true, connected: true },
  ]

  it('states active target, connection, and mock/physical kind without color-only meaning', () => {
    const markup = renderToStaticMarkup(
      createElement(RoasterTargetList, {
        activeId: 'physical-1',
        targets,
        onSelect: () => undefined,
      }),
    )
    expect(markup).toContain('Kitchen SR800')
    expect(markup).toContain('Development mock')
    expect(markup).toContain('Physical')
    expect(markup).toContain('Mock')
    expect(markup).toContain('Connected')
    expect(markup).toContain('Active')
  })

  it('keeps the switch reason visible when target changes are blocked', () => {
    const markup = renderToStaticMarkup(
      createElement(RoasterTargetList, {
        activeId: 'physical-1',
        targets,
        onSelect: () => undefined,
        blockedReason: 'Finish cooling before switching roasters.',
      }),
    )
    expect(markup).toContain('Finish cooling before switching roasters.')
    expect(markup).toContain('disabled')
  })
})
