import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Crack markers are annotations, never inputs.
 *
 * FIRST_CRACK and DRY_END are things a person writes down. Nothing detects them, nothing measures
 * them, and no two roasters agree on when they happened - so the moment any model, fit, analysis or
 * derivation reads one, every number downstream inherits an opinion dressed as a measurement. This
 * is the check that stops that happening again: the modules that compute anything must not so much
 * as mention them.
 *
 * What remains legal, deliberately: an annotation is stored on the run, drawn on the chart, listed
 * in History, and PRESERVED by telemetry compression as a retained sample point. Keeping a point
 * because something was noted there is annotation preservation, not consumption - the retained
 * sample carries no more weight in any later calculation than its neighbours do.
 *
 * A function such as `phaseFromEvents`, deriving a roast phase by asking whether a marker has been
 * recorded, would violate this. Unreferenced code of that kind survives review easily, so its
 * absence is pinned below.
 */
const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Everything that computes a number a roast decision could rest on. */
const COMPUTATIONAL_MODULES = [
  'domain/estimatedBaseline.ts',
  'domain/coefficientFit.ts',
  'domain/modelFit.ts',
  'domain/journeyControl.ts',
  'domain/controlResidual.ts',
  'domain/profileSimulation.ts',
  'domain/thermalModel.ts',
  'domain/thermalLog.ts',
  'domain/roastMetrics.ts',
  'domain/calibrationProvenance.ts',
  'domain/meshMetrics.ts',
]

/** Anything that names a roast milestone as if it were an input. */
const FORBIDDEN = [
  /FIRST_CRACK/,
  /DRY_END/,
  /RoastEvent/,
  /\bfirstCrack\b/,
  /\bdryEnd\b/,
  /first crack/i,
  /second crack/i,
]

describe('crack markers are annotations, never inputs', () => {
  const sources = COMPUTATIONAL_MODULES.map((path) => ({ path, text: readFileSync(join(SOURCE_ROOT, path), 'utf8') }))

  it('finds every module it is meant to police', () => {
    expect(sources).toHaveLength(COMPUTATIONAL_MODULES.length)
    for (const source of sources) expect(source.text.length).toBeGreaterThan(200)
  })

  it('never mentions a crack or dry-end marker in a computational module', () => {
    const offenders = sources.flatMap((source) =>
      FORBIDDEN.filter((pattern) => pattern.test(source.text)).map((pattern) => `${source.path} matches ${pattern}`),
    )
    expect(offenders).toEqual([])
  })

  it('imports nothing event-shaped into a computational module', () => {
    const offenders = sources
      .filter((source) => /import[^;]*\bRoastEvent\b/.test(source.text))
      .map((source) => source.path)
    expect(offenders).toEqual([])
  })

  /** The specific violation that existed, so it cannot come back under another name. */
  it('no longer derives a roast phase from recorded markers', () => {
    const model = readFileSync(join(SOURCE_ROOT, 'domain/model.ts'), 'utf8')
    expect(model).not.toMatch(/export const phaseFromEvents/)
    expect(model).not.toMatch(/FIRST_CRACK/)
  })

  /** And the thing that is still allowed, stated so nobody "fixes" it. */
  it('still lets telemetry compression retain the samples an annotation sits on', () => {
    const model = readFileSync(join(SOURCE_ROOT, 'domain/model.ts'), 'utf8')
    expect(model).toMatch(/eventTimes/)
    // Retention only: the event time selects a sample to keep, it never scales anything.
    expect(model).toMatch(/eventNearby/)
    expect(model).not.toMatch(/eventWeight|weightedBy|eventBias/)
  })
})
