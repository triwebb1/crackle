/**
 * ============================================================================================
 * A ZIP FILE, WRITTEN AND READ BY HAND, WITH NOTHING COMPRESSED
 * ============================================================================================
 *
 * A backup is a zip because a zip is what a user can open. Double-clicking it shows
 * `manifest.json`, `collections/profiles.json` and `recordings/41.crk` as files - readable years
 * from now, with no version of this app anywhere near them. That is the entire argument for the
 * container, and it is the reason the format is not a bespoke one.
 *
 * --------------------------------------------------------------------------------------------
 * WHY IT IS HAND-ROLLED, AND WHY NOTHING IS COMPRESSED
 * --------------------------------------------------------------------------------------------
 *
 * The backup container deliberately has no compression dependency: a library that stops being
 * maintained must not become a file nobody can open. Written out, the STORE-method zip is the four
 * little structures below and a CRC - about 120 lines
 * - and every byte of it is pinned by `zipFile.test.ts`.
 *
 * **STORE, method 0, no compression at all.** Deflate would need an encoder AND a decoder, and it
 * would buy almost nothing here: a `.crk` recording is already a delta-varint stream (2.4x, done on
 * the device), and controller documents are already compact zlib/Base64 payloads. Paying another
 * compressor to re-compress compressed telemetry is how a backup format acquires a
 * second thing that can be wrong. A user who wants it smaller can re-zip the zip.
 *
 * `CRC-32` is the standard IEEE polynomial (reflected `0xEDB88320`) - the same one the firmware's
 * `sr800_log_codec` checksums a recording with, and the same one the zip container requires. One
 * implementation serves both roles here, and `zipFile.test.ts` pins it against the `"123456789"` =
 * `0xCBF43926` check value every CRC-32 implementation is measured by.
 *
 * --------------------------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * --------------------------------------------------------------------------------------------
 *
 *   - **No ZIP64.** Sizes and offsets are 32-bit. The device holds 896 KB; a backup that needed
 *     ZIP64 could not have come off this roaster.
 *   - **No data descriptors.** Every size and CRC is known before its header is written, because the
 *     whole entry is already in memory.
 *   - **No directory entries, no attributes, no timestamps.** Every entry carries the same fixed DOS
 *     stamp (1980-01-01), so the same library backs up to the same bytes twice. A modification time
 *     would be a second, quieter version stamp, and the manifest already says when the file was made.
 *   - **No compressed entries on the way IN.** See `readZip`: an entry stored with any method other
 *     than STORE is REFUSED by name rather than skipped, because a silently skipped entry in a
 *     restore is a profile that quietly does not come back.
 *
 * Binary-safe throughout: `Uint8Array` in, `Uint8Array` out, and a recording's bytes are never put
 * through a string on the way to or from the file.
 */

export interface ZipEntry {
  /** The path inside the archive, forward slashes, no leading slash. */
  name: string
  data: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const textBytes = (value: string): Uint8Array => encoder.encode(value)
export const bytesText = (value: Uint8Array): string => decoder.decode(value)

/** Reflected IEEE 802.3 polynomial - the zip container's CRC and the archive codec's, one table. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const EOCD_BYTES = 22
/** Method 0. The only method this writer emits and the only one its reader accepts. */
const STORE = 0
/** Version 2.0 - what a STORE entry needs, and nothing above it. */
const VERSION = 20
/** General-purpose bit 11: the file name is UTF-8. */
const UTF8_NAME = 0x0800
/** A fixed 1980-01-01 00:00, so the same library produces the same bytes. */
const DOS_TIME = 0
const DOS_DATE = 0x0021
/** The central directory counts entries in a `uint16`, and there is no ZIP64 here. */
export const MAX_ZIP_ENTRIES = 0xffff

/**
 * The return type names its buffer because the caller hands it to `Blob`, which will not take an
 * array over a possibly-shared one. It is always a fresh, exclusively-owned `ArrayBuffer` here.
 */
export const writeZip = (entries: ZipEntry[]): Uint8Array<ArrayBuffer> => {
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`A backup may hold at most ${MAX_ZIP_ENTRIES} files`)
  const seen = new Set<string>()
  const records = entries.map((entry) => {
    if (entry.name.length === 0) throw new Error('A file in the backup has no name')
    if (seen.has(entry.name)) throw new Error(`Two files in the backup are both named "${entry.name}"`)
    seen.add(entry.name)
    return { name: textBytes(entry.name), data: entry.data, crc: crc32(entry.data) }
  })

  const localBytes = records.reduce(
    (total, record) => total + LOCAL_HEADER_BYTES + record.name.length + record.data.length,
    0,
  )
  const centralBytes = records.reduce((total, record) => total + CENTRAL_HEADER_BYTES + record.name.length, 0)
  const out = new Uint8Array(localBytes + centralBytes + EOCD_BYTES)
  const view = new DataView(out.buffer)

  let at = 0
  const localOffsets: number[] = []
  for (const record of records) {
    localOffsets.push(at)
    view.setUint32(at, LOCAL_SIGNATURE, true)
    view.setUint16(at + 4, VERSION, true)
    view.setUint16(at + 6, UTF8_NAME, true)
    view.setUint16(at + 8, STORE, true)
    view.setUint16(at + 10, DOS_TIME, true)
    view.setUint16(at + 12, DOS_DATE, true)
    view.setUint32(at + 14, record.crc, true)
    view.setUint32(at + 18, record.data.length, true)
    view.setUint32(at + 22, record.data.length, true)
    view.setUint16(at + 26, record.name.length, true)
    view.setUint16(at + 28, 0, true)
    out.set(record.name, at + LOCAL_HEADER_BYTES)
    out.set(record.data, at + LOCAL_HEADER_BYTES + record.name.length)
    at += LOCAL_HEADER_BYTES + record.name.length + record.data.length
  }

  const centralStart = at
  records.forEach((record, index) => {
    view.setUint32(at, CENTRAL_SIGNATURE, true)
    view.setUint16(at + 4, VERSION, true)
    view.setUint16(at + 6, VERSION, true)
    view.setUint16(at + 8, UTF8_NAME, true)
    view.setUint16(at + 10, STORE, true)
    view.setUint16(at + 12, DOS_TIME, true)
    view.setUint16(at + 14, DOS_DATE, true)
    view.setUint32(at + 16, record.crc, true)
    view.setUint32(at + 20, record.data.length, true)
    view.setUint32(at + 24, record.data.length, true)
    view.setUint16(at + 28, record.name.length, true)
    view.setUint16(at + 30, 0, true)
    view.setUint16(at + 32, 0, true)
    view.setUint16(at + 34, 0, true)
    view.setUint16(at + 36, 0, true)
    view.setUint32(at + 38, 0, true)
    view.setUint32(at + 42, localOffsets[index], true)
    out.set(record.name, at + CENTRAL_HEADER_BYTES)
    at += CENTRAL_HEADER_BYTES + record.name.length
  })

  view.setUint32(at, EOCD_SIGNATURE, true)
  view.setUint16(at + 4, 0, true)
  view.setUint16(at + 6, 0, true)
  view.setUint16(at + 8, records.length, true)
  view.setUint16(at + 10, records.length, true)
  view.setUint32(at + 12, centralBytes, true)
  view.setUint32(at + 16, centralStart, true)
  view.setUint16(at + 20, 0, true)
  return out
}

const NOT_A_ZIP = 'That file is not a zip archive'
const DAMAGED = 'That backup file is damaged and could not be read'

/**
 * The end-of-central-directory record, found the way every zip reader has to find it: by scanning
 * backwards for its signature. It is at a fixed offset from the end only when the archive comment is
 * empty, and a reader that assumed that would fail on a file some other tool touched.
 */
const findEocd = (view: DataView, length: number): number => {
  const floor = Math.max(0, length - EOCD_BYTES - 0xffff)
  for (let at = length - EOCD_BYTES; at >= floor; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at
  }
  throw new Error(NOT_A_ZIP)
}

/**
 * Read a STORE-method zip back into its entries, in central-directory order.
 *
 * Every entry's CRC is verified against the bytes actually read. This is a restore path: a
 * recording whose bytes rotted in a Downloads folder must be refused here rather than
 * uploaded to the roaster, where the firmware would have refused it anyway - one message from the
 * file, rather than twenty-three from the device.
 */
export const readZip = (bytes: Uint8Array): ZipEntry[] => {
  if (bytes.length < EOCD_BYTES) throw new Error(NOT_A_ZIP)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEocd(view, bytes.length)
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)

  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_HEADER_BYTES > bytes.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE)
      throw new Error(DAMAGED)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localAt = view.getUint32(at + 42, true)
    const name = bytesText(bytes.subarray(at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength))
    at += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength

    // A directory entry carries no bytes and is not a file; Crackle writes none, but other tools do.
    if (name.endsWith('/') && size === 0) continue
    if (method !== STORE) {
      throw new Error(
        `"${name}" inside that file is compressed, and Crackle only reads the uncompressed backups it writes`,
      )
    }
    if (localAt + LOCAL_HEADER_BYTES > bytes.length || view.getUint32(localAt, true) !== LOCAL_SIGNATURE)
      throw new Error(DAMAGED)
    const dataAt =
      localAt + LOCAL_HEADER_BYTES + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true)
    if (dataAt + size > bytes.length) throw new Error(DAMAGED)
    // Copied rather than viewed, so an entry outlives the buffer the file arrived in.
    const data = bytes.slice(dataAt, dataAt + size)
    if (crc32(data) !== crc)
      throw new Error(`"${name}" inside that file did not match its checksum, so the backup is damaged`)
    entries.push({ name, data })
  }
  return entries
}
