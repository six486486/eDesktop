const { randomUUID } = require('node:crypto')
const { recordOperation } = require('./task-memory.cjs')

function runningTimers(workspace) {
  return workspace.widgets.filter(widget => widget.kind === 'pomodoro' && widget.data.running && Number.isFinite(widget.data.endsAt))
}
function clockState(widget, now) {
  return { widgetId: widget.id, mode: widget.data.mode, remainingSeconds: Math.max(0, Math.ceil((widget.data.endsAt - now) / 1000)) }
}

class FocusService {
  constructor({ host, onChange = () => {}, onComplete = () => {}, onError = console.warn, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { host, onChange, onComplete, onError, now, setTimer, clearTimer })
    this.calls = new Map()
    this.disposed = false
    this.timer = null
    this.pending = Promise.resolve()
  }
  snapshot() {
    const running = runningTimers(this.host.read())
    const owned = running.find(widget => widget.data.mode === 'focus' && widget.data.petFocus?.status === 'active')
    return { running: Boolean(owned), ...(owned ? clockState(owned, this.now()) : {}) }
  }
  context() {
    const workspace = this.host.read(), active = runningTimers(workspace)
    const selected = active[0] || workspace.widgets.find(widget => widget.kind === 'pomodoro' && !widget.hidden)
      || workspace.widgets.find(widget => widget.kind === 'pomodoro')
    return {
      state: active.length > 1 ? 'multiple' : active.length ? active[0].data.mode : 'idle',
      activeCount: active.length, defaultMinutes: selected?.data.focusMinutes || 25,
    }
  }
  start() {
    this.unsubscribe = this.host.subscribe(() => this.refresh())
    this.refresh()
  }
  refresh() {
    if (this.disposed) return
    this.clearTimer(this.timer)
    this.onChange(this.snapshot())
    const active = runningTimers(this.host.read())
    if (!active.length) return
    const next = Math.min(...active.map(widget => widget.data.endsAt))
    this.timer = this.setTimer(() => {
      this.pending = this.completeDue().catch(error => this.onError('[pet focus] 计时状态未能保存。', error))
    }, Math.min(60000, Math.max(0, next - this.now())))
    this.timer?.unref?.()
  }
  async completeDue() {
    if (this.disposed) return
    const result = await this.host.transact(workspace => {
      const events = []
      for (const widget of runningTimers(workspace)) {
        const data = widget.data, focus = data.petFocus
        if (!['focus', 'break'].includes(data.mode) || data.endsAt > this.now()) continue
        const petStarted = data.mode === 'focus' && focus?.status === 'active'
        const nextMode = data.mode === 'focus' ? 'break' : 'focus'
        events.push({ id: petStarted ? focus.id : `timer/${widget.id}/${data.mode}/${data.endsAt}`,
          mode: data.mode, minutes: petStarted ? focus.minutes : data.mode === 'focus' ? data.focusMinutes : data.breakMinutes, widgetId: widget.id })
        widget.data = { ...data, mode: nextMode, running: false, endsAt: null,
          remainingSeconds: (nextMode === 'focus' ? data.focusMinutes : data.breakMinutes) * 60,
          sessions: (data.sessions || 0) + (data.mode === 'focus' ? 1 : 0),
          petFocus: petStarted ? { ...focus, status: 'completed' } : null }
      }
      return { changed: events.length > 0, value: { events } }
    }, () => !this.disposed)
    for (const event of result.events || []) this.onComplete(event)
    this.refresh()
  }
  execute(call, { runId, isCurrent = () => true, sourceMessage }) {
    if (this.calls.has(runId)) return this.calls.get(runId)
    const work = this.host.transact(workspace => {
      const edit = this.edit(workspace, call)
      if (edit.changed) recordOperation(workspace, { id: runId, name: call.name, activity: call.activity || '',
        minutes: edit.value.minutes, widgetId: edit.value.widgetId, sessionId: edit.value.sessionId, source: sourceMessage, memoryId: call.memoryId || undefined }, this.now())
      return edit
    }, () => !this.disposed && isCurrent()).catch(() => ({ status: 'failed' }))
    this.calls.set(runId, work)
    // Dedupe is local to recent runs; an active persisted clock also blocks restart.
    if (this.calls.size > 64) this.calls.delete(this.calls.keys().next().value)
    return work
  }
  // All clock mutations pass through the host workspace commit.
  edit(workspace, call) {
      if (!['focus.start', 'focus.stop', 'focus.status'].includes(call.name)
        || !Number.isSafeInteger(call.minutes) || (call.name === 'focus.start'
          ? call.minutes < 0 || call.minutes > 240 || (call.explicitMinutes && call.minutes === 0) : call.minutes !== 0)) {
        return { value: { status: 'invalid-arguments' } }
      }
      const active = runningTimers(workspace)
      if (active.length > 1) return { value: { status: 'ambiguous' } }
      if (call.name === 'focus.status') return { value: active.length
        ? { status: 'running', ...clockState(active[0], this.now()) } : { status: 'idle' } }
      if (call.name === 'focus.stop') {
        if (!active.length) return { value: { status: 'idle' } }
        const widget = active[0], state = clockState(widget, this.now())
        widget.data = { ...widget.data, running: false, endsAt: null, remainingSeconds: state.remainingSeconds, petFocus: null }
        return { changed: true, value: { status: 'stopped', ...state } }
      }
      if (active.length) return { value: { status: 'already-running', ...clockState(active[0], this.now()) } }
      let widget = workspace.widgets.find(item => item.kind === 'pomodoro' && !item.hidden)
        || workspace.widgets.find(item => item.kind === 'pomodoro')
      if (!widget) { widget = this.host.createWidget(workspace); workspace.widgets.push(widget) }
      const minutes = call.minutes || widget.data.focusMinutes
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) return { value: { status: 'invalid-arguments' } }
      const id = randomUUID()
      // A one-off requested duration does not change the user's default duration.
      widget.hidden = false
      widget.data = { ...widget.data, mode: 'focus', running: true, remainingSeconds: minutes * 60,
        endsAt: this.now() + minutes * 60000, petFocus: { id, minutes, status: 'active' } }
      return { changed: true, value: { status: 'started', minutes, sessionId: id, ...clockState(widget, this.now()) } }
  }
  async dispose() {
    this.disposed = true
    this.clearTimer(this.timer)
    this.unsubscribe?.()
    await Promise.allSettled([this.pending, ...this.calls.values()])
  }
}
module.exports = { FocusService }
