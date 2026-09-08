const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PetHarness } = require('../harness.cjs')

const tick = () => new Promise(resolve => setImmediate(resolve))
const part = (content, done = false) => Buffer.from(JSON.stringify({ message: { content }, done }) + '\n')
const chat = () => new Response(part('{"reply":"好呀。","action":"happy"}', true))
const memory = content => new Response(JSON.stringify({ done: true, message: { content: JSON.stringify(content) } }))
const candidate = { '意图': '少追问', '用户称呼': [], '回答篇幅': [], '结尾追问': [{ '消息': 0, '片段': 0, '范围': '长期', '值': '减少追问' }] }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function fixture(t, fetchImpl = async () => chat()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-reset-test-'))
  const harness = new PetHarness({ directory, fetchImpl, memoryIdleMs: 60000 })
  t.after(async () => { harness.stop('shutdown'); await harness.memoryRunning; fs.rmSync(directory, { recursive: true, force: true }) })
  harness.setPreferences({ model: 'local-model', position: { x: 42, y: 64 } })
  return { harness, directory }
}
const records = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)

test('restarting chat clears context and gestures durably while keeping preferences, settings and source order', async t => {
  const requests = []
  const { harness, directory } = fixture(t, async (_url, options) => { requests.push(JSON.parse(options.body)); return chat() })
  harness.start('以后叫我小李，回答短一点，别总反问我。上个话题是套娃。')
  await harness.running
  const preferences = structuredClone(harness.chatPreferences)
  assert.equal(Object.keys(preferences).length, 3)
  assert.ok(harness.lastReaction)
  harness.error = 'previous error'
  harness.resetConversation()
  assert.deepEqual(harness.messages, [])
  assert.equal(harness.snapshot().reply, '')
  assert.equal(harness.snapshot().busy, false)
  assert.equal(harness.error, '')
  assert.equal(harness.reaction, null)
  assert.equal(harness.lastReaction, null)
  assert.equal(harness.memoryTimer, null)
  assert.equal(harness.memoryCursor, 1)
  assert.equal(harness.userSequence, 1)
  assert.deepEqual(harness.chatPreferences, preferences)
  await harness.reviewMemory()
  assert.equal(requests.length, 1, 'resetting must not request a greeting or review cleared evidence')

  const restored = new PetHarness({ directory, fetchImpl: harness.fetch, memoryIdleMs: 60000 })
  t.after(() => restored.stop('shutdown'))
  assert.deepEqual(restored.messages, [])
  assert.deepEqual(restored.chatPreferences, preferences)
  assert.deepEqual(restored.position, { x: 42, y: 64 })
  assert.equal(restored.model, 'local-model')
  assert.equal(restored.memoryCursor, 1)
  restored.start('今天聊点新的')
  await restored.running
  assert.equal(requests[1].messages.length, 2, 'only system instructions and the new user message enter context')
  assert.ok(!JSON.stringify(requests[1].messages).includes('套娃'))
  assert.match(requests[1].messages[0].content, /小李/)
  assert.match(requests[1].messages[0].content, /不主动追加问题/)
  assert.equal(restored.messages[0].sequence, 2)
  restored.start('以后叫我小林')
  await restored.running
  assert.equal(restored.chatPreferences.preferredName.value, '小林')
  assert.equal(restored.chatPreferences.preferredName.sourceSequence, 3)
  restored.resetConversation()
  restored.resetConversation()
  assert.equal(restored.memoryCursor, 3)
  assert.deepEqual(restored.messages, [])
})

test('restarting during a reply cancels it once; late text/actions cannot restore cleared context or overwrite a new turn', async t => {
  const late = deferred()
  let reads = 0, cancelled = false, signal, calls = 0
  const reader = {
    read: () => ++reads === 1 ? Promise.resolve({ value: part('{"reply":"旧话说到一半'), done: false }) : late.promise,
    cancel: async () => { cancelled = true }, releaseLock() {},
  }
  const { harness } = fixture(t, async (_url, options) => {
    signal = options.signal
    return ++calls === 1 ? { ok: true, body: { getReader: () => reader } } : chat()
  })
  harness.start('解释递归')
  const oldWork = harness.running
  await tick()
  assert.equal(harness.snapshot().reply, '旧话说到一半')
  harness.resetConversation()
  assert.equal(signal.aborted, true)
  assert.equal(cancelled, true)
  assert.equal(harness.activeRun, null)
  assert.deepEqual(harness.messages, [], 'do not save the old visible partial during reset')
  harness.start('换个话题')
  await harness.running
  const current = harness.snapshot(), saved = fs.readFileSync(harness.file, 'utf8')
  late.resolve({ value: part('继续讲。","action":"focus"}', true), done: false })
  await oldWork
  assert.deepEqual(harness.snapshot(), current)
  assert.equal(fs.readFileSync(harness.file, 'utf8'), saved)
  assert.deepEqual(records(harness.logFile).map(({ status, reason }) => [status, reason]), [['cancelled', 'conversation-reset'], ['completed', null]])
})

test('restarting cancels extraction or verification and a late result cannot recreate a cleared preference source', async t => {
  for (const phase of ['extract', 'verify']) {
    const delayed = deferred()
    let signal
    const { harness } = fixture(t, async (_url, options) => {
      const body = JSON.parse(options.body)
      if (body.stream) return chat()
      signal = options.signal
      if (phase === 'verify' && !body.format.properties['保留']) return memory(candidate)
      return delayed.promise // Ignore abort at the transport to exercise ownership.
    })
    harness.start('每次聊天都像被采访一样')
    await harness.running
    const oldReview = harness.reviewMemory()
    await tick()
    const preferences = structuredClone(harness.chatPreferences)
    if (phase === 'verify') assert.equal(harness.memoryJob.verificationRequested, true)
    harness.resetConversation()
    assert.equal(signal.aborted, true)
    assert.equal(harness.memoryJob, null)
    await oldReview
    assert.equal(records(harness.memoryLogFile)[0].reason, 'conversation-reset')
    assert.deepEqual(harness.chatPreferences, preferences)
    harness.start('以后叫我小林')
    await harness.running
    const saved = fs.readFileSync(harness.file, 'utf8')
    delayed.resolve(memory(phase === 'verify' ? { '保留': [0] } : candidate))
    await tick()
    assert.equal(fs.readFileSync(harness.file, 'utf8'), saved)
    assert.equal(harness.chatPreferences.preferredName.value, '小林')
    assert.equal(harness.memoryCursor, 1)
    assert.equal(harness.messages[0].sequence, 2)
    assert.ok(!harness.messages.some(message => message.content.includes('采访')))
    assert.equal(harness.chatPreferences.followUp, undefined, 'cleared semantic evidence cannot come back later')
  }
})

test('failed reset saves roll back history and cursor without interrupting an active reply or memory review', async t => {
  for (const phase of ['reply', 'review']) {
    const pending = deferred()
    let signal
    const { harness } = fixture(t, async (_url, options) => {
      const body = JSON.parse(options.body)
      if (phase === 'review' && body.stream) return chat()
      signal = options.signal
      return pending.promise
    })
    harness.start('以后叫我小李')
    const running = phase === 'reply' ? harness.running : (await harness.running, harness.reviewMemory())
    await tick()
    const before = harness.snapshot(), cursor = harness.memoryCursor, saved = fs.readFileSync(harness.file, 'utf8')
    const job = harness.memoryJob, save = harness.save
    harness.save = () => { throw new Error('disk full') }
    assert.throws(() => harness.resetConversation(), /disk full/)
    harness.save = save
    assert.equal(signal.aborted, false)
    assert.deepEqual(harness.snapshot(), before)
    assert.equal(harness.memoryCursor, cursor)
    assert.equal(harness.memoryJob, job)
    assert.equal(fs.readFileSync(harness.file, 'utf8'), saved)
    pending.resolve(phase === 'reply' ? chat() : memory({ ...candidate, '结尾追问': [] }))
    await running
    assert.equal(harness.messages.length, 2)
  }
})
