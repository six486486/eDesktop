const POMODORO_SECOND_MS = 1_000

export function getPomodoroRemainingSeconds(endsAt: number, now: number) {
  return Math.max(0, Math.ceil((endsAt - now) / POMODORO_SECOND_MS))
}

export function getPomodoroNextTickDelay(endsAt: number, now: number) {
  const remaining = getPomodoroRemainingSeconds(endsAt, now)
  if (remaining <= 0) return null

  const nextSecondBoundary = endsAt - (remaining - 1) * POMODORO_SECOND_MS
  return Math.max(1, nextSecondBoundary - now)
}
