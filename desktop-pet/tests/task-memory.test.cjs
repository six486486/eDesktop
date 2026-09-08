const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { createFocusHost } = require('../focus-host.cjs')
const { createWidget } = require('../../electron/widget-model.cjs')
const { PetHarness } = require('../harness.cjs')
const { FocusService } = require('../focus-service.cjs')
const { ReminderService } = require('../reminder-service.cjs')
const { memoryOf, recordOperation, compactHistory, WORKING_TTL, OPERATION_TTL } = require('../task-memory.cjs')
const { readReminderEnvelope } = require('../reminder-tools.cjs')
const doc = (action, params = {}) => JSON.stringify({ assessment: '测试用户意图', decision: { action, params }, response: { text: '模型草稿', visual: 'none' } })
const focusRule = (activity, minutes, evidence = `${activity}${minutes}分钟`) => ({ kind: 'focus', activity, minutes, clock: '', timeOfDay: 'auto', evidence })
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-task-memory-'))
  let workspace = { widgets: [] }, durable = structuredClone(workspace), tail = Promise.resolve(), now = new Date(2026, 8, 7, 8).getTime(), fail = false, proposal
  const host = createFocusHost({ read: () => workspace, enqueue: fn => { const r = tail.then(fn); tail = r.catch(() => {}); return r },
    persist: async next => { if (fail) throw new Error('disk failure'); durable = structuredClone(next) }, publish: next => { workspace = next; host.changed() },
    createWidget: (next, kind = 'pomodoro') => createWidget(kind, { index: next.widgets.length, primaryOffset: { x: 0, y: 0 } }),
  })
  const options = { host, now: () => now, setTimer: () => ({}), clearTimer: () => {} }
  const focus = new FocusService(options), reminders = new ReminderService(options)
  let harness
  const restart = () => {
    harness?.stop(); harness?.clearNotices()
    harness = new PetHarness({ directory, focusTools: focus, reminderTools: reminders, memoryIdleMs: 600000,
      fetchImpl: async () => new Response(JSON.stringify({ message: { content: typeof proposal === 'function' ? proposal(harness.activeRun) : proposal }, done: true }) + '\n') })
    harness.setPreferences({ model: 'fixture' })
  }
  restart()
  t.after(async () => { harness.stop(); harness.clearNotices(); await focus.dispose(); await reminders.dispose(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { host, focus, reminders, restart, get harness() { return harness }, get now() { return now }, advance: ms => { now += ms }, setNow: v => { now = v },
    get durable() { return durable }, fail: value => { fail = value },
    async turn(text, action, params) { proposal = typeof action === 'function' ? action : doc(action, params); harness.start(text); const run = harness.activeRun; await harness.running; harness.cancelMemoryReview('test'); return { run, reply: harness.messages.at(-1)?.content, error: harness.error } } }
}
test('multi-turn reminder fields retain user provenance; corrections mutate one actual item and shift uses the old deadline', async t => {
  const f = fixture(t)
  let r = await f.turn('提醒我取快递', 'reminder.create', { text: '取快递', when: '', timeOfDay: 'auto', memoryId: '' })
  assert.equal(r.error, ''); assert.equal(f.reminders.snapshot().reminders.length, 0); assert.match(r.reply, /什么时候/)
  const originalSource = r.run.userMessage.id
  f.advance(60000)
  r = await f.turn('二十分钟后', 'reminder.create', { text: '取快递', when: '二十分钟后', timeOfDay: 'auto', memoryId: '' })
  assert.equal(r.error, '')
  const item = f.reminders.snapshot().reminders[0], op = memoryOf(f.durable, f.now).operations.at(-1)
  assert.equal(item.at, f.now + 20 * 60000); assert.equal(op.fieldSources.text.messageId, originalSource); assert.equal(op.fieldSources.when.messageId, r.run.userMessage.id)
  f.advance(60000)
  r = await f.turn('还是改成半小时后吧', 'reminder.update', { targetId: item.id, when: '半小时后', timeOfDay: 'auto', memoryId: '' })
  assert.equal(r.error, ''); assert.equal(f.reminders.snapshot().reminders[0].at, f.now + 30 * 60000)
  const oldAt = f.reminders.snapshot().reminders[0].at
  f.advance(60000)
  r = await f.turn('再推迟十分钟', 'reminder.shift', { targetId: item.id, minutes: 10 })
  assert.equal(r.error, ''); assert.equal(f.reminders.snapshot().reminders[0].at, oldAt + 10 * 60000)
  await f.turn('不用提醒这个了', 'reminder.cancel', { targetId: item.id })
  assert.equal(f.reminders.snapshot().reminders.length, 0); assert.equal(f.host.read().widgets[0].data.items.length, 1)
})
test('pending dates are anchored to their source message across midnight; expired and reset drafts cannot authorize old text', async t => {
  const f = fixture(t); f.setNow(new Date(2026, 8, 7, 23, 59).getTime())
  await f.turn('明天上午九点提醒我', 'reminder.create', { text: '', when: '明天上午九点', timeOfDay: 'auto' })
  f.advance(120000)
  const r = await f.turn('取快递', 'reminder.create', { text: '取快递', when: '明天上午九点', timeOfDay: 'auto' })
  assert.equal(r.error, ''); assert.equal(f.reminders.snapshot().reminders[0].at, new Date(2026, 8, 8, 9).getTime())
  await f.turn('提醒我喝水', 'reminder.create', { text: '喝水', when: '', timeOfDay: 'auto' })
  f.advance(WORKING_TTL + 1)
  assert.match((await f.turn('十分钟后', 'reminder.create', { text: '喝水', when: '十分钟后', timeOfDay: 'auto' })).error, /说过的事项/)
  await f.turn('提醒我浇花', 'reminder.create', { text: '浇花', when: '', timeOfDay: 'auto' })
  f.harness.resetConversation()
  assert.match((await f.turn('十分钟后', 'reminder.create', { text: '浇花', when: '十分钟后', timeOfDay: 'auto' })).error, /说过的事项/)
})
test('new explicit time invalidates an older pending field even if the model copies that old value', async t => {
  const f = fixture(t)
  await f.turn('明天上午九点提醒我', 'reminder.create', { text: '', when: '明天上午九点', timeOfDay: 'auto' })
  const r = await f.turn('改成明天上午十点提醒我取快递', 'reminder.create', { text: '取快递', when: '明天上午九点', timeOfDay: 'auto' })
  assert.match(r.error, /新的时间/); assert.equal(f.reminders.snapshot().reminders.length, 0)
})
test('unsupported future focus cannot be silently converted into a reminder, while explicit future reminders still work', async t => {
  const f = fixture(t)
  let r = await f.turn('一个小时后再开始专注', 'reminder.create', { text: '专注', when: '一个小时后', timeOfDay: 'auto' })
  assert.equal(r.error, ''); assert.match(r.reply, /还不能预约/); assert.equal(f.reminders.snapshot().reminders.length, 0)
  r = await f.turn('一个小时后提醒我开始专注', 'reminder.create', { text: '开始专注', when: '一个小时后', timeOfDay: 'auto' })
  assert.equal(r.error, ''); assert.equal(f.reminders.snapshot().reminders.length, 1); assert.equal(f.focus.context().state, 'idle')
})
test('activity habits survive restart, explicit one-off duration wins, replacement versions and forgetting are real transactions', async t => {
  const f = fixture(t)
  let r = await f.turn('以后写代码45分钟，看书25分钟', 'memory.remember', { rules: [focusRule('写代码', 45), focusRule('看书', 25)] })
  assert.equal(r.error, ''); assert.equal(f.focus.context().state, 'idle'); assert.equal(f.harness.snapshot().memory.habits.length, 2)
  f.restart(); const code = f.harness.snapshot().memory.habits.find(h => h.activity === '写代码')
  r = await f.turn('我要写代码了', 'focus.start', { activity: '写代码', minutes: 0, memoryId: code.id })
  assert.equal(r.error, ''); assert.equal(f.host.read().widgets[0].data.remainingSeconds, 45 * 60)
  await f.turn('停一下', 'focus.stop', {})
  await f.turn('写代码，这次20分钟', 'focus.start', { activity: '写代码', minutes: 45, memoryId: code.id })
  assert.equal(f.host.read().widgets[0].data.remainingSeconds, 20 * 60); assert.equal(f.harness.snapshot().memory.habits.find(h => h.id === code.id).minutes, 45)
  r = await f.turn('以后写代码30分钟', 'memory.remember', { rules: [focusRule('写代码', 30)] })
  assert.equal(r.error, ''); assert.equal(f.harness.snapshot().memory.habits.find(h => h.id === code.id).version, 2)
  r = await f.turn('忘掉写代码的习惯', 'memory.forget', { ids: [code.id] })
  assert.equal(r.error, ''); assert.equal(f.harness.snapshot().memory.habits.length, 1); assert.equal(f.host.read().widgets[0].data.focusMinutes, 25)
})
test('successful operation recall/reuse uses actual minutes; failed tools and cancelled reminder references cannot become new actions', async t => {
  const f = fixture(t)
  await f.turn('写代码，计时35分钟', 'focus.start', { activity: '写代码', minutes: 10, memoryId: '' })
  await f.turn('停一下', 'focus.stop', {})
  const op = f.harness.snapshot().memory.operations.find(o => o.name === 'focus.start')
  await f.turn('上次写代码计时多久', 'memory.recall', { id: op.id })
  const r = await f.turn('这次也一样', 'focus.start', { activity: '写代码', minutes: 0, memoryId: op.id })
  assert.equal(r.error, ''); assert.equal(f.host.read().widgets[0].data.remainingSeconds, 35 * 60)
  f.fail(true); const count = f.harness.snapshot().memory.operations.length
  await f.turn('停止番茄钟', 'focus.stop', {}); assert.equal(f.harness.snapshot().memory.operations.length, count)
  f.fail(false)
  await f.turn('十分钟后提醒我喝水', 'reminder.create', { text: '喝水', when: '十分钟后', timeOfDay: 'auto' })
  const reminder = f.reminders.snapshot().reminders[0], create = f.harness.snapshot().memory.operations.find(o => o.name === 'reminder.create')
  await f.turn('取消喝水提醒', 'reminder.cancel', { targetId: reminder.id })
  const rejected = await f.turn('按上次一样再设提醒', 'reminder.create', { text: '喝水', when: '十分钟后', timeOfDay: 'auto', memoryId: create.id })
  assert.match(rejected.error, /已取消或移除/); assert.equal(f.reminders.snapshot().reminders.length, 0)
})
test('memory writes reject one-off claims, invented evidence, inconsistent duration and failed persistence', async t => {
  const f = fixture(t)
  for (const [input, rules] of [
    ['记住这次写代码20分钟', [focusRule('写代码', 20, '这次写代码20分钟')]],
    ['以后写代码45分钟', [focusRule('写代码', 30, '写代码45分钟')]],
    ['以后写代码45分钟', [focusRule('看书', 25)]],
  ]) { assert.ok((await f.turn(input, 'memory.remember', { rules })).error); assert.equal(f.harness.snapshot().memory.habits.length, 0) }
  f.fail(true)
  assert.ok((await f.turn('以后写代码45分钟', 'memory.remember', { rules: [focusRule('写代码', 45)] })).error)
  assert.equal(f.harness.snapshot().memory.habits.length, 0)
})
test('clock interpretation is scoped to activity and never overrides an explicit morning', async t => {
  const f = fixture(t)
  const evidence = '我说11点睡觉就是晚上11点'
  let r = await f.turn(`以后${evidence}`, 'memory.remember', { rules: [{ kind: 'clock', activity: '睡觉', minutes: 0, clock: '11:00', timeOfDay: 'pm', evidence }] })
  assert.equal(r.error, ''); const id = f.harness.snapshot().memory.habits[0].id
  r = await f.turn('11点提醒我睡觉', 'reminder.create', { text: '睡觉', when: '11点', timeOfDay: 'auto', memoryId: id })
  assert.equal(r.error, ''); assert.equal(new Date(f.reminders.snapshot().reminders[0].at).getHours(), 23)
  r = await f.turn('明天上午11点提醒我睡觉', 'reminder.create', { text: '睡觉', when: '明天上午11点', timeOfDay: 'auto', memoryId: id })
  assert.equal(r.error, ''); assert.equal(new Date(f.reminders.snapshot().reminders[0].at).getHours(), 11)
  assert.match((await f.turn('11点提醒我开会', 'reminder.create', { text: '开会', when: '11点', timeOfDay: 'auto', memoryId: id })).error, /不适用/)
})
test('an omitted model memoryId still applies an exact scoped clock habit and records the selected memory', async t => {
  const f = fixture(t)
  await f.turn('以后我说11点睡觉是上午11点', 'memory.remember', { rules: [{ kind: 'clock', activity: '说11点睡觉', minutes: 0, clock: '11:00', timeOfDay: 'am', evidence: '以后我说11点睡觉是上午11点' }] })
  const id = f.harness.snapshot().memory.habits[0].id
  const r = await f.turn('11点提醒我睡觉', 'reminder.create', { text: '睡觉', when: '11点', timeOfDay: 'pm', memoryId: '' })
  assert.equal(r.error, ''); assert.equal(r.run.memorySelection, id); assert.equal(new Date(f.reminders.snapshot().reminders[0].at).getHours(), 11)
})
test('reusing an active relative reminder recomputes from now with a recorded source, never copies its old deadline', async t => {
  const f = fixture(t)
  await f.turn('十分钟后提醒我喝水', 'reminder.create', { text: '喝水', when: '十分钟后', timeOfDay: 'auto' })
  const op = f.harness.snapshot().memory.operations[0]
  f.advance(5 * 60000)
  const r = await f.turn('按上次一样再设一个喝水提醒', 'reminder.create', { text: '喝水', when: '十分钟后', timeOfDay: 'auto', memoryId: op.id })
  assert.equal(r.error, ''); assert.equal(f.reminders.snapshot().reminders.length, 2)
  assert.equal(f.reminders.snapshot().reminders[0].at, f.now + 10 * 60000)
  assert.equal(memoryOf(f.durable, f.now).operations.at(-1).fieldSources.when.reusedFrom, op.id)
  const recent = f.reminders.snapshot().reminders[0]
  await f.turn('改成半小时', 'reminder.update', { targetId: recent.id, when: '半小时', timeOfDay: 'auto' })
  const updated = f.harness.snapshot().memory.operations[0]
  f.advance(5 * 60000)
  const reused = await f.turn('按上次一样再设一个喝水提醒', 'reminder.create', { text: '喝水', when: '半小时', timeOfDay: 'auto', memoryId: updated.id })
  assert.equal(reused.error, ''); assert.equal(f.reminders.snapshot().reminders[0].at, f.now + 30 * 60000)
})
test('explicit targets, stale memory changes, late writes after reset and unrelated habits are bounded', async t => {
  const f = fixture(t)
  await f.turn('十分钟后提醒我喝水', 'reminder.create', { text: '喝水', when: '十分钟后', timeOfDay: 'auto' })
  const first = f.reminders.snapshot().reminders[0]
  await f.turn('二十分钟后提醒我浇花', 'reminder.create', { text: '浇花', when: '二十分钟后', timeOfDay: 'auto' })
  assert.match((await f.turn('改成半小时后', 'reminder.update', { targetId: first.id, when: '半小时后', timeOfDay: 'auto' })).error, /不确定是哪条/)
  f.harness.taskMemory.reset()
  assert.match((await f.turn('取消这个', 'reminder.cancel', { targetId: first.id })).error, /不确定是哪条/)
  const pending = f.turn('以后写代码45分钟', 'memory.remember', { rules: [focusRule('写代码', 45)] })
  f.harness.resetConversation(); await pending
  assert.equal(f.harness.snapshot().memory.habits.length, 0)
  await f.turn('以后写代码45分钟，看书25分钟', 'memory.remember', { rules: [focusRule('写代码', 45), focusRule('看书', 25)] })
  const read = f.harness.snapshot().memory.habits.find(h => h.activity === '看书')
  assert.match((await f.turn('忘掉写代码的习惯', 'memory.forget', { ids: [read.id] })).error, /还没选准/)
  const stale = { memoryContext: f.harness.taskMemory.context('我要看书'), userMessage: { content: '我要看书', at: f.now } }
  await f.host.transact(w => { w.petMemory.habits.find(h => h.id === read.id).minutes = 30; w.petMemory.revision++; return { changed: true } })
  assert.throws(() => f.harness.taskMemory.resolve({ name: 'focus.start', activity: '看书', minutes: 0, memoryId: read.id }, stale), /变化/)
  assert.throws(() => f.harness.taskMemory.resolve({ name: 'focus.start', activity: '看书', minutes: 0, memoryId: '' }, stale), /变化/)
  const r = await f.turn('我现在写报告，开个番茄钟', 'focus.start', { activity: '写报告', minutes: 45, memoryId: '' })
  assert.equal(r.error, ''); assert.equal(f.host.read().widgets.find(w => w.kind === 'pomodoro').data.remainingSeconds, 25 * 60)
})
test('bounded context keeps message pairs, operation TTL and exact nested tool grammar', () => {
  const history = Array.from({ length: 30 }, (_, i) => [{ role: 'user', content: `${i}`.repeat(50) }, { role: 'assistant', content: '答'.repeat(100) }]).flat()
  const compact = compactHistory(history, 500)
  assert.equal(compact[0].role, 'user'); assert.equal(compact.length % 2, 0); assert.ok(compact.reduce((s, m) => s + m.content.length, 0) <= 500)
  const workspace = {}, now = Date.now()
  for (let i = 0; i < 50; i++) recordOperation(workspace, { id: `op${i}`, name: 'focus.start', minutes: 25 }, now)
  assert.equal(memoryOf(workspace, now).operations.length, 40); assert.equal(memoryOf(workspace, now + OPERATION_TTL + 1).operations.length, 0)
  const raw = doc('memory.remember', { rules: [focusRule('写代码', 45)] })
  assert.equal(readReminderEnvelope(raw, true).state, 'tool')
  assert.equal(readReminderEnvelope(raw.replace('"activity":"写代码"', '"activity":"写代码","activity":"看书"'), true).state, 'invalid')
  assert.equal(readReminderEnvelope(raw.replace('}]', '},]'), true).state, 'invalid')
})
