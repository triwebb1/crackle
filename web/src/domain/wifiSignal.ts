/**
 * The roaster's own Wi-Fi signal, as it reports it (`station_rssi_dbm`).
 *
 * A weak roaster signal makes the phone page load slowly, go STALE, and fail to reconnect. Measured
 * at -82 to -85 dBm (against a healthy -68 dBm), the roaster showed 23% packet loss from a PC and
 * none to the router: big transfers crawled (the app bundle at ~80 B/s) and live frames fell behind.
 * Nothing else in the page can say why, so a weak signal is said out loud.
 */
export const WEAK_WIFI_DBM = -78

export const weakWifiNotice = (rssiDbm: number | undefined): string | undefined => {
  if (rssiDbm === undefined || !Number.isFinite(rssiDbm) || rssiDbm > WEAK_WIFI_DBM || rssiDbm >= 0) return undefined
  return `The roaster's Wi-Fi signal is weak (${Math.round(rssiDbm)} dBm), so pages can load slowly and the live connection can stall. Moving the roaster or the router closer, or adding a Wi-Fi extender near the roaster, fixes this.`
}
