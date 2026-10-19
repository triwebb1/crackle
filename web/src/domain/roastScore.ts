import type { RoastRun } from './types'

/**
 * How much the user liked a roast - the bean and the roast together, as one number.
 *
 * Bean and roast are not ranked individually; a bean's rank is a composite derived from the roast
 * history. So a score is entered once, on the roast record, and a bean
 * lot's score is DERIVED from its roasts, never typed. A lot nobody has scored has no score rather
 * than a zero, which would sort a promising untasted lot below every disappointing one.
 *
 * Whole numbers 1-10: fine enough to separate "good" from "great", coarse enough to pick with one
 * tap on a phone, and the scale cupping notes already speak.
 */
export const SCORE_MIN = 1
export const SCORE_MAX = 10
export const SCORE_VALUES = Array.from({ length: SCORE_MAX - SCORE_MIN + 1 }, (_, index) => SCORE_MIN + index)

/** A stored value is a score only if it is a whole number on the scale. Anything else is absent. */
export const validScore = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= SCORE_MIN && value <= SCORE_MAX ? value : undefined

export const runScore = (run: Pick<RoastRun, 'score'>): number | undefined => validScore(run.score)

export interface BeanScoreSummary {
  /** Mean of the scored roasts, one decimal. Undefined when none of this lot's roasts is scored. */
  average?: number
  best?: number
  scoredRoasts: number
}

/** A lot's composite score: the mean of every scored roast recorded against it. */
export const beanScoreSummary = (runs: readonly RoastRun[], beanLotId: string): BeanScoreSummary => {
  const scores = runs
    .filter((run) => run.beanLotId === beanLotId)
    .flatMap((run) => {
      const score = runScore(run)
      return score === undefined ? [] : [score]
    })
  if (scores.length === 0) return { scoredRoasts: 0 }
  const average = Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10
  return { average, best: Math.max(...scores), scoredRoasts: scores.length }
}

export const formatScore = (score: number | undefined): string =>
  score === undefined ? '--' : Number.isInteger(score) ? `${score}/10` : `${score.toFixed(1)}/10`
