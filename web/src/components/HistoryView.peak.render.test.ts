import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { demoRuns } from '../data/demo'
import { DEMO_SOURCE_DEVICE_ID } from '../data/demoIdentity'
import { applyTableView, emptyTableView, type TableColumn, toggleSort } from '../domain/dataTable'
import type { RoastRun, TelemetrySample } from '../domain/types'
import { HistoryView, peakTemperature } from './HistoryView'

/**
 * PEAK TEMP, not finish temp.
 *
 * The LAST sample in the recording (`samples.at(-1)?.beanTempC`) is the wrong figure. A roast
 * record does not stop at the end of the roast - it runs on through any authored fan-only tail and through
 * the passive decay after that - so the last sample says how cool the beans had got, not how hot
 * they ever were. The column is the maximum bean temperature seen during the roast.
 *
 * The fixture below is the case that separates the two definitions and could not be told apart by
 * either "last sample" or "highest of the first half": a roast that climbs, DIPS mid-roast, climbs
 * to a higher second peak, and then cools a long way down. Peak, last sample and mid-roast local
 * maximum are three different numbers here, and only one of them is right.
 */

const noop = () => undefined

const sample = (elapsedSec: number, beanTempC: number): TelemetrySample => ({
  elapsedSec,
  beanTempC,
  rorCPerMin: 0,
  requestedFan: 6,
  effectiveFan: 6,
  requestedHeat: 5,
  effectiveHeat: 5,
  phase: 'DEVELOPMENT',
})

/**
 * Climb to 188, pull back to 171 (the mid-roast dip), climb again to 214.6 (THE peak), then the
 * cooling tail all the way down to 44.2 - which is what the old column called the finish temp.
 */
const doublePeak: RoastRun = {
  ...demoRuns[0],
  id: 'run-double-peak',
  name: 'double peak',
  samples: [
    sample(0, 24.5),
    sample(30, 96.1),
    sample(60, 143.8),
    sample(90, 188.0),
    sample(120, 179.4),
    sample(150, 171.2),
    sample(180, 196.7),
    sample(210, 209.3),
    sample(240, 214.6),
    sample(270, 198.1),
    sample(300, 152.0),
    sample(330, 101.7),
    sample(360, 62.4),
    sample(390, 44.2),
  ],
}

const PEAK = 214.6
const LAST = 44.2
const MID_ROAST_LOCAL_PEAK = 188.0

describe('the archive reports the hottest the beans ever got', () => {
  it('takes the maximum over the whole record, not the last sample', () => {
    expect(peakTemperature(doublePeak)).toBe(PEAK)
    // The three numbers really are distinct, so this fixture can tell the definitions apart.
    expect(doublePeak.samples.at(-1)?.beanTempC).toBe(LAST)
    expect(PEAK).not.toBe(LAST)
    expect(PEAK).toBeGreaterThan(MID_ROAST_LOCAL_PEAK)
  })

  /** A dropped thermocouple reading is an absence. One NaN must not become the peak, or the sort. */
  it('ignores non-finite samples rather than propagating them', () => {
    const dropouts = {
      ...doublePeak,
      samples: [...doublePeak.samples, sample(420, Number.NaN), sample(450, Number.POSITIVE_INFINITY)],
    }
    expect(peakTemperature(dropouts)).toBe(PEAK)
  })

  it('has no answer for a roast with no samples, rather than answering 0', () => {
    expect(peakTemperature({ ...doublePeak, samples: [] })).toBeUndefined()
  })

  /**
   * The definition is a property of the record, so a journey roast is scored identically. This is
   * the same run recorded under a temperature journey: same samples, same peak.
   */
  it('scores timed and journey roasts by the same rule', () => {
    const journey = {
      ...doublePeak,
      id: 'run-journey',
      profile: demoRuns.find((run) => run.profile.strategy !== 'timed')?.profile ?? doublePeak.profile,
    }
    expect(peakTemperature(journey)).toBe(peakTemperature(doublePeak))
  })
})

describe('the column that shows it', () => {
  const markup = renderToStaticMarkup(
    createElement(HistoryView, {
      runs: [doublePeak],
      onOverlay: noop,
      onDelete: noop,
      onSaveDetails: async () => undefined,
      onImport: async () => '',
      onUseAsProfile: noop,
      activeRoasterId: DEMO_SOURCE_DEVICE_ID,
    }),
  )

  it('is called Peak temp, and the retired name is gone', () => {
    expect(markup).toContain('Peak temp')
    expect(markup).not.toContain('Finish temp')
  })

  it('renders the peak, never the cooled-down last reading', () => {
    expect(markup).toContain('214.6 °C')
    expect(markup).not.toContain('44.2 °C')
  })

  it('stays sortable, with hottest-first as the first click', () => {
    expect(markup).toMatch(/<th[^>]*>\s*<button type="button" class="column-sort">Peak temp/)
  })
})

/**
 * Sorting reads the column's `value` accessor, which is `peakTemperature` itself - and a collapsed
 * server render cannot click a header. So the ordering is checked against the same pure table
 * machinery the component hands its columns to, with the accessor the component actually uses.
 */
describe('ordering the archive by peak', () => {
  const hotButCooledHard: RoastRun = {
    ...doublePeak,
    id: 'hot',
    name: 'hot',
    samples: [sample(0, 25), sample(60, 231.0), sample(120, 38.0)],
  }
  const coolerButLeftWarm: RoastRun = {
    ...doublePeak,
    id: 'warm',
    name: 'warm',
    samples: [sample(0, 25), sample(60, 202.0), sample(120, 190.0)],
  }
  const column: TableColumn<RoastRun> = {
    id: 'peak',
    label: 'Peak temp',
    defaultDirection: 'desc',
    value: peakTemperature,
  }
  const rows = [coolerButLeftWarm, hotButCooledHard]

  it('puts the hotter roast first even though it ended cooler', () => {
    const sorted = applyTableView(rows, [column], toggleSort(emptyTableView(), [column], 'peak'))
    expect(sorted.map((run) => run.id)).toEqual(['hot', 'warm'])
    // Under the retired definition the order would have been the exact opposite.
    expect(hotButCooledHard.samples.at(-1)!.beanTempC).toBeLessThan(coolerButLeftWarm.samples.at(-1)!.beanTempC)
  })
})
