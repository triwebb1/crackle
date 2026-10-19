/**
 * Suggestion lists for the bean catalog's recurring free-text fields.
 *
 * Origins, species, cultivars and process are typed over and over across a catalog, always with the
 * same handful of answers - "Washed", "Arabica", "Colombia" - and always with the risk of a typo
 * splitting one value into two. Offering what has already been entered fixes both without ever
 * constraining the field: these are combo inputs, so a value nobody has used yet is still just
 * typed in.
 *
 * Notes and lot ID are deliberately NOT in the list. A lot ID is unique by definition and notes are
 * prose; suggesting either would be noise.
 *
 * Deduplication is case- and whitespace-insensitive, and the FIRST spelling seen wins, so a catalog
 * that already says "Washed" is not offered "washed" as a second option.
 */
export const dedupeValues = (values: Array<string | undefined>): string[] => {
  const seen = new Map<string, string>()
  for (const raw of values) {
    const value = raw?.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (!seen.has(key)) seen.set(key, value)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

export interface BeanComboSource {
  origins: string[]
  species?: string
  cultivars: string[]
  process?: string
}

export interface BeanComboOptions {
  origins: string[]
  species: string[]
  cultivars: string[]
  process: string[]
}

export const beanComboOptions = (beans: BeanComboSource[]): BeanComboOptions => ({
  origins: dedupeValues(beans.flatMap((bean) => bean.origins ?? [])),
  species: dedupeValues(beans.map((bean) => bean.species)),
  cultivars: dedupeValues(beans.flatMap((bean) => bean.cultivars ?? [])),
  process: dedupeValues(beans.map((bean) => bean.process)),
})

/**
 * A comma-separated field suggests completions for the value being typed RIGHT NOW, not for the
 * whole string, so "Colombia, Hu" offers "Colombia, Huila". Returning full replacement strings is
 * what lets a plain `<datalist>` drive a multi-value field at all.
 */
export const listCompletions = (current: string, options: string[], limit = 8): string[] => {
  const parts = current.split(',')
  const prefix = parts
    .slice(0, -1)
    .map((part) => part.trim())
    .filter(Boolean)
  const typing = (parts[parts.length - 1] ?? '').trim().toLowerCase()
  const used = new Set(prefix.map((part) => part.toLowerCase()))
  return options
    .filter((option) => !used.has(option.toLowerCase()) && option.toLowerCase().includes(typing))
    .slice(0, limit)
    .map((option) => [...prefix, option].join(', '))
}
