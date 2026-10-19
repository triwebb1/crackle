import { readdir, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const dist = new URL('../dist/', import.meta.url)
const assets = new URL('assets/', dist)
const assetNames = await readdir(assets)
const names = ['index.html', ...assetNames.map((name) => `assets/${name}`).sort()]

const compress = {
  'gzip-1': (bytes) => gzipSync(bytes, { level: 1 }).length,
  'gzip-6': (bytes) => gzipSync(bytes, { level: 6 }).length,
  'gzip-9': (bytes) => gzipSync(bytes, { level: 9 }).length,
  'brotli-11': (bytes) =>
    brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
}

const rows = []
for (const name of names) {
  const bytes = await readFile(new URL(name, dist))
  rows.push({
    file: basename(name),
    raw: bytes.length,
    ...Object.fromEntries(Object.entries(compress).map(([label, run]) => [label, run(bytes)])),
  })
}

rows.push({
  file: 'TOTAL',
  ...Object.fromEntries(
    ['raw', ...Object.keys(compress)].map((field) => [field, rows.reduce((total, row) => total + row[field], 0)]),
  ),
})

console.table(rows)
