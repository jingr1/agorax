import { useEffect, useState } from 'react'

function isDarkNow(): boolean {
  if (typeof document === 'undefined') return true
  const root = document.documentElement
  if (root.classList.contains('dark')) return true
  if (root.classList.contains('light')) return false
  const theme = root.getAttribute('data-theme') || ''
  return !theme.endsWith('-light')
}

/** Track dark/light from `data-theme` / `.dark` on `<html>`. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(isDarkNow)

  useEffect(() => {
    const root = document.documentElement
    const sync = () => setDark(isDarkNow())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    })
    return () => observer.disconnect()
  }, [])

  return dark
}
