const pad2 = (value: number) => String(value).padStart(2, '0')

/** A compact local occurrence timestamp for names and labels: sortable date plus 24-hour time. */
export const formatLocalDateTime = (value: Date | string | number): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return 'time unknown'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** A table date: "9/22/26, 3:41 PM" in the viewer's locale. Seconds are noise in an archive row. */
export const formatTableDateTime = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? '--'
    : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}
