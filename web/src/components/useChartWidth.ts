import { useEffect, useState } from 'preact/hooks'
import { chartViewWidth } from '../domain/chartAxis'

/**
 * The viewBox width the charts should draw themselves in on this viewport.
 *
 * The arithmetic is in `chartAxis.ts` and is pure; this is the three lines of DOM around it. Two
 * details matter:
 *
 *   - **It reads `window` defensively.** Every render test in this repo runs under
 *     `preact-render-to-string` in a Node environment, so there is no window at all - and the
 *     fallback is the full-width default, which is why the server-rendered markup is the desktop
 *     rendering, byte for byte.
 *   - **It listens for resize**, because a phone rotating is exactly the case this exists for, and
 *     a chart that only measured the viewport it was mounted in would be wrong for the rest of the
 *     session. `chartViewWidth` snaps to a small set of steps, so the state settles immediately and
 *     a drag across a resize cannot start a render loop.
 */
export function useChartWidth(): number {
  const [width, setWidth] = useState(() =>
    chartViewWidth(typeof window === 'undefined' ? undefined : window.innerWidth),
  )
  useEffect(() => {
    const measure = () => setWidth(chartViewWidth(window.innerWidth))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return width
}
