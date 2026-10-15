import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MemberAvatar } from './member-avatar'
import { countRoomAgentProviderSiblings } from '../lib/avatar-utils'
import type { RoomParticipant } from '@/lib/group-chat-types'

interface MentionToken {
  query: string
  /** Index of the '@' character in the full string. */
  start: number
}

interface MentionOption {
  handle: string
  meta: string
  participant: RoomParticipant | null
}

type MentionPickerProps = {
  value: string
  participants: Array<RoomParticipant>
  onChange: (value: string) => void
  onSubmit?: () => void
  placeholder?: string
  autoFocus?: boolean
  'aria-label'?: string
}

function mentionTokenAt(text: string, caret: number): MentionToken | null {
  const upto = String(text || '').slice(0, caret)
  const match = /(^|\s)@([a-z0-9._-]*)$/i.exec(upto)
  if (!match) return null
  return { query: match[2].toLowerCase(), start: caret - match[2].length - 1 }
}

function buildOptions(
  token: MentionToken,
  participants: Array<RoomParticipant>,
): Array<MentionOption> {
  const out: Array<MentionOption> = []
  if ('all'.startsWith(token.query)) {
    out.push({ handle: 'all', meta: 'Notify everyone', participant: null })
  }
  for (const p of participants) {
    const handle = p.mentionName.trim()
    const display = p.displayName.trim()
    if (!handle) continue
    if (
      token.query &&
      !handle.toLowerCase().startsWith(token.query) &&
      !display.toLowerCase().startsWith(token.query)
    ) {
      continue
    }
    out.push({ handle, meta: display, participant: p })
  }
  return out
}

/** Scroll `el` into view inside its overflow parent — never touch page scroll. */
function scrollChildIntoParent(parent: HTMLElement, child: HTMLElement): void {
  const pTop = parent.getBoundingClientRect().top
  const pBottom = parent.getBoundingClientRect().bottom
  const cTop = child.getBoundingClientRect().top
  const cBottom = child.getBoundingClientRect().bottom
  if (cTop < pTop) {
    parent.scrollTop -= pTop - cTop
  } else if (cBottom > pBottom) {
    parent.scrollTop += cBottom - pBottom
  }
}

export function MentionPicker({
  value,
  participants,
  onChange,
  onSubmit,
  placeholder,
  autoFocus,
  'aria-label': ariaLabel,
}: MentionPickerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  const [token, setToken] = useState<MentionToken | null>(null)
  const [selected, setSelected] = useState(0)
  // After keyboard nav, ignore pointer until the user actually moves the mouse.
  const suppressPointerRef = useRef(false)
  // Live index for Enter/Tab — avoids applying a stale `active` if the user
  // presses Enter immediately after ArrowUp/Down before the next render.
  const selectedRef = useRef(0)

  const options = useMemo(
    () => (token ? buildOptions(token, participants) : []),
    [token, participants],
  )
  const open = Boolean(token) && options.length > 0
  const active = open ? Math.min(selected, options.length - 1) : 0
  selectedRef.current = active

  // Keep highlight and scroll in sync after every selected-index change.
  useLayoutEffect(() => {
    if (!open) return
    const dropdown = dropdownRef.current
    const btn = optionRefs.current[active]
    if (!dropdown || !btn) return
    scrollChildIntoParent(dropdown, btn)
  }, [active, open, options.length])

  const refreshToken = (el: HTMLTextAreaElement) => {
    const next = mentionTokenAt(el.value, el.selectionStart)
    setToken(next)
    setSelected(0)
    suppressPointerRef.current = false
  }

  const applyPick = (handle: string) => {
    const el = inputRef.current
    if (!token || !el) return
    const caret = el.selectionStart
    const next = `${value.slice(0, token.start)}@${handle} ${value.slice(caret)}`
    onChange(next)
    setToken(null)
    setSelected(0)
    const pos = token.start + handle.length + 2
    requestAnimationFrame(() => {
      el.focus()
      try {
        el.setSelectionRange(pos, pos)
      } catch {
        /* ignore */
      }
    })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return

    if (open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        suppressPointerRef.current = true
        setSelected((cur) => {
          const next = (Math.min(cur, options.length - 1) + 1) % options.length
          selectedRef.current = next
          return next
        })
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        suppressPointerRef.current = true
        setSelected((cur) => {
          const next =
            (Math.min(cur, options.length - 1) - 1 + options.length) %
            options.length
          selectedRef.current = next
          return next
        })
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const idx = Math.min(selectedRef.current, options.length - 1)
        applyPick(options[idx].handle)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setToken(null)
        setSelected(0)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit?.()
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      {open ? (
        <div
          ref={dropdownRef}
          className="absolute bottom-full left-0 z-50 mb-2 w-64 max-h-72 overflow-y-auto overscroll-contain rounded-xl border p-1 shadow-2xl"
          style={{
            background: 'var(--theme-card)',
            borderColor: 'var(--theme-border)',
          }}
        >
          {options.map((option, index) => (
            <button
              key={`${option.handle}:${option.meta}`}
              ref={(node) => {
                optionRefs.current[index] = node
              }}
              type="button"
              tabIndex={-1}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
              style={{
                background:
                  index === active
                    ? 'var(--theme-hover, var(--theme-accent-subtle))'
                    : 'transparent',
                color: 'var(--theme-text)',
              }}
              onMouseDown={(event) => {
                event.preventDefault() // keep textarea focused
                applyPick(option.handle)
              }}
              onMouseMove={(event) => {
                // Ignore zero-delta events; only real pointer motion counts.
                if (!event.movementX && !event.movementY) return
                suppressPointerRef.current = false
                if (selected === index) return
                setSelected(index)
              }}
              onMouseEnter={() => {
                if (suppressPointerRef.current) return
                if (selected === index) return
                setSelected(index)
              }}
            >
              {option.participant ? (
                <MemberAvatar
                  id={option.participant.participantId}
                  name={option.participant.displayName}
                  kind={option.participant.kind}
                  size={24}
                  runtime={option.participant.runtime}
                  providerSiblingCount={countRoomAgentProviderSiblings(
                    participants,
                    option.participant.runtime,
                  )}
                />
              ) : (
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold bg-slate-600 text-white">
                  @
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">@{option.handle}</div>
                <div className="truncate text-xs opacity-70">{option.meta}</div>
              </div>
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        value={value}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value)
          refreshToken(event.target)
        }}
        onKeyDown={handleKeyDown}
        onClick={(event) => refreshToken(event.currentTarget)}
        onBlur={() => {
          // Delay so mousedown on a suggestion can fire before blur clears token.
          setTimeout(() => {
            if (document.activeElement !== inputRef.current) {
              setToken(null)
              setSelected(0)
            }
          }, 100)
        }}
        onFocus={(event) => refreshToken(event.currentTarget)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        rows={1}
        className="field-bare w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-1"
        style={{
          minHeight: '2.5rem',
          maxHeight: '10rem',
          borderColor: 'var(--theme-border)',
          color: 'var(--theme-text)',
        }}
      />
    </div>
  )
}
