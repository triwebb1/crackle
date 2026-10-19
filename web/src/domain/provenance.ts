import type { CalibrationRun, RecordedOn, RecordingOrigin, RecordingStorageAddress, RoasterIdentity } from './types'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required recording provenance: ${field}`)
  }
  return value.trim()
}

/** Validate at every persistence/import boundary. Missing provenance is quarantined, never guessed. */
export const requireRecordedOn = (value: unknown): RecordedOn => {
  const source = record(value)
  if (!source) throw new Error('Missing required recording provenance')
  const identitySource = source.identitySource
  if (identitySource !== 'roaster' && identitySource !== 'configured-legacy') {
    throw new Error('Missing required recording provenance: identitySource')
  }
  if (typeof source.simulated !== 'boolean') {
    throw new Error('Missing required recording provenance: simulated')
  }
  const simulatesModelId =
    typeof source.simulatesModelId === 'string' && source.simulatesModelId.trim()
      ? source.simulatesModelId.trim()
      : undefined
  return {
    deviceId: requiredText(source.deviceId, 'deviceId'),
    modelId: requiredText(source.modelId, 'modelId'),
    displayNameAtCapture: requiredText(source.displayNameAtCapture, 'displayNameAtCapture'),
    simulated: source.simulated,
    firmwareVersion: requiredText(source.firmwareVersion, 'firmwareVersion'),
    identitySource,
    ...(simulatesModelId ? { simulatesModelId } : {}),
  }
}

export const recordedOnFromRoaster = (identity: RoasterIdentity, firmwareVersion: string): RecordedOn =>
  requireRecordedOn({
    deviceId: identity.deviceId,
    modelId: identity.modelId,
    displayNameAtCapture: identity.displayName,
    simulated: identity.simulated,
    simulatesModelId: identity.simulatesModelId,
    firmwareVersion,
    identitySource: 'roaster',
  })

const requireRecordingRef = <T extends RecordingOrigin | RecordingStorageAddress>(value: unknown, label: string): T => {
  const source = record(value)
  if (!source) throw new Error(`Missing required ${label}`)
  return {
    deviceId: requiredText(source.deviceId, `${label}.deviceId`),
    logId: requiredText(source.logId, `${label}.logId`),
  } as T
}

export const requireRecordingOrigin = (value: unknown): RecordingOrigin =>
  requireRecordingRef<RecordingOrigin>(value, 'recording origin')

export const requireStorageAddress = (value: unknown): RecordingStorageAddress =>
  requireRecordingRef<RecordingStorageAddress>(value, 'recording storage address')

/** Length-prefixing makes the compound identity unambiguous for arbitrary controller ids. */
export const recordingKey = ({ deviceId, logId }: RecordingOrigin | RecordingStorageAddress): string =>
  `${deviceId.length}:${deviceId}${logId.length}:${logId}`

/** The immutable archive identity represented by a stored calibration evidence row. */
export const calibrationRecordingKey = (run: Pick<CalibrationRun, 'recordedOn' | 'sourceLogId'>): string | undefined =>
  run.sourceLogId ? recordingKey({ deviceId: run.recordedOn.deviceId, logId: run.sourceLogId }) : undefined

const utf8Hex = (value: string): string =>
  [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const fromUtf8Hex = (value: string): string | undefined => {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) return undefined
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Safe for ZIP entries, LittleFS filenames, URLs, and Windows paths. */
export const recordingFileStem = (origin: RecordingOrigin): string =>
  `r1-${utf8Hex(origin.deviceId)}-${utf8Hex(origin.logId)}`

/** Compact deterministic token for firmware-limited document ids; full origin remains in the record. */
export const recordingIdToken = (origin: RecordingOrigin): string => {
  const bytes = new TextEncoder().encode(recordingKey(origin))
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (const byte of bytes) {
    left = Math.imul(left ^ byte, 0x01000193) >>> 0
    right = Math.imul(right ^ byte, 0x85ebca6b) >>> 0
  }
  return left.toString(16).padStart(8, '0') + right.toString(16).padStart(8, '0')
}
export const recordingOriginFromFileStem = (stem: string): RecordingOrigin | undefined => {
  const match = /^r1-([0-9a-f]+)-([0-9a-f]+)$/.exec(stem)
  if (!match) return undefined
  const deviceId = fromUtf8Hex(match[1])
  const logId = fromUtf8Hex(match[2])
  return deviceId && logId ? { deviceId, logId } : undefined
}

export const sameRecording = (
  left: RecordingOrigin | RecordingStorageAddress,
  right: RecordingOrigin | RecordingStorageAddress,
): boolean => left.deviceId === right.deviceId && left.logId === right.logId
