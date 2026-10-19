import {
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Thermometer,
  Wifi,
} from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import type { BackupType } from '../data/backupFile'
import type { DataSyncState } from '../data/deviceStore'
import type { DeviceLogEntry } from '../domain/deviceLogs'
import { formatBytes } from '../domain/storage'
import type {
  BeanLot,
  CalibrationRun,
  CalibrationSettings,
  CalibrationSnapshot,
  ControllerStatus,
  Profile,
  RoastRun,
} from '../domain/types'
import { MockPowerCycleControl } from './MockPowerCycleControl'
import { NumberField } from './NumberField'
import { RoasterTargetList, type RoasterTargetPresentation, TargetKindBadge } from './RoasterSource'
import { LifecycleBadge } from './Status'
import { StoragePanel } from './StoragePanel'

export type ActiveRoasterTarget = RoasterTargetPresentation

const statusSnapshotText = (status: ControllerStatus) => JSON.stringify(status, null, 2)

const copyStatusSnapshot = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const fallback = document.createElement('textarea')
  fallback.value = text
  fallback.setAttribute('readonly', '')
  fallback.style.position = 'fixed'
  fallback.style.opacity = '0'
  document.body.append(fallback)
  fallback.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Copy was not available')
  } finally {
    fallback.remove()
  }
}

/**
 * An operator-controlled snapshot rather than a live dump.
 *
 * Settings receives a new status object with every telemetry frame. Keeping the serialized text in
 * local state means those parent renders do not replace the text node under an active selection.
 */
export function AdvancedStatusSnapshot({ status }: { status: ControllerStatus }) {
  const [snapshot, setSnapshot] = useState(() => statusSnapshotText(status))
  const [feedback, setFeedback] = useState('')

  const refresh = () => {
    setSnapshot(statusSnapshotText(status))
    setFeedback('Status snapshot refreshed.')
  }
  const copy = async () => {
    try {
      await copyStatusSnapshot(snapshot)
      setFeedback('Status snapshot copied.')
    } catch {
      setFeedback('Copy failed. Select the status text and copy it manually.')
    }
  }

  return (
    <>
      <div className="status-snapshot-actions">
        <button type="button" className="secondary-button" onClick={() => void copy()}>
          <Copy size={17} />
          Copy status
        </button>
        <button type="button" className="secondary-button" onClick={refresh}>
          <RefreshCw size={17} />
          Refresh snapshot
        </button>
        {feedback && (
          <span className="status-snapshot-feedback" role="status" aria-live="polite">
            {feedback}
          </span>
        )}
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus so the keyboard can scroll it */}
      <pre role="region" aria-label="Status snapshot" tabIndex={0}>
        {snapshot}
      </pre>
    </>
  )
}
export function TransportDiagnostics({ status }: { status: ControllerStatus }) {
  const live = status.liveTransport
  if (!live) return null
  const stackReserve = (value?: number) =>
    value === undefined ? '—' : value === 0 ? 'Not measured' : formatBytes(value)
  const count = live.websocketClientCount
  const capacity = live.websocketClientCapacity
  const subscribers = count === undefined ? '—' : capacity === undefined ? String(count) : `${count} / ${capacity}`
  return (
    <section className="transport-diagnostics" aria-labelledby="transport-diagnostics-title">
      <div>
        <span className="eyebrow">Since this boot</span>
        <h3 id="transport-diagnostics-title">Connection diagnostics</h3>
      </div>
      <div className="transport-diagnostics-grid">
        <span>
          <small>Live subscribers</small>
          <strong>{subscribers}</strong>
        </span>
        <span>
          <small>Refused requests</small>
          <strong>{live.httpRejectedRequestCount ?? '—'}</strong>
        </span>
        <span>
          <small>Worker failures</small>
          <strong>{live.httpWorkerFailureCount ?? '—'}</strong>
        </span>
        {live.httpAssetWorkerStackLowWaterBytes !== undefined &&
        live.httpCommandWorkerStackLowWaterBytes !== undefined ? (
          <>
            <span>
              <small>Asset worker stack reserve</small>
              <strong>{stackReserve(live.httpAssetWorkerStackLowWaterBytes)}</strong>
            </span>
            <span>
              <small>Command worker stack reserve</small>
              <strong>{stackReserve(live.httpCommandWorkerStackLowWaterBytes)}</strong>
            </span>
          </>
        ) : (
          <span>
            <small>Network stack reserve</small>
            <strong>{stackReserve(live.httpWorkerStackLowWaterBytes)}</strong>
          </span>
        )}
        <span>
          <small>Live publisher stack reserve</small>
          <strong>{stackReserve(live.websocketStackLowWaterBytes)}</strong>
        </span>
        {live.storageSlowestRequestMs !== undefined && (
          <span>
            <small>Slowest storage request</small>
            <strong>
              {live.storageSlowestRequestMs} ms
              {live.storageSlowestRequestRoute && live.storageSlowestRequestRoute !== 'none'
                ? ` · ${live.storageSlowestRequestRoute}`
                : ''}
              {live.storageRequestsOverOneSecond ? ` · ${live.storageRequestsOverOneSecond} over 1 s` : ''}
            </strong>
          </span>
        )}
        {live.wifiRssiDbm !== undefined && (
          <span>
            <small>Wi-Fi signal</small>
            <strong>
              {live.wifiRssiDbm} dBm
              {live.wifiDisconnectCount !== undefined
                ? ` · ${live.wifiDisconnectCount} ${live.wifiDisconnectCount === 1 ? 'drop' : 'drops'}`
                : ''}
            </strong>
          </span>
        )}
        <span>
          <small>Storage stack reserve</small>
          <strong>
            {stackReserve(live.storageWorkerStackLowWaterBytes)}
            {live.storageWorkerStackLowWaterRoute && live.storageWorkerStackLowWaterRoute !== 'none'
              ? ` · ${live.storageWorkerStackLowWaterRoute}`
              : ''}
          </strong>
        </span>
      </div>
    </section>
  )
}

export function SystemDiagnostics({ status }: { status: ControllerStatus }) {
  const system = status.system
  if (!system && !status.sensorFaultReasons?.length) return null
  const duration = (milliseconds?: number) => {
    if (milliseconds === undefined) return '—'
    const seconds = Math.floor(milliseconds / 1000)
    const days = Math.floor(seconds / 86_400)
    const hours = Math.floor((seconds % 86_400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`
  }
  const bytes = (value?: number) => (value === undefined ? '—' : formatBytes(value))
  const milliseconds = (value?: number) => (value === undefined ? '—' : `${value} ms`)
  return (
    <section className="transport-diagnostics" aria-labelledby="system-diagnostics-title">
      <div>
        <span className="eyebrow">Since this boot</span>
        <h3 id="system-diagnostics-title">Controller diagnostics</h3>
      </div>
      <div className="transport-diagnostics-grid">
        <span>
          <small>Reset reason</small>
          <strong>{system?.resetReason?.replaceAll('_', ' ') ?? '—'}</strong>
        </span>
        <span>
          <small>Recent boots</small>
          <strong>
            {system?.bootHistory?.length
              ? system.bootHistory.map((entry) => `${entry.boot} ${entry.resetReason.replaceAll('_', ' ')}`).join(' · ')
              : '—'}
          </strong>
        </span>
        <span className="stored-crash">
          <small>Last stored crash</small>
          <strong>
            {system?.storedCrash
              ? `${system.storedCrash.currentBuild === false ? 'From earlier firmware: ' : ''}${system.storedCrash.task} at ${system.storedCrash.pc}${system.storedCrash.corrupted ? ' (backtrace incomplete)' : ''} · build ${system.storedCrash.elfSha256} · ${system.storedCrash.backtrace.join(' ')}`
              : 'None recorded'}
          </strong>
        </span>
        <span>
          <small>Uptime</small>
          <strong>{duration(system?.uptimeMs)}</strong>
        </span>
        <span>
          <small>Minimum free heap</small>
          <strong>{bytes(system?.minimumFreeHeapBytes)}</strong>
        </span>
        {system?.psramLowWaterBytes !== undefined ? (
          <span>
            <small>Lowest free PSRAM</small>
            <strong>
              {bytes(system.psramLowWaterBytes)}
              {system.psramLowWaterAtMs !== undefined ? ` at ${duration(system.psramLowWaterAtMs)}` : ''}
            </strong>
          </span>
        ) : (
          <span>
            <small>Minimum free PSRAM</small>
            <strong>{bytes(system?.minimumFreePsramBytes)}</strong>
          </span>
        )}
        {system?.failedAllocations !== undefined && (
          <span>
            <small>Failed allocations</small>
            <strong>
              {system.failedAllocations === 0 || !system.lastFailedAllocation
                ? String(system.failedAllocations)
                : `${system.failedAllocations} · last ${formatBytes(system.lastFailedAllocation.bytes)} (caps 0x${system.lastFailedAllocation.caps.toString(16)}) at ${duration(system.lastFailedAllocation.atMs)}`}
            </strong>
          </span>
        )}
        <span>
          <small>Longest loop gap</small>
          <strong>{milliseconds(system?.maximumLoopGapMs)}</strong>
        </span>
        <span>
          <small>Longest archive save</small>
          <strong>{milliseconds(system?.maximumArchivePersistMs)}</strong>
        </span>
        <span>
          <small>Archive saves</small>
          <strong>{system?.archivePersistCount ?? '—'}</strong>
        </span>
        <span>
          <small>Probe fault</small>
          <strong>
            {status.sensorFaultReasons?.map((reason) => reason.replaceAll('_', ' ')).join(', ') || 'None reported'}
          </strong>
        </span>
      </div>
    </section>
  )
}
interface SettingsViewProps {
  status: ControllerStatus
  liveConnection: 'websocket' | 'fallback'
  /** @deprecated Remove with App's browser-quota estimation; it is intentionally not rendered. */

  browserStorage?: { usageBytes?: number; quotaBytes?: number }
  profiles: Profile[]
  beans: BeanLot[]
  runs: RoastRun[]
  calibrationPasses: CalibrationRun[]
  calibrationSnapshots: CalibrationSnapshot[]
  deviceLogs: DeviceLogEntry[]
  /** False until the connected roaster's recording list has been read at least once. */
  deviceLogsListed?: boolean
  importedLogIds: string[]
  onExportEverything: () => Promise<string>
  onExportType?: (type: BackupType) => Promise<string>
  onImportBackup?: (file: File) => Promise<string>
  onRestoreBackup?: (file: File, onProgress: (line: string) => void) => Promise<string>
  restoreBlockedReason?: string
  onFormatStorage?: () => Promise<string>
  prunableLogIds?: string[]
  onPruneDeviceLogs?: (logIds: string[]) => void
  onDeleteRun?: (id: string) => void | Promise<unknown>
  onDeleteProfile?: (id: string) => void | Promise<unknown>
  onDeleteBean?: (id: string) => void | Promise<unknown>
  onDeleteCalibrationSnapshot?: (id: string) => void | Promise<unknown>
  /** Retained until App wiring drops the retired Settings planning editor. */
  storedCalibration: CalibrationSettings
  onCalibrationChange: (value: CalibrationSettings) => void
  onOpenCalibrate: () => void
  onReloadDemoData?: () => Promise<void>
  dataSync: DataSyncState
  onAdoptData: () => Promise<void>
  onDismissAdoption: () => void
  onThermocoupleOffsetChange?: (offsetC: number) => Promise<string>
  thermocoupleOffsetBlockedReason?: string
  activeRoaster?: ActiveRoasterTarget
  roasterTargets?: ActiveRoasterTarget[]
  onActiveRoasterChange?: (id: string) => void
  activeRoasterChangeBlockedReason?: string
  firmwareUpdateHref?: string
  rawStatusHref?: string
  /** Injected only by local development against the simulated controller. */
  onPowerCycleMock?: () => Promise<string>
  onSetMockProbeAvailable?: (available: boolean) => Promise<string>
  onDropMockLiveStream?: () => Promise<string>
}

export function SettingsView({
  status,
  liveConnection,
  profiles,
  beans,
  runs,
  calibrationPasses,
  calibrationSnapshots,
  deviceLogs,
  deviceLogsListed = true,
  importedLogIds,
  onExportEverything,
  onExportType,
  onImportBackup,
  onRestoreBackup,
  onFormatStorage,
  restoreBlockedReason,
  prunableLogIds,
  onPruneDeviceLogs,
  onDeleteRun,
  onDeleteProfile,
  onDeleteBean,
  onDeleteCalibrationSnapshot,
  onOpenCalibrate,
  onReloadDemoData,
  dataSync,
  onAdoptData,
  onDismissAdoption,
  onThermocoupleOffsetChange,
  thermocoupleOffsetBlockedReason,
  activeRoaster,
  roasterTargets = [],
  onActiveRoasterChange,
  activeRoasterChangeBlockedReason,
  firmwareUpdateHref = '/update',
  rawStatusHref = '/api/status',
  onPowerCycleMock,
  onSetMockProbeAvailable,
  onDropMockLiveStream,
}: SettingsViewProps) {
  const [advanced, setAdvanced] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const authoritativeThermocoupleOffset = status.thermocoupleOffsetC
  const [thermocoupleOffsetDraft, setThermocoupleOffsetDraft] = useState<number | undefined>(
    authoritativeThermocoupleOffset,
  )
  const [thermocoupleOffsetBusy, setThermocoupleOffsetBusy] = useState(false)
  const [thermocoupleOffsetMessage, setThermocoupleOffsetMessage] = useState('')
  const [thermocoupleOffsetError, setThermocoupleOffsetError] = useState('')

  useEffect(() => {
    if (authoritativeThermocoupleOffset !== undefined) setThermocoupleOffsetDraft(authoritativeThermocoupleOffset)
  }, [authoritativeThermocoupleOffset])

  const saveThermocoupleOffset = async () => {
    if (
      thermocoupleOffsetDraft === undefined ||
      !Number.isFinite(thermocoupleOffsetDraft) ||
      thermocoupleOffsetDraft < -25 ||
      thermocoupleOffsetDraft > 25
    ) {
      setThermocoupleOffsetMessage('')
      setThermocoupleOffsetError('Thermocouple correction must be between -25.0 and 25.0 °C')
      return
    }
    if (!onThermocoupleOffsetChange) return
    setThermocoupleOffsetBusy(true)
    setThermocoupleOffsetMessage('')
    setThermocoupleOffsetError('')
    try {
      setThermocoupleOffsetMessage(await onThermocoupleOffsetChange(thermocoupleOffsetDraft))
    } catch (error) {
      setThermocoupleOffsetError(
        error instanceof Error ? error.message : 'The thermocouple correction could not be saved',
      )
    } finally {
      setThermocoupleOffsetBusy(false)
    }
  }

  const targetName = activeRoaster?.name ?? 'Roaster'
  const targetDetail = activeRoaster
    ? `Reported by roaster · ${activeRoaster.model}${activeRoaster.simulated ? ' · simulation' : ''} · device ${activeRoaster.id}${activeRoaster.address ? ` · ${activeRoaster.address}` : ''}`
    : 'Roaster-reported identity pending'
  const canChooseRoaster = roasterTargets.length > 1

  return (
    <section className="view settings-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">Roaster</span>
          <h1>Settings</h1>
        </div>
      </div>
      <div className="settings-band">
        <div className="setting-icon">
          <Wifi />
        </div>
        <div className="active-roaster-summary">
          <span>Installed roaster</span>
          <span className="active-roaster-name">
            <strong>{targetName}</strong>
            {activeRoaster?.simulated === true && <TargetKindBadge simulated />}
          </span>
          <small>{targetDetail}</small>
        </div>
        <LifecycleBadge lifecycle={status.lifecycle} connected={status.connected} stale={status.stale} />
      </div>
      {canChooseRoaster && activeRoasterChangeBlockedReason && (
        <div className="model-scope-note" role="status">
          {activeRoasterChangeBlockedReason}
        </div>
      )}
      {canChooseRoaster && (
        <section className="roaster-targets-settings" aria-labelledby="roaster-targets-title">
          <div>
            <span className="eyebrow">Connections</span>
            <h2 id="roaster-targets-title">Choose a roaster</h2>
            <p>
              Crackle switches the complete device context together. The selected roaster supplies live state, storage,
              history, and calibration.
            </p>
          </div>
          <RoasterTargetList
            activeId={activeRoaster?.id}
            targets={roasterTargets}
            onSelect={onActiveRoasterChange}
            blockedReason={activeRoasterChangeBlockedReason}
          />
        </section>
      )}
      <div className="settings-grid">
        <div className="setting-row">
          <Cpu size={19} />
          <span>Firmware</span>
          <strong>{status.firmwareVersion}</strong>
        </div>
        <div className="setting-row">
          <Thermometer size={19} />
          <span>Thermocouple</span>
          <strong>{status.thermocoupleValid ? `${status.temperatureC?.toFixed(1)} °C` : 'Unavailable'}</strong>
        </div>
        <div className="setting-row">
          <Wifi size={19} />
          <span>Live updates</span>
          <strong>
            {liveConnection === 'websocket'
              ? `WebSocket :${status.liveTransport?.websocketPort ?? 81}`
              : 'HTTP fallback'}
          </strong>
        </div>
      </div>

      <section className="calibration-section thermocouple-setting">
        <div className="calibration-heading">
          <div className="setting-icon">
            <Thermometer />
          </div>
          <div>
            <span className="eyebrow">Temperature reading</span>
            <h2>Thermocouple correction</h2>
          </div>
        </div>
        <div className="model-scope-note">
          The roaster applies this correction once before reporting or recording temperature. The device default is
          -3.00 °C.
        </div>
        <div className="thermocouple-setting-row">
          <NumberField
            label="Correction (°C)"
            value={thermocoupleOffsetDraft}
            min={-25}
            max={25}
            step={0.05}
            disabled={
              authoritativeThermocoupleOffset === undefined || !onThermocoupleOffsetChange || thermocoupleOffsetBusy
            }
            onCommit={(value) => {
              setThermocoupleOffsetMessage('')
              setThermocoupleOffsetError('')
              setThermocoupleOffsetDraft(value)
            }}
            hint="Allowed range: -25.0 through 25.0 °C"
          />
          <button
            type="button"
            className="primary-button compact-action"
            disabled={
              !onThermocoupleOffsetChange ||
              authoritativeThermocoupleOffset === undefined ||
              thermocoupleOffsetBusy ||
              Boolean(thermocoupleOffsetBlockedReason) ||
              thermocoupleOffsetDraft === undefined ||
              !Number.isFinite(thermocoupleOffsetDraft) ||
              thermocoupleOffsetDraft < -25 ||
              thermocoupleOffsetDraft > 25 ||
              thermocoupleOffsetDraft === authoritativeThermocoupleOffset
            }
            onClick={() => void saveThermocoupleOffset()}
          >
            <Save size={17} />
            {thermocoupleOffsetBusy ? 'Saving…' : 'Save correction'}
          </button>
        </div>
        {authoritativeThermocoupleOffset === undefined && (
          <div className="model-scope-note" role="status">
            This firmware does not report its thermocouple correction, so it cannot be edited here.
          </div>
        )}
        {thermocoupleOffsetBlockedReason && (
          <div className="model-scope-note" role="status">
            {thermocoupleOffsetBlockedReason}
          </div>
        )}
        {thermocoupleOffsetError && (
          <div className="field-error" role="alert">
            {thermocoupleOffsetError}
          </div>
        )}
        {thermocoupleOffsetMessage && (
          <div className="import-message" role="status">
            {thermocoupleOffsetMessage}
          </div>
        )}
      </section>

      <section className="calibration-route" aria-labelledby="calibration-route-title">
        <div>
          <span className="eyebrow">Measured behavior</span>
          <h2 id="calibration-route-title">Calibration</h2>
          <p>
            Thermal response time scales by batch mass against the measured 225 g baseline; attainable equilibrium does
            not. Volume and density are recorded as evidence, but do not change control until repeated roasts support a
            fitted relationship.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={onOpenCalibrate}>
          <SlidersHorizontal size={17} />
          Open Calibrate
        </button>
      </section>

      <section className="storage-section">
        <div className="storage-heading">
          <div className="setting-icon">
            <Database />
          </div>
          <div>
            <span className="eyebrow">Data</span>
            <h2>Storage</h2>
          </div>
        </div>
        <StoragePanel
          status={status}
          dataSync={dataSync}
          deviceLogs={deviceLogs}
          deviceLogsListed={deviceLogsListed}
          importedLogIds={importedLogIds}
          runs={runs}
          profiles={profiles}
          beans={beans}
          calibrationPasses={calibrationPasses}
          snapshots={calibrationSnapshots}
          onExportEverything={onExportEverything}
          onExportType={onExportType}
          onImportBackup={onImportBackup}
          onRestoreBackup={onRestoreBackup}
          onFormatStorage={onFormatStorage}
          restoreBlockedReason={restoreBlockedReason}
          prunableLogIds={prunableLogIds}
          onPruneDeviceLogs={onPruneDeviceLogs}
          onDeleteRun={onDeleteRun}
          onDeleteProfile={onDeleteProfile}
          onDeleteBean={onDeleteBean}
          onDeleteCalibrationSnapshot={onDeleteCalibrationSnapshot}
        />
        <div className="storage-grid">
          <div className="storage-cell">
            <Cpu size={18} />
            <span>Firmware slot</span>
            <strong>
              {formatBytes(status.storage?.appUsedBytes)} / {formatBytes(status.storage?.appSlotBytes)}
            </strong>
            <small>
              {formatBytes(status.storage?.appFreeBytes)} available for firmware — a different partition from the data
              above
            </small>
          </div>
        </div>
        {dataSync.adoption && (
          <div className="dev-tools" role="group" aria-label="Adopt local data">
            <div>
              <strong>The roaster is holding no data yet</strong>
              <span>
                Put this browser's existing data onto the empty roaster once. After adoption, the roaster owns it and
                every browser reads the same records.
              </span>
            </div>
            <button
              type="button"
              className="primary-button"
              disabled={syncBusy}
              onClick={() => {
                setSyncBusy(true)
                void onAdoptData().finally(() => setSyncBusy(false))
              }}
            >
              <Database size={17} />
              Adopt existing data
            </button>
            <button type="button" className="secondary-button" onClick={onDismissAdoption}>
              Not now
            </button>
          </div>
        )}
        {onReloadDemoData && (
          <div className="dev-tools" role="group" aria-label="Development tools">
            <div>
              <strong>Development dataset</strong>
              <span>Replace the mock roaster's catalog with the rich demo dataset.</span>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={demoBusy}
              onClick={() => {
                if (!window.confirm('Replace all mock Crackle data with the demo dataset?')) return
                setDemoBusy(true)
                void onReloadDemoData().finally(() => setDemoBusy(false))
              }}
            >
              <Database size={17} />
              {demoBusy ? 'Loading…' : 'Reset demo data'}
            </button>
          </div>
        )}
      </section>

      <button type="button" className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}>
        {advanced ? <ChevronDown size={18} /> : <ChevronRight size={18} />}Advanced
      </button>
      {advanced && (
        <div className="advanced-panel">
          <div className="advanced-actions">
            <a className="secondary-button" href={firmwareUpdateHref} target="_blank" rel="noreferrer">
              <ExternalLink size={17} />
              Firmware update
            </a>
            <a className="secondary-button" href={rawStatusHref} target="_blank" rel="noreferrer">
              <ExternalLink size={17} />
              Raw status
            </a>
          </div>
          <TransportDiagnostics status={status} />
          <SystemDiagnostics status={status} />
          <MockPowerCycleControl
            status={status}
            onPowerCycleMock={onPowerCycleMock}
            onSetProbeAvailable={onSetMockProbeAvailable}
            onDropLiveStream={onDropMockLiveStream}
          />
          <AdvancedStatusSnapshot status={status} />
        </div>
      )}
    </section>
  )
}
