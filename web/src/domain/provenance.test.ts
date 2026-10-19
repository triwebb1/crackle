import { describe, expect, it } from 'vitest'
import {
  calibrationRecordingKey,
  recordedOnFromRoaster,
  recordingFileStem,
  recordingKey,
  recordingOriginFromFileStem,
  requireRecordedOn,
} from './provenance'

describe('recording provenance', () => {
  it('rejects an observation without complete provenance instead of attributing it to the active roaster', () => {
    expect(() => requireRecordedOn(undefined)).toThrow(/provenance/i)
    expect(() => requireRecordedOn({ deviceId: 'a', modelId: 'm', simulated: false })).toThrow(/identitySource/i)
  })

  it('captures the roaster-reported identity and firmware version', () => {
    expect(
      recordedOnFromRoaster(
        {
          deviceId: 'esp32-1',
          modelId: 'freshroast-sr800',
          displayName: 'Kitchen SR800',
          simulated: false,
        },
        '2026.07',
      ),
    ).toEqual({
      deviceId: 'esp32-1',
      modelId: 'freshroast-sr800',
      displayNameAtCapture: 'Kitchen SR800',
      simulated: false,
      firmwareVersion: '2026.07',
      identitySource: 'roaster',
    })
  })

  it('uses an unambiguous compound key', () => {
    expect(recordingKey({ deviceId: 'ab', logId: 'c' })).not.toBe(recordingKey({ deviceId: 'a', logId: 'bc' }))
  })

  it('associates restored calibration evidence by producer origin, not its new storage address', () => {
    const evidence = {
      recordedOn: {
        deviceId: 'source-roaster',
        modelId: 'freshroast-sr800',
        displayNameAtCapture: 'Source SR800',
        simulated: false,
        firmwareVersion: 'source-fw',
        identitySource: 'roaster' as const,
      },
      sourceLogId: '7',
    }
    const restoredEntry = {
      recordingOrigin: { deviceId: 'source-roaster', logId: '7' },
      storageAddress: { deviceId: 'target-roaster', logId: '42' },
    }
    expect(calibrationRecordingKey(evidence)).toBe(recordingKey(restoredEntry.recordingOrigin))
    expect(calibrationRecordingKey(evidence)).not.toBe(recordingKey(restoredEntry.storageAddress))
  })

  it('round-trips arbitrary identity through a filesystem-safe stem', () => {
    const origin = { deviceId: 'unit / café:1', logId: '41/α' }
    const stem = recordingFileStem(origin)
    expect(stem).toMatch(/^[A-Za-z0-9-]+$/)
    expect(recordingOriginFromFileStem(stem)).toEqual(origin)
  })
})
