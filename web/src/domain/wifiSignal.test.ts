import { describe, expect, it } from 'vitest'
import { WEAK_WIFI_DBM, weakWifiNotice } from './wifiSignal'

describe('the weak roaster Wi-Fi notice', () => {
  it('stays quiet at a usable signal and when nothing is reported', () => {
    expect(weakWifiNotice(-68)).toBeUndefined()
    expect(weakWifiNotice(WEAK_WIFI_DBM + 1)).toBeUndefined()
    expect(weakWifiNotice(undefined)).toBeUndefined()
    expect(weakWifiNotice(Number.NaN)).toBeUndefined()
    // 0 dBm is what an unassociated radio reports, not a strong signal or a weak one.
    expect(weakWifiNotice(0)).toBeUndefined()
  })

  it('names the reading and the remedy once the signal is weak', () => {
    expect(weakWifiNotice(WEAK_WIFI_DBM)).toContain(`(${WEAK_WIFI_DBM} dBm)`)
    const notice = weakWifiNotice(-85)!
    expect(notice).toContain('weak (-85 dBm)')
    expect(notice).toContain('Wi-Fi extender')
  })
})
