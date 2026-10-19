import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

describe('active journey review presentation', () => {
  it('makes the adjusted plan primary and the original plan visibly secondary', () => {
    expect(styles).toMatch(/\.target-trace \{[^}]*stroke-width: 2\.7[^}]*opacity: \.98/)
    expect(styles).toMatch(/\.ideal-target-trace \{[^}]*stroke-width: 1\.4[^}]*opacity: \.38/)
  })

  it('makes changed fields unmistakable without expanding every zone', () => {
    expect(styles).toMatch(/\.active-plan-review \{[^}]*border-left: 4px solid var\(--yellow\)/)
    expect(styles).toMatch(
      /\.active-plan-zone-list\.review-only fieldset\.changed \{[^}]*border-left-color: var\(--orange\)[^}]*background: #fffaf0/,
    )
    expect(styles).toMatch(/\.active-plan-zone-list\.review-only \.changed-field \{[^}]*background: #fff0c9/)
    expect(styles).toMatch(
      /\.active-plan-zone-list\.review-only \.changed-field output \{[^}]*font-weight: var\(--w-heavy\)/,
    )
    expect(styles).toMatch(
      /\.active-plan-zone-list\.review-only \.changed-field small \{[^}]*font-weight: var\(--w-strong\)/,
    )
  })

  it('stacks review fields and actions at phone width', () => {
    expect(styles).toMatch(
      /@media \(max-width: 520px\) \{[\s\S]*?\.active-plan-zone-list\.review-only fieldset \{ grid-template-columns: 1fr; \}/,
    )
    expect(styles).toMatch(/\.active-plan-review \.active-plan-actions button \{ width: 100%; \}/)
  })
})
