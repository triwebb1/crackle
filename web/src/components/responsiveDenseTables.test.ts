import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const calibrationMesh = readFileSync(new URL('./CalibrationMesh.tsx', import.meta.url), 'utf8')
const roastView = readFileSync(new URL('./RoastView.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

describe('dense calibration and live-roast tables on a phone', () => {
  it('labels every value that becomes a card row', () => {
    for (const label of ['Airflow', '63% of move', '95% complete', 'Measured spread', 'Evidence']) {
      expect(calibrationMesh).toContain(`data-label="${label}"`)
    }
    const calibrationView = readFileSync(new URL('./CalibrationView.tsx', import.meta.url), 'utf8')
    for (const label of [
      'Coefficient',
      'Applied now',
      'Preview',
      'Change',
      'Fan : Heat',
      'Steady state',
      'Rise over ambient',
      'Tau',
      'Held / approach',
      'Advance',
    ]) {
      expect(calibrationView).toContain(`data-label="${label}"`)
    }
    const simulation = readFileSync(new URL('./ProfileSimulationPanel.tsx', import.meta.url), 'utf8')
    for (const label of ['Zone', 'Planned', 'Simulated', 'Difference', 'Reading']) {
      expect(simulation).toContain(`data-label="${label}"`)
    }
    for (const label of [
      'Applied at',
      'Fan requested',
      'Heat requested',
      'Fan delivered',
      'Heat delivered',
      'Planned',
      'Actual',
      'Drift',
      'Result',
      'Seconds',
      'Status',
      'Action',
    ]) {
      expect(roastView).toContain(`data-label="${label}"`)
    }
  })

  it('turns every dense table into labelled records at phone width', () => {
    expect(styles).toContain('@media (max-width: 560px)')
    for (const selector of [
      '.response-summary',
      '.fit-preview',
      '.live-instruction-table',
      '.journey-scorecard',
      '.timed-step-table',
      '.simulation-zones',
      '.calibration-step-detail',
    ]) {
      expect(styles).toContain(`${selector} thead`)
      expect(styles).toContain(`${selector} td::before`)
    }
    expect(styles).toContain('content: attr(data-label)')
  })
})
