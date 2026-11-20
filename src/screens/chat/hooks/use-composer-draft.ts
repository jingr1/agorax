import { useCallback, useEffect, useState } from 'react'

export function useComposerDraft(sessionKey?: string) {
  const key = `claude-draft-${sessionKey?.trim() || 'new'}`
  const [value, setValue] = useState('')
  useEffect(() => {
    if (typeof window !== 'undefined') setValue(window.sessionStorage.getItem(key) ?? '')
  }, [key])
  const persistDraft = useCallback((nextValue: string) => {
    if (typeof window === 'undefined') return
    if (nextValue.length === 0) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, nextValue)
  }, [key])
  const clearDraft = useCallback(() => {
    setValue('')
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(key)
  }, [key])
  return { value, setValue, persistDraft, clearDraft }
}