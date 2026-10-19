import { describe, expect, it } from 'vitest'
import { PERSISTED_STATE_VERSION, parsePersistedState } from './persistence'

const current = {
  version: PERSISTED_STATE_VERSION,
  bootCount: 7,
  stateRev: '14',
  nextLogId: 42,
  lostLogs: 0,
  seeded: true,
  logs: [],
}

describe('mock persisted-state schema', () => {
  it('accepts only the current schema and deliberately reseeds obsolete dev data', () => {
    expect(parsePersistedState(JSON.stringify(current))).toEqual(current)
    expect(parsePersistedState(JSON.stringify({ ...current, version: PERSISTED_STATE_VERSION - 1 }))).toBeUndefined()
    expect(parsePersistedState(JSON.stringify({ ...current, logs: undefined }))).toBeUndefined()
    expect(parsePersistedState('not json')).toBeUndefined()
  })
})
