import type { RoasterIdentity } from './types'

export const SR800_MODEL_ID = 'freshroast-sr800'
export const MOCK_SR800_MODEL_ID = 'crackle-sim-sr800'

export interface ActuatorContract {
  fan: { minimumActive: number; maximum: number }
  heat: { minimum: number; maximum: number }
}

export interface RoasterModelSpec {
  modelId: string
  displayName: string
  contractModelId: string
  actuator: ActuatorContract
  coefficientReferenceMassG: number
}

const SR800_ACTUATOR: ActuatorContract = {
  fan: { minimumActive: 0.1, maximum: 10 },
  heat: { minimum: 0, maximum: 10 },
}

export const SR800_MODEL: RoasterModelSpec = {
  modelId: SR800_MODEL_ID,
  displayName: 'FreshRoast SR800',
  contractModelId: SR800_MODEL_ID,
  actuator: SR800_ACTUATOR,
  coefficientReferenceMassG: 225,
}

export const MOCK_SR800_MODEL: RoasterModelSpec = {
  modelId: MOCK_SR800_MODEL_ID,
  displayName: 'Crackle simulated SR800',
  contractModelId: SR800_MODEL_ID,
  actuator: SR800_ACTUATOR,
  coefficientReferenceMassG: 225,
}

const MODELS = new Map<string, RoasterModelSpec>([
  [SR800_MODEL.modelId, SR800_MODEL],
  [MOCK_SR800_MODEL.modelId, MOCK_SR800_MODEL],
])

export interface ActiveRoaster {
  identity: RoasterIdentity
  model?: RoasterModelSpec
  modelSupported: boolean
}

/** Resolve only what the controller declared. Unknown never falls back to the SR800. */
export const resolveActiveRoaster = (identity: RoasterIdentity | undefined): ActiveRoaster | undefined => {
  if (!identity) return undefined
  const model = MODELS.get(identity.modelId)
  if (identity.simulated && identity.simulatesModelId && model?.contractModelId !== identity.simulatesModelId) {
    return { identity, modelSupported: false }
  }
  return { identity, model, modelSupported: model !== undefined }
}

export type ModelSpecificOperation = 'author' | 'start' | 'calibrate' | 'apply-calibration' | 'preview'

export const unsupportedModelReason = (
  active: ActiveRoaster | undefined,
  operation: ModelSpecificOperation,
): string | undefined => {
  if (!active) return 'The roaster has not reported its model yet.'
  if (!active.modelSupported)
    return `${active.identity.displayName} reports unknown model "${active.identity.modelId}". Crackle will not ${operation.replace('-', ' ')} with SR800 assumptions. Status, storage, history, and Stop remain available.`
  return undefined
}

/**
 * A connection target selects an endpoint; its controller still declares the model.
 *
 * This is transport configuration, not a promise that an arbitrary browser origin can reach it.
 * Firmware-served pages use the empty same-origin target. Local development must use its proxy
 * unless the target explicitly serves compatible CORS headers.
 */
export interface ConfiguredRoasterTarget {
  id: string
  label: string
  baseUrl: string
  /** Same-origin development proxy prefix. Device firmware targets leave this empty. */
  pathPrefix?: string
}

export const normalizeTargetBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

export const normalizeTargetPathPrefix = (pathPrefix = ''): string => {
  const trimmed = pathPrefix.trim()
  if (!trimmed || trimmed === '/') return ''
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return prefixed.endsWith('/') ? prefixed.slice(0, -1) : prefixed
}
