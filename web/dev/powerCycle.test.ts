import { describe, expect, it } from 'vitest'
import { MockDevice } from './device'
import { statusDocument } from './documents'
import { powerCycleMockDevice } from './powerCycle'

const startManualRoast = (device: MockDevice) =>
  device.startRoast(
    new URLSearchParams({
      confirm: 'START_ROAST',
      mode: 'manual',
      name: 'Interrupted roast',
      mass: '225',
      fan: '4',
      heat: '0',
    }),
  )

describe('mock power cycle', () => {
  it('replaces runtime state while preserving device-owned flash state and identity', () => {
    const current = new MockDevice()
    current.seed()
    const beforeStatus = statusDocument(current)
    const beforeDocuments = current.data.snapshot()
    const beforeLogs = current.archive.logs.map((log) => ({ ...log, samples: [...log.samples] }))

    const started = startManualRoast(current)
    expect(started.status).toBe(202)
    const interruptedLogId = String(started.body.log_id)
    const provisional = current.archive.find(interruptedLogId)
    expect(provisional).toMatchObject({
      id: interruptedLogId,
      source: 'roast',
      version: 4,
      roastMode: 'manual',
      samples: [],
      initialPlan: { mode: 'manual', fan: 4, heat: 0 },
    })
    current.step(2_000)
    expect(current.roast?.active).toBe(true)
    expect(current.archive.active).toBe(true)

    const replacement = powerCycleMockDevice(current)
    const afterStatus = statusDocument(replacement)

    expect(replacement).not.toBe(current)
    expect(afterStatus.boot_id).not.toBe(beforeStatus.boot_id)
    expect(afterStatus.roaster).toEqual(beforeStatus.roaster)
    expect(replacement.data.snapshot()).toEqual(beforeDocuments)
    expect(replacement.archive.logs).toHaveLength(beforeLogs.length + 1)
    expect(replacement.archive.logs.slice(1)).toEqual(beforeLogs)
    expect(replacement.archive.find(interruptedLogId)).toEqual(provisional)
    expect(replacement.roast).toBeUndefined()
    expect(replacement.manual.active).toBe(false)
    expect(replacement.calibration).toBeUndefined()
    expect(replacement.actuator.mode).toBe('idle')
    expect(replacement.archive.active).toBe(false)
    expect(replacement.archive.unsaved).toBe(false)
  })
})
