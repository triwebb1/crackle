import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { FanHeatEditor } from './FanHeatEditor'

const noop = () => undefined
const render = (props: Partial<Parameters<typeof FanHeatEditor>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(FanHeatEditor, {
      id: 'levels',
      fanRaw: '5',
      heatRaw: '7',
      onFanInput: noop,
      onHeatInput: noop,
      appliedFan: 4,
      appliedHeat: 7,
      outputFan: 4,
      outputHeat: 7,
      draftDiffers: true,
      onReset: noop,
      onApply: noop,
      applyLabel: 'Apply',
      ...props,
    }),
  )

describe('shared Fan and Heat interaction', () => {
  it('keeps draft fields distinct from the authoritative current output', () => {
    const markup = render()
    expect(markup).toContain('aria-label="Fan"')
    expect(markup).toContain('value="5"')
    expect(markup).toContain('Current output')
    expect(markup).toContain('Fan 4.0 · Heat 7.0')
    expect(markup).not.toContain('Applied command: Fan 4.0 · Heat 7.0')
    expect(markup.indexOf('fan-heat-fields')).toBeLessThan(markup.indexOf('fan-heat-current'))
    expect(markup).toContain('Not applied')
    expect(markup).toContain('Reset')
  })

  /**
   * The cockpit steppers (typed fields are clumsy mid-roast).
   * Each channel gets a half-level notch in both directions; the draft value stays a real input,
   * so direct numeric entry survives as the secondary path.
   */
  it('offers a half-level notch in both directions on both channels, around a real input', () => {
    const markup = render()
    for (const control of ['Fan down 0.5', 'Fan up 0.5', 'Heat down 0.5', 'Heat up 0.5']) {
      expect(markup).toContain(`aria-label="${control}"`)
    }
    expect(markup).toContain('class="level-stepper fan"')
    expect(markup).toContain('class="level-stepper heat"')
    expect(markup).toContain('inputmode="decimal"')
  })

  it('states the exact command on Apply and announces scoped command success', () => {
    const markup = render({ feedback: { tone: 'success', text: 'Fan and heat updated' }, draftDiffers: false })
    // The button IS the readback: what will be sent, not just a verb.
    expect(markup).toContain('>Apply Fan 5.0 · Heat 7.0</button>')
    expect(markup).not.toContain('>Applied</button>')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('Fan and heat updated')
    expect(markup).not.toContain('Matches applied')
  })

  it('falls back to the bare verb when the draft does not parse as a command', () => {
    const markup = render({ fanRaw: '', draftDiffers: false })
    expect(markup).toContain('>Apply</button>')
    expect(markup).not.toContain('NaN')
  })

  it('says loudly, on the editor itself, that the draft is not what the roaster is running', () => {
    expect(render()).toContain('class="fan-heat-editor draft-differs"')
    expect(render({ draftDiffers: false })).toContain('class="fan-heat-editor"')
  })

  it('places an optional planning action beside Apply without changing the device command', () => {
    const markup = render({
      secondaryAction: createElement('button', { class: 'secondary-button' }, 'Add as next step'),
    })
    expect(markup).toContain('Add as next step')
    expect(markup.indexOf('Apply Fan 5.0')).toBeLessThan(markup.indexOf('Add as next step'))
    expect(markup.indexOf('Add as next step')).toBeLessThan(markup.indexOf('Reset'))
  })

  it('shows the accepted command separately only when the roaster output differs', () => {
    const markup = render({ outputFan: 4.8, outputHeat: 7 })
    expect(markup).toContain('Current output')
    expect(markup).toContain('Fan 4.8 · Heat 7.0')
    expect(markup).toContain('Applied command: Fan 4.0 · Heat 7.0')
  })

  it('uses scoped refusal feedback and explains the fan floor', () => {
    const markup = render({
      feedback: { tone: 'error', text: 'The roaster refused that change' },
      preview: 'The heat-on minimum will raise Fan to 1.338.',
    })
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('The roaster refused that change')
    expect(markup).toContain('The heat-on minimum will raise Fan')
    expect(markup).toContain('Use Stop to end the roast')
  })

  it('offers zero fan only for the direct Controls stop pair', () => {
    const controls = render({ allowZeroFanWhenHeatOff: true, fanRaw: '0', heatRaw: '0' })
    expect(controls).toContain('min="0"')
    expect(controls).toContain('0 with Heat 0; otherwise 0.1–10.')
    expect(render()).toContain('min="0.1"')
  })
})
