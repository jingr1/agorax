const STORAGE_KEY = 'agorax-product-update-auto-check'
export const PRODUCT_UPDATE_AUTO_CHECK_EVENT =
  'agorax-product-update-auto-check'

export function readProductUpdateAutoCheckEnabled(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return true
    return raw !== '0' && raw !== 'false'
  } catch {
    return true
  }
}

export function writeProductUpdateAutoCheckEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
    window.dispatchEvent(new Event(PRODUCT_UPDATE_AUTO_CHECK_EVENT))
  } catch {
    // Ignore quota / private-mode failures.
  }
}
