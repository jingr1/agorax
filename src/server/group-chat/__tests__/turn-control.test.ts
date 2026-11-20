import { describe, expect, it, vi } from 'vitest'
import { cancelRoomTurns, hasActiveRoomTurns, registerRoomTurn } from '../turn-control'

describe('precise room turn cancellation', () => {
  it('does not release an exited executor before cancellation confirmation', async () => {
    const turn = registerRoomTurn('exit-before-stop')
    let confirm!: () => void
    turn.bindCancel(() => new Promise<void>((resolve) => { confirm = resolve }))
    const pause = cancelRoomTurns('exit-before-stop')
    await Promise.resolve()
    turn.finish()
    expect(hasActiveRoomTurns('exit-before-stop')).toBe(true)
    confirm()
    await pause
    expect(hasActiveRoomTurns('exit-before-stop')).toBe(false)
  })
  it('retains Pause until a late run target is bound and terminal is confirmed', async () => {
    const turn = registerRoomTurn('late-run')
    let completed = false
    const pausing = cancelRoomTurns('late-run').then(() => { completed = true })
    expect(turn.signal.aborted).toBe(true)
    const stop = vi.fn().mockResolvedValue({ status: 'cancel_requested' })
    turn.bindCancel(stop)
    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
    expect(completed).toBe(false)
    expect(hasActiveRoomTurns('late-run')).toBe(true)
    turn.finish()
    await pausing
    expect(hasActiveRoomTurns('late-run')).toBe(false)
  })

  it('cancels only the requested room and deduplicates concurrent Pause', async () => {
    const first = registerRoomTurn('room-a')
    const other = registerRoomTurn('room-b')
    const stop = vi.fn().mockResolvedValue(undefined)
    first.bindCancel(stop)
    const requests = [cancelRoomTurns('room-a'), cancelRoomTurns('room-a')]
    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
    expect(other.signal.aborted).toBe(false)
    first.finish()
    other.finish()
    await Promise.all(requests)
  })

  it('reports cancellation failure without claiming terminal settlement', async () => {
    const turn = registerRoomTurn('failed-stop')
    turn.bindCancel(() => Promise.reject(new Error('Gateway offline')))
    await expect(cancelRoomTurns('failed-stop')).rejects.toThrow('Gateway offline')
    expect(hasActiveRoomTurns('failed-stop')).toBe(true)
    turn.finish()
  })

  it('can retry a failed precise cancellation', async () => {
    const turn = registerRoomTurn('retry-stop')
    const stop = vi.fn().mockRejectedValueOnce(new Error('Temporary outage')).mockResolvedValueOnce(undefined)
    turn.bindCancel(stop)
    await expect(cancelRoomTurns('retry-stop')).rejects.toThrow('Temporary outage')
    const retry = cancelRoomTurns('retry-stop')
    await Promise.resolve()
    expect(stop).toHaveBeenCalledTimes(2)
    turn.finish()
    await retry
  })

  it('bounds Pause without treating a cancellation request as terminal', async () => {
    const turn = registerRoomTurn('stop-timeout')
    await expect(cancelRoomTurns('stop-timeout', 1)).rejects.toThrow('still stopping')
    expect(hasActiveRoomTurns('stop-timeout')).toBe(true)
    turn.finish()
  })
})