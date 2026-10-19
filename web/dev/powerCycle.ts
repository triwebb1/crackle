import { MockDevice } from './device'

/**
 * Replace the simulated controller the same way a physical power cycle replaces its runtime.
 *
 * `snapshot()` is deliberately flash-shaped: controller documents, archived recordings, applied
 * calibration, identity-adjacent counters, and restore crash provenance survive. The plant,
 * actuator, live sequence, active program, and volatile recording do not appear in it, so restoring
 * into a new instance discards them instead of quietly carrying browser-visible RAM across boots.
 */
export const powerCycleMockDevice = (current: MockDevice): MockDevice => {
  const persisted = current.snapshot()
  const replacement = new MockDevice()
  replacement.restore(persisted)
  replacement.seed()
  return replacement
}
