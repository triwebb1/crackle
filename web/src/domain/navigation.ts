import type { AppView, ControllerStatus } from './types'

export interface LiveReadoutTargetInput {
  status: ControllerStatus
  /** A roast session is open in this browser. The controller cannot tell us this on its own. */
  roastInProgress: boolean
}

/**
 * Where the always-visible Fan / Heat / temperature readout takes you when you tap it.
 *
 * Whatever is actually driving those numbers is the screen you want: a manual hold, a roast, or a
 * calibration pass, in that order of directness. With nothing running the readout still goes
 * somewhere useful rather than doing nothing, and Manual is where you would go to make it move.
 */
export const liveReadoutTarget = ({ status, roastInProgress }: LiveReadoutTargetInput): AppView => {
  if (status.manual?.active) return 'manual'
  if (roastInProgress) return 'roast'
  if (status.calibration?.active) return 'calibrate'
  return 'manual'
}

export const liveReadoutHint = (target: AppView): string => {
  if (target === 'roast') return 'Open the roast in progress'
  if (target === 'calibrate') return 'Open the running calibration program'
  return 'Open manual control'
}
