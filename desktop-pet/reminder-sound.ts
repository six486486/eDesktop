import { useEffect, useRef } from 'react'
import meowUrl from './sounds/meow.wav?url'
import type { PetState } from './types'

export function createMeowPlayer() {
  const audio = new Audio(meowUrl)
  audio.preload = 'auto'; audio.volume = 0.5
  audio.addEventListener('playing', () => window.petAPI?.setMeowing(true))
  for (const event of ['pause', 'ended', 'error']) audio.addEventListener(event, () => window.petAPI?.setMeowing(false))
  return {
    async play() {
      audio.pause(); audio.currentTime = 0
      try { await audio.play(); return true } catch { return false }
    },
    stop() { audio.pause(); audio.currentTime = 0 },
  }
}

// Only the reminder bubble owns automatic playback. Shared state broadcasts to
// the pet and chat cannot multiply the sound or replay a finished notice.
export function useReminderSound(state: PetState) {
  const player = useRef<ReturnType<typeof createMeowPlayer> | null>(null)
  const handled = useRef<string | null>(null)
  const notice = state.focusNotice
  const quiet = state.enabled === false || state.reminderSoundEnabled === false
    || Boolean(state.voiceBubble)
    || state.voice?.phase === 'requesting' || state.voice?.phase === 'recording'
  useEffect(() => {
    player.current = createMeowPlayer()
    return () => { player.current?.stop(); player.current = null }
  }, [])
  useEffect(() => { if (quiet) player.current?.stop() }, [quiet])
  useEffect(() => {
    if (!notice || handled.current === notice.id) return
    // Defer until the effect survives React StrictMode's setup/cleanup pass.
    const timer = setTimeout(() => {
      handled.current = notice.id
      if (!quiet && notice.expiresAt > Date.now()) void player.current?.play()
    }, 0)
    return () => clearTimeout(timer)
  }, [notice?.id, notice?.expiresAt, quiet])
}
