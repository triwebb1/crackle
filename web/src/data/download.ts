/**
 * `content` is a `BlobPart` rather than a string because a backup is a ZIP: the recordings inside it
 * are raw archive bytes, and putting them through a string on the way to the file would corrupt
 * every one of them.
 */
export const downloadFile = (name: string, content: BlobPart, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10000)
}
