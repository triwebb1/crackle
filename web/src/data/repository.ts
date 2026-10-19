import { requireRecordedOn, requireRecordingOrigin, requireStorageAddress } from '../domain/provenance'
import type {
  BeanLot,
  BeanRevision,
  CalibrationCurve,
  CalibrationForm,
  CalibrationRun,
  CalibrationSettings,
  CalibrationSnapshot,
  CalibrationStep,
  ManualEvent,
  Profile,
  ProfileRevision,
  RoastRun,
  ThermalSample,
} from '../domain/types'
import { defaultCalibration } from './calibration'
import { demoBeans, demoProfiles, demoRuns, starterBean } from './demo'
import { storedCalibrationSettings } from './documentSerializer'

export const configuredTargetKey = (): string => {
  try {
    const configured = new URLSearchParams(globalThis.location?.search ?? '').get('roaster')?.trim()
    return configured || 'same-origin'
  } catch {
    return 'same-origin'
  }
}

export const CACHE_NAMESPACE = configuredTargetKey()
export const DATABASE = `crackle-v4:${encodeURIComponent(CACHE_NAMESPACE)}`
// Version 7 adds the two catalog edit-history stores; every earlier store is created only when
// missing, so an upgrade from any prior version leaves existing data untouched.
const VERSION = 7
const PROFILE_STORE = 'profiles'
const RUN_STORE = 'runs'
const BEAN_STORE = 'beans'
const META_STORE = 'meta'
const CALIBRATION_RUN_STORE = 'calibrationRuns'
const CALIBRATION_SNAPSHOT_STORE = 'calibrationSnapshots'
const MANUAL_EVENT_STORE = 'manualEvents'
const PROFILE_REVISION_STORE = 'profileRevisions'
const BEAN_REVISION_STORE = 'beanRevisions'
// Manual history is an operating log, not an archive: the newest 200 rows are kept and the rest
// are dropped as each one is written, so the store cannot grow without bound behind the user.
export const MANUAL_EVENT_CAP = 200
// Edit history is capped per subject rather than globally, so a heavily edited profile can never
// push another profile's history out of the store.
export const REVISION_CAP = 40
const SEEDED_META_KEY = 'seeded'
/**
 * The ledger of controller recordings this archive has already taken.
 *
 * It lives in `meta` rather than being derived from the runs, and that distinction is the whole
 * point: a run derived from a controller recording can be DELETED, and deriving the ledger from the
 * runs would resurrect it on the next visit. The ledger says "this browser has considered recording N",
 * which stays true after the roast is thrown away. Deterministic run ids handle the other half - see
 * `domain/deviceRoastImport.ts`.
 */
const IMPORTED_DEVICE_LOGS_KEY = 'importedDeviceLogs'
const CALIBRATION_KEY = `crackle:calibration:v4:${encodeURIComponent(CACHE_NAMESPACE)}`
const LEGACY_SEEDED_KEY = `crackle:seeded:v4:${encodeURIComponent(CACHE_NAMESPACE)}`
const OBSERVED_DEVICE_META_KEY = 'observedDeviceId'

/**
 * The rich development dataset is dev-server only.
 *
 * `vite build` sets `DEV` false, so the bundle the firmware serves can never reach it, and Vitest
 * reports `MODE` as `test`, so the suite seeds exactly what it seeded before. Taking the environment
 * as an argument is what lets a test assert both halves of that without building anything.
 */
export const richSeedEnabled = (env: Partial<ImportMetaEnv> = import.meta.env): boolean =>
  env?.DEV === true && env?.MODE === 'development'

let databasePromise: Promise<IDBDatabase> | undefined

const localValue = (key: string) => {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

const openDatabase = () => {
  if (databasePromise) return databasePromise
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PROFILE_STORE))
        database.createObjectStore(PROFILE_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(RUN_STORE)) database.createObjectStore(RUN_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(BEAN_STORE)) database.createObjectStore(BEAN_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'key' })
      if (!database.objectStoreNames.contains(CALIBRATION_RUN_STORE))
        database.createObjectStore(CALIBRATION_RUN_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(CALIBRATION_SNAPSHOT_STORE))
        database.createObjectStore(CALIBRATION_SNAPSHOT_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(MANUAL_EVENT_STORE))
        database.createObjectStore(MANUAL_EVENT_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(PROFILE_REVISION_STORE))
        database.createObjectStore(PROFILE_REVISION_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(BEAN_REVISION_STORE))
        database.createObjectStore(BEAN_REVISION_STORE, { keyPath: 'id' })
    }
    request.onblocked = () => {
      databasePromise = undefined
      reject(new Error('Another Crackle tab is holding local storage open. Close it and reload.'))
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = undefined
      }
      resolve(database)
    }
    request.onerror = () => {
      databasePromise = undefined
      reject(request.error ?? new Error('Local storage could not be opened'))
    }
  })
  return databasePromise
}

const readAll = async <T>(storeName: string) => {
  const database = await openDatabase()
  return new Promise<T[]>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).getAll()
    transaction.oncomplete = () => resolve(request.result as T[])
    transaction.onerror = () => reject(transaction.error ?? new Error(`Reading ${storeName} failed`))
    transaction.onabort = () => reject(transaction.error ?? new Error(`Reading ${storeName} was aborted`))
  })
}

const readOne = async <T>(storeName: string, key: string) => {
  const database = await openDatabase()
  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).get(key)
    transaction.oncomplete = () => resolve(request.result as T | undefined)
    transaction.onerror = () => reject(transaction.error ?? new Error(`Reading ${storeName} failed`))
    transaction.onabort = () => reject(transaction.error ?? new Error(`Reading ${storeName} was aborted`))
  })
}

const write = async (storeName: string, apply: (store: IDBObjectStore) => void) => {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error(`Writing ${storeName} failed`))
    transaction.onabort = () => reject(transaction.error ?? new Error(`Writing ${storeName} was aborted`))
    try {
      apply(transaction.objectStore(storeName))
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        /* already settling */
      }
      reject(error instanceof Error ? error : new Error(`Writing ${storeName} failed`))
    }
  })
}

const put = <T>(storeName: string, value: T) =>
  write(storeName, (store) => {
    store.put(value)
  })
const remove = (storeName: string, key: string) =>
  write(storeName, (store) => {
    store.delete(key)
  })
const clear = (storeName: string) =>
  write(storeName, (store) => {
    store.clear()
  })

const DEVICE_LIBRARY_STORES = [
  PROFILE_STORE,
  RUN_STORE,
  BEAN_STORE,
  CALIBRATION_RUN_STORE,
  CALIBRATION_SNAPSHOT_STORE,
  MANUAL_EVENT_STORE,
  PROFILE_REVISION_STORE,
  BEAN_REVISION_STORE,
] as const

/** Replace the device-backed mirror in one IndexedDB transaction, retaining browser-only metadata. */
const clearDeviceLibraryStores = async (libraryMetaKeys: string[]) => {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([...DEVICE_LIBRARY_STORES, META_STORE], 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Clearing the restored library cache failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Clearing the restored library cache was aborted'))
    try {
      for (const storeName of DEVICE_LIBRARY_STORES) transaction.objectStore(storeName).clear()
      const meta = transaction.objectStore(META_STORE)
      for (const key of new Set([IMPORTED_DEVICE_LOGS_KEY, ...libraryMetaKeys])) meta.delete(key)
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        /* already settling */
      }
      reject(error instanceof Error ? error : new Error('Clearing the restored library cache failed'))
    }
  })
}

// Write and trim in one transaction: the follow-up requests are issued from inside a success
// callback of the same transaction, so it stays open and the cap can never be applied to a store
// some other write has already changed underneath it.
const putCapped = (storeName: string, value: ManualEvent, cap: number) =>
  write(storeName, (store) => {
    store.put(value)
    const all = store.getAll()
    all.onsuccess = () => {
      const stored = (all.result as ManualEvent[]).sort((a, b) => b.atMs - a.atMs)
      for (const stale of stored.slice(cap)) store.delete(stale.id)
    }
  })

// Same one-transaction discipline as the manual-event cap, applied per subject: the trim reads and
// deletes from inside a success callback of the write that added the row, so the cap can never be
// applied against a store some other write has already changed underneath it.
const putCappedBySubject = <T extends { id: string; savedAt: string }>(
  storeName: string,
  value: T,
  subjectOf: (row: T) => string,
  cap: number,
) =>
  write(storeName, (store) => {
    store.put(value)
    const all = store.getAll()
    all.onsuccess = () => {
      const subject = subjectOf(value)
      const mine = (all.result as T[])
        .filter((row) => subjectOf(row) === subject)
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      for (const stale of mine.slice(cap)) store.delete(stale.id)
    }
  })

const removeWhere = <T extends { id: string }>(storeName: string, matches: (row: T) => boolean) =>
  write(storeName, (store) => {
    const all = store.getAll()
    all.onsuccess = () => {
      for (const row of (all.result as T[]).filter(matches)) store.delete(row.id)
    }
  })

const strings = (value: unknown, legacy?: unknown) => {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof legacy === 'string' && legacy.trim()) return [legacy.trim()]
  return []
}

const finiteNumber = (value: unknown, fallback: number) => {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback
}

const sameRecord = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const beanId = (value: string) =>
  `bean-${
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'imported'
  }`

type LegacyProfile = Profile & {
  metadata: Profile['metadata'] & {
    bean?: string
    beans?: string[]
    origin?: string
    origins?: string[]
    lotId?: string
    species?: string[]
    cultivars?: string[]
    process?: string
    moisturePercent?: number
  }
}

const legacyBeanFromProfile = (value: LegacyProfile): BeanLot | undefined => {
  const metadata = value.metadata
  const names = strings(metadata.beans, metadata.bean)
  const origins = strings(metadata.origins, metadata.origin)
  if (names.length === 0 && origins.length === 0 && !metadata.lotId) return undefined
  const name = names[0] ?? metadata.lotId ?? origins.join(' ') ?? 'Imported bean'
  const now = value.updatedAt || new Date().toISOString()
  return {
    id: metadata.lotId === starterBean.lotId ? starterBean.id : beanId(metadata.lotId ?? name),
    name,
    origins,
    lotId: metadata.lotId,
    species: strings(metadata.species)[0],
    cultivars: strings(metadata.cultivars),
    process: metadata.process,
    moisturePercent: metadata.moisturePercent,
    notes: 'Imported from legacy profile metadata.',
    createdAt: value.createdAt || now,
    updatedAt: now,
  }
}

const uniqueSegments = (profile: Profile) => {
  if (profile.strategy !== 'thermal-intent') return profile
  const seen = new Set<string>()
  const segments = profile.segments.filter((segment) => {
    if (seen.has(segment.id)) return false
    seen.add(segment.id)
    return true
  })
  return segments.length === profile.segments.length ? profile : { ...profile, segments }
}

/**
 * 0.7.0 retires two profile fields, and normalization is where they leave.
 *
 * `massG` moved to the roast setup - a recipe has no batch size, a roast does - and `beanLotIds`
 * was a hand-maintained duplicate of what the roast archive already knows. Both are dropped rather
 * than migrated, so an archive exported by any earlier version loads cleanly and simply stops
 * carrying them. Every other metadata key still survives untouched.
 *
 * Dropping rather than defaulting is what keeps it idempotent: a second pass has nothing left to
 * remove, so `initialize` rewrites each record exactly once.
 */
export const RETIRED_PROFILE_METADATA = ['massG', 'beanLotIds'] as const

export const normalizeProfile = (value: Profile): Profile => {
  const base = uniqueSegments(value)
  const metadata = { ...value.metadata } as Record<string, unknown>
  for (const retired of RETIRED_PROFILE_METADATA) delete metadata[retired]
  return {
    ...base,
    notes: value.notes ?? '',
    metadata: { ...metadata, intent: value.metadata.intent ?? '' } as Profile['metadata'],
  }
}

const optionalNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const normalizeSample = (sample: ThermalSample): ThermalSample => ({
  tMs: finiteNumber(sample?.tMs, 0),
  thermocoupleC: optionalNumber(sample?.thermocoupleC),
  coldJunctionC: optionalNumber(sample?.coldJunctionC),
  effectiveFan: finiteNumber(sample?.effectiveFan, 0),
  effectiveHeat: finiteNumber(sample?.effectiveHeat, 0),
})

// Runs captured against firmware 2026-07-26.30 stored one fan level plus a heat list and a fixed step
// length. Firmware 2026-07-26.31 and later record every step as a fan:heat pair with an adaptive cap,
// so those records migrate into
// pair form on read. Dropping the legacy keys is what makes the normalization idempotent.
type LegacyCalibrationRun = CalibrationRun & {
  fanLevel?: number
  heatSteps?: number[]
  stepSeconds?: number
}

const legacyPairs = (run: LegacyCalibrationRun): CalibrationStep[] => {
  const fan = finiteNumber(run.fanLevel, 0)
  return Array.isArray(run.heatSteps)
    ? run.heatSteps
        .filter((heat): heat is number => typeof heat === 'number' && Number.isFinite(heat))
        .map((heat) => ({ fan, heat }))
    : []
}

export const normalizeCalibrationRun = (value: CalibrationRun): CalibrationRun => {
  const { fanLevel, heatSteps, stepSeconds, ...rest } = value as LegacyCalibrationRun
  void fanLevel
  void heatSteps
  const declared = Array.isArray(value.steps)
    ? value.steps
        .filter(
          (step): step is CalibrationStep =>
            typeof step?.fan === 'number' &&
            Number.isFinite(step.fan) &&
            typeof step.heat === 'number' &&
            Number.isFinite(step.heat),
        )
        .map((step) => ({ fan: step.fan, heat: step.heat }))
    : []
  return {
    ...rest,
    recordedOn: requireRecordedOn(value.recordedOn),
    capturedAt: value.capturedAt || new Date(0).toISOString(),
    form: value.form === 'grid' ? ('grid' as CalibrationForm) : ('steps' as CalibrationForm),
    steps: declared.length > 0 ? declared : legacyPairs(value as LegacyCalibrationRun),
    // Only passes captured while the firmware still had a program ceiling carry these two. A new
    // pass leaves both absent, which is what stops the analysis marking anything ceiling-limited.
    advanceMarginC: optionalNumber(value.advanceMarginC),
    maxStepSeconds: finiteNumber(value.maxStepSeconds, finiteNumber(stepSeconds, 120)),
    minStepSeconds: finiteNumber(value.minStepSeconds, 20),
    settleSeconds: finiteNumber(value.settleSeconds, 5),
    settleBandC: finiteNumber(value.settleBandC, 2),
    ceilingC: optionalNumber(value.ceilingC),
    ambientC: optionalNumber(value.ambientC),
    roastRunId: typeof value.roastRunId === 'string' && value.roastRunId ? value.roastRunId : undefined,
    samples: Array.isArray(value.samples) ? value.samples.map(normalizeSample) : [],
    notes: value.notes ?? '',
    // Baseline runs are empty-chamber: mass and density stay absent unless the user records them.
    massG: optionalNumber(value.massG),
    densityGPerMl: optionalNumber(value.densityGPerMl),
  }
}

const CURVE_QUALITIES = ['measured', 'extrapolated', 'unreliable'] as const

const normalizeCurve = (curve: CalibrationCurve): CalibrationCurve => ({
  fanLevel: finiteNumber(curve?.fanLevel, 0),
  points: Array.isArray(curve?.points)
    ? curve.points
        .filter((point) => Number.isFinite(point?.heat) && Number.isFinite(point?.steadyStateC))
        .map((point) => ({
          heat: finiteNumber(point.heat, 0),
          steadyStateC: finiteNumber(point.steadyStateC, 0),
          riseOverAmbientC: optionalNumber(point.riseOverAmbientC),
          tauSec: optionalNumber(point.tauSec),
          // Snapshots saved before 0.5.0 carry only the boolean, which maps onto the first two qualities.
          quality:
            CURVE_QUALITIES.find((candidate) => candidate === point.quality) ??
            (point.extrapolated === true ? 'extrapolated' : 'measured'),
          floored: point.floored === true,
          extrapolated: point.extrapolated === true,
          r2: optionalNumber(point.r2),
        }))
    : [],
})

const THERMAL_FIELDS = [
  'heaterGainCPerMinAt10',
  'fanCoolingCPerMinAt10',
  'coolingFanCPerMinAt10',
  'thermalLossPerMinPerC',
] as const

export const normalizeCalibrationSnapshot = (snapshot: CalibrationSnapshot): CalibrationSnapshot => ({
  ...snapshot,
  recordedOn: requireRecordedOn(snapshot.recordedOn),
  name: snapshot.name?.trim() || 'Unnamed calibration',
  createdAt: snapshot.createdAt || new Date(0).toISOString(),
  runIds: Array.isArray(snapshot.runIds)
    ? snapshot.runIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [],
  ambientC: optionalNumber(snapshot.ambientC),
  // Only known coefficient fields survive: a snapshot must never smuggle an unknown key into the
  // locked calibration record when it is restored.
  patch: Object.fromEntries(
    THERMAL_FIELDS.flatMap((field) => {
      const value = optionalNumber(snapshot.patch?.[field])
      return value === undefined ? [] : [[field, value]]
    }),
  ),
  curves: Array.isArray(snapshot.curves) ? snapshot.curves.map(normalizeCurve) : [],
  // Fitted calibrations carry what they were fitted from. A snapshot saved before 0.7.0 has
  // neither, which is exactly what "not a fitted calibration" looks like.
  inputs: Array.isArray(snapshot.inputs) ? snapshot.inputs : undefined,
  fingerprint: snapshot.fingerprint?.measurementHash ? snapshot.fingerprint : undefined,
  fitRmsC: optionalNumber(snapshot.fitRmsC),
})

const MANUAL_EVENT_KINDS = ['apply', 'stop'] as const

export const normalizeManualEvent = (event: ManualEvent): ManualEvent => ({
  ...event,
  atMs: finiteNumber(event?.atMs, 0),
  kind: MANUAL_EVENT_KINDS.find((candidate) => candidate === event?.kind) ?? 'stop',
  fan: finiteNumber(event?.fan, 0),
  heat: finiteNumber(event?.heat, 0),
  // A faulted thermocouple stays undefined here exactly as it does everywhere else, never 0 °C.
  temperatureC: optionalNumber(event?.temperatureC),
  source: event?.source === 'firmware' ? 'firmware' : 'local',
  detail: typeof event?.detail === 'string' && event.detail.trim() ? event.detail : undefined,
  recordedOn: requireRecordedOn(event.recordedOn),
})

const text = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim().length > 0 ? value : fallback

// Revision rows carry a full record, so the record is normalized by the same pure function the live
// catalog uses. A history row can therefore never be a shape the rest of the app cannot read.
export const normalizeProfileRevision = (revision: ProfileRevision): ProfileRevision => ({
  ...revision,
  profileId: text(revision?.profileId, revision?.profile?.id ?? 'unknown'),
  revision: finiteNumber(revision?.revision, 1),
  savedAt: text(revision?.savedAt, new Date(0).toISOString()),
  summary: text(revision?.summary, 'Saved'),
  profile: normalizeProfile(revision.profile),
})

export const normalizeBeanRevision = (revision: BeanRevision): BeanRevision => ({
  ...revision,
  beanId: text(revision?.beanId, revision?.bean?.id ?? 'unknown'),
  savedAt: text(revision?.savedAt, new Date(0).toISOString()),
  summary: text(revision?.summary, 'Saved'),
  bean: revision.bean,
})

export const normalizeRun = (run: RoastRun): RoastRun => {
  // Read the retired link before normalization drops it: a pre-0.7.0 run that never recorded its
  // own bean lot can still recover one from the profile it was run with, once.
  const legacyBeanLotId = strings((run.profile?.metadata as { beanLotIds?: unknown } | undefined)?.beanLotIds)[0]
  const profile = normalizeProfile(run.profile)
  return {
    ...run,
    recordedOn: requireRecordedOn(run.recordedOn),
    deviceRoast: run.deviceRoast
      ? {
          ...run.deviceRoast,
          recordingOrigin: requireRecordingOrigin(run.deviceRoast.recordingOrigin),
          storageAddress: requireStorageAddress(run.deviceRoast.storageAddress),
        }
      : undefined,
    profile,
    beanLotId: run.beanLotId ?? legacyBeanLotId,
    beanLotSnapshot: run.beanLotSnapshot ? structuredClone(run.beanLotSnapshot) : undefined,
    notes: run.notes ?? '',
  }
}

export class CrackleRepository {
  private writeTail: Promise<unknown> = Promise.resolve()
  private writes = 0

  get writeCount() {
    return this.writes
  }
  /** Bind this configured-target namespace to one observed hardware identity, once. */
  async bindObservedDevice(deviceId: string): Promise<void> {
    const normalized = deviceId.trim()
    if (!normalized) throw new Error('The roaster did not report a stable device identity')
    const existing = await this.meta<string>(OBSERVED_DEVICE_META_KEY)
    if (existing && existing !== normalized) {
      throw new Error(
        `Configured target "${CACHE_NAMESPACE}" is bound to ${existing}, but the endpoint reported ${normalized}. Its cache was not opened.`,
      )
    }
    if (!existing) await this.saveMeta(OBSERVED_DEVICE_META_KEY, normalized)
  }

  async observedDeviceBinding(): Promise<string | undefined> {
    return this.meta<string>(OBSERVED_DEVICE_META_KEY)
  }

  private enqueue<T>(operation: () => Promise<T>) {
    this.writes += 1
    const result = this.writeTail.then(() => operation())
    this.writeTail = result.catch(() => undefined)
    return result
  }

  async initialize() {
    const warnings: string[] = []
    void globalThis.navigator?.storage?.persist?.().catch(() => undefined)
    const [rawProfiles, rawRuns, beans, rawCalibrationRuns, rawSnapshots, marker] = await Promise.all([
      readAll<LegacyProfile>(PROFILE_STORE),
      readAll<RoastRun>(RUN_STORE),
      readAll<BeanLot>(BEAN_STORE),
      readAll<CalibrationRun>(CALIBRATION_RUN_STORE),
      readAll<CalibrationSnapshot>(CALIBRATION_SNAPSHOT_STORE),
      readOne<{ key: string; value: boolean }>(META_STORE, SEEDED_META_KEY),
    ])
    const guard = async (operation: Promise<unknown>, warning: string) => {
      try {
        await operation
      } catch {
        if (!warnings.includes(warning)) warnings.push(warning)
      }
    }

    const seeded = marker?.value === true || localValue(LEGACY_SEEDED_KEY) === '1'
    // A deliberately emptied store stays empty; only a completely empty database is reseeded.
    const reseed = !seeded || (rawProfiles.length === 0 && rawRuns.length === 0 && beans.length === 0)
    const empty = rawProfiles.length === 0 && rawRuns.length === 0 && beans.length === 0
    if (reseed && empty && richSeedEnabled()) {
      await guard(this.seedDemoDataset(), 'The development demo dataset could not be saved locally')
    } else {
      if (reseed && rawProfiles.length === 0)
        await guard(
          Promise.all(demoProfiles.map((profile) => this.saveProfile(profile))),
          'Demo profiles could not be saved locally',
        )
      if (reseed && rawRuns.length === 0)
        await guard(Promise.all(demoRuns.map((run) => this.saveRun(run))), 'Demo roasts could not be saved locally')
      if (reseed && beans.length === 0)
        await guard(
          Promise.all(demoBeans.map((bean) => this.saveBean(bean))),
          'Demo bean lots could not be saved locally',
        )
    }

    const changedProfiles = rawProfiles.filter((profile) => !sameRecord(profile, normalizeProfile(profile)))
    const changedRuns = rawRuns.filter((run) => !sameRecord(run, normalizeRun(run)))
    const changedCalibrationRuns = rawCalibrationRuns.filter((run) => !sameRecord(run, normalizeCalibrationRun(run)))
    const changedSnapshots = rawSnapshots.filter(
      (snapshot) => !sameRecord(snapshot, normalizeCalibrationSnapshot(snapshot)),
    )
    await guard(
      Promise.all(changedProfiles.map((profile) => this.saveProfile(profile))),
      'Some stored profiles could not be updated locally',
    )
    await guard(
      Promise.all(changedRuns.map((run) => this.saveRun(run))),
      'Some stored roasts could not be updated locally',
    )
    await guard(
      Promise.all(changedCalibrationRuns.map((run) => this.saveCalibrationRun(run))),
      'Some stored calibration runs could not be updated locally',
    )
    await guard(
      Promise.all(changedSnapshots.map((snapshot) => this.saveCalibrationSnapshot(snapshot))),
      'Some stored calibrations could not be updated locally',
    )

    const knownBeanIds = new Set(beans.map((bean) => bean.id))
    const importedBeans: BeanLot[] = []
    for (const profile of rawProfiles) {
      const bean = legacyBeanFromProfile(profile)
      if (!bean || knownBeanIds.has(bean.id)) continue
      knownBeanIds.add(bean.id)
      importedBeans.push(bean)
    }
    await guard(
      Promise.all(importedBeans.map((bean) => this.saveBean(bean))),
      'Bean lots migrated from legacy profiles could not be saved',
    )

    if (!localValue(CALIBRATION_KEY))
      await guard(this.saveCalibration(defaultCalibration), 'Calibration defaults could not be saved locally')
    if (marker?.value !== true)
      await guard(
        this.enqueue(() => put(META_STORE, { key: SEEDED_META_KEY, value: true })),
        'The demo seed marker could not be saved locally',
      )
    return warnings
  }

  async profiles() {
    return (await readAll<Profile>(PROFILE_STORE)).map(normalizeProfile)
  }
  async runs() {
    return (await readAll<RoastRun>(RUN_STORE)).map(normalizeRun)
  }
  async beans() {
    return readAll<BeanLot>(BEAN_STORE)
  }
  saveProfile(profile: Profile) {
    return this.enqueue(() => put(PROFILE_STORE, normalizeProfile(profile)))
  }
  saveRun(run: RoastRun) {
    return this.enqueue(() => put(RUN_STORE, normalizeRun(run)))
  }
  saveBean(bean: BeanLot) {
    return this.enqueue(() => put(BEAN_STORE, bean))
  }
  deleteRun(id: string) {
    return this.enqueue(() => remove(RUN_STORE, id))
  }
  deleteBean(id: string) {
    return this.enqueue(() => remove(BEAN_STORE, id))
  }
  /**
   * Deleting a profile removes the RECIPE, never the roasts. Every stored run embeds its own
   * snapshot of the profile it was roasted with, so history keeps working and simply lists as
   * unlinked; a cascade over the roasts is a separate, explicitly confirmed decision.
   */
  deleteProfile(id: string) {
    return this.enqueue(() => remove(PROFILE_STORE, id))
  }
  async calibrationRuns() {
    return (await readAll<CalibrationRun>(CALIBRATION_RUN_STORE)).map(normalizeCalibrationRun)
  }
  saveCalibrationRun(run: CalibrationRun) {
    return this.enqueue(() => put(CALIBRATION_RUN_STORE, normalizeCalibrationRun(run)))
  }
  deleteCalibrationRun(id: string) {
    return this.enqueue(() => remove(CALIBRATION_RUN_STORE, id))
  }
  clearCalibrationRuns() {
    return this.enqueue(() => clear(CALIBRATION_RUN_STORE))
  }
  async calibrationSnapshots() {
    return (await readAll<CalibrationSnapshot>(CALIBRATION_SNAPSHOT_STORE)).map(normalizeCalibrationSnapshot)
  }
  saveCalibrationSnapshot(snapshot: CalibrationSnapshot) {
    return this.enqueue(() => put(CALIBRATION_SNAPSHOT_STORE, normalizeCalibrationSnapshot(snapshot)))
  }
  deleteCalibrationSnapshot(id: string) {
    return this.enqueue(() => remove(CALIBRATION_SNAPSHOT_STORE, id))
  }
  clearCalibrationSnapshots() {
    return this.enqueue(() => clear(CALIBRATION_SNAPSHOT_STORE))
  }
  // Manual history is a volatile operating log rather than an archive, so it is normalized on read
  // and never written back during initialize the way profiles and passes are.
  async manualEvents() {
    return (await readAll<ManualEvent>(MANUAL_EVENT_STORE)).map(normalizeManualEvent).sort((a, b) => a.atMs - b.atMs)
  }
  saveManualEvent(event: ManualEvent) {
    return this.enqueue(() => putCapped(MANUAL_EVENT_STORE, normalizeManualEvent(event), MANUAL_EVENT_CAP))
  }
  clearManualEvents() {
    return this.enqueue(() => clear(MANUAL_EVENT_STORE))
  }

  /** Clear the former device library while retaining browser-only metadata. */
  clearDeviceLibraryMirror(libraryMetaKeys: string[] = []) {
    return this.enqueue(async () => {
      await clearDeviceLibraryStores(libraryMetaKeys)
      try {
        globalThis.localStorage?.removeItem(CALIBRATION_KEY)
      } catch {
        throw new Error('The former calibration could not be cleared from local storage')
      }
    })
  }
  // Newest first, because that is the only order an edit history is ever read in.
  async profileRevisions() {
    return (await readAll<ProfileRevision>(PROFILE_REVISION_STORE))
      .map(normalizeProfileRevision)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }
  saveProfileRevision(revision: ProfileRevision) {
    return this.enqueue(() =>
      putCappedBySubject(
        PROFILE_REVISION_STORE,
        normalizeProfileRevision(revision),
        (row) => row.profileId,
        REVISION_CAP,
      ),
    )
  }
  async beanRevisions() {
    return (await readAll<BeanRevision>(BEAN_REVISION_STORE))
      .map(normalizeBeanRevision)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }
  saveBeanRevision(revision: BeanRevision) {
    return this.enqueue(() =>
      putCappedBySubject(BEAN_REVISION_STORE, normalizeBeanRevision(revision), (row) => row.beanId, REVISION_CAP),
    )
  }
  deleteBeanRevisions(beanId: string) {
    return this.enqueue(() => removeWhere<BeanRevision>(BEAN_REVISION_STORE, (row) => row.beanId === beanId))
  }
  deleteProfileRevisions(profileId: string) {
    return this.enqueue(() =>
      removeWhere<ProfileRevision>(PROFILE_REVISION_STORE, (row) => row.profileId === profileId),
    )
  }
  clearBeanRevisions() {
    return this.enqueue(() => clear(BEAN_REVISION_STORE))
  }
  clearProfileRevisions() {
    return this.enqueue(() => clear(PROFILE_REVISION_STORE))
  }
  /**
   * Dev-only. Writes the rich dataset through the same public save methods every other write uses,
   * so it is normalized identically and cannot introduce a record shape the app would not have
   * produced itself. The applied thermal coefficients come from the newest pass's own analysis, so
   * the saved calibration marked "currently applied" really does match what Settings reports.
   */
  async seedDemoDataset(force = false) {
    // Loaded dynamically behind the literal `import.meta.env.DEV` so a production build folds the
    // branch away entirely: the dataset is not in the bundle the firmware serves, not merely
    // unreachable in it. `force` exists for the test that seeds it deliberately; it cannot open the
    // door in a built bundle, because the literal in front of it is already false there.
    if (!import.meta.env.DEV || (!force && !richSeedEnabled())) return
    const dataset = (await import('./demoDataset')).richDemoDataset()
    for (const item of dataset.beans) await this.saveBean(item)
    for (const item of dataset.profiles) await this.saveProfile(item)
    for (const item of dataset.runs) await this.saveRun(item)
    for (const item of dataset.profileRevisions) await this.saveProfileRevision(item)
    for (const item of dataset.beanRevisions) await this.saveBeanRevision(item)
    for (const item of dataset.manualEvents) await this.saveManualEvent(item)
    for (const item of dataset.calibrationRuns) await this.saveCalibrationRun(item)
    for (const item of dataset.calibrationSnapshots) await this.saveCalibrationSnapshot(item)
    const current = (await this.calibration()) ?? defaultCalibration
    await this.saveCalibration({ ...current, ...dataset.appliedCalibration })
  }

  /** Dev-only. Empties every catalog store and re-seeds, for the Settings action. */
  async resetDemoData(force = false) {
    for (const store of [
      PROFILE_STORE,
      RUN_STORE,
      BEAN_STORE,
      CALIBRATION_RUN_STORE,
      CALIBRATION_SNAPSHOT_STORE,
      MANUAL_EVENT_STORE,
      PROFILE_REVISION_STORE,
      BEAN_REVISION_STORE,
    ]) {
      await this.enqueue(() => clear(store))
    }
    await this.seedDemoDataset(force)
    await this.enqueue(() => put(META_STORE, { key: SEEDED_META_KEY, value: true }))
  }

  /**
   * Which controller recordings this archive has already considered.
   *
   * Read as a Set because every caller asks membership questions, and stored as a plain array
   * because IndexedDB structured-clones what it is given and a Set round-tripping through the
   * store is one more shape to normalize for no benefit.
   */
  async importedDeviceLogIds(): Promise<Set<string>> {
    const stored = await readOne<{ key: string; value: unknown }>(META_STORE, IMPORTED_DEVICE_LOGS_KEY)
    const ids = Array.isArray(stored?.value) ? stored.value : []
    return new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))
  }

  /**
   * Record that a recording has been dealt with. Additive and idempotent: marking the same id twice
   * writes the same set, so a retry after a failed sample fetch cannot corrupt the ledger.
   */
  markDeviceLogsImported(ids: string[]) {
    return this.enqueue(async () => {
      const known = await this.importedDeviceLogIds()
      for (const id of ids) known.add(id)
      await put(META_STORE, { key: IMPORTED_DEVICE_LOGS_KEY, value: [...known].sort() })
    })
  }

  replaceDeviceLogsImported(ids: string[]) {
    const normalized = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))].sort()
    return this.enqueue(() => put(META_STORE, { key: IMPORTED_DEVICE_LOGS_KEY, value: normalized }))
  }

  /**
   * The `meta` store, as a small key/value shelf.
   *
   * The device-backed data layer keeps two pieces of bookkeeping here - the per-run document
   * versions it uses to skip refetching unchanged roasts, and whether the one-time "adopt this
   * browser's data" offer has been answered. Both are facts about THIS CACHE rather than about the
   * library, so they are the one class of thing that deliberately does not travel to the controller.
   */
  async meta<T>(key: string): Promise<T | undefined> {
    const stored = await readOne<{ key: string; value: T }>(META_STORE, key)
    return stored?.value
  }

  saveMeta<T>(key: string, value: T) {
    return this.enqueue(() => put(META_STORE, { key, value }))
  }
  deleteMeta(key: string) {
    return this.enqueue(() => remove(META_STORE, key))
  }

  async calibration() {
    const stored = localValue(CALIBRATION_KEY)
    if (!stored) return undefined
    try {
      return storedCalibrationSettings({ ...defaultCalibration, ...JSON.parse(stored) } as CalibrationSettings)
    } catch {
      return undefined
    }
  }
  async saveCalibration(value: CalibrationSettings) {
    try {
      globalThis.localStorage?.setItem(CALIBRATION_KEY, JSON.stringify(storedCalibrationSettings(value)))
    } catch {
      throw new Error('Calibration could not be written to local storage')
    }
  }
  async clearCalibration() {
    try {
      globalThis.localStorage?.removeItem(CALIBRATION_KEY)
    } catch {
      throw new Error('Calibration could not be cleared from local storage')
    }
  }
}

export const repository = new CrackleRepository()
