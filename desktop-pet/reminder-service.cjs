const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { WeatherClient } = require('./weather.cjs')
const { dayKey, clockTime, atTime, parseWhen, displayWhen, timePhrases, conflictingTimeContext, clockCandidates } = require('./reminder-time.cjs')
const { recordOperation } = require('./task-memory.cjs')
const { explicitMinutes } = require('./duration.cjs')
const defaults = () => ({ revision: 0, weather: { enabled: false, city: null, time: '08:30', repeat: 'daily' }, todo: { enabled: true, leadMinutes: 5 }, events: {}, receipts: [] })
function stateOf(workspace) { const s = workspace.petReminders || {}; return { ...defaults(), ...s, weather: { ...defaults().weather, ...s.weather }, todo: { ...defaults().todo, ...s.todo } } }
function entries(workspace) { return workspace.widgets.filter(w => w.kind === 'todo').flatMap(w => (w.data.items || []).map(item => ({ widget: w, item }))) }
function contextOf(workspace) {
  const s = stateOf(workspace)
  return { revision: s.revision, weather: s.weather, todo: s.todo,
    reminders: entries(workspace).filter(({ item: i }) => i.list === 'temporary' && Number.isFinite(i.reminderAt) && !i.completed)
      .sort((a, b) => b.item.reminderAt - a.item.reminderAt).slice(0, 16).map(({ widget, item }) => ({ id: `${widget.id}/${item.id}`, text: item.text, at: item.reminderAt })) }
}
class ReminderService {
  constructor({ host, weather = new WeatherClient(), now = Date.now, onChange = () => {}, onNotice = () => {}, directory = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { host, weather, now, onChange, onNotice, directory, setTimer, clearTimer })
    this.disposed = false; this.controller = new AbortController(); this.running = Promise.resolve(); this.ticking = false
  }
  snapshot() { return contextOf(this.host.read()) }
  context() { return this.snapshot() }
  trace(event) {
    if (!this.directory) return
    try { fs.mkdirSync(this.directory, { recursive: true }); fs.appendFileSync(path.join(this.directory, 'reminder-runs.jsonl'), JSON.stringify({ at: this.now(), ...event }) + '\n') } catch {}
  }
  start() { this.unsubscribe = this.host.subscribe(() => { this.onChange(); this.schedule() }); this.schedule() }
  schedule() {
    this.clearTimer(this.timer)
    if (this.disposed) return
    // A minute ceiling also handles sleep/resume, local-day rollover and clock changes.
    const next = this.occurrences().filter(o => !stateOf(this.host.read()).events[o.key]).map(o => o.at)
    const wait = Math.min(60000, Math.max(50, Math.min(...next) - this.now()))
    this.timer = this.setTimer(() => { this.running = this.tick().finally(() => this.schedule()) }, wait)
    this.timer?.unref?.()
  }
  occurrences(workspace = this.host.read()) {
    const s = stateOf(workspace), now = this.now(), day = dayKey(now), result = []
    for (const { widget, item } of entries(workspace)) {
      if (item.list !== 'temporary') {
        if (!s.todo.enabled || !clockTime(item.startTime)) continue
        for (const offset of [0, 1]) {
          const date = new Date(now); date.setDate(date.getDate() + offset)
          const occurrenceDay = dayKey(date), start = atTime(date, item.startTime)
          if (item.completed && item.completedOn === occurrenceDay) continue
          result.push({ key: `day/${widget.id}/${item.id}/${occurrenceDay}/${item.startTime}`, at: start - s.todo.leadMinutes * 60000,
            expires: start + 15 * 60000, kind: 'todo', text: `${item.startTime} 的「${item.text}」，小栖来提醒你啦～` })
        }
      } else if (!item.completed && Number.isFinite(item.reminderAt)) {
        result.push({ key: `once/${widget.id}/${item.id}/${item.reminderAt}`, at: item.reminderAt, expires: item.reminderAt + 3600000, kind: 'temporary', text: `约好的时间到啦，记得「${item.text}」喵～` })
      }
    }
    const w = s.weather
    if (w.enabled && w.city && clockTime(w.time) && (w.repeat === 'daily' || ![0, 6].includes(new Date(now).getDay()))) {
      const at = atTime(now, w.time)
      result.push({ key: `weather/${day}/${w.city.id}/${w.time}`, at, expires: at + 3600000, kind: 'weather', city: w.city })
    }
    return result
  }
  async tick() {
    if (this.disposed || this.ticking) return
    this.ticking = true
    try {
      // Commit short reminder deliveries before starting slower weather I/O.
      const due = this.occurrences().filter(o => o.at <= this.now()).sort((a, b) => (a.kind === 'weather') - (b.kind === 'weather'))
      for (const occurrence of due) {
        if (this.disposed || stateOf(this.host.read()).events[occurrence.key]) continue
        let text = occurrence.text, outcome = occurrence.expires < this.now() ? 'expired' : 'delivered'
        if (outcome !== 'expired' && occurrence.kind === 'weather') {
          try { text = (await this.weather.forecast(occurrence.city, this.controller.signal)).text }
          catch { text = '呜，小栖这次没查到天气，等一小会儿再来问我吧～'; outcome = 'unavailable' }
        }
        const result = await this.host.transact(workspace => {
          const live = this.occurrences(workspace).find(o => o.key === occurrence.key), s = stateOf(workspace)
          if (!live || live.at > this.now() || s.events[occurrence.key]) return { value: false }
          if (live.expires < this.now()) outcome = 'expired'
          if (live.kind !== 'weather') text = live.text // Latest manual title wins.
          s.events = Object.fromEntries(Object.entries(s.events).filter(([, event]) => event.at > this.now() - 7 * 86400000))
          s.events[occurrence.key] = { at: this.now(), status: outcome }
          workspace.petReminders = s
          return { changed: true, value: true }
        }, () => !this.disposed)
        if (result === true) {
          this.trace({ occurrence: occurrence.key, kind: occurrence.kind, status: outcome })
          if (outcome !== 'expired' && !this.disposed) this.onNotice({ id: occurrence.key, text, kind: occurrence.kind })
        }
      }
    } catch { this.trace({ status: 'save-failed' }) }
    finally { this.ticking = false }
  }
  async execute(call, { runId = randomUUID(), isCurrent = () => true, expectedContext, fromUI = false, sourceText = '', fieldSources, sourceMessage, signal = this.controller.signal } = {}) {
    if (this.disposed || !isCurrent()) return { status: 'cancelled', text: '这次操作已取消。' }
    const previous = stateOf(this.host.read()).receipts.find(r => r.id === runId)
    if (previous) return previous.result
    try {
      let city = null
      if (call.name === 'weather.update' && call.city) {
        const savedCity = stateOf(this.host.read()).weather.city
        if (savedCity && call.city === savedCity.name) city = savedCity
        else {
          if (!fromUI && !sourceText.includes(call.city)) throw new Error('城市需要来自这次的指令，请明确说一下城市。')
          const cities = await this.weather.search(call.city, signal)
          if (!cities.length) throw new Error('没有找到城市，请在天气设置里搜索完整名称或拼音。')
          const exact = cities.filter(c => c.name.replace(/市$/, '') === call.city.replace(/市$/, ''))
          if (exact.length !== 1 && cities.length !== 1) throw new Error(`找到了多个同名地点，请在天气设置里选择：${cities.map(c => c.label).join('；')}。`)
          city = exact.length === 1 ? exact[0] : cities[0]
        }
      }
      if (call.name === 'weather.get') {
        const w = stateOf(this.host.read()).weather
        if (!w.city) throw new Error('先告诉小栖你想看哪座城市的天气吧，也可以在天气设置里选好喵～')
        const result = await this.weather.forecast(w.city, signal)
        if (!isCurrent() || this.disposed || JSON.stringify(contextOf(this.host.read())) !== expectedContext && expectedContext !== undefined) return { status: 'stale', text: '天气设置刚刚变啦，再让小栖查一次吧～' }
        return { status: 'read', text: result.text }
      }
      const result = await this.host.transact(workspace => {
        const s = stateOf(workspace), old = s.receipts.find(r => r.id === runId)
        if (old) return { value: old.result }
        if (expectedContext !== undefined && expectedContext !== JSON.stringify(contextOf(workspace))) return { value: { status: 'stale', text: '安排刚刚有变化，请再说一次。' } }
        let text, operation, changed = true
        if (call.name === 'weather.update') {
          if (city) s.weather.city = city
          if (call.time) {
            if (!clockTime(call.time)) throw new Error('请使用明确的播报时间。')
            const phrases = timePhrases(sourceText), clocks = phrases.length === 1 ? clockCandidates(phrases[0]) : []
            const time = clocks.length === 1 ? clocks[0] : clocks.find(c => c.slice(0, 2) === call.time.slice(0, 2))
            if (clocks.length && !time) throw new Error('播报时间和你说的对不上，再告诉小栖是几点吧～')
            s.weather.time = time || call.time
          }
          if (call.repeat !== 'keep') { if (!['daily', 'weekdays'].includes(call.repeat)) throw new Error('支持每天或周一至周五播报。'); s.weather.repeat = call.repeat }
          if (call.enabled !== 'keep') { if (!['on', 'off'].includes(call.enabled)) throw new Error('播报开关无效。'); s.weather.enabled = call.enabled === 'on' }
          if (s.weather.enabled && !s.weather.city) throw new Error('还缺一个城市，请先选择城市。')
          text = s.weather.enabled ? `记好啦～我会在${s.weather.repeat === 'daily' ? '每天' : '周一至周五'} ${s.weather.time} 告诉你${s.weather.city.name}的天气。` : '好呀，天气播报先暂停啦，城市和时间小栖都记着～'
        } else if (call.name === 'settings.update' && fromUI) {
          const { weather: w, todo } = call
          if (!w || typeof w.enabled !== 'boolean' || !clockTime(w.time) || !['daily', 'weekdays'].includes(w.repeat)
            || !todo || typeof todo.enabled !== 'boolean' || ![0, 5, 10, 15].includes(todo.leadMinutes)) throw new Error('提醒设置无效。')
          const selected = w.cityId === s.weather.city?.id ? s.weather.city : this.weather.cities.get(w.cityId)
          if (w.enabled && !selected) throw new Error('请搜索并选择城市。')
          s.weather = { enabled: w.enabled, time: w.time, repeat: w.repeat, city: selected || null }; s.todo = { enabled: todo.enabled, leadMinutes: todo.leadMinutes }
          text = '提醒设置已保存。'
        } else if (['reminder.create', 'reminder.update', 'reminder.cancel', 'reminder.shift'].includes(call.name)) {
          let target
          if (call.name !== 'reminder.create') {
            target = entries(workspace).find(({ widget, item }) => `${widget.id}/${item.id}` === call.targetId && item.list === 'temporary' && Number.isFinite(item.reminderAt) && !item.completed)
            if (!target || !contextOf(workspace).reminders.some(r => r.id === call.targetId)) throw new Error('找不到这条临时提醒，请说明要改哪一条。')
          }
          if (call.name === 'reminder.cancel') { delete target.item.reminderAt; text = `好呀，「${target.item.text}」不再提醒啦，事项还留在临时安排里。` }
          else if (call.name === 'reminder.shift') {
            const duration = explicitMinutes(sourceText)
            const sign = /提前/.test(sourceText) ? -1 : /推迟|延后/.test(sourceText) ? 1 : 0
            if (!duration || !sign || !Number.isSafeInteger(duration.minutes) || duration.minutes < 1 || duration.minutes > 1440 || call.minutes !== sign * duration.minutes) throw new Error('请说清楚要推迟还是提前，以及多少分钟。')
            const at = target.item.reminderAt + call.minutes * 60000
            if (at <= this.now()) throw new Error('调整后已经过了提醒时间，再选一个未来时间吧～')
            target.item.reminderAt = at
            text = `改好啦～「${target.item.text}」会在${displayWhen(at)}提醒你。`
          }
          else {
            const timeSource = fieldSources?.when || { content: sourceText, at: this.now() }
            const textSource = fieldSources?.text?.content || sourceText
            const bareDuration = timeSource.relativeDuration && explicitMinutes(timeSource.content)?.evidence === call.when
            if (!call.when || (!timePhrases(timeSource.content).includes(call.when) && !bareDuration) || !Number.isFinite(timeSource.at)) throw new Error('小栖需要完整的提醒时间，再告诉我一次吧～')
            const at = parseWhen(bareDuration ? `${call.when}后` : call.when, timeSource.at, call.timeOfDay)
            if (!Number.isFinite(at) || at <= this.now()) throw new Error(`「${call.when}」可能已经过去，或还没说清楚。你想让我哪天、几点提醒呀？`)
            const conflict = conflictingTimeContext(timeSource.content, call.when, timeSource.at, at)
            if (conflict) throw new Error(`你还提到了「${conflict}」，小栖没确认好时间，这条提醒还没设置。请把日期、几点和提醒事项连起来说一下吧～`)
            if (call.name === 'reminder.create') {
              if (!call.text?.trim() || call.text.length > 200 || !textSource.includes(call.text)) throw new Error('请说明要提醒的事项。')
              let widget = workspace.widgets.find(w => w.kind === 'todo')
              if (!widget) { widget = this.host.createWidget(workspace, 'todo'); workspace.widgets.push(widget) }
              const item = { id: randomUUID(), text: call.text, completed: false, list: 'temporary', reminderAt: at }
              widget.data.items = [...(widget.data.items || []), item]; widget.data.activeList = 'temporary'; target = { widget, item }
            } else target.item.reminderAt = at
            text = call.name === 'reminder.create' ? `记好啦～「${target.item.text}」已加入临时安排，${displayWhen(at)} 我来提醒你。`
              : `改好啦～「${target.item.text}」会在${displayWhen(at)}提醒你。`
          }
          operation = { id: runId, name: call.name, targetId: `${target.widget.id}/${target.item.id}`, text: target.item.text,
            reminderAt: target.item.reminderAt, when: call.when, timeOfDay: call.timeOfDay, source: sourceMessage,
            relativeMinutes: call.when && !clockCandidates(call.when).length ? explicitMinutes(call.when)?.minutes : undefined,
            fieldSources: fieldSources ? Object.fromEntries(Object.entries(fieldSources).map(([key, s]) => [key, { messageId: s.id, at: s.at, reusedFrom: s.reusedFrom }])) : undefined }
        } else if (call.name === 'reminder.status') {
          const list = contextOf(workspace).reminders
          text = list.length ? `小栖记着这些呢～\n${list.map(r => `${displayWhen(r.at)} · ${r.text}`).join('\n')}` : '现在没有等着提醒的事，想起什么再告诉小栖呀～'; changed = false
        } else throw new Error('这项操作不在本轮支持范围内。')
        const value = { status: changed ? 'saved' : 'read', text, ...(operation ? { operation } : {}) }
        if (!changed) return { value }
        if (operation) recordOperation(workspace, operation, this.now())
        s.revision++; s.receipts = [...s.receipts, { id: runId, result: value }].slice(-32); workspace.petReminders = s
        return { changed: true, value }
      }, () => !this.disposed && isCurrent())
      this.trace({ runId, action: call.name, status: result.status, revision: stateOf(this.host.read()).revision })
      return result
    } catch (error) { return { status: 'failed', text: error instanceof TypeError ? '呜，暂时连不上天气服务，等一小会儿再问小栖吧～'
      : ['TimeoutError', 'AbortError'].includes(error.name) ? '这次天气还没查到，等一小会儿再问小栖吧～' : error.message } }
  }
  async dispose() { this.disposed = true; this.controller.abort(); this.clearTimer(this.timer); this.unsubscribe?.(); await this.running }
}
module.exports = { ReminderService, stateOf, contextOf }
