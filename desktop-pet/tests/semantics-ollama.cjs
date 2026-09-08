// Production reminder + focus protocol, real local LLM, isolated durable workspace.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createFocusPreview } = require('../focus-preview.cjs')
const { FocusService } = require('../focus-service.cjs')
const { ReminderService } = require('../reminder-service.cjs')
const { PetHarness } = require('../harness.cjs')
const model = process.argv[2] || 'qwen3:4b-instruct-2507-q4_K_M', seed = Number(process.argv[3] || 42)
const root = path.resolve('.artifacts/pet-semantics-ollama', `run-${Date.now()}`)
fs.mkdirSync(root, { recursive: true })
const clock = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime()
const at = expected => f => { assert.equal(f.reminders.snapshot().reminders.length, 1); assert.equal(f.reminders.snapshot().reminders[0].at, expected); assert.match(f.reply, /已加入临时安排|改好啦/); assert.equal(f.focus.context().state, 'idle') }
const unchanged = f => assert.equal(JSON.stringify(f.host.read()), f.before)
const atOrClarifies = expected => f => {
  if (f.reminders.snapshot().reminders.length) { at(expected)(f); return 'executed' }
  unchanged(f); assert.match(f.reply, /还没设置.*日期.*提醒事项/); return 'clarified'
}
const idle = f => assert.equal(f.focus.context().state, 'idle')
const focusFor = minutes => f => { assert.equal(f.focus.context().state, 'focus'); assert.equal(f.host.read().widgets.find(w => w.kind === 'pomodoro').data.remainingSeconds, minutes * 60); assert.equal(f.reminders.snapshot().reminders.length, 0) }
const groups = [
  ['bedtime-night', clock(6, 22, 42), [
    ['11点提醒我上床睡觉。', at(clock(6, 23))],
    ['改到11点半吧', at(clock(6, 23, 30))],
    ['不用提醒这个了', f => { assert.equal(f.reminders.snapshot().reminders.length, 0); assert.equal(f.host.read().widgets.find(w => w.kind === 'todo').data.items.length, 1) }],
  ]],
  ['bedtime-morning', clock(6, 8), [['11点提醒我上床睡觉。', at(clock(6, 23))]]],
  ['wake-up', clock(6, 22, 42), [['明天7点提醒我起床', at(clock(7, 7))]]],
  ['night-shift', clock(6, 22, 42), [['我上夜班，明天上午下班，11点提醒我上床睡觉。', atOrClarifies(clock(7, 11))]]],
  ['compound-reminder', clock(6, 22, 42), [['一个半小时后提醒我取快递', at(clock(7, 0, 12))]]],
  ['quarter-reminder', clock(6, 22, 42), [['一刻钟后提醒我关火', at(clock(6, 22, 57))]]],
  ['past', clock(6, 22, 42), [['今天上午11点提醒我睡觉', unchanged]]],
  ['negation', clock(6, 22, 42), [['11点别提醒我睡觉', unchanged]]],
  ['quote', clock(6, 22, 42), [['翻译成英文：11点提醒我上床睡觉。', f => { unchanged(f); assert.match(f.reply, /(?:remind|notify).*(?:11|eleven)/i) }]]],
  ['focus-compound', clock(6, 22, 42), [
    ['陪我专注一个半小时', focusFor(90)],
    ['还剩多久呀', f => { assert.equal(f.decision.action, 'focus.status'); assert.match(f.reply, /还剩/); unchanged(f) }],
    ['我继续写，你帮我看着时间就行', unchanged],
    ['先停一下吧，我要去休息了', idle],
  ]],
  ['focus-combined', clock(6, 22, 42), [['帮我计时一小时二十分钟', focusFor(80)]]],
  ['focus-quarter', clock(6, 22, 42), [['陪我专注一刻钟', focusFor(15)]]],
  ['focus-half', clock(6, 22, 42), [['开半个小时番茄钟', focusFor(30)]]],
  ['focus-default', clock(6, 22, 42), [['我要写一会儿代码了', focusFor(25)], ['今天先干到这儿吧', idle]]],
  ['focus-opt-out', clock(6, 22, 42), [['今天写代码不用帮我计时', unchanged], ['我现在开始写代码了', unchanged], ['还是开个十分钟番茄钟吧', focusFor(10)]]],
  ['focus-future', clock(6, 22, 42), [['一个小时后再开始专注', f => { unchanged(f); assert.match(f.reply, /还不能预约|不能.*开始/) }]]],
  ['focus-range', clock(6, 22, 42), [['开20到30分钟番茄钟', unchanged]]],
]
const results = []
;(async () => {
  for (const [id, now, steps] of groups) {
    if (process.argv[4] && !process.argv[4].split(',').includes(id)) continue
    const directory = path.join(root, id), host = createFocusPreview(directory), raw = []
    const timers = { now: () => now, setTimer: () => ({}), clearTimer: () => {} }
    const focus = new FocusService({ host, ...timers }), reminders = new ReminderService({ host, directory, ...timers })
    let decision
    const harness = new PetHarness({ directory, focusTools: focus, reminderTools: reminders, memoryIdleMs: 600000,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body); body.options = { ...body.options, seed }
        const response = await fetch(url, { ...options, body: JSON.stringify(body) }), data = await response.text()
        raw.push({ request: body, status: response.status, response: data })
        const content = data.split('\n').filter(Boolean).map(line => JSON.parse(line).message?.content || '').join('')
        try { decision = JSON.parse(content).decision } catch { decision = null }
        return new Response(data, { status: response.status })
      },
    })
    harness.setPreferences({ model })
    try {
      for (const [input, check] of steps) {
        const before = JSON.stringify(host.read()), start = Date.now()
        harness.start(input); await harness.running; harness.cancelMemoryReview('test')
        const reply = harness.messages.at(-1)?.content
        let error = null, outcome = null
        try { assert.equal(harness.error, ''); outcome = check({ host, focus, reminders, before, reply, decision }) || 'passed' } catch (e) { error = e.message }
        const result = { id, input, decision, reply, passed: !error, outcome, error, durationMs: Date.now() - start }
        results.push(result); console.log(JSON.stringify(result))
      }
      fs.writeFileSync(path.join(directory, 'raw.json'), JSON.stringify(raw, null, 2))
    } finally { harness.stop(); harness.clearNotices(); await reminders.dispose(); await focus.dispose() }
  }
  const report = { model, seed, passed: results.filter(r => r.passed).length, total: results.length, results }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(root)
  if (report.passed !== report.total) process.exitCode = 1
})().catch(e => { console.error(e); process.exitCode = 1 })
