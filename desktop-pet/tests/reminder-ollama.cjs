// Real local model; isolated workspace and deterministic weather provider.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createFocusPreview } = require('../focus-preview.cjs')
const { FocusService } = require('../focus-service.cjs')
const { ReminderService } = require('../reminder-service.cjs')
const { PetHarness } = require('../harness.cjs')
const directory = path.resolve('.artifacts/desktop-pet-reminder-ollama', `run-${Date.now()}`)
fs.mkdirSync(directory, { recursive: true })
const city = { id: '1808926', name: '杭州', label: '杭州 · 浙江 · 中国', latitude: 30.27, longitude: 120.15 }
const host = createFocusPreview(directory), noTimer = { setTimer: () => ({}), clearTimer: () => {} }
const focus = new FocusService({ host, ...noTimer })
const reminders = new ReminderService({ host, directory, ...noTimer, weather: { cities: new Map([[city.id, city]]), search: async () => [city], forecast: async () => ({ text: '杭州：多云，20–25℃。（测试天气数据）' }) } })
const raw = [], seed = Number(process.argv[3] || 42)
const harness = new PetHarness({ directory, focusTools: focus, reminderTools: reminders, memoryIdleMs: 600000,
  fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); body.options = { ...body.options, seed }
    const response = await fetch(url, { ...options, body: JSON.stringify(body) })
    const data = await response.text(); raw.push({ request: body, status: response.status, response: data })
    return new Response(data, { status: response.status })
  },
})
harness.setPreferences({ model: process.argv[2] || 'qwen3:4b-instruct-2507-q4_K_M' })
const results = []
const steps = [
  ['weather-set', '每天早上八点半播报杭州天气', () => { assert.equal(reminders.snapshot().weather.time, '08:30'); assert.equal(reminders.snapshot().weather.enabled, true); assert.equal(reminders.snapshot().weather.city.name, '杭州') }],
  ['weather-time', '天气播报改成早上九点', () => assert.equal(reminders.snapshot().weather.time, '09:00')],
  ['weather-weekdays', '周末就不用报天气了', () => { assert.equal(reminders.snapshot().weather.repeat, 'weekdays'); assert.equal(reminders.snapshot().weather.enabled, true) }],
  ['weather-off', '关闭天气定时播报', () => assert.equal(reminders.snapshot().weather.enabled, false)],
  ['temporary-create', '四十分钟后提醒我取快递', () => { const r = reminders.snapshot().reminders[0]; assert.equal(r.text, '取快递'); assert.ok(Math.abs(r.at - Date.now() - 2400000) < 30000); assert.equal(focus.context().state, 'idle') }],
  ['temporary-update', '刚才取快递的提醒改成十分钟后', () => { assert.equal(reminders.snapshot().reminders.length, 1); assert.ok(Math.abs(reminders.snapshot().reminders[0].at - Date.now() - 600000) < 30000) }],
  ['temporary-cancel', '不用提醒取快递了', () => { assert.equal(reminders.snapshot().reminders.length, 0); assert.equal(host.read().widgets.find(w => w.kind === 'todo').data.items[0].text, '取快递') }],
  ['focus-start', '陪我专注二十分钟', () => { assert.equal(focus.context().state, 'focus'); assert.equal(host.read().widgets.find(w => w.kind === 'pomodoro').data.remainingSeconds, 1200) }],
  ['focus-stop', '停止计时', () => assert.equal(focus.context().state, 'idle')],
  ['quote-inert', '翻译成英文：四十分钟后提醒我取快递', (_, before) => assert.equal(JSON.stringify(host.read()), before)],
  ['future-clock-inert', '明天下午三点自动开始番茄钟', (_, before) => assert.equal(JSON.stringify(host.read()), before)],
  ['ordinary-chat', '今天看到了一只很可爱的小猫', (_, before) => assert.equal(JSON.stringify(host.read()), before)],
]
;(async () => {
  for (const [id, text, check] of steps) {
    const before = JSON.stringify(host.read()), start = Date.now()
    harness.start(text); await harness.running; harness.cancelMemoryReview('test')
    let error = null
    try { assert.equal(harness.error, ''); check(harness, before) } catch (e) { error = e.message }
    const result = { id, input: text, passed: !error, error, reply: harness.messages.at(-1)?.content, durationMs: Date.now() - start }
    results.push(result); console.log(JSON.stringify(result))
  }
  fs.writeFileSync(path.join(directory, 'raw.json'), JSON.stringify(raw, null, 2))
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ model: harness.model, seed, passed: results.filter(r => r.passed).length, total: results.length, results }, null, 2))
  console.log(directory); if (results.some(r => !r.passed)) process.exitCode = 1
})().catch(e => { console.error(e); process.exitCode = 1 }).finally(async () => { harness.stop(); harness.clearNotices(); await reminders.dispose(); await focus.dispose() })
