import { h } from 'preact'
import { renderToString } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { starterThermalIntent } from '../data/demo'
import { LiveChart } from './LiveChart'

const render = (planOnly: boolean) =>
  renderToString(
    h(LiveChart, {
      samples: [],
      targetIntent: starterThermalIntent,
      events: [],
      elapsedSec: 0,
      planOnly,
    }),
  )

/** A stored roast has no adjusted schedule, so its chart must not key one. */
describe('a journey chart with no adjusted schedule', () => {
  it('draws the plan once and keys it as the plan', () => {
    const markup = render(true)
    expect(markup).toContain('>Plan<')
    expect(markup).not.toContain('>Adjusted plan<')
    expect(markup).not.toContain('>Original plan<')
    expect(markup).not.toContain('ideal-target-trace')
    expect(markup.match(/class="trace target-trace"/g)).toHaveLength(1)
  })

  it('keeps both lines and both keys on a live chart', () => {
    const markup = render(false)
    expect(markup).toContain('>Adjusted plan<')
    expect(markup).toContain('>Original plan<')
    expect(markup).toContain('ideal-target-trace')
  })
})
