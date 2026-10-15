import { useCallback, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  chatQueryKeys,
  clearHistoryMessages,
  removeSessionFromCache,
} from '../chat-queries'
import { clearPendingSendForSession, resetPendingSend } from '../pending-send'
import { clearSessionDeleted, markSessionDeleted } from '../session-tombstones'
import { readError } from '../utils'
import { clearSessionTitleState } from '../session-title-store'
import { useProfiles } from './use-profiles'

export type DeleteSessionResult = {
  deleteSession: (
    sessionKey: string,
    friendlyId: string,
    isActive: boolean,
  ) => Promise<void>
  deleting: boolean
  error: string | null
}

export function useDeleteSession(): DeleteSessionResult {
  const queryClient = useQueryClient()
  const { activeProfileName } = useProfiles()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sessionsKey = chatQueryKeys.sessionsForProfile(activeProfileName)

  const mutation = useMutation({
    mutationFn: async function deleteSessionRequest(payload: {
      sessionKey: string
      friendlyId: string
      isActive: boolean
    }) {
      const query = new URLSearchParams()
      if (payload.sessionKey) query.set('sessionKey', payload.sessionKey)
      if (payload.friendlyId) query.set('friendlyId', payload.friendlyId)
      const res = await fetch(`/api/sessions?${query.toString()}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(await readError(res))
      return payload
    },
    onMutate: async function onMutate(payload) {
      setError(null)
      markSessionDeleted(payload.sessionKey || payload.friendlyId)
      clearPendingSendForSession(payload.sessionKey, payload.friendlyId)
      await queryClient.cancelQueries({ queryKey: sessionsKey })
      const previousSessions = queryClient.getQueryData(sessionsKey)
      removeSessionFromCache(
        queryClient,
        activeProfileName,
        payload.sessionKey,
        payload.friendlyId,
      )
      if (payload.isActive && (payload.sessionKey || payload.friendlyId)) {
        clearHistoryMessages(
          queryClient,
          payload.friendlyId || payload.sessionKey,
          payload.sessionKey || payload.friendlyId,
        )
      }
      return { previousSessions, isActive: payload.isActive }
    },
    onError: function onError(err, _payload, context) {
      if (context?.previousSessions) {
        queryClient.setQueryData(sessionsKey, context.previousSessions)
      }
      clearSessionDeleted(_payload.sessionKey || _payload.friendlyId)
      setError(err instanceof Error ? err.message : String(err))
    },
    onSuccess: function onSuccess(payload) {
      if (payload.isActive) {
        resetPendingSend()
      }
      clearSessionTitleState(payload.friendlyId || payload.sessionKey)
      queryClient.invalidateQueries({ queryKey: sessionsKey })
    },
    onSettled: function onSettled() {
      setDeleting(false)
    },
  })

  const deleteSession = useCallback(
    async (sessionKey: string, friendlyId: string, isActive: boolean) => {
      if (!sessionKey && !friendlyId) return
      setDeleting(true)
      await mutation.mutateAsync({ sessionKey, friendlyId, isActive })
    },
    [mutation],
  )

  return { deleteSession, deleting, error }
}
