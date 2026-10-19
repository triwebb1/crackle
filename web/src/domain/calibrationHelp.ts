/**
 * One crisp sentence per input and per reported term on the Calibrate screen. Kept in one module so
 * a test can assert that everything the view renders actually has an explanation, and so the
 * wording stays uniform instead of drifting across JSX.
 *
 * Deliberately ASCII: this text is rendered into `title` attributes as well as visible notes, and
 * plain characters survive both without escaping surprises.
 */
export const CALIBRATION_HELP = {
  // Program inputs
  gridFans:
    'The fan levels the baseline air map sweeps, one curve per level; four coarse levels map the chamber far better than many close ones.',
  gridHeats:
    'The heat levels visited at every fan level; keep the list coarse (1,5,10) so each transition is large enough to settle unambiguously.',
  steps:
    'A custom sequence written as fan:heat pairs, up to 12, run in exactly the order given; fan 0 is legal only with heat 0, which is a passive-decay step.',
  maxStepSeconds:
    'The hard cap on one step; a step that has not settled by then advances anyway and its steady state is estimated rather than measured.',
  minStepSeconds:
    'The minimum dwell before a settled advance is allowed, so a small transition cannot look settled before its transient has even begun.',
  settleSeconds:
    'How many consecutive one-second samples must stay inside the settle band before the step counts as settled.',
  settleBandC:
    'The width of that band in °C: temperature must hold within plus or minus this much for the whole settle window.',
  serpentine:
    'The order the grid actually runs: each fan group walks the heat list in the opposite direction to the one before, so every fan change happens at a shared heat and nothing is wasted on recovery steps.',
  batchMass:
    'Green mass of the batch in grams; leave it empty for a baseline pass, which is measured with an empty chamber.',
  greenDensity:
    'Green bean density in grams per millilitre; leave it empty for a baseline pass, and record it on loaded runs so they compare directly.',
  passNotes:
    'Anything about this pass a later reading would need: chamber state, ambient conditions, anything unusual.',
  calibrationName:
    'The name this pass is saved under in the calibration library; it defaults to the capture date and the grid.',

  // Live program state
  program: 'Whether the roaster is running a calibration pass right now.',
  stepIndex: 'Which step of the declared program is running, out of the total the grid expanded to.',
  currentPair: 'The fan and heat levels the current step is holding.',
  lastAdvance:
    'How the previous step ended: settled means it held inside the band for the settle window, capped means it ran out of step seconds first and never plateaued.',
  dwell: 'The minimum dwell and step cap being used, in seconds.',
  settling: 'The settle window and band being used.',
  endReason:
    'Why the last program stopped: completed ran every step, stopped was commanded, telemetry_stale means roaster temperature updates paused, fault is a protective abort, renewal_rejected means a heat lease was refused, qualification_stalled means the fan never qualified for heat.',
  logBuffer: 'How many one-second samples the roaster has logged against its buffer capacity; a new program clears it.',

  // Analysis terms
  ambient:
    'The lowest cold-junction reading in the final fifth of the recording. This avoids treating a heat-soaked restart as room temperature.',
  peak: 'The hottest thermocouple reading in the whole log.',
  steadyState:
    'Tss: the temperature a step settles at, taken as the mean of the last quarter of its samples once it has plateaued.',
  riseOverAmbient: 'Steady state minus ambient, which is the quantity the heat gain is actually fitted against.',
  tau: 'The time constant of the step: how long the chamber takes to close 63 percent of the gap to its steady state, fitted from the log rather than assumed.',
  held: 'How long the step actually ran, recovered from the log rather than from a clock, because adaptive settling makes step length unpredictable.',
  extrapolated:
    'A measured point plateaued and is drawn filled; an extrapolated point was cut short, so its steady state comes from a curve fit and is drawn hollow with the fit quality beside it; an unreliable point was cut short too but the fit identified nothing, so its number is only a lower bound.',
  approach:
    'How much of its fitted rise the step actually completed before advancing; anything well under 100 percent means the reported plateau came from the fit, not from the log.',
  floored:
    'The actuator will not run heat without airflow. A nonzero fan below public level 0.1 is normalized to 0.1 and reported at the level it actually used.',
  suspect:
    'Steady state must rise with heat at a fixed fan, so a row that falls is not a reading at all: those steps never settled, and the pass should be run again with a longer settle window and a narrower band.',
  mesh: 'The mesh: steady state against heat with one curve per fan level, over an aligned time-constant panel; a second pass overlays dashed and produces a signed drift table.',
  baselineMap:
    'Every stored pass aggregated into one fan by heat table, so coverage and gaps in the map are visible at a glance.',
  gainSlope:
    'Degrees of steady rise gained per unit of heat, from a linear fit grouped by fan level rather than drawn through a mixed cloud.',
  r2: 'How well that straight line fits: 1.000 is perfect, and a low value means the response is not linear over the range measured.',
  forcedTau:
    'The decay constant of the cooling tail while the fan is still running, which is what the cooling-fan coefficient comes from.',
  passiveTau:
    'The decay constant after the fan stops, with nothing but ambient loss acting; this is the anchor for everything else.',
  thermalLoss:
    'How fast the chamber sheds heat per degree above ambient, derived from the passive tail; without a fan-off tail in the log it cannot be derived at all.',
  staging:
    'What a pass measured, written as coefficients. Reading them changes nothing: a set only goes to work through Apply on its entry in Saved calibrations.',
  snapshot:
    'A saved calibration holds one coefficient set and its curve data under a name. Apply sends it to the roaster, and makes it this browser set once the roaster has taken it.',
} as const

export type CalibrationHelpKey = keyof typeof CALIBRATION_HELP

/**
 * A short display name per term. There are no per-field `i` buttons: help reaches the
 * screen as always-visible text under the fields it belongs to, and as one glossary inside the
 * collapsible guide for everything that is a reported term rather than an input. Both read from
 * the same object above, so an explanation still cannot exist without being shown somewhere.
 */
export const CALIBRATION_TERM_LABELS: Record<CalibrationHelpKey, string> = {
  gridFans: 'Fan levels',
  gridHeats: 'Heat levels',
  steps: 'Explicit step sequence',
  maxStepSeconds: 'Step cap',
  minStepSeconds: 'Minimum dwell',
  settleSeconds: 'Settle window',
  settleBandC: 'Settle band',
  serpentine: 'Serpentine path',
  batchMass: 'Batch mass',
  greenDensity: 'Green density',
  passNotes: 'Pass notes',
  calibrationName: 'Calibration name',
  program: 'Program',
  stepIndex: 'Step',
  currentPair: 'Fan : Heat',
  lastAdvance: 'Last advance',
  dwell: 'Dwell',
  settling: 'Settling',
  endReason: 'End reason',
  logBuffer: 'Log buffer',
  ambient: 'Ambient',
  peak: 'Peak',
  steadyState: 'Steady state',
  riseOverAmbient: 'Rise over ambient',
  tau: 'Tau',
  held: 'Held',
  extrapolated: 'Measured, extrapolated, unreliable',
  approach: 'Approach',
  floored: 'Floored step',
  suspect: 'Suspect row',
  mesh: 'The mesh',
  baselineMap: 'Baseline air map',
  gainSlope: 'Thermal gain per heat unit',
  r2: 'R2',
  forcedTau: 'Forced cooling tau',
  passiveTau: 'Passive decay tau',
  thermalLoss: 'Thermal-loss coefficient',
  staging: 'Staging',
  snapshot: 'Saved calibration',
}

export interface CalibrationGlossarySection {
  heading: string
  terms: CalibrationHelpKey[]
}

export const CALIBRATION_GLOSSARY: CalibrationGlossarySection[] = [
  {
    heading: 'Program inputs',
    terms: [
      'gridFans',
      'gridHeats',
      'steps',
      'maxStepSeconds',
      'minStepSeconds',
      'settleSeconds',
      'settleBandC',
      'serpentine',
      'batchMass',
      'greenDensity',
      'passNotes',
      'calibrationName',
    ],
  },
  {
    heading: 'Live program state',
    terms: ['program', 'stepIndex', 'currentPair', 'lastAdvance', 'dwell', 'settling', 'endReason', 'logBuffer'],
  },
  {
    heading: 'What the analysis reports',
    terms: [
      'ambient',
      'peak',
      'steadyState',
      'riseOverAmbient',
      'tau',
      'held',
      'approach',
      'extrapolated',
      'floored',
      'suspect',
      'mesh',
      'baselineMap',
      'gainSlope',
      'r2',
      'forcedTau',
      'passiveTau',
      'thermalLoss',
      'staging',
      'snapshot',
    ],
  },
]

/**
 * The collapsible guide at the top of the view. Deliberately short: it orients someone who has not
 * run a pass in months, and the per-field tooltips carry the detail.
 */
export const CALIBRATION_GUIDE: string[] = [
  'A baseline air map measures an EMPTY chamber: what temperature it settles at for every fan and heat pair, and how fast it gets there.',
  'The grid runs serpentine - each fan group walks the heats in the opposite direction - so every transition is a measurement and no step is wasted.',
  'A step ends when it settles (holds inside the band for the settle window, after the minimum dwell) or when it hits the step cap.',
  'The settled flag is not trusted: every step is curve-fitted, and a step whose fit disagrees with its tail is reported as extrapolated, or as unreliable if the fit identified nothing.',
  'Every nonzero fan request is normalized to at least public level 0.1, and a normalized step is measured and reported at the fan it actually ran at.',
  'The mesh is the result: steady state against heat, one curve per fan level, over an aligned time-constant panel.',
  'Leave the pass running and stay with the roaster. It heats unattended and the firmware protections are what stand underneath it.',
  'When the program ends, Fan and Heat stop. Crackle retains up to three minutes of passive decay, then fetches and analyses the log by itself.',
  'That decay tail is the whole reason for the wait: the thermal-loss coefficient can only be fitted from cooling with the fan off.',
  'Skipping the wait is allowed. The pass still analyses, only without a loss coefficient, and everything that depends on it stays informational.',
  'Two passes back to back should nearly coincide. That is the repeatability proof; passes months apart make the drift itself the reading.',
  'Save a pass as a named calibration to restore or compare it later.',
  'Apply on a saved calibration is one act: it shows the exact old and new numbers, sends them to the roaster, and adopts them here once the roaster has taken them.',
  'Baseline passes record no batch mass or volume. Loaded runs should record both: mass is the thermal-model input, while volume and density remain measured covariates until real evidence supports a separate term.',
  'Every recording and saved calibration is tied to the device and model that produced it. Evidence from different devices is never pooled; applying a same-model calibration from another roaster requires an explicit warning.',
  'The CSV download is an optional raw export. Nothing in this workflow needs a file to leave the browser.',
]
