import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { MockPowerCycleControl, mockPowerCycleAvailable } from './MockPowerCycleControl'

const action = async () => 'Power-cycled'
const simulated = {
  roaster: { deviceId: 'sim', modelId: 'mock-sr800', displayName: 'Simulated SR800', simulated: true },
}
const real = { roaster: { deviceId: 'real', modelId: 'sr800', displayName: 'SR800', simulated: false } }

describe('mock power-cycle control', () => {
  it('requires development, an authoritative simulated identity, and an injected action', () => {
    expect(mockPowerCycleAvailable(simulated, action, true)).toBe(true)
    expect(mockPowerCycleAvailable(simulated, undefined, true)).toBe(false)
    expect(mockPowerCycleAvailable(real, action, true)).toBe(false)
    expect(mockPowerCycleAvailable(simulated, action, false)).toBe(false)
  })

  it('labels the destructive runtime boundary without implying device data is erased', () => {
    const markup = renderToStaticMarkup(
      createElement(MockPowerCycleControl, {
        status: simulated,
        onPowerCycleMock: action,
        onSetProbeAvailable: async () => 'Probe changed',
        onDropLiveStream: async () => 'Dropped',
        development: true,
      }),
    )
    expect(markup).toContain('Local simulation only')
    expect(markup).toContain('Power-cycle mock roaster')
    expect(markup).toContain('Disconnect probe')
    expect(markup).toContain('Reconnect probe')
    expect(markup).toContain('Drop live stream')
    expect(markup).toContain('Stored device data remains')
    expect(markup).toContain('active runtime work is discarded')
  })

  it('renders no production or real-device action', () => {
    expect(
      renderToStaticMarkup(
        createElement(MockPowerCycleControl, {
          status: real,
          onPowerCycleMock: action,
          development: true,
        }),
      ),
    ).toBe('')
    expect(
      renderToStaticMarkup(
        createElement(MockPowerCycleControl, {
          status: simulated,
          onPowerCycleMock: action,
          development: false,
        }),
      ),
    ).toBe('')
  })
})
