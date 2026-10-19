import type { ControllerStatus, ThermalIntent } from './types'

/**
 * A requirement message must state what is MISSING, never the full checklist.
 *
 * Saying a temperature journey "requires a healthy thermocouple and validated thermal
 * calibration" whether or not the thermocouple is healthy reads as an error about something that
 * is fine. The roast start gate already has the right instinct - it returns the first unmet
 * condition and nothing else - so this generalizes that to lists.
 */
export interface Requirement {
  key: string
  /** Phrased to read after "Requires ", lower case, no trailing period. */
  need: string
  met: boolean
}

export const unmetRequirements = (requirements: Requirement[]) => requirements.filter((requirement) => !requirement.met)

export const joinNeeds = (needs: string[]): string => {
  if (needs.length === 0) return ''
  if (needs.length === 1) return needs[0]
  return `${needs.slice(0, -1).join(', ')} and ${needs[needs.length - 1]}`
}

/**
 * The sentence for whatever is still missing, or `undefined` when nothing is - in which case the
 * caller must render nothing at all rather than a satisfied checklist.
 */
export const requirementSentence = (requirements: Requirement[], prefix = 'Requires'): string | undefined => {
  const unmet = unmetRequirements(requirements)
  if (unmet.length === 0) return undefined
  return `${prefix} ${joinNeeds(unmet.map((requirement) => requirement.need))}.`
}

/**
 * What a temperature journey actually needs before it could execute. The controller half is read
 * from live status, the calibration half from the profile itself, so the message tracks reality
 * instead of restating the design.
 */
export const thermalJourneyRequirements = (intent: ThermalIntent, status?: ControllerStatus): Requirement[] => [
  { key: 'thermocouple', need: 'a healthy thermocouple', met: status?.thermocoupleValid === true },
  { key: 'calibration', need: 'validated thermal calibration', met: intent.calibrationStatus === 'validated' },
  {
    key: 'runner',
    need: 'an installed temperature-journey runner',
    met: status?.capabilities.thermalExecution === true,
  },
]

/**
 * Why the bean probe cannot be believed right now, in plain words, or `undefined` when it can.
 *
 * A "not executable" banner belongs on the Roast page, not the Profiles page: defining a temperature
 * journey is only authoring, and the warning matters only when a journey is chosen to roast and the
 * thermocouple is not working. Authoring a journey needs no hardware at all; ROASTING one is steered entirely by this
 * reading, so this is the condition the Roast page asks about.
 *
 * Ordered most-fundamental first, and it reports only the first thing that is wrong: a disconnected
 * controller has a stale status and an invalid thermocouple too, and listing all three would bury
 * the one that matters. Every field is one the status document already carries; nothing here polls.
 */
export const thermocoupleUnavailableReason = (status: ControllerStatus): string | undefined => {
  if (!status.connected) return 'The roaster is not connected.'
  if (status.fault) return `The roaster is reporting a fault: ${status.fault}`
  if (status.stale) return 'The roaster has not answered recently, so its last reading is stale.'
  if (!status.thermocoupleValid || status.temperatureC === undefined)
    return 'The thermocouple is not reporting a temperature.'
  return undefined
}
