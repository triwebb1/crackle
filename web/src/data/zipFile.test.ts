import { describe, expect, it } from 'vitest'
import { bytesText, crc32, MAX_ZIP_ENTRIES, readZip, textBytes, writeZip, type ZipEntry } from './zipFile'

/**
 * ============================================================================================
 * THE CONTAINER, PINNED BYTE BY BYTE
 * ============================================================================================
 *
 * This is a hand-rolled file format on a restore path, which means two obligations rather than one.
 * It has to round-trip - `readZip(writeZip(x)) === x`, for empty files, for binary payloads, for
 * many entries - and it has to be a real ZIP, because half the value of the container is that an
 * user can open the backup with anything. So the structures are asserted at their documented
 * offsets rather than only through this module's own reader, which would happily agree with itself
 * about a format nothing else can read.
 */

const bytes = (...values: number[]) => Uint8Array.from(values)
const view = (zip: Uint8Array) => new DataView(zip.buffer, zip.byteOffset, zip.byteLength)

describe('CRC-32', () => {
  /** The check value every CRC-32 implementation is measured by. */
  it('produces 0xCBF43926 for "123456789", which is what makes it the standard one', () => {
    expect(crc32(textBytes('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for nothing, and unsigned for everything', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
    // A naive implementation returns a negative number here, which then writes wrong into a u32.
    expect(crc32(bytes(0xff, 0xff, 0xff, 0xff))).toBeGreaterThanOrEqual(0)
    expect(crc32(bytes(0x00))).not.toBe(crc32(bytes(0x01)))
  })
})

describe('the zip writer', () => {
  it('writes the local header, the central directory and the EOCD at their documented offsets', () => {
    const zip = writeZip([{ name: 'a.txt', data: textBytes('hello') }])
    const at = view(zip)
    expect(at.getUint32(0, true)).toBe(0x04034b50)
    expect(at.getUint16(8, true)).toBe(0) // STORE, method 0
    expect(at.getUint32(14, true)).toBe(crc32(textBytes('hello')))
    expect(at.getUint32(18, true)).toBe(5) // compressed size
    expect(at.getUint32(22, true)).toBe(5) // uncompressed size, the same
    expect(at.getUint16(26, true)).toBe(5) // name length
    expect(bytesText(zip.subarray(30, 35))).toBe('a.txt')
    expect(bytesText(zip.subarray(35, 40))).toBe('hello')

    const central = 40
    expect(at.getUint32(central, true)).toBe(0x02014b50)
    expect(at.getUint32(central + 42, true)).toBe(0) // offset of the local header
    const eocd = central + 46 + 5
    expect(at.getUint32(eocd, true)).toBe(0x06054b50)
    expect(at.getUint16(eocd + 10, true)).toBe(1) // one entry
    expect(at.getUint32(eocd + 16, true)).toBe(central) // where the directory starts
    expect(zip.length).toBe(eocd + 22)
  })

  it('marks names as UTF-8, because a bean lot may not be named in ASCII', () => {
    const zip = writeZip([{ name: 'runs/café.json', data: textBytes('{}') }])
    expect(view(zip).getUint16(6, true) & 0x0800).toBe(0x0800)
    expect(readZip(zip)[0].name).toBe('runs/café.json')
  })

  /**
   * The same library twice is the same file twice. Every entry carries a fixed 1980-01-01 stamp
   * rather than the clock: a modification time would be a second, quieter version stamp, and the
   * manifest already says when the backup was made.
   */
  it('is deterministic - the same entries produce identical bytes', () => {
    const entries: ZipEntry[] = [
      { name: 'manifest.json', data: textBytes('{"a":1}') },
      { name: 'x.crk', data: bytes(1, 2, 3) },
    ]
    expect([...writeZip(entries)]).toEqual([...writeZip(entries)])
  })

  it('refuses two entries with the same name, and an entry with none', () => {
    expect(() =>
      writeZip([
        { name: 'a', data: bytes(1) },
        { name: 'a', data: bytes(2) },
      ]),
    ).toThrow(/both named/)
    expect(() => writeZip([{ name: '', data: bytes(1) }])).toThrow(/no name/)
  })

  it('states its own entry ceiling rather than silently writing a broken directory', () => {
    // The central directory counts entries in a uint16 and there is no ZIP64 here, so the limit is
    // real. A backup that quietly wrapped its count would read back as almost nothing.
    expect(MAX_ZIP_ENTRIES).toBe(65535)
  })
})

describe('the round trip', () => {
  it('returns every entry, in order, byte for byte', () => {
    const entries: ZipEntry[] = [
      { name: 'manifest.json', data: textBytes(JSON.stringify({ format: 'crackle-backup' })) },
      { name: 'collections/profiles.json', data: textBytes('{"v":1,"profiles":[]}') },
      { name: 'runs/run-1.json', data: textBytes('{"v":1}') },
    ]
    const read = readZip(writeZip(entries))
    expect(read.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name))
    for (const [index, entry] of read.entries()) expect([...entry.data]).toEqual([...entries[index].data])
  })

  /** An empty file is a fact - a collection that exists and holds nothing - not an absent one. */
  it('round-trips a zero-length entry as a zero-length entry', () => {
    const read = readZip(writeZip([{ name: 'empty.json', data: new Uint8Array(0) }]))
    expect(read).toHaveLength(1)
    expect(read[0].data).toHaveLength(0)
  })

  /**
   * A `.crk` recording is arbitrary binary - its fifth byte is 0x00 by construction, and every byte
   * value appears in a delta-varint stream. Nothing in this path may go through a string.
   */
  it('round-trips every byte value, including the NUL that breaks the naive transports', () => {
    const every = Uint8Array.from({ length: 256 }, (_value, index) => index)
    const read = readZip(writeZip([{ name: 'recordings/41.crk', data: every }]))
    expect([...read[0].data]).toEqual([...every])
    expect(read[0].data[0]).toBe(0)
  })

  it('round-trips a hundred entries and a large one', () => {
    const many: ZipEntry[] = Array.from({ length: 100 }, (_value, index) => ({
      name: `runs/run-${index}.json`,
      data: textBytes(JSON.stringify({ id: index })),
    }))
    const big = Uint8Array.from({ length: 60_000 }, (_value, index) => (index * 31) % 251)
    many.push({ name: 'recordings/9.crk', data: big })
    const read = readZip(writeZip(many))
    expect(read).toHaveLength(101)
    expect([...read[100].data]).toEqual([...big])
    expect(JSON.parse(bytesText(read[42].data)) as { id: number }).toEqual({ id: 42 })
  })
})

describe('the zip reader', () => {
  it('refuses a file that is not a zip at all', () => {
    expect(() => readZip(textBytes('this is a JSON backup, from the round before'))).toThrow(/not a zip/)
    expect(() => readZip(new Uint8Array(4))).toThrow(/not a zip/)
  })

  /**
   * A damaged entry is REFUSED by name rather than returned. This is a restore path: a recording
   * whose bytes rotted in a Downloads folder must be caught here, once, rather than
   * uploaded to the roaster to be refused there twenty-three separate times.
   */
  it('refuses an entry whose bytes no longer match their checksum, and names it', () => {
    const zip = writeZip([{ name: 'recordings/41.crk', data: bytes(9, 9, 9, 9) }])
    const damaged = Uint8Array.from(zip)
    // One flipped payload byte. The entry's data sits immediately after its local header and name.
    damaged[30 + 'recordings/41.crk'.length] ^= 0xff
    expect(() => readZip(damaged)).toThrow(/recordings\/41\.crk/)
  })

  /**
   * We only ever read our own zips, and this says so out loud rather than assuming it. A compressed
   * entry is refused BY NAME instead of skipped: silently skipping one during a restore is a profile
   * that quietly does not come back, which is the failure this whole feature exists to prevent.
   */
  it('refuses a compressed entry by name instead of skipping it', () => {
    const zip = writeZip([{ name: 'collections/beans.json', data: textBytes('{"beans":[]}') }])
    const deflated = Uint8Array.from(zip)
    // The central directory's method field is the one the reader trusts.
    const central = zip.length - 22 - (46 + 'collections/beans.json'.length)
    new DataView(deflated.buffer).setUint16(central + 10, 8, true)
    expect(() => readZip(deflated)).toThrow(/collections\/beans\.json.*compressed/)
  })

  it('finds the directory even when a comment has been appended by some other tool', () => {
    const zip = writeZip([{ name: 'a.json', data: textBytes('{}') }])
    const commented = new Uint8Array(zip.length + 5)
    commented.set(zip)
    commented.set(textBytes('hello'), zip.length)
    new DataView(commented.buffer).setUint16(zip.length - 2, 5, true)
    expect(readZip(commented)[0].name).toBe('a.json')
  })

  /** Some tools write explicit directory records. They carry no bytes and are not files. */
  it('skips a directory record rather than reporting it as an empty file', () => {
    const zip = writeZip([
      { name: 'runs/', data: new Uint8Array(0) },
      { name: 'runs/a.json', data: textBytes('{}') },
    ])
    expect(readZip(zip).map((entry) => entry.name)).toEqual(['runs/a.json'])
  })
})
