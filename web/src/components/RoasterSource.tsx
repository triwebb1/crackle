import type { RecordedOn } from '../domain/types'

export interface RoasterTargetPresentation {
  id: string
  name: string
  model: string
  address?: string
  simulated?: boolean
  connected?: boolean
  stale?: boolean
  firmwareVersion?: string
}

export type RoasterSourceFilter = 'active' | 'all' | 'physical' | 'mock' | 'other'

export const sourceKind = (recordedOn: RecordedOn, activeDeviceId?: string): 'mock' | 'physical' | 'other' => {
  if (recordedOn.simulated) return 'mock'
  if (activeDeviceId && recordedOn.deviceId !== activeDeviceId) return 'other'
  return 'physical'
}

export const sourceLabel = (recordedOn: RecordedOn, activeDeviceId?: string): string => {
  const kind = sourceKind(recordedOn, activeDeviceId)
  return kind === 'mock' ? 'Mock' : kind === 'other' ? 'Other roaster' : 'Physical'
}

export const sourceMatches = (
  recordedOn: RecordedOn,
  filter: RoasterSourceFilter,
  activeDeviceId?: string,
): boolean => {
  if (filter === 'all') return true
  if (filter === 'mock') return recordedOn.simulated
  if (filter === 'physical') return !recordedOn.simulated
  if (filter === 'other') return Boolean(activeDeviceId) && recordedOn.deviceId !== activeDeviceId
  return Boolean(activeDeviceId) && recordedOn.deviceId === activeDeviceId
}

const sourceDetail = (recordedOn: RecordedOn): string =>
  `${recordedOn.displayNameAtCapture} · ${recordedOn.modelId} · device ${recordedOn.deviceId} · firmware ${recordedOn.firmwareVersion}`

export function RoasterSourceBadge({
  recordedOn,
  activeDeviceId,
}: {
  recordedOn: RecordedOn
  activeDeviceId?: string
}) {
  const kind = sourceKind(recordedOn, activeDeviceId)
  return (
    <span className={`roaster-source-badge ${kind}`} title={sourceDetail(recordedOn)}>
      {sourceLabel(recordedOn, activeDeviceId)}
    </span>
  )
}

export function RoasterSourceFilterControl({
  value,
  onChange,
  activeName = 'Active roaster',
  label = 'Record source',
}: {
  value: RoasterSourceFilter
  onChange: (value: RoasterSourceFilter) => void
  activeName?: string
  label?: string
}) {
  return (
    <label className="source-filter">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onInput={(event) => onChange(event.currentTarget.value as RoasterSourceFilter)}
      >
        <option value="active">{activeName}</option>
        <option value="all">All roasters</option>
        <option value="physical">Physical roasters</option>
        <option value="mock">Development mock</option>
        <option value="other">Other roasters</option>
      </select>
    </label>
  )
}

export function TargetKindBadge({ simulated }: { simulated?: boolean }) {
  const kind = simulated === undefined ? 'unknown' : simulated ? 'mock' : 'physical'
  return (
    <span className={`target-kind-badge ${kind}`}>
      {simulated === undefined ? 'Identity pending' : simulated ? 'Mock' : 'Physical'}
    </span>
  )
}

const targetConnection = (target: RoasterTargetPresentation): string => {
  if (target.connected === false) return 'Not connected'
  if (target.stale) return 'Status stale'
  if (target.connected) return 'Connected'
  return 'Not checked'
}

export function RoasterTargetList({
  activeId,
  targets,
  onSelect,
  blockedReason,
  compact = false,
}: {
  activeId?: string
  targets: RoasterTargetPresentation[]
  onSelect?: (id: string) => void
  blockedReason?: string
  compact?: boolean
}) {
  return (
    <div className={compact ? 'roaster-target-list compact' : 'roaster-target-list'}>
      {targets.map((target) => {
        const active = target.id === activeId
        return (
          <div className={active ? 'roaster-target-row active' : 'roaster-target-row'} key={target.id}>
            <div className="roaster-target-main">
              <span className="roaster-target-name">
                <strong>{target.name}</strong>
                <TargetKindBadge simulated={target.simulated} />
                {active && <span className="target-active-badge">Active</span>}
              </span>
              <small>
                {target.model}
                {target.address ? ` · ${target.address}` : ''}
                {target.firmwareVersion ? ` · firmware ${target.firmwareVersion}` : ''}
              </small>
            </div>
            <span className={`target-connection ${target.connected === false || target.stale ? 'offline' : ''}`}>
              {targetConnection(target)}
            </span>
            {!active && onSelect && (
              <button
                type="button"
                className="compact-button"
                disabled={Boolean(blockedReason)}
                title={blockedReason}
                onClick={() => onSelect(target.id)}
              >
                Switch
              </button>
            )}
          </div>
        )
      })}
      {targets.length === 0 && <div className="empty-state">No roaster targets are configured.</div>}
      {blockedReason && (
        <p className="target-switch-blocked" role="status">
          {blockedReason}
        </p>
      )}
    </div>
  )
}
