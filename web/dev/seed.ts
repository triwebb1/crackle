/**
 * A first-run controller with a history, produced by actually running the programs.
 *
 * A brand new mock with an empty archive is a poor development target: History, the recording
 * importer, the calibration analysis and the roast comparison views all need something to show, and
 * hand-written fixtures for those would be fixtures of what the mock is SUPPOSED to produce rather
 * than of what it does produce.
 *
 * So the seeder drives the real device, synchronously, on its simulated clock: two baseline
 * calibration passes and two completed journey roasts, all of them dated a few days back. It takes
 * well under a second of wall time, and because it uses the same start paths a browser uses, a
 * seeding run that fails is a real bug being reported at startup rather than a fixture drifting.
 *
 * The two roasts are journeys, so they archive as v2 entries carrying `name`, `batch_mass_g` and
 * per-zone `zone_attained_sec`. The calibration passes archive as v1. A mixed archive is the normal
 * case after a firmware update, and it is the case the listing code has to get right.
 */

import { defaultCalibration } from '../src/data/calibration'
import { starterThermalIntent } from '../src/data/demo'
import { type DemoDataset, richDemoDataset } from '../src/data/demoDataset'
import {
  serializeBeansDocument,
  serializeCalibrationsDocument,
  serializeMetaDocument,
  serializeProfilesDocument,
  serializeRunDocument,
} from '../src/data/documentSerializer'
import { serializeJourneyZones } from '../src/domain/roastProgram'
import { ARCHIVE_TOTAL_BYTES, CONFIRM } from './config'
import type { DocumentStore } from './dataStore'
import type { MockDevice } from './device'

const DAY_MS = 86400000

/** Run one program to completion, then let the archive settle so the log reaches "flash". */
const runToRest = (device: MockDevice) => {
  device.runUntil(() => !device.actuator.busy && !device.archive.active && !device.archive.unsaved, 10800)
  // Past the settle-time list-busy window too: a freshly seeded device answers its first listing.
  device.runUntil(() => !device.archiveListBusy(), 60)
}

const calibrationPass = (device: MockDevice, fans: string, heats: string) => {
  device.runUntil(() => device.calibrationReadiness().ready, 3600)
  if (!device.calibrationReadiness().ready) throw new Error('mock seed: probe never became calibration-ready')
  const args = new URLSearchParams({
    confirm: CONFIRM.calibration,
    fans,
    heats,
    step_seconds: '180',
    min_step_seconds: '20',
    settle_seconds: '15',
    settle_band_tenths_c: '15',
    // The seeder drives the clock itself, so the program's own fast-forward must not apply.
    speed: '1',
  })
  const outcome = device.startCalibration(args)
  if (outcome.status !== 200) throw new Error(`mock seed: calibration refused (${outcome.status})`)
  runToRest(device)
}

const journeyRoast = (device: MockDevice, name: string, massG: number) => {
  const args = new URLSearchParams({
    confirm: CONFIRM.roast,
    mode: 'journey',
    name,
    mass: String(massG),
    zones: serializeJourneyZones(starterThermalIntent.segments),
    start: String(Math.round(device.plant.probeC * 10) / 10),
  })
  const outcome = device.startRoast(args)
  if (outcome.status !== 202)
    throw new Error(`mock seed: roast refused (${outcome.status}) ${JSON.stringify(outcome.body)}`)
  runToRest(device)
}

export const seedArchive = (device: MockDevice) => {
  // Everything seeded happened days ago; wall time is restored at the end.
  device.setEpochBase(Date.now() - 6 * DAY_MS)

  /*
   * Heats declared hottest-first. `expandBaselineGrid` reverses the heat order in every other fan
   * group, so with an EVEN number of fan levels the serpentine ends where it began: declare 1,5,10
   * and the pass finishes on its coldest step with the chamber near ambient, leaving little useful
   * passive decay. Declared hot-first it ends hot, and the tail is worth recording. The 3,6,9 pass
   * below has an odd number
   * of fan groups and ends hot either way.
   */
  calibrationPass(device, '1,4,7,10', '10,5,1')
  device.setEpochBase(Date.now() - 5 * DAY_MS)
  journeyRoast(device, 'Ethiopian light roast', 225)

  device.setEpochBase(Date.now() - 3 * DAY_MS)
  calibrationPass(device, '3,6,9', '2,6,9')
  device.setEpochBase(Date.now() - 2 * DAY_MS)
  journeyRoast(device, 'Colombian espresso', 250)

  // Back to the present, with the simulated clock continuing from where the seeding left it.
  device.setEpochBase(Date.now())
}

/**
 * ============================================================================================
 * A FIRST-RUN ROASTER WITH A LIBRARY, NOT ONLY WITH RECORDINGS
 * ============================================================================================
 *
 * `seedArchive` above gives the mock a recording history. It cannot give it a LIBRARY: profiles,
 * bean lots, months of roast records and the calibrations fitted from them are things the user
 * authors in the browser, not things a roaster produces by running programs.
 *
 * Without a seed, deleting the state file - the documented way to ask for a fresh mock - would leave
 * an empty app: no profiles to roast, no history to compare against, no calibration to preview
 * with, and a dataset to rebuild by hand.
 *
 * So a fresh store is seeded from `richDemoDataset()`, written through the REAL serializers at
 * `base=0` exactly as the app would write them. That is what makes this a fixture of the product
 * rather than of itself: if a document format changes, this seeding changes with it or fails loudly,
 * and the bytes the mock hands back are bytes the app's own parsers produced.
 *
 * Pure in the sense that matters: it takes a store and a dataset and writes documents. No clock, no
 * device, no filesystem - which is what lets the test drive it directly.
 */
export const seedDocuments = (store: DocumentStore, dataset: DemoDataset = richDemoDataset(), otherUsedBytes = 0) => {
  const room = { idle: true, otherUsedBytes, volumeTotalBytes: ARCHIVE_TOTAL_BYTES }
  const put = (target: string, payload: string) => {
    const verdict = store.write(target, payload, '0', room)
    if (verdict.status !== 200) throw new Error(`mock seed: ${target} refused (${verdict.status})`)
  }
  put('profiles', serializeProfilesDocument(dataset.profiles, dataset.profileRevisions))
  put('beans', serializeBeansDocument(dataset.beans, dataset.beanRevisions))
  put(
    'calibrations',
    serializeCalibrationsDocument(
      { ...defaultCalibration, ...dataset.appliedCalibration },
      dataset.calibrationSnapshots,
      dataset.calibrationRuns,
    ),
  )
  // No recordings are claimed as imported: the roaster's own archive is reconciled by the app, and
  // pre-marking them would hide the import path the mock exists to exercise.
  put('meta', serializeMetaDocument([], dataset.manualEvents))
  for (const run of dataset.runs) put(`runs/${run.id}`, serializeRunDocument(run))
}
