import type { DeviceRoastOrigin, RecordedOn, RecordingOrigin, RecordingStorageAddress } from '../domain/types'

export const testRecordedOn: RecordedOn = {
  deviceId: 'test-roaster',
  modelId: 'freshroast-sr800',
  displayNameAtCapture: 'Test SR800',
  simulated: false,
  firmwareVersion: 'test-firmware',
  identitySource: 'roaster',
}

export const testRecordingOrigin = (logId = 'test-log'): RecordingOrigin => ({
  deviceId: testRecordedOn.deviceId,
  logId,
})

export const testStorageAddress = (logId = 'test-log'): RecordingStorageAddress => ({
  deviceId: testRecordedOn.deviceId,
  logId,
})

export const testLogProvenance = (logId = 'test-log') => ({
  recordedOn: testRecordedOn,
  recordingOrigin: testRecordingOrigin(logId),
  storageAddress: testStorageAddress(logId),
})

export const testDeviceRoastOrigin = (
  logId = 'test-log',
  overrides: Partial<DeviceRoastOrigin> = {},
): DeviceRoastOrigin => ({
  recordingOrigin: testRecordingOrigin(logId),
  storageAddress: testStorageAddress(logId),
  name: 'test-roast',
  dateUnknown: false,
  profileLinked: true,
  ...overrides,
})
