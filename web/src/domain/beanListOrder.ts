import type { BeanScoreSummary } from './roastScore'
import type { BeanLot, RoastRun } from './types'

/**
 * How the Beans page lists lots. `custom` is the drag order stored on the roaster and is the only
 * order a drag may edit; the others are read-only views. Unscored lots sort after every scored lot
 * under `score`, because "no score yet" is not "scored low".
 */
export type BeanListOrder = 'custom' | 'score' | 'recent' | 'name'
const ORDERS: readonly BeanListOrder[] = ['custom', 'score', 'recent', 'name']
const STORAGE_KEY = 'crackle.beanListOrder'

export const readBeanListOrder = (): BeanListOrder => {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY)
    return ORDERS.includes(stored as BeanListOrder) ? (stored as BeanListOrder) : 'custom'
  } catch {
    return 'custom'
  }
}

export const writeBeanListOrder = (order: BeanListOrder) => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, order)
  } catch {
    /* a per-browser nicety only */
  }
}

export const orderBeanLots = (
  beans: readonly BeanLot[],
  runs: readonly RoastRun[],
  order: BeanListOrder,
  scores: ReadonlyMap<string, BeanScoreSummary>,
): BeanLot[] => {
  const custom = [...beans]
  if (order === 'custom') return custom
  const position = new Map(beans.map((bean, index) => [bean.id, index]))
  const byCustom = (a: BeanLot, b: BeanLot) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)
  if (order === 'name')
    return custom.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || byCustom(a, b))
  if (order === 'recent') {
    const latest = new Map<string, string>()
    for (const run of runs) {
      if (!run.beanLotId) continue
      const current = latest.get(run.beanLotId)
      if (!current || run.startedAt > current) latest.set(run.beanLotId, run.startedAt)
    }
    return custom.sort((a, b) => (latest.get(b.id) ?? '').localeCompare(latest.get(a.id) ?? '') || byCustom(a, b))
  }
  return custom.sort((a, b) => {
    const left = scores.get(a.id)
    const right = scores.get(b.id)
    if (left?.average === undefined || right?.average === undefined) {
      if (left?.average !== undefined) return -1
      if (right?.average !== undefined) return 1
      return byCustom(a, b)
    }
    return right.average - left.average || right.scoredRoasts - left.scoredRoasts || byCustom(a, b)
  })
}
