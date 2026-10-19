import type { ConfiguredRoasterTarget } from '../domain/roasterModel'
import type { ControllerStatus } from '../domain/types'

export type RoasterTargetKind = 'mock' | 'physical'

export interface SelectableRoasterTarget extends ConfiguredRoasterTarget {
  kind: RoasterTargetKind
  address: string
}

const selectedKey = (search: string) => new URLSearchParams(search).get('roaster') ?? ''

export const configuredRoasterTargets = (development: boolean, origin: string): SelectableRoasterTarget[] =>
  development
    ? [
        { id: 'mock', label: 'Development mock', kind: 'mock', address: origin, baseUrl: '' },
        {
          id: 'physical',
          label: 'Physical SR800',
          kind: 'physical',
          address: 'Configured development proxy',
          baseUrl: origin.replace(/\/$/, ''),
          pathPrefix: '/__crackle/physical',
        },
      ]
    : [{ id: 'current', label: 'This roaster', kind: 'physical', address: origin, baseUrl: '' }]

export const activeConfiguredTarget = (targets: SelectableRoasterTarget[], search: string): SelectableRoasterTarget => {
  const requested = selectedKey(search)
  return targets.find((target) => target.id === requested) ?? targets[0]
}

export const targetHttpUrl = (
  target: Pick<SelectableRoasterTarget, 'baseUrl' | 'pathPrefix'>,
  path: string,
): string => {
  const prefix = target.pathPrefix ?? ''
  const targetPath = `${prefix}${path.startsWith('/') ? path : `/${path}`}`
  return target.baseUrl ? new URL(targetPath, `${target.baseUrl.replace(/\/$/, '')}/`).toString() : targetPath
}

export const targetNavigationUrl = (currentUrl: string, targetId: string): string => {
  const next = new URL(currentUrl)
  // The mock is the development default; spelling it as an explicit query must not fork a second cache.
  if (targetId === 'current' || targetId === 'mock') next.searchParams.delete('roaster')
  else next.searchParams.set('roaster', targetId)
  return next.toString()
}

export interface TargetVerificationFailure {
  message: string
  detail?: string
}

/**
 * A development proxy returning a bare 5xx is evidence that the configured target could not be
 * reached, not a useful device diagnosis. Structured firmware messages are already plain language
 * and must pass through unchanged.
 */
export const targetVerificationFailure = (
  target: Pick<SelectableRoasterTarget, 'label' | 'kind'>,
  fault: string | undefined,
): TargetVerificationFailure => {
  const raw = fault?.trim() || 'The target did not answer'
  if (/^HTTP 5\d\d$/i.test(raw)) {
    return {
      message: `${target.label} could not be reached through the configured connection. The current roaster remains selected. Check that the roaster is powered on and reachable, then retry.`,
      detail: raw,
    }
  }
  if (/abort|timeout|timed out|failed to fetch|network|did not answer/i.test(raw)) {
    return {
      message: `${target.label} did not answer. The current roaster remains selected. Check its power and connection, then retry.`,
      detail: raw,
    }
  }
  return { message: raw }
}

export interface TargetSwitchState {
  status: ControllerStatus
  profileDirty: boolean
  beanDirty: boolean
  pendingWrites: number
  switching: boolean
  manualRecordingSettlementPending?: boolean
  recordingImportPending?: boolean
}

export const targetSwitchBlockedReason = ({
  status,
  profileDirty,
  beanDirty,
  pendingWrites,
  switching,
  manualRecordingSettlementPending = false,
  recordingImportPending = false,
}: TargetSwitchState): string | undefined => {
  if (switching) return 'Another roaster is being verified.'
  if (status.roast?.active) return 'A roast is active. Stop it before switching roasters.'
  if (status.calibration?.active) return 'Calibration is active. Stop it before switching roasters.'
  if (status.manual?.active || status.manualLockout || status.lifecycle === 'MANUAL_LOCKOUT')
    return 'Controls are active or locked out. Stop them before switching roasters.'
  if (status.lifecycle === 'RUNNING') return 'The roaster is running. Wait until it is idle before switching.'
  if (status.restoreMaintenance?.active)
    return 'A restore is in progress. Wait for it to finish before switching roasters.'
  if (manualRecordingSettlementPending)
    return 'The completed manual roast is still being saved from the roaster. Wait for its recording to appear before switching.'
  if (recordingImportPending)
    return 'Roast recordings are still being reconciled from the roaster. Wait for the import to finish before switching.'
  if (pendingWrites > 0) return `${pendingWrites} device write${pendingWrites === 1 ? ' is' : 's are'} still pending.`
  if (profileDirty || beanDirty) return 'Save or discard the working catalog edit before switching roasters.'
  return undefined
}
