import { describe, expect, it } from 'vitest'
import { demoRuns, starterBean } from '../data/demo'
import { orderBeanLots } from './beanListOrder'
import { beanScoreSummary, formatScore, runScore, validScore } from './roastScore'
import type { BeanLot, RoastRun } from './types'

const run = (
  id: string,
  beanLotId: string | undefined,
  score: unknown,
  startedAt = '2026-09-01T10:00:00.000Z',
): RoastRun => ({ ...demoRuns[0], id, beanLotId, startedAt, score }) as RoastRun
const bean = (id: string, name: string): BeanLot => ({ ...starterBean, id, name })

describe('roast score', () => {
  it('accepts only whole numbers on the 1-10 scale', () => {
    expect(validScore(7)).toBe(7)
    expect(validScore(1)).toBe(1)
    expect(validScore(10)).toBe(10)
    for (const bad of [0, 11, 7.5, -1, Number.NaN, '8', null, undefined]) expect(validScore(bad)).toBeUndefined()
    expect(runScore(run('a', undefined, 12))).toBeUndefined()
  })

  it('derives a lot score from its scored roasts only, never a zero for an unscored lot', () => {
    const runs = [run('a', 'lot', 8), run('b', 'lot', 7), run('c', 'lot', undefined), run('d', 'other', 2)]
    expect(beanScoreSummary(runs, 'lot')).toEqual({ average: 7.5, best: 8, scoredRoasts: 2 })
    expect(beanScoreSummary(runs, 'untasted')).toEqual({ scoredRoasts: 0 })
    expect(beanScoreSummary([run('a', 'lot', 7), run('b', 'lot', 8), run('c', 'lot', 8)], 'lot').average).toBe(7.7)
  })

  it('formats whole and averaged scores', () => {
    expect(formatScore(8)).toBe('8/10')
    expect(formatScore(7.5)).toBe('7.5/10')
    expect(formatScore(undefined)).toBe('--')
  })
})

describe('bean lot ordering', () => {
  const beans = [bean('a', 'Zambia'), bean('b', 'Brazil'), bean('c', 'Kenya'), bean('d', 'Aceh')]
  const runs = [
    run('1', 'a', 6, '2026-09-10T00:00:00.000Z'),
    run('2', 'b', 9, '2026-08-01T00:00:00.000Z'),
    run('3', 'c', 9, '2026-09-20T00:00:00.000Z'),
    run('4', 'c', 9, '2026-09-01T00:00:00.000Z'),
  ]
  const scores = new Map(beans.map((lot) => [lot.id, beanScoreSummary(runs, lot.id)]))
  const ids = (order: Parameters<typeof orderBeanLots>[2]) =>
    orderBeanLots(beans, runs, order, scores).map((lot) => lot.id)

  it('keeps the stored custom order by default', () => expect(ids('custom')).toEqual(['a', 'b', 'c', 'd']))
  it('orders by score, breaking ties by how many roasts earned it, unscored lots last', () =>
    expect(ids('score')).toEqual(['c', 'b', 'a', 'd']))
  it('orders by most recent roast, never-roasted lots last', () => expect(ids('recent')).toEqual(['c', 'a', 'b', 'd']))
  it('orders by name', () => expect(ids('name')).toEqual(['d', 'b', 'c', 'a']))
})
