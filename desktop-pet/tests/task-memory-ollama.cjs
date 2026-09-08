// Uses the production harness with a real local model and an isolated durable host.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createFocusPreview } = require('../focus-preview.cjs')
const { FocusService } = require('../focus-service.cjs')
const { ReminderService } = require('../reminder-service.cjs')
const { PetHarness } = require('../harness.cjs')
const model = process.argv[2] || 'qwen3:4b-instruct-2507-q4_K_M'
const root = path.resolve('.artifacts/pet-task-memory-ollama', `run-${Date.now()}`), results = []
fs.mkdirSync(root, { recursive: true })
const focusFor = minutes => f => assert.equal(f.host.read().widgets.find(w => w.kind === 'pomodoro').data.remainingSeconds, minutes * 60)
const reminderIn = minutes => f => { assert.equal(f.reminders.snapshot().reminders.length, 1); assert.equal(f.reminders.snapshot().reminders[0].at, f.now + minutes * 60000) }
const groups = [
  ['continuation', [
    ['提醒我取快递', f => { assert.equal(f.reminders.snapshot().reminders.length, 0); assert.equal(f.harness.taskMemory.current().working.fields.text, '取快递'); assert.match(f.reply, /什么时候|几点/) }],
    ['二十分钟后', reminderIn(20)],
    ['还是改成半小时吧', reminderIn(30)],
    ['再推迟十分钟', reminderIn(40)],
    ['不用提醒这个了', f => { assert.equal(f.reminders.snapshot().reminders.length, 0); assert.equal(f.host.read().widgets.find(w => w.kind === 'todo').data.items.length, 1) }],
  ]],
  ['habits', [
    ['以后写代码45分钟，看书25分钟', f => { const h = f.harness.snapshot().memory.habits; assert.equal(h.length, 2); assert.equal(h.find(x => x.activity === '写代码').minutes, 45); assert.equal(f.focus.context().state, 'idle') }],
    ['@restart'],
    ['我要写代码了', focusFor(45)],
    ['先停一下', f => assert.equal(f.focus.context().state, 'idle')],
    ['写代码，这次20分钟', focusFor(20)],
    ['以后写代码30分钟', f => assert.equal(f.harness.snapshot().memory.habits.find(h => h.activity === '写代码').minutes, 30)],
    ['忘掉写代码的习惯', f => { assert.equal(f.harness.snapshot().memory.habits.length, 1); assert.equal(f.harness.snapshot().memory.habits[0].activity, '看书') }],
  ]],
  ['reuse', [
    ['写代码，计时35分钟', focusFor(35)],
    ['停止番茄钟', f => assert.equal(f.focus.context().state, 'idle')],
    ['@restart'],
    ['上次写代码计时多久', f => { assert.equal(f.decision.action, 'memory.recall'); assert.match(f.reply, /35/) }],
    ['这次也一样', focusFor(35)],
  ]],
  ['clock-habit', [
    ['以后我说11点睡觉就是晚上11点', f => { const h = f.harness.snapshot().memory.habits; assert.equal(h.length, 1); assert.equal(h[0].timeOfDay, 'pm'); assert.equal(f.reminders.snapshot().reminders.length, 0) }],
    ['@restart'],
    ['11点提醒我睡觉', f => assert.equal(new Date(f.reminders.snapshot().reminders[0].at).getHours(), 23)],
    ['以后我说11点睡觉是上午11点', f => { const h = f.harness.snapshot().memory.habits; assert.equal(h.length, 1); assert.equal(h[0].timeOfDay, 'am') }],
    ['@restart'],
    ['11点提醒我睡觉', f => { assert.ok(f.reminders.snapshot().reminders.some(r => new Date(r.at).getHours() === 11)); assert.ok(f.run.memorySelection) }],
  ]],
]
;(async () => {
  for (const [id, steps] of groups) {
    if (process.argv[3] && !process.argv[3].split(',').includes(id)) continue
    const directory = path.join(root, id), host = createFocusPreview(directory), now = new Date(2026, 8, 7, 8).getTime(), raw = []
    const options = { host, now: () => now, setTimer: () => ({}), clearTimer: () => {} }
    const focus = new FocusService(options), reminders = new ReminderService(options)
    let harness, decision
    const restart = () => {
      harness?.stop(); harness?.clearNotices()
      harness = new PetHarness({ directory, focusTools: focus, reminderTools: reminders, memoryIdleMs: 600000, fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body); body.options.seed = 42
        const response = await fetch(url, { ...options, body: JSON.stringify(body) }), data = await response.text()
        raw.push({ request: body, response: data })
        try { decision = JSON.parse(data.split('\n').filter(Boolean).map(l => JSON.parse(l).message?.content || '').join('')).decision } catch { decision = null }
        return new Response(data, { status: response.status })
      } }); harness.setPreferences({ model })
    }
    restart()
    try {
      for (const [input, check] of steps) {
        if (input === '@restart') { restart(); continue }
        const started = Date.now(); harness.start(input); const run = harness.activeRun; await harness.running; harness.cancelMemoryReview('test')
        const reply = harness.messages.at(-1)?.content; let error = null
        try { assert.equal(harness.error, ''); check({ host, harness, reminders, focus, now, reply, decision, run }) } catch (e) { error = e.message }
        const result = { id, input, passed: !error, reply, decision, error, durationMs: Date.now() - started }
        results.push(result); console.log(JSON.stringify(result)); fs.writeFileSync(path.join(directory, 'raw.json'), JSON.stringify(raw, null, 2))
      }
    } finally { harness.stop(); harness.clearNotices(); await focus.dispose(); await reminders.dispose() }
  }
  const report = { model, passed: results.filter(r => r.passed).length, total: results.length, results }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(root)
  if (report.passed !== report.total) process.exitCode = 1
})().catch(e => { console.error(e); process.exitCode = 1 })
