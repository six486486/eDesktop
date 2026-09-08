const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createWidget } = require('../../electron/widget-model.cjs')
const { createFocusHost } = require('../focus-host.cjs')
const { FocusService } = require('../focus-service.cjs')
const { ReminderService } = require('../reminder-service.cjs')
const { WeatherClient } = require('../weather.cjs')
const { parseWhen, dayKey, atTime, timePhrases } = require('../reminder-time.cjs')
const { availableReminderTools, reminderSchema, readReminderEnvelope } = require('../reminder-tools.cjs')
const { PetHarness } = require('../harness.cjs')
const city = { id: '1', name: '杭州', label: '杭州 · 浙江 · 中国', latitude: 30.27, longitude: 120.15 }
function fixture(t, initial = { widgets: [] }) {
  let workspace = structuredClone(initial), durable = structuredClone(initial), tail = Promise.resolve(), now = new Date(2026, 8, 7, 8).getTime(), fail = false
  const events = [], timers = [], weather = { cities: new Map([[city.id, city]]), search: async () => [city], forecast: async () => ({ text: '杭州：多云，20–25℃。' }) }
  const host = createFocusHost({ read: () => workspace, enqueue: fn => { const r = tail.then(fn); tail = r.catch(() => {}); return r },
    persist: async next => { if (fail) throw new Error('disk failure'); durable = structuredClone(next) }, publish: next => { workspace = next; host.changed() },
    createWidget: (next, kind = 'pomodoro') => createWidget(kind, { index: next.widgets.length, primaryOffset: { x: 0, y: 0 } }),
  })
  const options = { host, now: () => now, weather, onNotice: e => events.push(e), setTimer: (fn, ms) => { timers.push({ fn, ms }); return {} }, clearTimer: () => {} }
  const service = new ReminderService(options); service.start(); t.after(() => service.dispose())
  return { host, service, weather, options, events, timers, get workspace() { return workspace }, get durable() { return durable },
    get now() { return now }, setNow: n => { now = n }, fail: value => { fail = value },
    call: (call, sourceText = '', extra = {}) => service.execute(call, { sourceText, expectedContext: JSON.stringify(service.snapshot()), ...extra }) }
}
const todoWidget = items => ({ id: 'todo', kind: 'todo', data: { items } })
const createCall = { name: 'reminder.create', text: '取快递', when: '四十分钟后' }
const envelope = (action, params = {}, text = '好。') => JSON.stringify({ assessment: '测试指令意图', decision: { action,
  params: ['reminder.create', 'reminder.update'].includes(action) ? { timeOfDay: 'auto', ...params } : params }, response: { text, visual: 'none' } })
const packet = content => new Response(JSON.stringify({ message: { content }, done: true }) + '\n')

test('reminder time arithmetic: relative Chinese, day/period, midnight, invalid and elapsed inputs', () => {
  const now = new Date(2026, 8, 7, 23, 50).getTime()
  assert.equal(parseWhen('四十分钟后', now), now + 2400000)
  assert.equal(parseWhen('再过半小时', now), now + 1800000)
  assert.equal(parseWhen('明天下午三点半', now), new Date(2026, 8, 8, 15, 30).getTime())
  assert.equal(parseWhen('后天上午9:05', now), new Date(2026, 8, 9, 9, 5).getTime())
  assert.equal(parseWhen('三点', now), new Date(2026, 8, 8, 3).getTime())
  for (const phrase of ['今天下午三点', '零分钟后', '-5分钟后', '1.5分钟后', '99999分钟后', '明天25:90', '有空时', '每天下午三点']) assert.ok(Number.isNaN(parseWhen(phrase, now)), phrase)
})
test('semantic half-day hints resolve bedtime, wake-up and shifts without overriding explicit dates or periods', () => {
  const night = new Date(2026, 8, 6, 22, 42).getTime(), morning = new Date(2026, 8, 6, 8).getTime()
  for (const [phrase, now, hint, expected] of [
    ['11点', night, 'pm', new Date(2026, 8, 6, 23)],
    ['十一点', night, 'auto', new Date(2026, 8, 6, 23)],
    ['11点', morning, 'pm', new Date(2026, 8, 6, 23)],
    ['11点', morning, 'am', new Date(2026, 8, 6, 11)],
    ['7点', night, 'am', new Date(2026, 8, 7, 7)],
    ['明天11点', night, 'pm', new Date(2026, 8, 7, 23)],
    ['明天11点', night, 'am', new Date(2026, 8, 7, 11)],
    ['今晚十一点一刻', night, 'auto', new Date(2026, 8, 6, 23, 15)],
    ['零点', night, 'auto', new Date(2026, 8, 7)],
    ['12点', night, 'auto', new Date(2026, 8, 7)],
    ['23:00', new Date(2026, 8, 6, 23).getTime(), 'auto', new Date(2026, 8, 7, 23)],
  ]) assert.equal(parseWhen(phrase, now, hint), expected.getTime(), `${phrase}/${hint}`)
  for (const [phrase, hint] of [['今天上午11点', 'auto'], ['今晚九点', 'auto'], ['今天23:00', 'am'],
    ['明天上午11点', 'pm'], ['明天上午23点', 'auto'], ['明天25点', 'auto'], ['11点', 'night']]) {
    assert.ok(Number.isNaN(parseWhen(phrase, night, hint)), `${phrase}/${hint}`)
  }
})
test('reminder extraction and arithmetic keep compound durations and quarter-hours intact', () => {
  const now = new Date(2026, 8, 6, 22, 42).getTime()
  for (const [phrase, minutes] of [['一个半小时后', 90], ['半个小时后', 30], ['一小时二十分钟后', 80],
    ['一刻钟后', 15], ['再过三刻钟', 45], ['再过1.5小时', 90], ['再过一点五小时', 90]]) {
    assert.deepEqual(timePhrases(`${phrase}提醒我取快递。`), [phrase])
    assert.equal(parseWhen(phrase, now), now + minutes * 60000, phrase)
  }
  assert.deepEqual(timePhrases('今晚11点一刻提醒我睡觉'), ['今晚11点一刻'])
  assert.deepEqual(timePhrases('-5分钟后提醒我'), ['-5分钟后'])
})
test('bedtime reminder commits the interpreted time once; truncated or contradictory proposals cannot write', async t => {
  const f = fixture(t); f.setNow(new Date(2026, 8, 6, 22, 42).getTime())
  const call = { name: 'reminder.create', text: '上床睡觉', when: '11点', timeOfDay: 'pm' }
  const result = await f.call(call, '11点提醒我上床睡觉。', { runId: 'bedtime' })
  assert.equal(result.status, 'saved'); assert.match(result.text, /23:00/)
  assert.equal(f.service.snapshot().reminders[0].at, new Date(2026, 8, 6, 23).getTime())
  await f.call(call, '11点提醒我上床睡觉。', { runId: 'bedtime' })
  assert.equal(f.service.snapshot().reminders.length, 1)
  const before = structuredClone(f.workspace)
  for (const [when, source] of [['半小时后', '一个半小时后提醒我上床睡觉'], ['11点', '今天上午11点提醒我上床睡觉'],
    ['5分钟后', '-5分钟后提醒我上床睡觉'], ['今天上午11点', '今天上午11点提醒我上床睡觉']]) {
    assert.equal((await f.call({ ...call, when }, source)).status, 'failed')
  }
  assert.deepEqual(f.workspace, before)
  const nightShift = '我上夜班，明天上午下班，11点提醒我上床睡觉。'
  assert.match((await f.call(call, nightShift)).text, /还没设置/)
  assert.deepEqual(f.workspace, before)
  assert.equal((await f.call({ ...call, timeOfDay: 'am' }, nightShift)).status, 'saved')
  assert.equal(f.service.snapshot().reminders[0].at, new Date(2026, 8, 7, 11).getTime())
})
test('temporary reminder creates a real todo atomically, persists dedupe, and cancellation keeps the item', async t => {
  const f = fixture(t), source = '四十分钟后提醒我取快递'
  assert.equal((await f.call(createCall, source, { runId: 'same' })).status, 'saved')
  const item = f.workspace.widgets[0].data.items[0]
  assert.equal(item.list, 'temporary'); assert.equal(item.reminderAt, f.now + 2400000); assert.equal(item.completed, false)
  const restarted = new ReminderService({ ...f.options }); t.after(() => restarted.dispose())
  await restarted.execute(createCall, { runId: 'same', sourceText: source })
  assert.equal(f.workspace.widgets[0].data.items.length, 1)
  const targetId = f.service.snapshot().reminders[0].id
  assert.equal((await f.call({ name: 'reminder.update', targetId, when: '十分钟后' }, '改成十分钟后')).status, 'saved')
  assert.equal(f.workspace.widgets[0].data.items[0].reminderAt, f.now + 600000)
  await f.call({ name: 'reminder.cancel', targetId }, '不用提醒这个了')
  assert.equal(f.workspace.widgets[0].data.items[0].reminderAt, undefined)
  assert.equal(f.workspace.widgets[0].data.items[0].text, '取快递')
  assert.deepEqual(f.workspace, f.durable)
})
test('failed save, stale revision, cancelled run, invented text/time and unoffered target never write', async t => {
  const f = fixture(t), before = structuredClone(f.workspace)
  f.fail(true); assert.equal((await f.call(createCall, '四十分钟后提醒我取快递')).status, 'failed'); f.fail(false)
  assert.equal((await f.call(createCall, '四十分钟后提醒我取快递', { expectedContext: '{}' })).status, 'stale')
  assert.equal((await f.call(createCall, '四十分钟后提醒我取快递', { isCurrent: () => false })).status, 'cancelled')
  for (const call of [createCall, { name: 'reminder.update', targetId: 'foreign', when: '十分钟后' }, { name: 'shell.exec' }]) assert.equal((await f.call(call, '你好')).status, 'failed')
  assert.deepEqual(f.workspace, before)
})
test('my-day only: manual temporary time ranges do not remind; explicit temporary reminders do', async t => {
  const f = fixture(t, { widgets: [todoWidget([
    { id: 'day', text: '开会', list: 'my-day', startTime: '08:05', endTime: '09:00' },
    { id: 'temporary', text: '自己写的临时事项', list: 'temporary', startTime: '08:05', endTime: '09:00' },
    { id: 'done', text: '已完成', list: 'my-day', startTime: '08:05', completed: true, completedOn: '2026-09-07' },
  ])] })
  await f.service.tick(); assert.equal(f.events.length, 1); assert.match(f.events[0].text, /08:05.*开会/)
  await f.call(createCall, '四十分钟后提醒我取快递'); f.setNow(f.now + 2400000); await f.service.tick()
  assert.match(f.events.at(-1).text, /取快递/); assert.equal(f.events.length, 2)
})
test('day reminders follow latest manual edits, completion/removal and local-day reset', async t => {
  const f = fixture(t, { widgets: [todoWidget([{ id: 'day', text: '开会', startTime: '08:05' }])] })
  await f.host.transact(w => { w.widgets[0].data.items[0].startTime = '09:00'; return { changed: true } })
  await f.service.tick(); assert.equal(f.events.length, 0)
  f.setNow(atTime(f.now, '08:55')); await f.service.tick(); assert.equal(f.events.length, 1)
  await f.host.transact(w => { Object.assign(w.widgets[0].data.items[0], { completed: true, completedOn: dayKey(f.now) }); return { changed: true } })
  f.setNow(f.now + 86400000); await f.service.tick(); assert.equal(f.events.length, 2)
  await f.host.transact(w => { w.widgets[0].data.items = []; return { changed: true } }); f.setNow(f.now + 86400000); await f.service.tick(); assert.equal(f.events.length, 2)
})
test('midnight advance notification belongs to the next local day and does not replay after midnight', async t => {
  const f = fixture(t, { widgets: [todoWidget([{ id: 'day', text: '零点', startTime: '00:00' }])] })
  f.setNow(new Date(2026, 8, 7, 23, 55).getTime()); await f.service.tick(); assert.equal(f.events.length, 1)
  f.setNow(new Date(2026, 8, 8, 0, 0).getTime()); await f.service.tick(); assert.equal(f.events.length, 1)
})
test('restart/double tick dedupe and bounded late delivery; notifications never mark todos completed', async t => {
  const f = fixture(t); await f.call(createCall, '四十分钟后提醒我取快递'); f.setNow(f.now + 2400000)
  await Promise.all([f.service.tick(), f.service.tick()]); assert.equal(f.events.length, 1)
  const next = new ReminderService(f.options); t.after(() => next.dispose()); await next.tick(); assert.equal(f.events.length, 1)
  assert.equal(f.workspace.widgets[0].data.items[0].completed, false)
  await f.call(createCall, '四十分钟后提醒我取快递'); f.setNow(f.now + 3 * 3600000); await next.tick(); assert.equal(f.events.length, 1)
  assert.ok(Object.values(f.workspace.petReminders.events).some(e => e.status === 'expired'))
})
test('weather configuration is shared between UI and tools; partial updates preserve other settings', async t => {
  const f = fixture(t)
  await f.call({ name: 'settings.update', weather: { cityId: '1', enabled: true, time: '08:30', repeat: 'daily' }, todo: { enabled: true, leadMinutes: 5 } }, '', { fromUI: true })
  await f.call({ name: 'weather.update', city: '', time: '09:00', repeat: 'keep', enabled: 'keep' }, '改成九点')
  assert.equal(f.workspace.petReminders.weather.city.id, '1'); assert.equal(f.workspace.petReminders.weather.enabled, true)
  await f.call({ name: 'weather.update', city: '', time: '', repeat: 'weekdays', enabled: 'keep' }, '周末不用')
  assert.equal(f.workspace.petReminders.weather.time, '09:00'); assert.equal(f.workspace.petReminders.weather.repeat, 'weekdays')
  f.setNow(new Date(2026, 8, 12, 9).getTime()); await f.service.tick(); assert.equal(f.events.length, 0)
  f.setNow(new Date(2026, 8, 14, 9).getTime()); await f.service.tick(); assert.equal(f.events[0].kind, 'weather')
})
test('changing weather time to nine resets minutes instead of inheriting a previous half-hour', async t => {
  const f = fixture(t)
  await f.call({ name: 'weather.update', city: '杭州', time: '08:30', repeat: 'daily', enabled: 'on' }, '每天早上八点半报杭州天气')
  const call = { name: 'weather.update', city: '', time: '09:30', repeat: 'keep', enabled: 'keep' }
  await f.call(call, '天气播报改成早上九点')
  assert.equal(f.service.snapshot().weather.time, '09:00')
  await f.call({ ...call, time: '21:30' }, '天气改成九点')
  assert.equal(f.service.snapshot().weather.time, '21:00')
  const schema = reminderSchema(['weather.update'], { reminders: [] }, '天气播报改成早上九点')
  assert.deepEqual(schema.properties.decision.anyOf[0].properties.params.properties.time.enum, ['', '09:00'])
})
test('weather response is revalidated after I/O; cancellation and a late old search cannot change new settings', async t => {
  const f = fixture(t)
  await f.call({ name: 'weather.update', city: '杭州', time: '08:00', repeat: 'daily', enabled: 'on' }, '每天8点报杭州天气')
  let resolve; f.weather.forecast = () => new Promise(r => { resolve = r })
  const tick = f.service.tick(); await new Promise(r => setImmediate(r))
  await f.call({ name: 'weather.update', city: '', time: '', repeat: 'keep', enabled: 'off' }, '关闭播报')
  resolve({ text: '过时播报' }); await tick; assert.equal(f.events.length, 0)
  let searched; f.weather.search = () => new Promise(r => { searched = r }); let current = true
  const call = f.call({ name: 'weather.update', city: '宁波', time: '09:00', repeat: 'daily', enabled: 'on' }, '宁波', { isCurrent: () => current })
  await new Promise(r => setImmediate(r)); current = false; searched([{ ...city, id: '2', name: '宁波' }]); assert.equal((await call).status, 'cancelled')
  assert.equal(f.workspace.petReminders.weather.enabled, false)
})
test('weather failure is a truthful notice and does not block ordinary reminders or require a model', async t => {
  const f = fixture(t); await f.call(createCall, '四十分钟后提醒我取快递')
  await f.call({ name: 'weather.update', city: '杭州', time: '08:40', repeat: 'daily', enabled: 'on' }, '杭州')
  f.weather.forecast = async () => { throw new Error('network') }; f.setNow(f.now + 2400000)
  await f.service.tick(); assert.equal(f.events[0].kind, 'temporary'); assert.match(f.events[1].text, /没查到天气/)
})
test('weather adapter validates API payloads and uses only fixed service hosts', async () => {
  const urls = [], weather = new WeatherClient({ fetchImpl: async url => { urls.push(url); return new Response(JSON.stringify(url.includes('geocoding') ? { results: [{ ...city, admin1: '浙江', country: '中国' }] } : { daily: { time: ['2026-09-07'], weather_code: [61], temperature_2m_min: [20], temperature_2m_max: [25], precipitation_probability_max: [80] } })) } })
  assert.equal((await weather.search('杭州'))[0].id, '1'); assert.match((await weather.forecast(city)).text, /带伞/)
  assert.ok(urls.every(u => ['geocoding-api.open-meteo.com', 'api.open-meteo.com'].includes(new URL(u).hostname)))
  weather.fetch = async () => new Response('{}'); await assert.rejects(weather.forecast(city), /不完整/)
})
test('unknown and ambiguous cities do not save a guessed location', async t => {
  const f = fixture(t), before = structuredClone(f.workspace), call = { name: 'weather.update', city: '某某城市', time: '09:00', repeat: 'daily', enabled: 'on' }
  f.weather.search = async () => []
  assert.match((await f.call(call, '某某城市')).text, /没有找到城市/)
  f.weather.search = async () => [{ ...city, id: 'a', name: '某某城市' }, { ...city, id: 'b', name: '某某城市' }]
  assert.match((await f.call(call, '某某城市')).text, /同名地点/)
  assert.deepEqual(f.workspace, before)
})
test('tool protocol withholds drafts, rejects duplicates/truncation and gates future clock control', () => {
  const tool = envelope('reminder.create', { text: '取快递', when: '十分钟后' })
  for (let i = 0; i <= tool.length; i++) assert.equal(readReminderEnvelope(tool.slice(0, i)).text, '')
  assert.equal(readReminderEnvelope(tool, true).tool.name, 'reminder.create')
  for (const bad of [tool.slice(0, -1), tool.replace('"when":', '"text":"bad","when":'), envelope('shell.exec'), envelope('none', { unexpected: 'value' })]) assert.equal(readReminderEnvelope(bad, true).state, 'invalid')
  assert.deepEqual(availableReminderTools('翻译：十分钟后提醒我取快递', { state: 'idle' }), ['none'])
  const names = availableReminderTools('明天下午三点开始专注', { state: 'idle' })
  assert.ok(!names.includes('focus.start')); assert.ok(!names.includes('reminder.create'))
  assert.ok(availableReminderTools('明天下午三点提醒我开始专注', { state: 'idle' }).includes('reminder.create'))
  const schema = reminderSchema(names, { reminders: [] }); assert.ok(!schema.properties.decision.anyOf.some(b => b.properties.action.enum[0] === 'reminder.cancel'))
  assert.ok(!availableReminderTools('11点别提醒我睡觉', { state: 'idle' }).includes('reminder.create'))
  for (const input of ['别忘了11点提醒我睡觉', '不用提醒取快递，11点提醒我睡觉']) assert.ok(availableReminderTools(input, { state: 'idle' }).includes('reminder.create'))
  for (const raw of [tool.replace('"assessment":"测试指令意图",', ''), tool.replace('"timeOfDay":"auto"', '"timeOfDay":"night"')]) {
    assert.equal(readReminderEnvelope(raw, true).state, 'invalid')
  }
})
test('production harness uses real results, preserves focus control, and keeps raw reminder content out of traces', async t => {
  const f = fixture(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-reminder-'))
  const focus = new FocusService({ host: f.host, now: () => f.now, setTimer: () => ({}), clearTimer: () => {} }); t.after(() => focus.dispose())
  let next = envelope('reminder.create', { text: '取快递', when: '四十分钟后' }, '已经开钟了')
  const h = new PetHarness({ directory: dir, reminderTools: f.service, focusTools: focus, memoryIdleMs: 600000, fetchImpl: async () => packet(next) }); h.setPreferences({ model: 'fixture' }); t.after(() => { h.stop(); h.clearNotices() })
  h.start('四十分钟后提醒我取快递'); await h.running
  assert.match(h.messages.at(-1).content, /已加入临时安排/); assert.ok(!f.workspace.widgets.some(w => w.kind === 'pomodoro'))
  next = envelope('focus.start', { minutes: 25 }); h.start('陪我专注二十分钟'); await h.running
  assert.equal(f.workspace.widgets.find(w => w.kind === 'pomodoro').data.remainingSeconds, 1200)
  next = envelope('focus.stop'); h.start('停止计时'); await h.running
  assert.equal(f.workspace.widgets.find(w => w.kind === 'pomodoro').data.running, false)
  const before = structuredClone(f.workspace)
  next = envelope('reminder.create', { text: '取快递', when: '四十分钟后' })
  h.start('四十分钟后别提醒我取快递'); await h.running
  assert.deepEqual(f.workspace, before); assert.match(h.error, /范围/)
  next = envelope('none', {}, '好的，一个小时后我会自动开始。')
  h.start('一个小时后再开始专注'); await h.running
  assert.deepEqual(f.workspace, before); assert.match(h.messages.at(-1).content, /还不能预约/)
  next = envelope('reminder.create', { text: '取快递', when: '四十分钟后' }); h.start('翻译：四十分钟后提醒我取快递'); await h.running
  assert.deepEqual(f.workspace, before)
  assert.ok(!fs.readFileSync(path.join(dir, 'tool-runs.jsonl'), 'utf8').includes('取快递'))
})
test('late model response after reset cannot create a temporary item', async t => {
  const f = fixture(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-reminder-cancel-')); let resolve
  const h = new PetHarness({ directory: dir, reminderTools: f.service, fetchImpl: () => new Promise(r => { resolve = r }) }); h.setPreferences({ model: 'fixture' }); t.after(() => h.stop())
  h.start('四十分钟后提醒我取快递'); h.resetConversation()
  resolve(packet(envelope('reminder.create', { text: '取快递', when: '四十分钟后' }))); await h.running
  assert.equal(f.workspace.widgets.length, 0); assert.equal(h.messages.length, 0)
})
test('reminders received with empty chat survive history trimming and restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-notice-')), h = new PetHarness({ directory })
  t.after(() => h.clearNotices())
  h.notifyReminder({ id: 'one', text: '取快递', kind: 'temporary' })
  h.notifyReminder({ id: 'two', text: '开会', kind: 'todo' })
  assert.deepEqual(h.messages.map(m => m.content), ['取快递', '开会'])
  assert.equal(h.focusNotice.text, '取快递'); assert.equal(h.noticeQueue.length, 1)
  const restored = new PetHarness({ directory }); assert.equal(restored.messages.length, 2); assert.equal(restored.focusNotice, null)
})
