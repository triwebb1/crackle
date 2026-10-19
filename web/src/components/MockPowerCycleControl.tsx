import { Power } from 'lucide-preact'
import { useState } from 'preact/hooks'
import type { ControllerStatus } from '../domain/types'

interface MockPowerCycleControlProps {
  status: Pick<ControllerStatus, 'roaster'>
  onPowerCycleMock?: () => Promise<string>
  onSetProbeAvailable?: (available: boolean) => Promise<string>
  /** Severs every live WebSocket subscriber so the reconnect-and-resync path can be exercised. */
  onDropLiveStream?: () => Promise<string>
  /** Test seam; Settings relies on Vite's compile-time development flag. */
  development?: boolean
}

export const mockPowerCycleAvailable = (
  status: Pick<ControllerStatus, 'roaster'>,
  action: MockPowerCycleControlProps['onPowerCycleMock'],
  development: boolean,
) => development && status.roaster?.simulated === true && action !== undefined

/**
 * A local-simulation recovery tool, intentionally absent from real-device and production views.
 *
 * The action is injected rather than fetching here so Settings stays on the app's single controller
 * surface. The mock endpoint itself only exists in Vite's serve-only controller plugin.
 */
export function MockPowerCycleControl({
  status,
  onPowerCycleMock,
  onSetProbeAvailable,
  onDropLiveStream,
  development = import.meta.env.DEV,
}: MockPowerCycleControlProps) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  if (!mockPowerCycleAvailable(status, onPowerCycleMock, development)) return null

  const powerCycle = async () => {
    if (!onPowerCycleMock || busy) return
    if (
      !window.confirm(
        'Power-cycle the simulated roaster? Device-stored profiles, beans, roast records, recordings, and calibration will remain. Any roast, calibration, or manual control currently in progress will stop and its unsaved runtime work will be discarded.',
      )
    )
      return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      setMessage(await onPowerCycleMock())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The simulated roaster could not be power-cycled')
    } finally {
      setBusy(false)
    }
  }

  const setProbeAvailable = async (available: boolean) => {
    if (!onSetProbeAvailable || busy) return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      setMessage(await onSetProbeAvailable(available))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The simulated probe state could not be changed')
    } finally {
      setBusy(false)
    }
  }

  const dropLiveStream = async () => {
    if (!onDropLiveStream || busy) return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      setMessage(await onDropLiveStream())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The simulated live stream could not be dropped')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mock-power-cycle" role="group" aria-label="Simulated roaster recovery">
      <div>
        <strong>Local simulation only</strong>
        <span>
          Power-cycle the mock controller to test recovery. Stored device data remains; active runtime work is
          discarded. Drop the live stream during a roast to watch the trace resync fill the hole.
        </span>
      </div>
      <div className="advanced-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void powerCycle()}>
          <Power size={17} />
          {busy ? 'Working…' : 'Power-cycle mock roaster'}
        </button>
        {onSetProbeAvailable && (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void setProbeAvailable(false)}
            >
              Disconnect probe
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void setProbeAvailable(true)}
            >
              Reconnect probe
            </button>
          </>
        )}
        {onDropLiveStream && (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void dropLiveStream()}>
            Drop live stream
          </button>
        )}
      </div>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
      {message && (
        <span className="import-message" role="status">
          {message}
        </span>
      )}
    </div>
  )
}
