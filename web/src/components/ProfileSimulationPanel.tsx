import { FlaskConical, RefreshCw, TriangleAlert } from 'lucide-preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { defaultCalibration } from '../data/calibration'
import { calibrationProvenance, previewCalibration } from '../domain/calibrationProvenance'
import type { DeviceCoefficients } from '../domain/deviceLogs'
import { heldTargetPath, simulatedChartZones } from '../domain/liveJourney'
import { effectiveThermalIntent, formatClock } from '../domain/model'
import {
  hasAssumedError,
  MAX_ASSUMED_ERROR_PERCENT,
  NO_ASSUMED_ERROR,
  type ProfileSimulationInput,
  profileGoalAt,
  type SimulatedZone,
  simulateJourney,
} from '../domain/profileSimulation'
import type { CalibrationSettings, CalibrationSnapshot, Profile, TimedProfile } from '../domain/types'
import { LiveChart } from './LiveChart'
import { NumberField } from './NumberField'

const SIMULATION_DEBOUNCE_MS = 300

/** A signed clock, because an overrun and an early arrival are different findings. */
const signedClock = (seconds: number) => `${seconds < 0 ? '-' : '+'}${formatClock(Math.abs(seconds))}`

/**
 * What a zone's simulated duration MEANS, which depends entirely on whether an error was injected.
 *
 * With no assumed error the plant IS the controller's model, so a zone that runs long is not a
 * prediction error - there is nothing to be wrong about. It is the profile asking for more than the
 * roaster can deliver. That distinction is the whole reason the error input exists.
 */
const zoneVerdict = (zone: SimulatedZone): string => {
  if (zone.infeasible)
    return `Unreachable: at this zone's own Fan and Heat limits the roaster settles at ${zone.reachableC.toFixed(0)} °C`
  if (!zone.attained)
    return `Did not arrive before the roaster's whole-profile runtime envelope expired; it had reached ${zone.plateauC.toFixed(1)} °C`
  if (zone.role === 'ramp') {
    return `Expected to miss: reached ${zone.endC} °C in ${formatClock(zone.simulatedDurationSec)} against a planned ${formatClock(zone.nominalDurationSec)}`
  }
  if (zone.role === 'cooling') {
    return `Accuracy not scored: cooling is governed by heat leaving the beans, and this model does not rebound (modelled rebound ${zone.reboundC.toFixed(1)} °C)`
  }
  if (zone.overrunSec > 15)
    return `Arrived ${formatClock(zone.overrunSec)} late: this zone asks for more climb than the roaster can deliver`
  if (zone.overrunSec < -15)
    return `Arrived ${formatClock(-zone.overrunSec)} early: the roaster climbs faster than this zone asks for`
  return 'Followed as written'
}

/**
 * A profile has no batch size - a roast does - so mass is not part of the profile. The simulation
 * still needs one and asks for it here, defaulting to whatever was last actually
 * roasted rather than to a number stored on the recipe.
 *
 * The snapshot recomputes automatically, debounced, so changing the mass shows its effect without
 * a second button to press. It is still never recomputed per keystroke: the debounce is what keeps
 * a two-thousand-sample simulation off the typing path.
 *
 * ==============================================================================================
 * WHAT THIS PANEL IS ALLOWED TO CLAIM
 * ==============================================================================================
 *
 * Predicted duration, predicted finish, and "furthest off goal" mean nothing in a pure simulation:
 * a loop that drives the plant with the same coefficients it hands the controller is perfectly
 * accurate by construction, so "furthest off goal" would measure the sensor lag and nothing else,
 * and presenting it as a prediction of a real roast would be a claim it cannot support. Such figures
 * matter only when an error is injected, to evaluate how the algorithm adjusts for it. So:
 *
 *   - With **no assumed error** the panel reports only what a perfect-model run can honestly say:
 *     nominal versus simulated duration per zone, and whether each zone's endpoint is reachable at
 *     that zone's own limits at all. A zone that runs long here is an INFEASIBLE PROFILE, not a
 *     wrong model.
 *   - With an **assumed error** the plant is perturbed and the controller is not, and the panel may
 *     then say how the loop coped - correction size, bias read back, overrun against the same run
 *     with no error - labelled as exactly that.
 */
export function ProfileSimulationPanel({
  profile,
  profiles,
  calibration: appCalibration,
  defaultMassG,
  snapshots,
  deviceCoefficients,
}: {
  profile: Profile
  profiles: Profile[]
  calibration: CalibrationSettings
  defaultMassG: number
  snapshots: CalibrationSnapshot[]
  deviceCoefficients?: DeviceCoefficients
}) {
  /*
   * The model this preview is drawn with is the CONTROLLER's whenever the controller has one, so a
   * prediction and the roast that follows it agree by construction rather than by coincidence.
   * `previewCalibration` holds the whole ladder and the reasoning behind it.
   */
  // Device status objects may be recreated at live-telemetry cadence. Key the expensive model by
  // coefficient values so an equal clone cannot restart the simulation debounce.
  const calibrationSignature = JSON.stringify([appCalibration, deviceCoefficients])
  const calibration = useMemo(() => previewCalibration(appCalibration, deviceCoefficients), [calibrationSignature])
  const [massG, setMassG] = useState(defaultMassG)
  const [volumeMl, setVolumeMl] = useState<number | undefined>()
  const [heaterGainErrorPercent, setHeaterGainErrorPercent] = useState(0)
  const [thermalLossErrorPercent, setThermalLossErrorPercent] = useState(0)
  const [request, setRequest] = useState<ProfileSimulationInput>({
    profile,
    calibration,
    massG,
    volumeMl,
    assumedError: NO_ASSUMED_ERROR,
  })
  const [recomputing, setRecomputing] = useState(false)
  useEffect(() => {
    setMassG(defaultMassG)
    setVolumeMl(undefined)
  }, [defaultMassG, profile.id])

  // Debounced auto-recompute: the last edit wins, and the intermediate states of a number being
  // typed never each trigger a simulation.
  const pending = useRef<number>()
  useEffect(() => {
    setRecomputing(true)
    window.clearTimeout(pending.current)
    pending.current = window.setTimeout(() => {
      setRequest({
        profile,
        calibration,
        massG,
        volumeMl,
        assumedError: { heaterGainErrorPercent, thermalLossErrorPercent },
      })
      setRecomputing(false)
    }, SIMULATION_DEBOUNCE_MS)
    return () => window.clearTimeout(pending.current)
  }, [calibration, heaterGainErrorPercent, massG, profile, thermalLossErrorPercent, volumeMl])

  const run = useMemo(() => simulateJourney(request), [request])
  const injected = hasAssumedError(request.assumedError)
  // The same journey with a perfect model, so an overrun caused by the error can be told apart from
  // one the profile was always going to have. Only computed when there is something to compare to.
  const perfect = useMemo(
    () => (injected ? simulateJourney({ ...request, assumedError: NO_ASSUMED_ERROR }) : run),
    [injected, request, run],
  )

  const samples = run.samples
  const rawGoal = useMemo(() => profileGoalAt(request.profile, profiles), [profiles, request.profile])
  const goal = useMemo(
    () => (rawGoal ? effectiveThermalIntent(rawGoal, 24.5, request.calibration.coolingTargetMarginC) : undefined),
    [rawGoal, request.calibration.coolingTargetMarginC],
  )
  // Read off the FIELDS rather than off the debounced request, so the note and the density it
  // replaces change over on the same keystroke; otherwise a value can appear while the note asking
  // for it is still on screen.
  const density = volumeMl !== undefined && volumeMl > 0 && massG > 0 ? massG / volumeMl : undefined
  const last = samples.at(-1)
  const isJourney = request.profile.strategy === 'thermal-intent'

  // Where the coefficients underneath this prediction came from, stated rather than assumed.
  const provenance = useMemo(
    () => calibrationProvenance(request.calibration, snapshots, defaultCalibration, deviceCoefficients),
    [deviceCoefficients, request.calibration, snapshots],
  )

  /*
   * The chart is handed the same three things the LIVE chart gets, and for the same reason.
   *
   * With both error fields at zero the run responds exactly, to within a few tenths of a degree of
   * the target the control is holding. What can still look like error is the TIME shift: zones advance by attainment, so a charge ramp
   * that needs an extra two minutes carries every later zone two minutes to the right of where the
   * profile drew it. Drawing the nominal goal ALONE turns that into a temperature gap the eye reads
   * as tracking error, which is the one thing a perfect-model run cannot have.
   *
   * So the plan stays where the profile drew it, the target the control actually held is drawn as its
   * own line, and the extra time is drawn as a labelled bar along the x-axis - the same overrun
   * rendering `LiveChart` uses on the live page. See `liveJourney.ts`.
   */
  const chartZones = useMemo(() => simulatedChartZones(run.zones), [run.zones])
  const heldTarget = useMemo(() => heldTargetPath(run.zones, run.completedSec), [run.completedSec, run.zones])

  const attained = run.zones.filter((zone) => zone.attained).length
  const infeasible = run.zones.filter((zone) => zone.infeasible)
  const worstOverrun = run.zones.reduce<SimulatedZone | undefined>(
    (worst, zone) => (worst === undefined || zone.overrunSec > worst.overrunSec ? zone : worst),
    undefined,
  )
  const extraSec = injected
    ? run.zones.reduce(
        (total, zone, index) => total + zone.simulatedDurationSec - (perfect.zones[index]?.simulatedDurationSec ?? 0),
        0,
      )
    : 0
  const peakCorrection = samples.reduce(
    (peak, sample) => Math.max(peak, Math.abs(sample.correction?.totalRatePerMin ?? 0)),
    0,
  )

  return (
    <section className="profile-simulation-panel">
      <div className="profile-simulation-heading">
        <div>
          <span className="eyebrow">Simulation snapshot</span>
          <h2>Predicted full process</h2>
        </div>
        <NumberField
          label="Starting mass (g)"
          value={massG}
          min={1}
          step={1}
          onCommit={(value) => setMassG(Math.max(1, value ?? 1))}
        />
        <NumberField
          label="Starting volume (ml)"
          value={volumeMl}
          min={1}
          step={1}
          placeholder="Optional"
          hint={density ? `${density.toFixed(3)} g/ml` : undefined}
          onCommit={(value) => setVolumeMl(value === undefined ? undefined : Math.max(1, value))}
        />
        <span className={recomputing ? 'simulation-state recomputing' : 'simulation-state'} role="status">
          <RefreshCw size={15} />
          {recomputing ? 'Recomputing' : 'Up to date'}
        </span>
      </div>
      {/*
      One quiet provenance caption, not two banners.
      ---------------------------------------------
      A provenance line plus a second line saying Fan and Heat are "derived per zone by inverting the
      thermal model" would say one thing twice - where these numbers come from - and "inverting" is
      engineering vocabulary that has no business in front of a roaster. It is one caption, in plain
      words, and the honesty grade colours it - a prediction
      against uncalibrated defaults looks exactly like one against a measured roaster, which is
      precisely why it has to say which it is.
    */}
      <div className={`model-provenance ${provenance.grade}`} role="status">
        {provenance.grade === 'manual' ? <TriangleAlert size={17} /> : <FlaskConical size={17} />}
        <div>
          <strong>{provenance.label}</strong>
          <span>
            {provenance.detail}{' '}
            {isJourney
              ? 'Fan and heat come from that calibration: for each zone, Crackle works out the settings that produce the climb the zone asks for, and a zone ends when the temperature reaches its endpoint rather than when a clock runs out.'
              : 'A timed profile runs its fan and heat exactly as written, so only the temperature here is modelled.'}
          </span>
        </div>
      </div>
      {/*
      The density note, which is a note rather than a permanent label.
      ---------------------------------------------------------------
      "Density not supplied" in the caption above, next to a sentence about the thermal model, would
      read as one statement - as if the whole banner were a result of the missing volume. It is one
      small thing, it says what to type and
      where, it appears only while the volume is actually blank, and the moment a volume is entered
      it disappears and the density it implies is shown under the field it came from.
    */}
      {volumeMl === undefined && (
        <div className="simulation-note">
          Starting volume is blank, so this batch is modelled on its weight alone. Fill in Starting volume (ml) above
          and the model will allow for how densely these beans pack.
        </div>
      )}
      {isJourney && (
        <div className="fit-panel">
          <div>
            <strong>Assumed model error</strong>
            <span>
              The simulated roaster normally behaves exactly as the calibration says it will. These two fields make it
              misbehave on purpose, by the percentages you give, while the control logic carries on believing the
              calibration - which is how you watch the control cope with being wrong. At zero, the default, it behaves
              exactly as predicted, so the run says only whether the PROFILE can be followed and makes no claim about
              accuracy at all. Bounded to +/-{MAX_ASSUMED_ERROR_PERCENT}%, the range the feedback layer's acceptance
              tests validate.
            </span>
          </div>
          <div className="form-row">
            <NumberField
              label="Real heater gain vs believed (%)"
              className="narrow"
              value={heaterGainErrorPercent}
              min={-MAX_ASSUMED_ERROR_PERCENT}
              max={MAX_ASSUMED_ERROR_PERCENT}
              step={5}
              hint="Negative means the roaster is weaker than the model thinks."
              onCommit={(value) => setHeaterGainErrorPercent(value ?? 0)}
            />
            <NumberField
              label="Real thermal loss vs believed (%)"
              className="narrow"
              value={thermalLossErrorPercent}
              min={-MAX_ASSUMED_ERROR_PERCENT}
              max={MAX_ASSUMED_ERROR_PERCENT}
              step={5}
              hint="Positive means the chamber leaks more heat than the model thinks."
              onCommit={(value) => setThermalLossErrorPercent(value ?? 0)}
            />
          </div>
        </div>
      )}
      {/*
      The goal is drawn as the profile authored it. `LiveChart` never re-anchors the goal to measured
      zone completions (which would drag the first zone's endpoint to the end of the chart and stack
      the rest beyond it), so there is no prop for this panel to get wrong.
    */}
      <LiveChart
        samples={samples}
        profile={request.profile.strategy === 'timed' ? (request.profile as TimedProfile) : undefined}
        targetIntent={goal}
        events={[]}
        elapsedSec={last?.elapsedSec ?? 0}
        temperatureLabel="Predicted"
        journeyZones={isJourney ? chartZones : undefined}
        zoneTargetSegment={isJourney && heldTarget.length > 1 ? heldTarget : undefined}
        zoneTargetLabel="Target each zone held"
      />
      {isJourney && (
        <div className="model-scope-note">
          {injected
            ? `With an assumed error the control logic is still working from the unshifted calibration, so these durations and corrections are how it COPES with being wrong - not a prediction of your next roast.`
            : `No assumed error, so the simulated roaster behaves exactly as the calibration says it will and there is nothing here for it to get wrong. A zone that runs longer than its nominal duration means the PROFILE asks for more than the roaster can deliver, which is infeasibility rather than model error - the goal line stays where the profile drew it and the extra time is drawn as a bar along it. Set an assumed error above to ask what happens when the calibration is wrong.`}
        </div>
      )}
      {isJourney && run.zones.length > 0 && (
        <div className="calibration-table-wrap simulation-zones">
          <table className="diff-table simulation-zone-table">
            <thead>
              <tr>
                <th>Zone</th>
                <th>Planned</th>
                <th>Simulated</th>
                <th>Difference</th>
                <th>Reading</th>
              </tr>
            </thead>
            <tbody>
              {run.zones.map((zone) => (
                <tr key={zone.zoneId}>
                  <td data-label="Zone">
                    <strong>Zone {zone.zoneIndex + 1}</strong>
                    <small>
                      {zone.startC} to {zone.endC} °C
                    </small>
                  </td>
                  <td data-label="Planned">{formatClock(zone.nominalDurationSec)}</td>
                  <td data-label="Simulated">
                    {zone.attained ? formatClock(zone.simulatedDurationSec) : 'Not reached'}
                  </td>
                  <td data-label="Difference">{zone.attained ? signedClock(Math.round(zone.overrunSec)) : '--'}</td>
                  <td data-label="Reading">
                    {zoneVerdict(zone)}
                    {injected && perfect.zones[zone.zoneIndex]?.attained && zone.attained ? (
                      <small>
                        With no assumed error this zone takes{' '}
                        {formatClock(perfect.zones[zone.zoneIndex].simulatedDurationSec)}.
                      </small>
                    ) : undefined}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="simulation-summary">
        {isJourney ? (
          <>
            <span>
              Zones attained<strong>{`${attained} / ${run.zones.length}`}</strong>
            </span>
            {injected ? (
              <>
                <span>
                  Model bias read back
                  <strong>{`${run.residual.bias.meanIntegralRatePerMin >= 0 ? '+' : ''}${run.residual.bias.meanIntegralRatePerMin.toFixed(2)} °C/min`}</strong>
                </span>
                <span>
                  Extra time vs perfect model<strong>{signedClock(Math.round(extraSec))}</strong>
                </span>
                <span>
                  Peak correction applied<strong>{`${peakCorrection.toFixed(1)} °C/min`}</strong>
                </span>
                <span>
                  Unreachable zones<strong>{infeasible.length === 0 ? 'None' : `${infeasible.length}`}</strong>
                </span>
                <span>
                  Bias measured over
                  <strong>
                    {run.residual.biasZoneIndexes.length === 0
                      ? 'No controlled zones'
                      : `Zone ${run.residual.biasZoneIndexes.map((index) => index + 1).join(', ')}`}
                  </strong>
                </span>
              </>
            ) : (
              <>
                <span>
                  Longest overrun
                  <strong>
                    {worstOverrun === undefined || worstOverrun.overrunSec <= 0
                      ? 'None'
                      : `Zone ${worstOverrun.zoneIndex + 1}, ${signedClock(Math.round(worstOverrun.overrunSec))}`}
                  </strong>
                </span>
                <span>
                  Unreachable zones
                  <strong>
                    {infeasible.length === 0
                      ? 'None'
                      : `Zone ${infeasible.map((zone) => zone.zoneIndex + 1).join(', ')}`}
                  </strong>
                </span>
              </>
            )}
          </>
        ) : (
          <>
            <span>
              Command duration<strong>{formatClock(last?.elapsedSec ?? 0)}</strong>
            </span>
            <span>
              Modelled finish<strong>{last ? `${last.beanTempC.toFixed(1)} °C` : '--'}</strong>
            </span>
            <span>
              Steps<strong>{samples.length}</strong>
            </span>
          </>
        )}
      </div>
    </section>
  )
}
