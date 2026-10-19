import { describe, expect, it } from 'vitest'
import { starterBean, starterThermalIntent } from '../data/demo'
import { testRecordedOn } from '../testFixtures/provenance'
import {
  type DeviceRoastStartPorts,
  executeDeviceRoastStart,
  provisionalDeviceRoastRun,
  provisionalManualRoastRun,
} from './deviceRoastStart'
import type { RoastRun } from './types'

const stagedInput = {
  id: 'run-1',
  name: 'Gentle espresso journey',
  profile: starterThermalIntent,
  measurements: { startingMassG: 225, startingVolumeMl: 350, ambientC: 24.5 },
  beanLotId: starterBean.id,
  beanLot: starterBean,
  recordedOn: testRecordedOn,
  firmwareVersion: '2026-07-26.108',
  bootId: 'boot-9',
  startedAt: '2026-08-29T09:15:00.000Z',
}

const run = () => provisionalDeviceRoastRun(stagedInput)

/** Ports that record every call in order, with each behavior overridable per test. */
const ports = (overrides: Partial<DeviceRoastStartPorts> = {}) => {
  const calls: string[] = []
  const saved: RoastRun[] = []
  const base: DeviceRoastStartPorts = {
    saveRun: async (record) => {
      calls.push('saveRun')
      saved.push(record)
    },
    deleteRun: async () => {
      calls.push('deleteRun')
    },
    markRunAborted: async () => {
      calls.push('markRunAborted')
    },
    start: async () => {
      calls.push('start')
      return { ok: true }
    },
  }
  return { calls, saved, ports: { ...base, ...overrides } as DeviceRoastStartPorts }
}

/**
 * Design rule: the roast setup stages on the ROASTER at Start, never the browser. The
 * staged record is complete, it is durable BEFORE the Start command fires, and the write is a
 * fail-closed precondition.
 */
describe('the record staged on the roaster at Start', () => {
  it('carries the complete setup: volume, ambient, bean lot id and snapshot, mass, name, outcome running', () => {
    const staged = run()
    expect(staged.measurements).toEqual({ startingMassG: 225, startingVolumeMl: 350, ambientC: 24.5 })
    expect(staged.beanLotId).toBe(starterBean.id)
    expect(staged.beanLotSnapshot).toEqual(starterBean)
    // Snapshots are copies: later catalog edits must not rewrite history.
    expect(staged.beanLotSnapshot).not.toBe(starterBean)
    expect(staged.profile).toEqual(starterThermalIntent)
    expect(staged.profile).not.toBe(starterThermalIntent)
    expect(staged.name).toBe('Gentle espresso journey')
    expect(staged.outcome).toBe('running')
    expect(staged.samples).toEqual([])
    expect(staged.deviceRoastPending).toEqual({ bootId: 'boot-9' })
    expect(staged.manualRoast).toBeUndefined()
  })

  it('gives a recordable manual roast the same treatment, plus its manual instruction path', () => {
    const staged = provisionalManualRoastRun({ ...stagedInput, fan: 8, heat: 6 })
    expect(staged.measurements).toEqual({ startingMassG: 225, startingVolumeMl: 350, ambientC: 24.5 })
    expect(staged.beanLotSnapshot?.id).toBe(starterBean.id)
    expect(staged.outcome).toBe('running')
    expect(staged.deviceRoastPending).toEqual({ bootId: 'boot-9' })
    expect(staged.manualRoast).toEqual({ changes: [], deviceName: 'Gentle espresso journey', incomplete: true })
  })

  /**
   * The cross-browser property, stated as the ordering that produces it: browser A's record is
   * durable on the roaster BEFORE the roast starts, so browser B reading the device library at any
   * moment during the roast sees the complete record - not a partial one awaiting A's return.
   */
  it('writes the complete record durably before the Start command fires', async () => {
    const { calls, saved, ports: p } = ports()
    const outcome = await executeDeviceRoastStart(run(), p)
    expect(outcome.ok).toBe(true)
    expect(calls).toEqual(['saveRun', 'start'])
    expect(saved[0].measurements?.startingVolumeMl).toBe(350)
    expect(saved[0].beanLotId).toBe(starterBean.id)
    expect(saved[0].outcome).toBe('running')
  })

  it('fails closed when the roaster refuses the record: Start never fires and the reason surfaces', async () => {
    const { calls, ports: p } = ports({
      saveRun: async () => {
        throw new Error('The roaster is running or recording. Try again when it is idle.')
      },
    })
    const outcome = await executeDeviceRoastStart(run(), p)
    expect(outcome).toEqual({
      ok: false,
      stage: 'record',
      message: 'The roaster is running or recording. Try again when it is idle.',
    })
    // No blind retry of a mutation, and above all no Start on top of an unstaged record.
    expect(calls).toEqual([])
  })

  it('removes the staged record when Start is refused after the write', async () => {
    const { calls, ports: p } = ports({
      start: async () => {
        calls.push('start')
        return { ok: false, message: 'A roast is already running.' }
      },
    })
    const outcome = await executeDeviceRoastStart(run(), p)
    expect(outcome).toEqual({ ok: false, stage: 'start', message: 'A roast is already running.', cleanup: 'removed' })
    expect(calls).toEqual(['saveRun', 'start', 'deleteRun'])
  })

  it('marks the record aborted when removal fails, and reports stranded when even that fails', async () => {
    const failingDelete = async () => {
      throw new Error('busy')
    }
    const aborted = await executeDeviceRoastStart(
      run(),
      ports({
        start: async () => ({ ok: false, message: 'refused' }),
        deleteRun: failingDelete,
      }).ports,
    )
    expect(aborted.ok).toBe(false)
    if (!aborted.ok && aborted.stage === 'start') expect(aborted.cleanup).toBe('aborted')

    const stranded = await executeDeviceRoastStart(
      run(),
      ports({
        start: async () => ({ ok: false, message: 'refused' }),
        deleteRun: failingDelete,
        markRunAborted: async () => {
          throw new Error('still busy')
        },
      }).ports,
    )
    expect(stranded.ok).toBe(false)
    if (!stranded.ok && stranded.stage === 'start') expect(stranded.cleanup).toBe('stranded')
  })

  /**
   * A Start whose acknowledgement was lost may have committed: the roast may be running. Only a
   * definite refusal may remove or abort the staged record.
   */
  it('keeps the staged record untouched when the Start outcome is unknown', async () => {
    const { calls, ports: p } = ports({
      start: async () => {
        calls.push('start')
        return { ok: false, outcomeUnknown: true, message: 'The answer to Start was lost.' }
      },
    })
    const outcome = await executeDeviceRoastStart(run(), p)
    expect(outcome).toMatchObject({ ok: false, stage: 'start', cleanup: 'kept', outcomeUnknown: true })
    if (!outcome.ok) expect(outcome.message).toContain('check the roaster')
    expect(calls).toEqual(['saveRun', 'start'])
  })

  it('treats a Start that threw as unknown too, never as a refusal', async () => {
    const { calls, ports: p } = ports({
      start: async () => {
        calls.push('start')
        throw new Error('network changed')
      },
    })
    const outcome = await executeDeviceRoastStart(run(), p)
    expect(outcome).toMatchObject({ ok: false, stage: 'start', cleanup: 'kept', outcomeUnknown: true })
    expect(calls).toEqual(['saveRun', 'start'])
  })
})
