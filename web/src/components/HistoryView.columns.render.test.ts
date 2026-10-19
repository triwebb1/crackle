import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { demoRuns } from '../data/demo'
import { DEMO_SOURCE_DEVICE_ID } from '../data/demoIdentity'
import { HistoryView } from './HistoryView'

const noop = () => undefined

/**
 * A roast is found by when it ran and what it was called. The roast name is the primary column:
 * directly after the date, the widest column, and allowed to wrap rather than be clipped.
 */
describe('history columns', () => {
  const markup = renderToStaticMarkup(
    createElement(HistoryView, {
      runs: demoRuns,
      onOverlay: noop,
      onDelete: noop,
      onSaveDetails: async () => undefined,
      onImport: async () => '',
      onUseAsProfile: noop,
      activeRoasterId: DEMO_SOURCE_DEVICE_ID,
    }),
  )
  const cells = [...markup.matchAll(/<th([^>]*)>([\s\S]*?)<\/th>/g)]
  const headers = cells.map((match) => match[2].replace(/<[^>]+>/g, '').trim())
  const widths = cells.map((match) => Number(/width:\s*(\d+)%/.exec(match[1])?.[1] ?? 0))

  it('puts the roast name directly after the date', () => {
    const date = headers.findIndex((text) => text.startsWith('Date'))
    expect(date).toBeGreaterThanOrEqual(0)
    expect(headers[date + 1]).toMatch(/^Roast/)
  })

  it('gives the roast name the widest column, wrapping instead of clipping', () => {
    const roast = headers.findIndex((text) => text.startsWith('Roast'))
    expect(widths[roast]).toBeGreaterThan(0)
    expect(widths[roast]).toBe(Math.max(...widths))
    expect(markup).toContain('name-cell')
  })
})
