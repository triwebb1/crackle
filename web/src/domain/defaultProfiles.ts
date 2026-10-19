import type { Profile, ProfileRevision, ThermalIntent, TimedProfile } from './types'

/**
 * The profiles a new roaster starts with: one temperature journey (the primary default, listed and
 * selected first) and one timed profile. They are installed once, into a roaster library that has
 * never held a profiles document; after that they are ordinary profiles the operator may edit or
 * delete. Fixed ids make the install idempotent when two browsers attach at the same moment.
 */
export const DEFAULT_JOURNEY_PROFILE_ID = 'profile-default-espresso-express'
export const DEFAULT_TIMED_PROFILE_ID = 'profile-default-espresso-express-timed'

/**
 * A fast, dark espresso journey. The zone durations are deliberately short so the controller drives
 * hard toward each endpoint; the measured roast runs longer than the nominal 8:00 because every zone
 * completes on attained temperature, not on time. Zone 1 holds Fan 10 / Heat 10 for the charge, and
 * each later zone's Fan minimum is the circulation setting to raise for a bed that does not move.
 */
export const defaultJourneyProfile = (now: string): ThermalIntent => ({
  id: DEFAULT_JOURNEY_PROFILE_ID,
  name: 'Espresso Express',
  revision: 1,
  strategy: 'thermal-intent',
  createdAt: now,
  updatedAt: now,
  metadata: { intent: 'Dark espresso, fast' },
  notes:
    'Fast, dark espresso journey to 233 °C. Zone times are intentionally short so the roaster pushes hard; ' +
    'expect the real roast to run longer than planned, because each zone ends when its temperature is reached. ' +
    "Developed on 200-225 g batches; raise a zone's Fan minimum if the beans stop circulating.",
  calibrationStatus: 'unavailable',
  segments: [
    { id: 'express-charge', startC: 25, endC: 150, durationSec: 120, fanMin: 10, fanMax: 10, heatMin: 10, heatMax: 10 },
    { id: 'express-drive', startC: 150, endC: 180, durationSec: 60, fanMin: 5, fanMax: 10, heatMin: 5, heatMax: 10 },
    { id: 'express-develop', startC: 180, endC: 215, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'express-finish', startC: 215, endC: 233, durationSec: 60, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'express-cool', startC: 233, endC: 50, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 0 },
  ],
})

/**
 * The timed companion: a lighter espresso roast on the clock, for the common 150-200 g batch. It is
 * timed against a measured 168 g roast on this machine rather than the journey's rushed nominal
 * schedule (Fan 10 / Heat 10 levels off near 173 °C; Fan 5 / Heat 10 climbs about 14 °C/min through
 * 170-200 °C; Fan 2 / Heat 8 develops at about 5 °C/min above 200 °C): drying at full heat, browning
 * from about 3:00, first crack near 7:00-7:30, roughly two minutes of development, and Heat off at
 * 9:30. Fan never drops below 5, so a full small batch keeps moving.
 */
export const defaultTimedProfile = (now: string): TimedProfile => ({
  id: DEFAULT_TIMED_PROFILE_ID,
  name: 'Espresso Express (timed)',
  revision: 1,
  strategy: 'timed',
  createdAt: now,
  updatedAt: now,
  metadata: { intent: 'Lighter espresso, on the clock' },
  notes:
    'Lighter espresso on a fixed schedule for 150-200 g batches: first crack near 7:00-7:30 and Heat off at 9:30. ' +
    'A timed profile runs open loop, so watch the first roast and adjust the steps for your beans and room.',
  points: [
    { id: 'express-timed-dry', timeSec: 0, fan: 9, heat: 10 },
    { id: 'express-timed-brown', timeSec: 180, fan: 7, heat: 10 },
    { id: 'express-timed-approach', timeSec: 390, fan: 6, heat: 9 },
    { id: 'express-timed-develop', timeSec: 450, fan: 5, heat: 8 },
    { id: 'express-timed-cool', timeSec: 570, fan: 10, heat: 0 },
  ],
  coolFan: 10,
  coolDurationSec: 120,
})

/** Both defaults, journey first: the order the library lists them and the Roast page selects them. */
export const defaultProfiles = (now: string): Profile[] => [defaultJourneyProfile(now), defaultTimedProfile(now)]

/** The "Created" history row each default carries, like a profile the operator saved. */
export const defaultProfileRevisions = (profiles: Profile[], savedAt: string): ProfileRevision[] =>
  profiles.map((profile) => ({
    id: `${profile.id}-created`,
    profileId: profile.id,
    revision: profile.revision,
    savedAt,
    summary: 'Created',
    profile: structuredClone(profile),
  }))
