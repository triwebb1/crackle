import { expect } from 'vitest'

/**
 * Source-text assertions compare code, not layout. The formatter is free to rewrap a line, add a
 * trailing comma, parenthesize a single arrow parameter, wrap multi-line JSX in parentheses, or drop
 * a semicolon; none of that changes what the code says, so neither side of the comparison keeps it.
 */
export const compactCode = (text: string) =>
  text
    .replace(/\(([A-Za-z_$][\w$]*)\)\s*=>/g, '$1=>')
    .replace(/\s+/g, '')
    .replace(/,([)\]}>])/g, '$1')
    .replace(/\(</g, '<')
    .replace(/>\)/g, '>')
    // Statements split onto their own lines lose their semicolons; `?? await` gains parentheses.
    .replace(/;/g, '')
    .replace(/\(await/g, 'await')
    .replace(/,$/, '')

declare module 'vitest' {
  interface Assertion<T> {
    /** Like `toContain`, for source text: true when the code matches regardless of formatting. */
    toContainCode(expected: string): T
  }
}

expect.extend({
  toContainCode(received: unknown, expected: string) {
    // Only source text can be compared as code. Anything else is a mistaken assertion, and under
    // `.not` it would pass without checking anything, so it fails loudly instead.
    if (typeof received !== 'string') throw new TypeError('toContainCode expects source text (a string)')
    const pass = compactCode(received).includes(compactCode(expected))
    return {
      pass,
      message: () => `expected source ${pass ? 'not ' : ''}to contain code:\n${expected}`,
    }
  },
})
