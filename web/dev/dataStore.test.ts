/**
 * Mock parity with the firmware's documented contract.
 *
 * The mock is what the whole controller-as-database feature is reviewed against on the dev server,
 * so a mock that drifts from `firmware/crackle/README.md` is worse than no mock at all: every
 * behaviour built on it would look finished and would fail on the first real device. Everything
 * asserted here is a sentence in that README, and the store is written as a pure module precisely so
 * the contract can be driven directly rather than through a running server.
 *
 * The last two tests go through `createRouter` instead, because two things only exist on the wire:
 * the payload comes back as the BODY of a successful GET (not wrapped in JSON), and the version
 * comes back in `X-Doc-Version`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { richDemoDataset } from '../src/data/demoDataset'
import { parseBeansDocument, parseProfilesDocument, parseRunDocument } from '../src/data/documentSerializer'
import { ARCHIVE_LIST_BUSY_MS, ARCHIVE_TOTAL_BYTES, IDLE_PERSIST_MS, LOG_TAIL_MS, PLAUSIBLE } from './config'
import {
  ARCHIVE_BLOCKED_MESSAGE,
  BUSY_MESSAGE,
  COLLECTION_CAP_BYTES,
  DATA_COLLECTIONS,
  DocumentStore,
  ENVELOPE_BYTES,
  isRunId,
  LOG_ARCHIVE_RESERVE_BYTES,
  MAX_INCOMING_LOG_BYTES,
  MAX_LISTED_RUNS,
  parseBase,
  RECORDING_BUSY_MESSAGE,
  RUN_CAP_BYTES,
  VOLUME_FLOOR_BYTES,
} from './dataStore'
import { MockDevice } from './device'
import { PERSISTED_STATE_VERSION } from './persistence'
import { createRouter } from './routes'
import { seedDocuments } from './seed'

type StoreWriteOptions = Parameters<DocumentStore['write']>[3]
const room: StoreWriteOptions = {
  idle: true,
  archiveState: 'ready',
  otherUsedBytes: 0,
  volumeTotalBytes: ARCHIVE_TOTAL_BYTES,
}
const write = (
  store: DocumentStore,
  target: string,
  payload: string,
  base: string | null,
  options: Partial<StoreWriteOptions> = {},
) => store.write(target, payload, base, { ...room, ...options })

const seeded = () => {
  const store = new DocumentStore()
  expect(write(store, 'profiles', '{"v":1}', '0').status).toBe(200)
  return store
}

describe('the document store contract', () => {
  it('accepts exactly four collection names, case sensitively', () => {
    const store = new DocumentStore()
    for (const name of DATA_COLLECTIONS) expect(write(store, name, '{}', '0').status).toBe(200)
    for (const name of ['Profiles', 'runs', 'settings', 'profiles.json', '']) {
      expect(write(store, name, '{}', '0').status).toBe(400)
      expect(store.read(name).status).toBe(400)
    }
  })

  it('validates a run id as a path segment rather than looking it up', () => {
    expect(isRunId('device-roast-41')).toBe(true)
    expect(isRunId('a.b_c-1')).toBe(true)
    expect(isRunId('')).toBe(false)
    expect(isRunId('.')).toBe(false)
    expect(isRunId('..')).toBe(false)
    expect(isRunId('a'.repeat(25))).toBe(false)
    expect(isRunId('has space')).toBe(false)
    expect(isRunId('a%2Fb')).toBe(false)
    const store = new DocumentStore()
    for (const bad of ['runs/..', 'runs/a b', 'runs/', `runs/${'a'.repeat(25)}`]) {
      expect(write(store, bad, '{}', '0').status).toBe(400)
    }
  })

  it('parses base strictly, and never reads a malformed one as 0', () => {
    expect(parseBase('0')).toBe(0)
    expect(parseBase('4294967295')).toBe(4294967295)
    expect(parseBase('4294967296')).toBeUndefined()
    for (const bad of ['', ' 1', '1 ', '+1', '-1', '0x1', '1.0', 'one', null, undefined]) {
      expect(parseBase(bad)).toBeUndefined()
    }
    expect(write(new DocumentStore(), 'profiles', '{}', '+1').status).toBe(400)
  })

  it('advances the version by exactly one, and refuses a stale base without touching the bytes', () => {
    const store = new DocumentStore()
    expect(write(store, 'beans', '{"a":1}', '0')).toMatchObject({ status: 200, body: { ok: true, version: 1 } })
    expect(write(store, 'beans', '{"a":2}', '1')).toMatchObject({ status: 200, body: { ok: true, version: 2 } })
    // A second create refuses: base 0 means "it must not exist".
    expect(write(store, 'beans', '{"a":3}', '0')).toMatchObject({
      status: 409,
      body: { ok: false, conflict: true, version: 2 },
    })
    expect(store.read('beans')).toMatchObject({ status: 200, payload: '{"a":2}', version: 2 })
  })

  it('keeps an empty document distinct from a missing one', () => {
    const store = new DocumentStore()
    expect(store.read('meta').status).toBe(404)
    expect(write(store, 'meta', '', '0').status).toBe(200)
    expect(store.read('meta')).toMatchObject({ status: 200, payload: '', version: 1 })
  })

  it('hands back an opaque payload byte for byte', () => {
    const store = new DocumentStore()
    const payload = '{"unbalanced": [1,2,  "é—🔥" '
    expect(write(store, 'calibrations', payload, '0').status).toBe(200)
    expect(store.read('calibrations').payload).toBe(payload)
  })

  it('caps collections at 12 KB and runs at 8 KB', () => {
    const store = new DocumentStore()
    expect(write(store, 'profiles', 'x'.repeat(COLLECTION_CAP_BYTES), '0').status).toBe(200)
    expect(write(store, 'beans', 'x'.repeat(COLLECTION_CAP_BYTES + 1), '0').status).toBe(413)
    expect(write(store, 'runs/one', 'x'.repeat(RUN_CAP_BYTES), '0').status).toBe(200)
    expect(write(store, 'runs/two', 'x'.repeat(RUN_CAP_BYTES + 1), '0').status).toBe(413)
  })

  /**
   * Target/base validation precede the storage gate. After that, idle and archive evidence precede
   * the size cap, matching production's decision before it materializes the POST body.
   */
  it('gates idle and archive persistence before checking payload size', () => {
    const store = seeded()
    const oversized = 'x'.repeat(COLLECTION_CAP_BYTES + 1)
    expect(write(store, 'nonsense', '{}', '0', { idle: false }).status).toBe(400)
    expect(write(store, 'beans', '{}', 'bad', { idle: false }).status).toBe(400)
    const busy = write(store, 'beans', oversized, '0', { idle: false })
    expect(busy).toMatchObject({ status: 409, body: { ok: false, message: BUSY_MESSAGE } })
    const recording = write(store, 'beans', oversized, '0', { archiveState: 'recording' })
    expect(recording).toMatchObject({ status: 409, body: { ok: false, message: RECORDING_BUSY_MESSAGE } })
    const blocked = write(store, 'beans', oversized, '0', { archiveState: 'blocked' })
    expect(blocked).toMatchObject({ status: 503, body: { ok: false, message: ARCHIVE_BLOCKED_MESSAGE } })
    expect(write(store, 'beans', oversized, '0').status).toBe(413)
    expect(store.remove('profiles', 'DELETE_DATA', '1', false)).toMatchObject({
      status: 409,
      body: { ok: false, message: BUSY_MESSAGE },
    })
    // Reads are ALWAYS allowed: a browser renders the whole store mid-roast.
    expect(store.read('profiles').status).toBe(200)
    expect(store.listRuns().status).toBe(200)
  })

  it('refuses a write that would take the volume under its derived write floor', () => {
    const store = new DocumentStore()
    const nearlyFull = ARCHIVE_TOTAL_BYTES - VOLUME_FLOOR_BYTES - 100
    expect(write(store, 'profiles', 'x'.repeat(200), '0', { otherUsedBytes: nearlyFull })).toMatchObject({
      status: 507,
    })
    expect(store.read('profiles').status).toBe(404)
    expect(write(store, 'profiles', 'x'.repeat(50), '0', { otherUsedBytes: nearlyFull }).status).toBe(200)
  })

  it('deletes with a confirmation token, and the delete resets the version history', () => {
    const store = new DocumentStore()
    write(store, 'runs/device-roast-41', '{"v":1}', '0')
    write(store, 'runs/device-roast-41', '{"v":2}', '1')
    expect(store.remove('runs/device-roast-41', undefined, '2', true).status).toBe(409)
    expect(store.remove('runs/device-roast-41', 'delete_data', '2', true).status).toBe(409)
    expect(store.remove('runs/device-roast-41', 'DELETE_DATA', undefined, true).status).toBe(400)
    expect(store.remove('runs/device-roast-41', 'DELETE_DATA', '1', true)).toMatchObject({
      status: 409,
      body: { conflict: true, version: 2 },
    })
    expect(store.remove('runs/device-roast-41', 'DELETE_DATA', '2', true)).toMatchObject({
      status: 200,
      body: { ok: true, deleted: 'runs/device-roast-41', version: 0 },
    })
    expect(store.remove('runs/device-roast-41', 'DELETE_DATA', '2', true)).toMatchObject({
      status: 409,
      body: { conflict: true, version: 0 },
    })
    expect(store.remove('runs/device-roast-41', 'DELETE_DATA', '0', true).status).toBe(404)
    // Version history is gone with it, so a later create starts again at 1.
    expect(write(store, 'runs/device-roast-41', '{"v":3}', '0')).toMatchObject({
      status: 200,
      body: { ok: true, version: 1 },
    })
  })

  it('reports a corrupted envelope as 500 at version 0, and lets base=0 overwrite it', () => {
    const store = seeded()
    store.documents.set('profiles', { version: 4, payload: 'damaged', corrupt: true })
    expect(store.read('profiles')).toMatchObject({ status: 500, version: 0 })
    expect(write(store, 'profiles', '{"repaired":true}', '4').status).toBe(409)
    expect(write(store, 'profiles', '{"repaired":true}', '0')).toMatchObject({
      status: 200,
      body: { ok: true, version: 1 },
    })
  })

  it('lists runs by envelope only, reporting payload bytes, capped at 400', () => {
    const store = new DocumentStore()
    write(store, 'runs/one', '{"a":1}', '0')
    write(store, 'runs/one', '{"a":22}', '1')
    write(store, 'profiles', '{"not":"a run"}', '0')
    store.documents.set('runs/damaged', { version: 9, payload: 'x', corrupt: true })
    expect(store.listRuns().body).toEqual({
      ok: true,
      runs: [{ id: 'one', bytes: 8, version: 2 }],
      total: 1,
      truncated: false,
    })

    const many = new DocumentStore()
    for (let index = 0; index <= MAX_LISTED_RUNS; index += 1) write(many, `runs/r${index}`, '{}', '0')
    expect((many.listRuns().body as { runs: unknown[] }).runs).toHaveLength(MAX_LISTED_RUNS)
    expect(many.listRuns().body).toMatchObject({ total: MAX_LISTED_RUNS + 1, truncated: true })
  })

  it('answers 503 for every endpoint, reads included, when the volume is not mounted', () => {
    const store = seeded()
    store.mounted = false
    expect(store.read('profiles').status).toBe(503)
    expect(store.listRuns().status).toBe(503)
    expect(write(store, 'profiles', '{}', '1').status).toBe(503)
    expect(store.remove('profiles', 'DELETE_DATA', '1', true).status).toBe(503)
    // The block is still emitted: its PRESENCE is the feature detection.
    expect(store.statusBlock(ARCHIVE_TOTAL_BYTES, 0)).toMatchObject({ mounted: false, used_bytes: 0, collections: {} })
  })

  it('omits a collection that has never been written from the status block', () => {
    const store = new DocumentStore()
    write(store, 'profiles', '{"a":1}', '0')
    write(store, 'runs/one', '{"b":22}', '0')
    const block = store.statusBlock(ARCHIVE_TOTAL_BYTES, 1000)
    expect(block.collections).toEqual({ profiles: { bytes: 7, version: 1 } })
    expect(block.runs).toEqual({ count: 1, bytes: 8 })
    // used_bytes is a capacity number - payload plus envelope - and free is volume-wide.
    expect(block.used_bytes).toBe(7 + 8 + 32)
    expect(block.free_bytes).toBe(ARCHIVE_TOTAL_BYTES - 1000 - block.used_bytes)
  })
})

/**
 * A wiped state file is the documented way to ask for a fresh mock, and an unseeded store would leave
 * the app with recordings but no library, so nothing to roast, compare or preview with. The
 * store therefore seeds itself from the same dataset the browser's own demo mode uses, written through the
 * real serializers - so what the mock hands back is what the app would have written.
 */
describe('a fresh document store seeds itself with the demo library', () => {
  it('writes every collection and one document per roast, at version 1', () => {
    const store = new DocumentStore()
    const dataset = richDemoDataset()
    seedDocuments(store, dataset)

    for (const name of DATA_COLLECTIONS) expect(store.read(name), name).toMatchObject({ status: 200, version: 1 })
    const index = store.listRuns().body as { runs: Array<{ id: string }> }
    expect(index.runs).toHaveLength(dataset.runs.length)
    expect(index.runs.map((entry) => entry.id).sort()).toEqual(dataset.runs.map((run) => run.id).sort())
  })

  it('seeds bytes the app can actually parse back, at the dataset counts', () => {
    const store = new DocumentStore()
    const dataset = richDemoDataset()
    seedDocuments(store, dataset)

    expect(parseProfilesDocument(store.read('profiles').payload!).profiles).toHaveLength(dataset.profiles.length)
    expect(parseBeansDocument(store.read('beans').payload!).beans).toHaveLength(dataset.beans.length)
    const first = dataset.runs[0]
    expect(parseRunDocument(store.read(`runs/${first.id}`).payload!).name).toBe(first.name)
  })

  /** The whole library plus a full recordings archive still has to clear the volume floor. */
  it('fits alongside a seeded recordings archive', () => {
    const store = new DocumentStore()
    expect(() => seedDocuments(store, richDemoDataset(), 200 * 1024)).not.toThrow()
    expect(store.usedBytes()).toBeLessThan(ARCHIVE_TOTAL_BYTES - VOLUME_FLOOR_BYTES - 200 * 1024)
  })

  it('leaves a restored state file completely alone', () => {
    const device = new MockDevice()
    device.restore({
      version: PERSISTED_STATE_VERSION,
      bootCount: 3,
      nextLogId: 9,
      lostLogs: 0,
      seeded: true,
      logs: [],
      documents: [['profiles', { version: 7, payload: '{"v":1,"profiles":[]}' }]],
    })
    device.seed()
    // Same version, same bytes, and nothing else invented alongside it.
    expect(device.data.read('profiles')).toMatchObject({ status: 200, version: 7, payload: '{"v":1,"profiles":[]}' })
    expect(device.data.read('beans').status).toBe(404)
    expect((device.data.listRuns().body as { runs: unknown[] }).runs).toEqual([])
    // Including the applied set: a state file that holds none - because it was cleared through the
    // API - is a roaster holding none, and seeding must never quietly re-apply one behind that.
    expect(device.applied()).toBeUndefined()
  })

  /** A fresh mock exposes the same already-applied bean-scale fit in status and its library. */
  it('seeds a fresh controller with its library calibration applied', () => {
    const device = new MockDevice()
    const dataset = richDemoDataset()
    device.seed()

    expect(device.applied()).toMatchObject({
      heater_gain: dataset.appliedCalibration.heaterGainCPerMinAt10,
      fan_cooling: dataset.appliedCalibration.fanCoolingCPerMinAt10,
      cooling_fan: dataset.appliedCalibration.coolingFanCPerMinAt10,
      loss_per_min: dataset.appliedCalibration.thermalLossPerMinPerC,
      fit_id: dataset.appliedCalibration.thermalSourceRunId,
    })
    // And it clears the firmware's own plausibility gate, which is what the seed exists to satisfy:
    // a set the journey-start path would refuse would leave the roast page just as unreachable.
    const applied = device.applied()!
    for (const [field, range] of Object.entries(PLAUSIBLE)) {
      const value = applied[field as keyof typeof PLAUSIBLE]
      expect(value, field).toBeGreaterThanOrEqual(range.min)
      expect(value, field).toBeLessThanOrEqual(range.max)
    }
  })
})

// ---------------------------------------------------------------------------------- on the wire

const fakeRequest = (method: string, url: string, body = ''): IncomingMessage => {
  const stream = Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage
  return Object.assign(stream, { method, url, headers: { 'content-type': 'application/json' } })
}

const fakeResponse = () => {
  const captured = { status: 0, headers: {} as Record<string, string>, body: '' }
  const response = {
    statusCode: 0,
    setHeader(key: string, value: string) {
      captured.headers[key.toLowerCase()] = String(value)
    },
    end(chunk: string) {
      captured.status = response.statusCode
      captured.body = chunk
    },
  }
  return { response: response as unknown as ServerResponse, captured }
}

const call = async (device: MockDevice, method: string, url: string, body?: string) => {
  const { response, captured } = fakeResponse()
  const handled = await createRouter(device)(fakeRequest(method, url, body), response)
  return { handled, ...captured }
}

describe('the document store on the wire', () => {
  it('serves the revisioned manifest before the generic document prefix and paginates it', async () => {
    const device = new MockDevice()
    device.data.documents.set('profiles', { version: 3, payload: '{"v":1,"profiles":[]}' })
    for (let index = 0; index < 70; index += 1) {
      device.data.documents.set(`runs/run-${String(index).padStart(2, '0')}`, {
        version: index + 1,
        payload: '{"v":1}',
      })
    }

    const first = await call(device, 'GET', '/api/data/manifest')
    expect(first.status).toBe(200)
    const firstBody = JSON.parse(first.body) as {
      state_rev: string
      boot_id: string
      collections: Record<string, unknown>
      runs: Array<{ id: string; version: number }>
      logs: Array<{ id: string; bytes: number }>
      next_cursor?: string
    }
    expect(firstBody).toMatchObject({
      state_rev: '1',
      boot_id: '1',
      collections: {
        profiles: { bytes: 21, version: 3 },
        beans: null,
        calibrations: null,
        meta: null,
      },
    })
    expect(firstBody.runs).toHaveLength(64)
    expect(firstBody.next_cursor).toBe('m:64')

    const second = await call(device, 'GET', `/api/data/manifest?cursor=${encodeURIComponent(firstBody.next_cursor!)}`)
    expect(second.status).toBe(200)
    const secondBody = JSON.parse(second.body) as {
      state_rev: string
      runs: Array<{ id: string }>
      next_cursor?: string
    }
    expect(secondBody.state_rev).toBe(firstBody.state_rev)
    expect(secondBody.runs).toHaveLength(6)
    expect(secondBody.next_cursor).toBeUndefined()
    expect((await call(device, 'GET', '/api/data/manifest?cursor=bad')).status).toBe(400)
  })

  it('serves the current RAM thermal trace while its recording remains open', async () => {
    const device = new MockDevice()
    device.archive.open(device.nowMs, device.epochSeconds(), 'roast')
    const active = await call(device, 'GET', '/thermal.csv')
    expect(active.status).toBe(200)
    expect(active.body).toContain('t_ms,thermocouple_c')
    expect(device.actuator.request(device.nowMs, 4, 1)).toBeUndefined()
    device.nowMs += 1_500
    device.actuator.tick(device.nowMs, 1_500, 120)
    expect(device.actuator.effectiveHeat).toBe(1)
    device.actuator.stop(device.nowMs, 120)
    expect(device.actuator.mode).toBe('idle')
    const stopped = await call(device, 'GET', '/thermal.csv')
    expect(stopped.status).toBe(200)
    expect(stopped.body).toBe(active.body)
  })

  it('answers a read with the payload as its body and the version as a header', async () => {
    const device = new MockDevice()
    const created = await call(device, 'POST', '/api/data/profiles?base=0', '{"v":1,"profiles":[]}')
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toEqual({ ok: true, version: 1, state_rev: '2' })

    const read = await call(device, 'GET', '/api/data/profiles')
    expect(read.status).toBe(200)
    // The BODY is the payload itself, not a wrapper around it.
    expect(read.body).toBe('{"v":1,"profiles":[]}')
    expect(read.headers['x-doc-version']).toBe('1')
    expect(read.headers['cache-control']).toBe('no-store')

    const index = await call(device, 'GET', '/api/data/runs')
    expect(JSON.parse(index.body)).toEqual({ ok: true, runs: [], total: 0, truncated: false })
    expect((await call(device, 'GET', '/api/data/meta')).status).toBe(404)
  })

  it('routes a run by id, and takes the delete before the generic write', async () => {
    const device = new MockDevice()
    await call(device, 'POST', '/api/data/runs/device-roast-41?base=0', '{"v":1,"run":{}}')
    expect((await call(device, 'GET', '/api/data/runs/device-roast-41')).body).toBe('{"v":1,"run":{}}')
    expect(JSON.parse((await call(device, 'GET', '/api/data/runs')).body)).toMatchObject({
      runs: [{ id: 'device-roast-41', version: 1 }],
    })

    // `delete` is not a collection, so this only works because the route is matched first.
    const removed = await call(
      device,
      'POST',
      '/api/data/delete?target=runs/device-roast-41&confirm=DELETE_DATA&base=1',
    )
    expect(JSON.parse(removed.body)).toEqual({ ok: true, deleted: 'runs/device-roast-41', version: 0, state_rev: '3' })
    expect((await call(device, 'GET', '/api/data/runs/device-roast-41')).status).toBe(404)
  })

  it('publishes data_store in the status document, mounted, with real byte accounting', async () => {
    const device = new MockDevice()
    await call(device, 'POST', '/api/data/beans?base=0', '{"v":1,"beans":[]}')
    const status = JSON.parse((await call(device, 'GET', '/api/status')).body) as {
      data_store: Record<string, unknown>
    }
    expect(status.data_store).toMatchObject({ mounted: true, total_bytes: ARCHIVE_TOTAL_BYTES })
    expect(status.data_store.collections).toEqual({ beans: { bytes: 18, version: 1 } })
    expect(status.data_store.used_bytes).toBe(18 + 16)
  })

  /**
   * THE WRITE FLOOR IS PUBLISHED, DERIVED, AND ENFORCED AT THE SAME VALUE.
   *
   * crackle.ino emits `data_store.write_floor_bytes` because "the line is not a round number a
   * client should hardcode" - and the app hardcoded one anyway, 64 KB, then subtracted the archive's
   * 96 KB reserve a SECOND time on top of it. Both halves of that bug were invisible while the mock
   * published no floor at all and enforced a 64 KB one of its own.
   *
   * So three claims, and they are the three the app depends on:
   *   1. the field is present, because its absence is what sent the app to its fallback constant;
   *   2. it is at least the retention reserve, because the reserve is INSIDE it - a floor smaller
   *      than the reserve is the drift the firmware's derivation exists to make impossible;
   *   3. free minus floor is what a document may still have, and the mock refuses exactly there.
   */
  it('publishes the write floor it actually enforces, reserve included', async () => {
    const device = new MockDevice()
    const status = JSON.parse((await call(device, 'GET', '/api/status')).body) as {
      data_store: { write_floor_bytes: number; free_bytes: number; total_bytes: number; used_bytes: number }
    }
    const floor = status.data_store.write_floor_bytes

    expect(floor).toBe(VOLUME_FLOOR_BYTES)
    expect(floor).toBe(LOG_ARCHIVE_RESERVE_BYTES + MAX_INCOMING_LOG_BYTES)
    expect(floor).toBe(219548)
    // The reserve is a part of the floor, never a charge beside it.
    expect(floor).toBeGreaterThanOrEqual(LOG_ARCHIVE_RESERVE_BYTES)
    expect(floor).toBeLessThan(status.data_store.total_bytes)

    // Free minus floor is exactly what a document may still take, and the mock refuses ON that line
    // rather than near it: the published number is the enforced one to the byte.
    expect(status.data_store.free_bytes).toBe(status.data_store.total_bytes - status.data_store.used_bytes)
    const onTheLine = ARCHIVE_TOTAL_BYTES - floor - ENVELOPE_BYTES - 200
    expect(write(new DocumentStore(), 'profiles', 'x'.repeat(200), '0', { otherUsedBytes: onTheLine }).status).toBe(200)
    expect(write(new DocumentStore(), 'profiles', 'x'.repeat(200), '0', { otherUsedBytes: onTheLine + 1 }).status).toBe(
      507,
    )
    // And the old 64 KB floor would have let that same write through with 154 KB less to spare.
    expect(
      write(new DocumentStore(), 'profiles', 'x'.repeat(200), '0', {
        otherUsedBytes: ARCHIVE_TOTAL_BYTES - 64 * 1024 - ENVELOPE_BYTES - 200,
      }).status,
    ).toBe(507)
  })

  /**
   * `log_archive.used_bytes` IS THE WHOLE VOLUME, AND THE MOCK HAS TO SAY SO.
   *
   * crackle.ino fills that field with `LittleFS.usedBytes()` - `/data` and `/logs` together - and
   * for a while the mock reported the archive's own share instead. That single divergence certified
   * a real bug in the app, which added `data_store.used_bytes` on top and would have overstated
   * every real roaster by the size of its library, warning that a roast was about to prune a
   * recording while there was still room for it.
   *
   * So the invariant is asserted as an inequality rather than an equality: volume usage must be at
   * least its two tenants combined. Equality would pin the mock's own accounting; the inequality
   * pins the SEMANTICS, and it is exactly the assertion the recordings-only reading fails.
   */
  it('reports log_archive.used_bytes volume-wide, at least documents plus recordings', async () => {
    // Seeded, so both tenants are genuinely occupied: the demo library and a recordings archive.
    const device = new MockDevice()
    device.seed()

    const status = JSON.parse((await call(device, 'GET', '/api/status')).body) as {
      log_archive: { used_bytes: number; total_bytes: number }
      data_store: { used_bytes: number; free_bytes: number; total_bytes: number }
    }
    const index = JSON.parse((await call(device, 'GET', '/api/logs')).body) as {
      used_bytes: number
      logs: Array<{
        bytes: number
        recorded_on: { deviceId: string; simulated: boolean }
        recording_origin: { deviceId: string; logId: string }
        storage_address: { deviceId: string; logId: string }
      }>
      current: { recorded_on: { deviceId: string; simulated: boolean } }
      quarantined: unknown[]
    }
    const recordings = index.logs.reduce((total, entry) => total + entry.bytes, 0)

    expect(device.data.usedBytes()).toBeGreaterThan(0)
    expect(recordings).toBeGreaterThan(0)
    expect(index.logs[0]).toMatchObject({
      recorded_on: { deviceId: 'crackle-dev-sim-sr800', simulated: true },
      recording_origin: { deviceId: 'crackle-dev-sim-sr800' },
      storage_address: { deviceId: 'crackle-dev-sim-sr800' },
    })
    expect(index.current.recorded_on).toMatchObject({ deviceId: 'crackle-dev-sim-sr800', simulated: true })
    expect(index.quarantined).toEqual([])
    expect(status.log_archive.used_bytes).toBeGreaterThanOrEqual(status.data_store.used_bytes + recordings)
    // The listing serves the same volume figure the status block does - one number, two routes.
    expect(index.used_bytes).toBe(status.log_archive.used_bytes)
    // And `data_store.free_bytes` is that same figure said the other way round, as the firmware's is.
    expect(status.data_store.free_bytes).toBe(status.data_store.total_bytes - status.log_archive.used_bytes)
  })

  it('refuses a write while the mock is actuating, which is what makes the queue reviewable', async () => {
    const device = new MockDevice()
    await call(device, 'POST', '/api/data/beans?base=0', '{"v":1}')
    const started = await call(device, 'POST', '/api/manual/set?confirm=MANUAL_CONTROL&fan=6&heat=4')
    expect(started.status).toBe(200)

    const refused = await call(device, 'POST', '/api/data/beans?base=1', '{"v":2}')
    expect(refused.status).toBe(409)
    expect(JSON.parse(refused.body)).toEqual({ ok: false, message: BUSY_MESSAGE })
    // The stored bytes are untouched, and reading is still perfectly allowed mid-session.
    expect((await call(device, 'GET', '/api/data/beans')).body).toBe('{"v":1}')

    await call(device, 'POST', '/api/manual/stop')
    device.actuator.stop(device.nowMs, 25)
    // Diagnostic manual controls do not create a roast recording or passive
    // tail. Once outputs are stopped, document writes are immediately safe.
    expect((await call(device, 'POST', '/api/data/beans?base=1', '{"v":2}')).status).toBe(200)
  })

  it('refuses to format the shared volume while actuation is active', async () => {
    const device = new MockDevice()
    await call(device, 'POST', '/api/data/meta?base=0', '{"v":1}')
    expect((await call(device, 'POST', '/api/manual/set?confirm=MANUAL_CONTROL&fan=4&heat=0')).status).toBe(200)

    const refused = await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')
    expect(refused.status).toBe(409)
    expect((await call(device, 'GET', '/api/data/meta')).body).toBe('{"v":1}')

    await call(device, 'POST', '/api/manual/stop')
    expect((await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')).status).toBe(200)
  })

  it('refuses format through a roast passive tail and its unsaved interval', async () => {
    const device = new MockDevice()
    await call(device, 'POST', '/api/data/meta?base=0', '{"v":1}')
    const start = await call(
      device,
      'POST',
      '/api/roast/start?confirm=START_ROAST&mode=manual&name=format-gate&mass=225&fan=4&heat=0',
    )
    expect(start.status).toBe(202)
    const sessionId = (JSON.parse(start.body) as { session_id: number }).session_id
    device.step(1000)

    const actuating = await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')
    expect(actuating.status).toBe(409)
    expect(JSON.parse(actuating.body)).toEqual({ ok: false, message: 'Formatting waits until actuation finishes.' })

    expect((await call(device, 'POST', `/api/roast/stop?expected_session=${sessionId}`)).status).toBe(200)
    expect(device.archive.active).toBe(true)
    // The ten-second post-stop cooling tail is real actuation; formatting still waits for idle
    // outputs first.
    const cooling = await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')
    expect(cooling.status).toBe(409)
    expect(JSON.parse(cooling.body)).toEqual({ ok: false, message: 'Formatting waits until actuation finishes.' })
    device.step(11_000)
    const tail = await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')
    expect(tail.status).toBe(409)
    expect(JSON.parse(tail.body)).toEqual({
      ok: false,
      message: 'Formatting waits until the active or unsaved recording is finalized.',
    })
    expect((await call(device, 'GET', '/api/data/meta')).body).toBe('{"v":1}')

    device.step(LOG_TAIL_MS)
    expect(device.archive.active).toBe(false)
    expect(device.archive.unsaved).toBe(true)
    const unsaved = await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')
    expect(unsaved.status).toBe(409)
    expect(JSON.parse(unsaved.body)).toEqual({
      ok: false,
      message: 'Formatting waits until the active or unsaved recording is finalized.',
    })

    device.step(IDLE_PERSIST_MS)
    expect(device.archive.unsaved).toBe(false)
    expect((await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')).status).toBe(200)
  })

  /**
   * The settle moment, on the wire. On the device the just-finished recording's persist and the
   * settle-time meta/run writes share one storage worker, so the browser's settle-triggered
   * `GET /api/logs` is routinely answered `503 + Retry-After` for a while - exactly the deferral
   * that can strand the post-roast panel. The mock says busy for a compressed window
   * after the persist lands, so the app's archive retry schedule is exercisable in dev.
   */
  it('defers the archive listing with 503 + Retry-After through the settle write burst', async () => {
    const device = new MockDevice()
    const start = await call(
      device,
      'POST',
      '/api/roast/start?confirm=START_ROAST&mode=manual&name=settle-busy&mass=225&fan=4&heat=0',
    )
    expect(start.status).toBe(202)
    const sessionId = (JSON.parse(start.body) as { session_id: number }).session_id
    device.step(60_000)
    expect((await call(device, 'POST', `/api/roast/stop?expected_session=${sessionId}`)).status).toBe(200)
    device.step(LOG_TAIL_MS)
    device.step(IDLE_PERSIST_MS)
    expect(device.archive.unsaved).toBe(false)

    const busy = await call(device, 'GET', '/api/logs')
    expect(busy.status).toBe(503)
    // The header is the whole classification: without it a 503 reads as an unmounted volume.
    expect(busy.headers['retry-after']).toBe('1')

    device.step(ARCHIVE_LIST_BUSY_MS)
    const listed = await call(device, 'GET', '/api/logs')
    expect(listed.status).toBe(200)
    const index = JSON.parse(listed.body) as { logs: Array<{ name?: string }> }
    expect(index.logs.some((log) => log.name === 'settle-busy')).toBe(true)
  })

  it('returns a clean 400 for malformed percent escapes in path parameters', async () => {
    const device = new MockDevice()
    for (const [method, path] of [
      ['GET', '/api/data/%ZZ'],
      ['POST', '/api/data/%ZZ?base=0'],
      ['GET', '/logs/%ZZ.csv'],
    ] as const) {
      const response = await call(device, method, path, method === 'POST' ? '{}' : undefined)
      expect(response.status, path).toBe(400)
      expect(JSON.parse(response.body)).toMatchObject({ ok: false })
    }
  })

  it('keeps an expired incomplete restore behind its token gate', async () => {
    const device = new MockDevice()
    await call(device, 'POST', '/api/data/meta?base=0', '{"v":1}')
    expect((await call(device, 'POST', '/api/restore/begin?confirm=BEGIN_RESTORE')).status).toBe(200)
    device.nowMs += 120_001
    const refused = await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')
    expect(refused.status).toBe(423)
    expect(device.restoreStatus()).toMatchObject({ active: false, incomplete: true })
    expect((await call(device, 'GET', '/api/data/meta')).status).toBe(200)
  })

  it('erases the document store when the volume is formatted, and says so', async () => {
    const device = new MockDevice()
    await call(device, 'POST', '/api/data/meta?base=0', '{"v":1}')
    const formatted = await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')
    expect(JSON.parse(formatted.body)).toEqual({ ok: true, mounted: true, data_store_erased: true, state_rev: '3' })
    expect((await call(device, 'GET', '/api/data/meta')).status).toBe(404)
  })

  it('makes a needs-format volume authoritative until format remounts it and restores the manifest', async () => {
    const device = new MockDevice()
    device.data.mounted = false

    const before = JSON.parse((await call(device, 'GET', '/api/status')).body) as {
      log_archive: { mounted: boolean; needs_format: boolean; health: string; used_bytes: number; total_bytes: number }
      data_store: { mounted: boolean }
    }
    expect(before.log_archive).toMatchObject({
      mounted: false,
      needs_format: true,
      health: 'needs_format',
      used_bytes: 0,
      total_bytes: 0,
    })
    expect(before.data_store).toMatchObject({ mounted: false })
    expect((await call(device, 'GET', '/api/logs')).status).toBe(503)
    expect((await call(device, 'GET', '/api/data/manifest')).status).toBe(503)

    const formatted = JSON.parse((await call(device, 'POST', '/api/logs/format?confirm=FORMAT_LOGS')).body) as {
      ok: boolean
      mounted: boolean
      state_rev: string
    }
    expect(formatted).toMatchObject({ ok: true, mounted: true })

    const after = JSON.parse((await call(device, 'GET', '/api/status')).body) as {
      log_archive: { mounted: boolean; needs_format: boolean; health: string; used_bytes: number; total_bytes: number }
      data_store: { mounted: boolean }
    }
    expect(after.log_archive).toMatchObject({ mounted: true, needs_format: false })
    expect(after.data_store).toMatchObject({ mounted: true })
    expect((await call(device, 'GET', '/api/logs')).status).toBe(200)

    const manifest = await call(device, 'GET', '/api/data/manifest')
    expect(manifest.status).toBe(200)
    expect(JSON.parse(manifest.body)).toMatchObject({
      ok: true,
      state_rev: formatted.state_rev,
      collections: { profiles: null, beans: null, calibrations: null, meta: null },
      runs: [],
      logs: [],
    })
  })
})
