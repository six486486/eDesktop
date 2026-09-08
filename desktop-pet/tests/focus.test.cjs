const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createWidget } = require('../../electron/widget-model.cjs')
const { createFocusHost } = require('../focus-host.cjs')
const { FocusService } = require('../focus-service.cjs')
const { readFocusEnvelope, focusReply, focusPermission, focusSchema, explicitMinutes } = require('../focus-tools.cjs')
const { PetHarness } = require('../harness.cjs')

const tick = () => new Promise(resolve => setImmediate(resolve))
const packet = (content, done = false) => Buffer.from(JSON.stringify({ message: { content }, done }) + '\n')
const envelope = (tool, minutes = 0, reply = '好。') => JSON.stringify({
  decision: { name: tool, minutes }, response: { text: reply, visual: 'none' },
})
function fixture(t, initial) {
  let workspace = initial || { widgets: [], settings: { desktopEnabled: true } }, durable = structuredClone(workspace)
  let tail = Promise.resolve(), now = 100000, fail = false, writes = 0
  const events = [], timers = []
  const host = createFocusHost({ read: () => workspace,
    enqueue: operation => { const result = tail.then(operation, operation); tail = result.catch(() => {}); return result },
    createWidget: next => createWidget('pomodoro', { index: next.widgets.length, primaryOffset: { x: 0, y: 0 } }),
    persist: async next => { if (fail) throw new Error('disk'); durable = structuredClone(next); writes++ },
    publish: next => { workspace = next; host.changed() },
  })
  const options = { host, now: () => now, onComplete: event => events.push(event),
    setTimer: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer }, clearTimer: () => {} }
  const service = new FocusService(options)
  service.start()
  t.after(() => service.dispose())
  let id = 0
  return { host, service, options, events, timers,
    get workspace() { return workspace }, get durable() { return durable }, get writes() { return writes },
    setNow: value => { now = value }, setFail: value => { fail = value },
    call: (name, minutes = 0, context = {}) => service.execute({ name, minutes }, { runId: String(++id), ...context }),
  }
}

test('focus envelopes stream chat only after the no-tool decision; tool speech is withheld in any field order', () => {
  const raw = envelope('none', 0, '我在这儿🐈，慢慢说。')
  let previous = ''
  for (let i = 0; i <= raw.length; i++) {
    const result = readFocusEnvelope(raw.slice(0, i))
    assert.ok(result.text.startsWith(previous))
    assert.ok('我在这儿🐈，慢慢说。'.startsWith(result.text))
    previous = result.text
  }
  assert.equal(readFocusEnvelope(raw, true).state, 'model')
  assert.equal(readFocusEnvelope(`${raw}\n`, true).state, 'model')
  for (const tool of ['focus.start', 'focus.stop', 'focus.status']) {
    for (const candidate of [envelope(tool, 0, '已经完成'), JSON.stringify({
      response: { text: '已经完成', visual: 'none' }, decision: { name: tool, minutes: 0 },
    })]) {
      for (let i = 0; i <= candidate.length; i++) assert.equal(readFocusEnvelope(candidate.slice(0, i)).text, '')
      assert.equal(readFocusEnvelope(candidate, true).tool.name, tool)
    }
  }
})

test('invalid, duplicate, missing and truncated tool fields never become an executable proposal', () => {
  for (const raw of [
    envelope('shell.exec'), envelope('__proto__'), envelope('focus.start', 1.5),
    '{"decision":{"name":"focus.stop","minutes":0,"name":"focus.start"},"response":{"text":"好。","visual":"none"}}',
    '{"decision":{"name":"focus.start","minutes":"20"},"response":{"text":"好。","visual":"none"}}',
    '{"decision":{"name":"none","minutes":0},"response":{"text":"hi","visual":"none"},"extra":true}',
    envelope('focus.status', 20), envelope('focus.start').slice(0, -1), '开始了',
    '{"response":{"text":"我在","visual":"none"}}',
  ]) {
    const result = readFocusEnvelope(raw, true)
    assert.equal(result.state, 'invalid', raw)
    assert.equal(result.tool, undefined)
  }
})

test('materials, capability questions and unsupported schedules disable tools while ordinary self-reports remain available', () => {
  for (const text of ['请翻译：停止番茄钟', '解释“开始计时”的含义', '假设我让你计时十分钟', '你能帮我计时吗？', '明天九点帮我开始二十分钟专注', '一个小时后再开始专注', '一刻钟后开始番茄钟']) {
    assert.notEqual(focusPermission(text), 'available')
    assert.deepEqual(focusSchema(focusPermission(text)).properties.decision.properties.name.enum, ['none'])
  }
  for (const text of ['陪我专注二十分钟', '开始吧', '先停了', '我想让你帮我计时十分钟', '还要等多久？', '我要干一会活了', '我想干一会活了', '我准备写一会儿代码', '我准备看电视剧']) {
    assert.equal(focusPermission(text), 'available')
  }
})

test('model context describes manually started clocks and the actual configured default', async t => {
  const f = fixture(t)
  assert.deepEqual(f.service.context(), { state: 'idle', activeCount: 0, defaultMinutes: 25 })
  await f.call('focus.start', 20)
  f.workspace.widgets[0].data.petFocus = null
  f.workspace.widgets[0].data.focusMinutes = 40
  assert.deepEqual(f.service.context(), { state: 'focus', activeCount: 1, defaultMinutes: 40 })
  assert.equal(f.service.snapshot().running, false, 'the resting pose still describes pet-owned sessions only')
  let request
  const { harness } = harnessFixture(t, async (_url, options) => {
    request = JSON.parse(options.body)
    return new Response(packet(envelope('focus.status'), true))
  }, f.service)
  harness.start('还剩多久？')
  await harness.running
  assert.match(request.messages[0].content, /"state":"focus"/)
  assert.match(request.messages[0].content, /"defaultMinutes":40/)
})

test('a provider that bypasses a narrowed schema still cannot execute material as a command', async t => {
  let called = false, request
  const { harness } = harnessFixture(t, async (_url, options) => {
    request = JSON.parse(options.body)
    return new Response(packet(envelope('focus.start', 20), true))
  }, {
    execute: async () => { called = true; return { status: 'started', minutes: 20 } },
  })
  harness.start('翻译这句话：开始计时二十分钟')
  await harness.running
  assert.equal(called, false)
  assert.deepEqual(request.format.required, ['reply', 'action'])
  assert.match(harness.error, /再试一次/)
})

test('active clocks expose stop and status only, and a provider cannot bypass that request scope', async t => {
  const f = fixture(t)
  await f.call('focus.start', 20)
  const before = structuredClone(f.workspace)
  let request
  const { harness, directory } = harnessFixture(t, async (_url, options) => {
    request = JSON.parse(options.body)
    return new Response(packet(envelope('focus.start', 30), true))
  }, f.service)
  harness.start('再开始三十分钟')
  await harness.running
  assert.deepEqual(request.format.properties.decision.properties.name.enum, ['none', 'focus.stop', 'focus.status'])
  assert.deepEqual(request.format.properties.decision.properties.minutes.enum, [0])
  assert.match(harness.error, /当前计时状态不支持/)
  assert.deepEqual(f.workspace, before)
  assert.equal(f.writes, 1)
  const log = JSON.parse(fs.readFileSync(path.join(directory, 'runs.jsonl'), 'utf8').trim())
  assert.deepEqual(log.availableTools, request.format.properties.decision.properties.name.enum)
  // When the clock becomes idle, the next request regains the start capability.
  await f.call('focus.stop')
  harness.start('现在开始三十分钟')
  await harness.running
  assert.ok(request.format.properties.decision.properties.name.enum.includes('focus.start'))
  assert.equal(f.workspace.widgets[0].data.petFocus.minutes, 30)
})

test('start, real-time status and stop share a durable widget without changing default durations', async t => {
  const f = fixture(t)
  const started = await f.call('focus.start', 20)
  assert.equal(started.status, 'started')
  assert.equal(f.workspace.widgets.length, 1)
  assert.equal(f.workspace.widgets[0].data.focusMinutes, 25)
  assert.deepEqual(f.durable, f.workspace)
  f.setNow(135500)
  const status = await f.call('focus.status')
  assert.equal(status.remainingSeconds, 1165)
  assert.match(focusReply(status), /19 分25 秒/)
  assert.equal(f.writes, 1, 'query does not persist or create a timer')
  assert.equal((await f.call('focus.stop')).status, 'stopped')
  assert.equal(f.workspace.widgets[0].data.running, false)
  f.setNow(99999999)
  await f.service.completeDue()
  assert.equal(f.events.length, 0)
})

test('runtime enforces parameter bounds and whitelist even if the model violates its schema', async t => {
  const f = fixture(t)
  for (const [name, minutes] of [['focus.start', -1], ['focus.start', 241], ['focus.start', 1.5], ['focus.start', '20'], ['focus.stop', 1], ['shell.exec', 0]]) {
    assert.equal((await f.call(name, minutes)).status, 'invalid-arguments')
  }
  assert.equal(f.writes, 0)
  assert.equal(f.workspace.widgets.length, 0)
  for (const minutes of [1, 240, 0]) {
    const result = await f.call('focus.start', minutes)
    assert.equal(result.minutes, minutes || 25)
    await f.call('focus.stop')
  }
})

test('an explicit duration is derived from the user, not a model-invented default', async t => {
  for (const [text, minutes] of [['陪我专注十二分钟', 12], ['开始 240 分钟', 240], ['计时两小时', 120], ['二百零五分钟', 205],
    ['陪我专注一个半小时', 90], ['开半个小时', 30], ['一小时二十分钟', 80], ['计时一刻钟', 15], ['计时三刻钟', 45], ['一点五小时', 90]]) {
    assert.equal(explicitMinutes(text).minutes, minutes)
  }
  for (const text of ['现在开始吧', '十分钟还是二十分钟']) assert.equal(explicitMinutes(text), null)
  assert.ok(Number.isNaN(explicitMinutes('20到30分钟').minutes))
  assert.equal(explicitMinutes('1.5分钟').minutes, 1.5)
  assert.equal(explicitMinutes('半小时').minutes, 30)
  assert.equal(explicitMinutes('零分钟').minutes, 0)
  assert.equal(explicitMinutes('-10分钟').minutes, -10)
  const f = fixture(t)
  const { harness } = harnessFixture(t, async () => new Response(packet(envelope('focus.start', 0), true)), f.service)
  harness.start('陪我专注十二分钟')
  await harness.running
  assert.equal(f.workspace.widgets[0].data.remainingSeconds, 720)
  assert.match(harness.messages.at(-1).content, /12 分钟/)
  await f.call('focus.stop')
  for (const [input, seconds] of [['陪我专注一个半小时', 5400], ['计时一小时二十分钟', 4800], ['专注一刻钟', 900]]) {
    harness.start(input); await harness.running
    assert.equal(f.workspace.widgets[0].data.remainingSeconds, seconds, input)
    await f.call('focus.stop')
  }
  for (const text of ['开始零分钟', '开始1.5分钟', '开始-10分钟']) {
    harness.start(text)
    await harness.running
    assert.equal(f.workspace.widgets[0].data.running, false)
    assert.match(harness.messages.at(-1).content, /整数分钟/)
  }
})

test('duplicate run and repeated start cannot reset a clock; multiple active clocks are not guessed', async t => {
  const f = fixture(t)
  const first = await f.call('focus.start', 20, { runId: 'same' })
  assert.deepEqual(await f.call('focus.start', 30, { runId: 'same' }), first)
  assert.equal((await f.call('focus.start', 30)).status, 'already-running')
  assert.equal(f.writes, 1)
  f.workspace.widgets.push({ ...structuredClone(f.workspace.widgets[0]), id: 'second' })
  assert.equal((await f.call('focus.stop')).status, 'ambiguous')
  assert.equal(f.workspace.widgets.every(widget => widget.data.running), true)
})

test('queued cancellation and failed persistence leave both live and durable state untouched', async t => {
  const f = fixture(t)
  let release, current = true
  const blocked = f.host.transact(async () => ({ value: null })) // establish queue order
  await blocked
  const originalPersist = f.options.host.transact
  f.options.host.transact = (edit, guard) => new Promise(resolve => { release = () => resolve(originalPersist(edit, guard)) })
  const cancelled = f.call('focus.start', 20, { isCurrent: () => current })
  current = false
  release()
  assert.equal((await cancelled).status, 'cancelled')
  f.options.host.transact = originalPersist
  f.setFail(true)
  assert.equal((await f.call('focus.start', 20)).status, 'failed')
  assert.equal(f.workspace.widgets.length, 0)
  assert.deepEqual(f.workspace, f.durable)
})

test('completion is persisted once, survives restart, and needs no renderer or model', async t => {
  const f = fixture(t)
  await f.call('focus.start', 1)
  f.setNow(160000)
  await Promise.all([f.service.completeDue(), f.service.completeDue()])
  assert.equal(f.events.length, 1)
  assert.equal(f.workspace.widgets[0].data.sessions, 1)
  assert.equal(f.workspace.widgets[0].data.mode, 'break')
  assert.equal(f.workspace.widgets[0].data.running, false)
  const restored = new FocusService(f.options)
  restored.start()
  await restored.completeDue()
  await restored.dispose()
  assert.equal(f.events.length, 1)
  const late = fixture(t, { widgets: [{ ...f.workspace.widgets[0], data: {
    ...f.workspace.widgets[0].data, mode: 'focus', running: true, endsAt: 50000,
    petFocus: { id: 'before-restart', minutes: 1, status: 'active' },
  } }], settings: { desktopEnabled: true } })
  await late.service.completeDue()
  assert.equal(late.events.length, 1)
})

test('manual pause, reset, reschedule or removal invalidates the old deadline', async t => {
  const f = fixture(t)
  await f.call('focus.start', 1)
  f.workspace.widgets[0].data.running = false
  f.host.changed()
  f.setNow(170000)
  await f.service.completeDue()
  assert.equal(f.events.length, 0)
  f.workspace.widgets[0].data.running = true
  f.workspace.widgets[0].data.endsAt = 200000
  f.host.changed()
  await f.service.completeDue()
  assert.equal(f.events.length, 0)
  f.workspace.widgets = []
  f.setNow(210000)
  await f.service.completeDue()
  assert.equal(f.events.length, 0)
})

test('a failed completion save does not announce success or consume the event', async t => {
  const f = fixture(t)
  await f.call('focus.start', 1)
  f.setNow(160000)
  f.setFail(true)
  await assert.rejects(f.service.completeDue(), /disk/)
  assert.equal(f.events.length, 0)
  assert.equal(f.workspace.widgets[0].data.running, true)
  f.setFail(false)
  await f.service.completeDue()
  assert.equal(f.events.length, 1)
})

test('manually started focus and break phases both schedule and notify exactly once', async t => {
  for (const mode of ['focus', 'break']) {
    const widget = createWidget('pomodoro', { index: 0, primaryOffset: { x: 0, y: 0 } })
    widget.data = { ...widget.data, mode, running: true, endsAt: 100250, sessions: 2, petFocus: null }
    const f = fixture(t, { widgets: [widget], settings: { desktopPetEnabled: true } })
    assert.equal(f.timers.at(-1)?.ms, 250, `${mode} has a main-process wakeup`)
    f.setNow(100250)
    await Promise.all([f.service.completeDue(), f.service.completeDue()])
    assert.equal(f.events.length, 1)
    assert.equal(f.events[0].mode, mode)
    assert.equal(f.events[0].minutes, mode === 'focus' ? 25 : 5)
    const data = f.workspace.widgets[0].data
    assert.equal(data.mode, mode === 'focus' ? 'break' : 'focus')
    assert.equal(data.remainingSeconds, mode === 'focus' ? 300 : 1500)
    assert.equal(data.sessions, mode === 'focus' ? 3 : 2)
    assert.equal(data.running, false)
    assert.deepEqual(f.workspace, f.durable)
    const restored = new FocusService(f.options)
    await restored.completeDue(); await restored.dispose()
    assert.equal(f.events.length, 1)
  }
})

test('a completed pet focus can be followed by a manually started break without reusing its notice ID', async t => {
  const f = fixture(t)
  await f.call('focus.start', 1)
  f.setNow(160000); await f.service.completeDue()
  const firstId = f.events[0].id
  Object.assign(f.workspace.widgets[0].data, { running: true, endsAt: 160500 })
  f.host.changed(); f.setNow(160500); await f.service.completeDue()
  assert.equal(f.events.length, 2)
  assert.equal(f.events[1].mode, 'break')
  assert.notEqual(f.events[1].id, firstId)
  assert.equal(f.workspace.widgets[0].data.sessions, 1)
})

function harnessFixture(t, fetchImpl, focusTools) {
  const directory = path.resolve('.artifacts/desktop-pet-focus-tests', `${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const harness = new PetHarness({ directory, fetchImpl, focusTools, memoryIdleMs: 60000 })
  harness.setPreferences({ model: 'fixture' })
  t.after(() => harness.stop('shutdown'))
  return { harness, directory }
}

test('harness executes only after done and shows the actual receipt, never the model success claim', async t => {
  let stream, calls = 0
  const { harness, directory } = harnessFixture(t, async () => new Response(new ReadableStream({ start(controller) { stream = controller } })), {
    execute: async () => { calls++; return { status: 'failed' } },
  })
  harness.start('陪我专注二十分钟')
  await tick()
  stream.enqueue(packet(envelope('focus.start', 20, '已经成功开始了！')))
  await tick()
  assert.equal(calls, 0)
  assert.equal(harness.snapshot().reply, '')
  stream.enqueue(packet('', true))
  stream.close()
  await harness.running
  assert.equal(calls, 1)
  assert.match(harness.messages.at(-1).content, /没能完成/)
  assert.doesNotMatch(JSON.stringify(harness.messages), /成功开始/)
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'tool-runs.jsonl'), 'utf8').trim())
  assert.equal(receipt.status, 'failed')
})

test('interrupted tool proposal never executes; close/reset/model changes preserve an accepted clock', async t => {
  const f = fixture(t)
  let stream
  const { harness } = harnessFixture(t, async () => new Response(new ReadableStream({ start(controller) { stream = controller } })), f.service)
  harness.start('开始二十分钟')
  await tick()
  stream.enqueue(packet(envelope('focus.start', 20)))
  await tick()
  harness.stop()
  await harness.running
  assert.equal(f.writes, 0)
  harness.fetch = async () => new Response(packet(envelope('focus.start', 20), true))
  harness.start('现在开始二十分钟')
  await harness.running
  assert.equal(f.workspace.widgets[0].data.running, true)
  harness.stop('chat-close')
  harness.resetConversation()
  harness.setPreferences({ model: 'another-model' })
  assert.equal(f.workspace.widgets[0].data.running, true)
})

test('late receipt is logged but cannot overwrite a newer chat after the commit boundary', async t => {
  let release, calls = 0
  const { harness, directory } = harnessFixture(t, async () => new Response(packet(
    calls === 0 ? envelope('focus.start', 20) : envelope('none', 0, '我在听。'), true)), {
    execute: () => { calls++; return new Promise(resolve => { release = resolve }) },
  })
  harness.start('开始二十分钟')
  await tick()
  const old = harness.running
  harness.start('继续聊吧')
  await harness.running
  release({ status: 'started', minutes: 20 })
  await old
  assert.equal(harness.messages.at(-1).content, '我在听。')
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'tool-runs.jsonl'), 'utf8').trim()).status, 'started')
})
