export type BackgroundTaskStatus = 'running' | 'done' | 'error'

export type BackgroundTaskRecord = {
  taskId: string
  parentSessionId: string
  sessionId: string
  prompt: string
  status: BackgroundTaskStatus
  answer?: string
  error?: string
  createdAt: number
  updatedAt: number
}

const tasks = new Map<string, BackgroundTaskRecord>()

export function listBackgroundTasks(
  parentSessionId?: string,
): Array<BackgroundTaskRecord> {
  const all = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  if (!parentSessionId) return all
  return all.filter((task) => task.parentSessionId === parentSessionId)
}

export function getBackgroundTask(
  taskId: string,
): BackgroundTaskRecord | undefined {
  return tasks.get(taskId)
}

export function startBackgroundTask(input: {
  parentSessionId: string
  sessionId: string
  prompt: string
  run: () => Promise<{ answer: string; sessionId?: string }>
}): BackgroundTaskRecord {
  const taskId = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  const record: BackgroundTaskRecord = {
    taskId,
    parentSessionId: input.parentSessionId,
    sessionId: input.sessionId,
    prompt: input.prompt,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  }
  tasks.set(taskId, record)

  void (async () => {
    try {
      const result = await input.run()
      const current = tasks.get(taskId)
      if (!current) return
      tasks.set(taskId, {
        ...current,
        status: 'done',
        answer: result.answer,
        sessionId: result.sessionId || current.sessionId,
        updatedAt: Date.now(),
      })
    } catch (err) {
      const current = tasks.get(taskId)
      if (!current) return
      tasks.set(taskId, {
        ...current,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      })
    }
  })()

  return record
}
