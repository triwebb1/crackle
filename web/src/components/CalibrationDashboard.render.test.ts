import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import {
  CalibrationDashboard,
  type CalibrationDashboardCell,
  type CalibrationDashboardData,
  formatCalibrationDuration,
} from './CalibrationDashboard'

function cells(multiplier: number): CalibrationDashboardCell[] {
  return Array.from({ length: 121 }, (_, index) => {
    const fan = Math.floor(index / 11)
    const heat = index % 11
    if (fan === 0 && heat === 10) return { fan, heat, count: 0, basis: 'unavailable', detail: 'Invalid destination.' }
    const averageSec = (fan + heat + 1) * multiplier
    return {
      fan,
      heat,
      averageSec,
      count: 2,
      minSec: averageSec - 1,
      maxSec: averageSec + 1,
      stdDevSec: 0.7,
      basis: multiplier === 4 ? 'calculated' : 'modelled',
      detail: 'Summary evidence.',
    }
  })
}

const dashboard: CalibrationDashboardData = {
  panels: [
    {
      id: 'heat-empty',
      title: 'Empty chamber',
      direction: 'heating',
      basisLabel: 'Baseline evidence',
      cells: cells(4),
    },
    {
      id: 'heat-100',
      title: '100 g bean load',
      direction: 'heating',
      basisLabel: 'Applied-model estimate',
      cells: cells(5),
    },
    {
      id: 'heat-250',
      title: '250 g bean load',
      direction: 'heating',
      basisLabel: 'Applied-model estimate',
      cells: cells(6),
    },
    {
      id: 'cool-empty',
      title: 'Empty chamber',
      direction: 'cooling',
      basisLabel: 'Baseline evidence',
      cells: cells(4),
    },
    {
      id: 'cool-100',
      title: '100 g bean load',
      direction: 'cooling',
      basisLabel: 'Applied-model estimate',
      cells: cells(5),
    },
    {
      id: 'cool-250',
      title: '250 g bean load',
      direction: 'cooling',
      basisLabel: 'Applied-model estimate',
      cells: cells(6),
    },
  ],
}

describe('CalibrationDashboard', () => {
  const markup = renderToStaticMarkup(createElement(CalibrationDashboard, { dashboard }))

  it('renders two response rows and three load identities in each row', () => {
    expect(markup.match(/calibration-dashboard-row calibration-dashboard-row--/g)).toHaveLength(2)
    expect(markup.match(/calibration-heatmap-card calibration-heatmap-card--/g)).toHaveLength(6)
    expect(markup).toContain('Time to heat')
    expect(markup).toContain('Time to cool')
    expect(markup.match(/<h4>Empty chamber<\/h4>/g)).toHaveLength(2)
    expect(markup.match(/<h4>100 g bean load<\/h4>/g)).toHaveLength(2)
    expect(markup.match(/<h4>250 g bean load<\/h4>/g)).toHaveLength(2)
  })

  it('renders 121 passive shaded cells per map without hover, focus, or detail UI', () => {
    expect(markup.match(/class="calibration-heatmap-cell/g)).toHaveLength(6 * 121)
    expect(markup.match(/role="img"/g)).toHaveLength(12)
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('calibration-heatmap-detail')
    expect(markup).not.toContain('tabindex=')
    const source = readFileSync(resolve(__dirname, 'CalibrationDashboard.tsx'), 'utf8')
    expect(source).not.toContain('onPointerEnter')
    expect(source).not.toContain('onMouseEnter')
    expect(source).not.toContain('onFocus')
  })

  it('renders the saved-calibration compact variant as six cards in one responsive grid', () => {
    const compact = renderToStaticMarkup(createElement(CalibrationDashboard, { dashboard, compact: true }))
    expect(compact).toContain('calibration-dashboard--compact')
    expect(compact).toContain('calibration-dashboard--compact__cards')
    expect(compact).toContain('Heat · Empty chamber')
    expect(compact).toContain('Cool · 250 g bean load')
    expect(compact.match(/is-compact/g)).toHaveLength(6)
  })

  it('labels one independently scaled gradient inside every map', () => {
    expect(markup.match(/response-time scale from zero/g)).toHaveLength(6)
    expect(markup.match(/calibration-dashboard-legend calibration-dashboard-legend--/g)).toHaveLength(6)
    expect(markup).toContain('1.4 min')
    expect(markup).toContain('1.8 min')
    expect(markup).toContain('2.1 min')
    expect(markup).not.toContain('Shared heating response-time scale')
  })
  it('keeps duration labels concise', () => {
    expect(formatCalibrationDuration(undefined)).toBe('No timing estimate')
    expect(formatCalibrationDuration(12.34)).toBe('12.3 seconds')
    expect(formatCalibrationDuration(125)).toBe('2 min 5.0 sec')
  })
})
