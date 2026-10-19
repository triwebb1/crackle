import { describe, expect, it } from 'vitest'
import { beanComboOptions, dedupeValues, listCompletions } from './comboValues'

describe('combo suggestion values', () => {
  it('dedupes case- and whitespace-insensitively, keeping the first spelling seen', () => {
    expect(dedupeValues(['Washed', 'washed', '  WASHED  ', 'Natural'])).toEqual(['Natural', 'Washed'])
    expect(dedupeValues(['Natural', 'natural'])).toEqual(['Natural'])
  })

  it('drops nothing-values rather than offering a blank suggestion', () => {
    expect(dedupeValues([undefined, '', '   ', 'Honey'])).toEqual(['Honey'])
    expect(dedupeValues([])).toEqual([])
  })

  it('collects the four recurring fields across the whole catalog', () => {
    const options = beanComboOptions([
      { origins: ['Colombia', 'Huila'], species: 'Arabica', cultivars: ['Caturra'], process: 'Washed' },
      { origins: ['colombia', 'Nariño'], species: 'arabica', cultivars: ['Caturra', 'Castillo'], process: 'Natural' },
      { origins: [], cultivars: [] },
    ])
    expect(options.origins).toEqual(['Colombia', 'Huila', 'Nariño'])
    expect(options.species).toEqual(['Arabica'])
    expect(options.cultivars).toEqual(['Castillo', 'Caturra'])
    expect(options.process).toEqual(['Natural', 'Washed'])
  })
})

/**
 * A comma-separated field has to suggest a completion for the value being typed right now, not for
 * the whole string, and it has to hand back a full replacement because that is the only thing a
 * native `<datalist>` can insert.
 */
describe('completions inside a comma-separated field', () => {
  const options = ['Brazil', 'Colombia', 'Ethiopia', 'Huila']

  it('completes the last value and keeps everything already typed', () => {
    expect(listCompletions('Colombia, Hu', options)).toEqual(['Colombia, Huila'])
    expect(listCompletions('Colombia, ', options)).toEqual([
      'Colombia, Brazil',
      'Colombia, Ethiopia',
      'Colombia, Huila',
    ])
  })

  it('never offers a value the field already contains', () => {
    expect(listCompletions('Colombia, Huila, ', options)).toEqual([
      'Colombia, Huila, Brazil',
      'Colombia, Huila, Ethiopia',
    ])
  })

  it('offers everything for an empty field, and caps the list', () => {
    expect(listCompletions('', options)).toEqual(options)
    expect(listCompletions('', options, 2)).toEqual(['Brazil', 'Colombia'])
  })

  it('matches case-insensitively on the fragment being typed', () => {
    expect(listCompletions('eth', options)).toEqual(['Ethiopia'])
    expect(listCompletions('ETH', options)).toEqual(['Ethiopia'])
  })
})
