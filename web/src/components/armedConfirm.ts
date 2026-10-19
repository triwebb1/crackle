import { useEffect, useRef, useState } from 'preact/hooks'

/**
 * Two-stage confirmation for a roast-interrupting Stop. A single accidental phone tap must not
 * abort a live roast: with the fan stopped, hot beans scorch on the base plate.
 *
 * The first activation ARMS the control — the button itself changes to its confirm wording — and
 * the second activation fires. Arming decays after a few seconds so a stray tap never leaves a
 * hair-trigger behind. This is deliberately an in-place transform rather than a dialog: the
 * control never moves, never loses focus, and a genuine emergency stop is two quick taps on the
 * same spot with nothing to re-acquire. Heat-off remains instant on the device once the command
 * is sent; only the sending is confirmed.
 */
export const ARMED_STOP_DECAY_MS = 4000

export const useArmedConfirm = (decayMs = ARMED_STOP_DECAY_MS) => {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    [],
  )
  const disarm = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
    setArmed(false)
  }
  /** Returns true when the caller should perform the guarded action. */
  const fire = (): boolean => {
    if (armed) {
      disarm()
      return true
    }
    setArmed(true)
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setArmed(false)
    }, decayMs)
    return false
  }
  return { armed, fire, disarm }
}
