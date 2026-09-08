import { Coffee, Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { clamp } from '../lib/desktopGeometry'
import { getPomodoroNextTickDelay, getPomodoroRemainingSeconds } from '../pomodoroTiming'
import type { DesktopWidget, PomodoroWidgetData } from '../types'

const defaultPomodoro: PomodoroWidgetData = {
  mode: 'focus',
  focusMinutes: 25,
  breakMinutes: 5,
  remainingSeconds: 25 * 60,
  running: false,
  endsAt: null,
  sessions: 0,
}

function FlipDigit({ value, position }: { value: string; position: string }) {
  const settledValue = useRef(value)
  const [transition, setTransition] = useState<{
    from: string
    to: string
    key: number
  } | null>(null)

  useEffect(() => {
    const from = settledValue.current
    if (value === from) return undefined
    settledValue.current = value
    const key = Date.now()
    setTransition({ from, to: value, key })
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(() => {
      setTransition((current) => current?.key === key ? null : current)
    }, reducedMotion ? 0 : 480)
    return () => window.clearTimeout(timer)
  }, [value])

  const currentValue = transition?.to ?? settledValue.current
  const lowerValue = transition?.from ?? currentValue
  const glyph = (digit: string) => <span className="flip-digit-glyph" data-value={digit} />

  return (
    <span className={`flip-digit ${transition ? 'is-flipping' : ''}`} data-position={position} aria-hidden="true">
      <span className="flip-digit-leaf-stage flip-digit-leaf-stage-top flip-digit-static-stage">
        <span className="flip-digit-leaf flip-digit-face-top flip-digit-static-top">
          {glyph(currentValue)}
        </span>
      </span>
      <span className="flip-digit-leaf-stage flip-digit-leaf-stage-bottom flip-digit-static-stage">
        <span className="flip-digit-leaf flip-digit-face-bottom flip-digit-static-bottom">
          {glyph(lowerValue)}
        </span>
      </span>
      {transition && (
        <span key={`${position}-${transition.key}`} className="flip-digit-animation">
          <span className="flip-digit-leaf-stage flip-digit-leaf-stage-top">
            <span className="flip-digit-leaf flip-digit-face-top flip-digit-leaf-out">
              {glyph(transition.from)}
            </span>
          </span>
          <span className="flip-digit-leaf-stage flip-digit-leaf-stage-bottom">
            <span className="flip-digit-leaf flip-digit-face-bottom flip-digit-leaf-in">
              {glyph(transition.to)}
            </span>
          </span>
        </span>
      )}
      <span className="flip-digit-seam" />
    </span>
  )
}

export function PomodoroWidget({ widget, settingsOpen, onCloseSettings, onUpdate, completionManaged = false }: {
  widget: DesktopWidget
  settingsOpen: boolean
  onCloseSettings: () => void
  onUpdate?: (data: PomodoroWidgetData) => Promise<unknown>
  completionManaged?: boolean
}) {
  const data = { ...defaultPomodoro, ...(widget.data as PomodoroWidgetData) }
  const [now, setNow] = useState(Date.now())
  const [focusDraft, setFocusDraft] = useState(String(data.focusMinutes))
  const [breakDraft, setBreakDraft] = useState(String(data.breakMinutes))
  const completing = useRef(false)
  const fallbackDuration = (data.mode === 'focus' ? data.focusMinutes : data.breakMinutes) * 60
  const storedRemaining = Number.isFinite(data.remainingSeconds)
    ? Math.max(0, Math.round(data.remainingSeconds))
    : fallbackDuration
  const activeEndsAt = data.running && typeof data.endsAt === 'number' ? data.endsAt : null
  const remaining = activeEndsAt !== null
    ? getPomodoroRemainingSeconds(activeEndsAt, now)
    : storedRemaining

  useEffect(() => {
    if (!data.running || typeof data.endsAt !== 'number') return undefined

    const endsAt = data.endsAt
    let timer = 0
    let disposed = false
    const tickAtSecondBoundary = () => {
      const tickedAt = Date.now()
      setNow(tickedAt)

      const delay = getPomodoroNextTickDelay(endsAt, tickedAt)
      if (!disposed && delay !== null) {
        timer = window.setTimeout(tickAtSecondBoundary, delay)
      }
    }

    tickAtSecondBoundary()
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [data.endsAt, data.running])

  useEffect(() => {
    if (!settingsOpen) return
    setFocusDraft(String(data.focusMinutes))
    setBreakDraft(String(data.breakMinutes))
  }, [data.breakMinutes, data.focusMinutes, settingsOpen])

  useEffect(() => {
    if (!data.running || remaining > 0 || completing.current) return
    // With the pet enabled, the main process saves each completed phase before
    // notifying. A renderer must not consume that deadline first.
    if (completionManaged) return
    completing.current = true
    const nextMode = data.mode === 'focus' ? 'break' : 'focus'
    const duration = nextMode === 'focus' ? data.focusMinutes : data.breakMinutes
    const next: PomodoroWidgetData = {
      ...data,
      mode: nextMode,
      remainingSeconds: duration * 60,
      running: false,
      endsAt: null,
      sessions: data.sessions + (data.mode === 'focus' ? 1 : 0),
      petFocus: null,
    }
    const saved = onUpdate ? onUpdate(next) : window.desktopAPI?.updateWidget(widget.id, { data: next })
    saved?.finally(() => {
      completing.current = false
    })
  }, [data, remaining, widget.id, onUpdate, completionManaged])

  const update = (next: Partial<PomodoroWidgetData>) => {
    const updated = { ...data, ...next }
    return onUpdate ? onUpdate(updated) : window.desktopAPI?.updateWidget(widget.id, { data: updated })
  }
  const saveDurations = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const focusMinutes = clamp(Math.round(Number(focusDraft) || data.focusMinutes), 1, 240)
    const breakMinutes = clamp(Math.round(Number(breakDraft) || data.breakMinutes), 1, 120)
    const remainingSeconds = (data.mode === 'focus' ? focusMinutes : breakMinutes) * 60
    setFocusDraft(String(focusMinutes))
    setBreakDraft(String(breakMinutes))
    void update({
      focusMinutes,
      breakMinutes,
      remainingSeconds,
      running: false,
      endsAt: null,
      petFocus: null,
    })?.then(onCloseSettings)
  }
  const toggle = () => {
    if (data.running) {
      const pausedAt = Date.now()
      const pausedRemaining = typeof data.endsAt === 'number'
        ? getPomodoroRemainingSeconds(data.endsAt, pausedAt)
        : remaining
      setNow(pausedAt)
      update({ running: false, endsAt: null, remainingSeconds: pausedRemaining })
    } else {
      const startedAt = Date.now()
      const startRemaining = remaining > 0 ? remaining : fallbackDuration
      setNow(startedAt)
      update({ running: true, endsAt: startedAt + startRemaining * 1000, remainingSeconds: startRemaining })
    }
  }
  const reset = () => {
    const minutes = data.mode === 'focus' ? data.focusMinutes : data.breakMinutes
    update({ running: false, endsAt: null, remainingSeconds: minutes * 60, petFocus: null })
  }
  const skip = () => {
    const nextMode = data.mode === 'focus' ? 'break' : 'focus'
    const minutes = nextMode === 'focus' ? data.focusMinutes : data.breakMinutes
    update({ mode: nextMode, running: false, endsAt: null, remainingSeconds: minutes * 60, petFocus: null })
  }
  const minutes = Math.floor(remaining / 60).toString().padStart(2, '0')
  const seconds = (remaining % 60).toString().padStart(2, '0')
  const total = (data.mode === 'focus' ? (data.petFocus?.status === 'active' ? data.petFocus.minutes : data.focusMinutes) : data.breakMinutes) * 60
  const progress = total > 0 ? Math.max(0, Math.min(100, ((total - remaining) / total) * 100)) : 0

  if (settingsOpen) {
    return (
      <form className="pomodoro-settings" onSubmit={saveDurations}>
        <strong>计时时长</strong>
        <label>
          <span>专注时间</span>
          <span className="pomodoro-duration-input">
            <input
              name="focusMinutes"
              type="number"
              min="1"
              max="240"
              step="1"
              value={focusDraft}
              onChange={(event) => setFocusDraft(event.currentTarget.value)}
            />
            <small>分钟</small>
          </span>
        </label>
        <label>
          <span>休息时间</span>
          <span className="pomodoro-duration-input">
            <input
              name="breakMinutes"
              type="number"
              min="1"
              max="120"
              step="1"
              value={breakDraft}
              onChange={(event) => setBreakDraft(event.currentTarget.value)}
            />
            <small>分钟</small>
          </span>
        </label>
        <button type="submit">保存设置</button>
      </form>
    )
  }

  return (
    <div className="pomodoro-widget-content">
      <span className={`timer-mode mode-${data.mode}`}>{data.mode === 'focus' ? '专注时间' : '休息时间'}</span>
      <div className="desktop-timer-value" aria-label={`${minutes}:${seconds}`}>
        {[...minutes].map((digit, index) => <FlipDigit key={`minute-${index}`} value={digit} position={`minute-${index}`} />)}
        <span className="timer-separator" aria-hidden="true" />
        {[...seconds].map((digit, index) => <FlipDigit key={`second-${index}`} value={digit} position={`second-${index}`} />)}
        <span className="timer-accessible-value">{minutes}:{seconds}</span>
      </div>
      <div className="desktop-timer-progress"><i style={{ width: `${progress}%` }} /></div>
      <div className="desktop-timer-controls">
        <button type="button" onClick={reset} aria-label="重置"><RotateCcw size={15} /></button>
        <button type="button" className="timer-toggle" onClick={toggle} aria-label={data.running ? '暂停' : '开始'}>
          {data.running ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          type="button"
          className={`timer-mode-switch ${data.mode === 'break' ? 'is-break' : ''}`}
          onClick={skip}
          aria-label={data.mode === 'focus' ? '进入休息时间' : '返回专注时间'}
          aria-pressed={data.mode === 'break'}
        >
          <Coffee size={15} />
        </button>
      </div>
    </div>
  )
}
