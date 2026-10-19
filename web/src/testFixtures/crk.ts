import { crkCrc32 } from '../data/crkValidator'

export const CRK_V4_HEADER_BYTES = 220

const writeAscii = (bytes: Uint8Array, offset: number, length: number, value: string) => {
  bytes.set(new TextEncoder().encode(value).subarray(0, length - 1), offset)
}

const integrityBytes = (bytes: Uint8Array) =>
  Uint8Array.from([
    ...bytes.subarray(0, 96),
    ...bytes.subarray(100, CRK_V4_HEADER_BYTES),
    ...bytes.subarray(CRK_V4_HEADER_BYTES),
  ])

export const refreshV4Checksums = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(216, crkCrc32(bytes.subarray(104, 216)), true)
  view.setUint32(96, crkCrc32(integrityBytes(bytes)), true)
  return bytes
}

export const v4Recording = ({
  id = 41,
  originId = id,
  payload = Uint8Array.of(0, 0, 0, 0, 0),
  sampleCount = 1,
  codec = 1,
}: {
  id?: number
  originId?: number
  payload?: Uint8Array
  sampleCount?: number
  codec?: number
} = {}) => {
  const bytes = new Uint8Array(CRK_V4_HEADER_BYTES + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x4c4b5243, true)
  view.setUint16(4, 4, true)
  view.setUint8(6, 4)
  view.setUint32(8, id, true)
  view.setUint32(12, 7, true)
  view.setUint32(24, sampleCount, true)
  view.setUint32(28, 1000, true)
  view.setUint32(92, payload.length, true)
  view.setUint8(100, codec)
  writeAscii(bytes, 104, 24, 'test-device')
  writeAscii(bytes, 128, 24, 'freshroast-sr800')
  writeAscii(bytes, 152, 32, 'Test SR800')
  writeAscii(bytes, 184, 24, 'test-firmware')
  view.setUint32(208, originId, true)
  view.setInt16(213, -300, true)
  view.setUint8(215, 1)
  bytes.set(payload, CRK_V4_HEADER_BYTES)
  return refreshV4Checksums(bytes)
}
