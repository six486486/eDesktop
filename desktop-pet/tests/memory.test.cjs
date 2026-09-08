const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PetHarness } = require('../harness.cjs')
const { WIRE_KEYS, WIRE_VALUES, MEMORY_SCHEMA, reviewSources, validateCandidates, extractMemory } = require('../memory-review.cjs')
const { readChatPreferences, extractExplicitPreferences } = require('../memory.cjs')

const tick = () => new Promise(resolve => setImmediate(resolve))
const values = memory => Object.fromEntries(Object.entries(memory).map(([key, entry]) => [key, entry.value]))
const source = (content, sequence = 1) => ({ id: `user-${sequence}`, role: 'user', sequence, content })
const candidate = (key, value, evidence, index = 0, scope = 'persistent') => ({ key, value, evidence, source: index, scope })
function output(...candidates) {
  const result = { '意图': '测试候选', '用户称呼': [], '回答篇幅': [], '结尾追问': [] }
  for (const item of candidates) result[WIRE_KEYS[item.key]].push({
    '消息': item.source, '片段': item.segment ?? 0, '范围': item.scope === 'turn' ? '本次' : '长期',
    '值': WIRE_VALUES[item.key] ? Object.keys(WIRE_VALUES[item.key]).find(value => WIRE_VALUES[item.key][value] === item.value) : item.value,
  })
  return JSON.stringify(result)
}
const response = raw => new Response(JSON.stringify({ done: true, message: { content: raw } }))
const chatResponse = () => new Response(JSON.stringify({ done: true, message: { content: '好，接着聊。' } }) + '\n')
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(t, fetchImpl, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-memory-test-'))
  const routedFetch = async (url, options) => {
    const request = JSON.parse(options.body)
    if (request.format?.properties?.['保留']) {
      const claims = JSON.parse(request.messages.at(-1).content)
      return response(JSON.stringify({ '保留': claims.map((_, index) => index) }))
    }
    return fetchImpl(url, options)
  }
  const harness = new PetHarness({ directory, fetchImpl: routedFetch, memoryIdleMs: 60000, ...options })
  t.after(async () => { harness.stop('shutdown'); await harness.memoryRunning; fs.rmSync(directory, { recursive: true, force: true }) })
  harness.setPreferences({ model: 'local-model' })
  return { harness, directory }
}
const records = harness => fs.readFileSync(harness.memoryLogFile, 'utf8').trim().split('\n').map(JSON.parse)
async function say(harness, text) { harness.start(text); await harness.running }

test('manual chat preferences work offline, preserve unrelated data and survive restart without adding conversation', t => {
  let requests = 0
  const { harness, directory } = fixture(t, () => { requests++; throw new Error('offline') })
  harness.setPreferences({ position: { x: 120, y: 200 }, reminderSoundEnabled: false })
  const saved = harness.setChatPreferences({ preferredName: '  小李  ', replyLength: 'short', followUp: 'avoid' })
  assert.deepEqual(saved, { preferredName: '小李', replyLength: 'short', followUp: 'avoid' })
  assert.deepEqual(harness.messages, [])
  assert.equal(requests, 0)
  assert.equal(harness.chatPreferences.preferredName.method, 'settings')
  const restored = new PetHarness({ directory })
  t.after(() => restored.stop('shutdown'))
  assert.deepEqual(restored.snapshot().chatPreferences, saved)
  assert.equal(restored.chatPreferences.preferredName.method, 'settings')
  assert.deepEqual(restored.position, { x: 120, y: 200 })
  assert.equal(restored.reminderSoundEnabled, false)
  assert.equal(restored.model, 'local-model')
  restored.setChatPreferences({ preferredName: ' ' })
  assert.equal(restored.snapshot().chatPreferences.preferredName, null)
  assert.equal(restored.snapshot().chatPreferences.replyLength, 'short')
})

test('conversation and settings share preferences with last explicit change winning and temporary overrides staying local', async t => {
  const requests = []
  const { harness } = fixture(t, (_url, options) => { requests.push(JSON.parse(options.body)); return chatResponse() })
  harness.setChatPreferences({ preferredName: '小李', replyLength: 'short', followUp: 'avoid' })
  await say(harness, '这次回答详细一点')
  assert.match(requests.at(-1).messages[0].content, /稍微展开/)
  assert.equal(harness.chatPreferences.replyLength.value, 'short')
  await say(harness, '以后叫我小林，回答详细一点，可以追问我')
  assert.deepEqual(harness.snapshot().chatPreferences, { preferredName: '小林', replyLength: 'detailed', followUp: 'natural' })
  harness.setChatPreferences({ replyLength: 'short' })
  assert.equal(harness.snapshot().chatPreferences.preferredName, '小林')
  harness.resetConversation()
  await say(harness, '我回来了')
  assert.match(requests.at(-1).messages[0].content, /小林/)
  assert.match(requests.at(-1).messages[0].content, /一到两句/)
  await say(harness, '恢复默认聊天偏好')
  assert.deepEqual(harness.snapshot().chatPreferences, { preferredName: null, replyLength: 'normal', followUp: 'natural' })
})

test('manual changes preempt late memory work and older evidence cannot overwrite them on a later review', async t => {
  const delayed = deferred()
  let extractions = 0, extractionSignal
  const raw = output(candidate('followUp', 'avoid', ''), { ...candidate('replyLength', 'short', ''), segment: 1 })
  const { harness } = fixture(t, (_url, options) => {
    if (JSON.parse(options.body).stream) return chatResponse()
    extractions++
    if (extractions === 1) { extractionSignal = options.signal; return delayed.promise }
    return response(raw)
  })
  await say(harness, '每次都像采访，随便聊聊就好。平时一大屏文字我看不进去，抓重点就行。')
  const review = harness.reviewMemory()
  await tick()
  harness.setChatPreferences({ followUp: 'natural' })
  assert.equal(extractionSignal.aborted, true)
  await review
  delayed.resolve(response(raw)); await tick()
  assert.equal(harness.chatPreferences.followUp.value, 'natural')
  assert.equal(harness.memoryCursor, 0)
  await harness.reviewMemory()
  assert.deepEqual(values(harness.chatPreferences), { followUp: 'natural', replyLength: 'short' })
  assert.equal(harness.chatPreferences.followUp.method, 'settings')
})

test('invalid or failed manual saves leave preferences, source order and active reply intact', async t => {
  const delayed = deferred()
  const { harness } = fixture(t, () => delayed.promise)
  harness.setChatPreferences({ preferredName: '小李' })
  harness.start('继续聊聊')
  const active = harness.activeRun, before = harness.snapshot(), sequence = harness.userSequence
  for (const patch of [null, [], 'short', { enabled: false }, { preferredName: '李'.repeat(25) }, { preferredName: '小明', replyLength: 'huge' }, { followUp: null }]) {
    assert.throws(() => harness.setChatPreferences(patch))
  }
  const save = harness.save
  harness.save = () => { throw new Error('disk full') }
  assert.throws(() => harness.setChatPreferences({ preferredName: '小林' }), /聊天偏好未能保存/)
  assert.deepEqual(harness.snapshot(), before)
  assert.equal(harness.userSequence, sequence)
  assert.equal(active.controller.signal.aborted, false)
  harness.save = save
  harness.setChatPreferences({ replyLength: 'detailed' })
  assert.equal(harness.activeRun, active, 'current reply continues; the new preference applies next time')
  delayed.resolve(chatResponse()); await harness.running
  assert.equal(harness.snapshot().chatPreferences.replyLength, 'detailed')
})

test('model candidates require valid values, original evidence, correct source and unambiguous claims', () => {
  const sources = [source('平时一大屏文字我看不进去，抓重点就行。以后叫我小林。')]
  const good = candidate('replyLength', 'short', '平时一大屏文字我看不进去，抓重点就行。')
  const result = validateCandidates(output(good), {}, sources)
  assert.equal(result.memory.replyLength.value, 'short')
  assert.equal(result.memory.replyLength.sourceMessageId, sources[0].id)
  assert.equal(result.memory.replyLength.sourceSequence, 1)
  assert.equal(result.memory.replyLength.evidence, good.evidence)
  for (const [claim, reason] of [
    [{ ...candidate('replyLength', 'short', '编造的依据'), segment: 99 }, 'evidence'],
    [candidate('replyLength', 'short', '抓重点就行。', 3), 'source'],
    [candidate('preferredName', '大王', '以后叫我小林。'), 'name-evidence'],
    [candidate('preferredName', '李'.repeat(25), '以后叫我小林。'), 'value'],
    [candidate('replyLength', 'detailed', '抓重点就行。', 0, 'turn'), 'temporary'],
  ]) {
    const rejected = validateCandidates(output(claim), {}, sources)
    assert.deepEqual(rejected.memory, {})
    assert.equal(rejected.rejected[0].reason, reason)
  }
  const duplicates = validateCandidates(output(good, { ...good, value: 'detailed' }), {}, sources)
  assert.deepEqual(duplicates.memory, {})
  assert.ok(duplicates.rejected.every(entry => entry.reason === 'ambiguous'))
  assert.throws(() => validateCandidates('not json', {}, sources))
  assert.throws(() => validateCandidates('{"用户称呼":[]}', {}, sources), /invalid-output/)
  const extra = JSON.parse(output(good)); extra.filesystem = 'write'
  assert.throws(() => validateCandidates(JSON.stringify(extra), {}, sources), /invalid-output/)
  const malformed = JSON.parse(output(good)); malformed['回答篇幅'][0]['工具'] = 'write'
  assert.equal(validateCandidates(JSON.stringify(malformed), {}, sources).rejected[0].reason, 'shape')
  const wrongValue = JSON.parse(output(good)); wrongValue['回答篇幅'][0]['值'] = '随便'
  assert.equal(validateCandidates(JSON.stringify(wrongValue), {}, sources).rejected[0].reason, 'value')
})

test('source order resolves corrections and a temporary override does not erase an earlier durable choice', () => {
  const sources = [source('平时抓重点就好。可以多问我问题。', 10), source('我更喜欢听详细的来龙去脉。这次少问我问题。', 11)]
  const result = validateCandidates(output(
    { ...candidate('followUp', 'avoid', '', 1, 'turn'), segment: 1 },
    candidate('replyLength', 'detailed', '', 1),
    candidate('replyLength', 'short', '', 0),
    { ...candidate('followUp', 'natural', '', 0), segment: 1 },
  ), {}, sources)
  assert.deepEqual(values(result.memory), { replyLength: 'detailed', followUp: 'natural' })
  const older = validateCandidates(output(candidate('replyLength', 'short', '')), result.memory, sources)
  assert.equal(older.memory.replyLength.value, 'detailed')
  assert.equal(older.rejected[0].reason, 'older-source')
})

test('semantic memory is committed after chat, survives restart and stays available after its source leaves context', async t => {
  const requests = []
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request)
    return request.stream ? chatResponse() : response(output(candidate('followUp', 'avoid', '每次都像采访，随便聊聊就好。')))
  }
  const { harness, directory } = fixture(t, fetchImpl)
  await say(harness, '每次都像采访，随便聊聊就好。')
  assert.equal(requests.length, 1, 'chat must start without awaiting extraction')
  assert.deepEqual(harness.chatPreferences, {})
  await harness.reviewMemory()
  assert.equal(requests[1].stream, false)
  assert.equal(typeof requests[1].format, 'object', 'use Ollama structured output')
  assert.deepEqual(values(harness.chatPreferences), { followUp: 'avoid' })
  assert.equal(harness.memoryCursor, harness.userSequence)
  assert.equal(harness.snapshot().busy, false)
  assert.ok(!requests[1].messages.some(message => message.content.includes('好，接着聊。')), 'assistant replies are not extraction evidence')
  const stored = structuredClone(harness.chatPreferences)
  harness.messages = Array.from({ length: 40 }, (_, i) => ({ id: `later-${i}`, role: i % 2 ? 'assistant' : 'user', content: '随便聊聊' }))
  harness.save()
  const restored = new PetHarness({ directory, fetchImpl, memoryIdleMs: 60000 })
  t.after(() => restored.stop('shutdown'))
  assert.deepEqual(restored.chatPreferences, stored)
  await say(restored, '我回来了')
  assert.match(requests.at(-1).messages[0].content, /不主动追加问题/)
  assert.equal(restored.userSequence, 2)
  assert.deepEqual(records(harness)[0].accepted, ['followUp'])
  assert.ok(!fs.readFileSync(harness.memoryLogFile, 'utf8').includes('采访'), 'logs do not include raw personal text')
})

test('new chat cancels a review immediately and late transport results cannot overwrite a correction', async t => {
  const delayed = deferred(), signals = [], reviewRequests = []
  const { harness } = fixture(t, async (_url, options) => {
    const request = JSON.parse(options.body)
    if (request.stream) return chatResponse()
    signals.push(options.signal); reviewRequests.push(request)
    if (signals.length === 1) return delayed.promise // Ignores AbortSignal deliberately.
    return response(output(candidate('preferredName', '小林', '还是叫我小林', 1)))
  })
  await say(harness, '以后叫我小李')
  const oldReview = harness.reviewMemory()
  await tick()
  harness.start('还是叫我小林')
  assert.equal(signals[0].aborted, true)
  await harness.running
  await oldReview // Release locally even if the old HTTP request never settled.
  await harness.reviewMemory()
  assert.equal(harness.chatPreferences.preferredName.value, '小林')
  assert.ok(reviewRequests[1].messages.at(-1).content.includes('以后叫我小李'), 'preemption preserves pending user evidence')
  const saved = fs.readFileSync(harness.file, 'utf8')
  delayed.resolve(response(output(candidate('preferredName', '小李', '以后叫我小李'))))
  await tick()
  assert.equal(fs.readFileSync(harness.file, 'utf8'), saved)
  assert.deepEqual(records(harness).map(({ status, reason }) => [status, reason]), [['cancelled', 'chat-priority'], ['completed', null]])
})

test('failed chat acceptance leaves the running review and sequence intact', async t => {
  const pending = deferred(); let signal
  const { harness } = fixture(t, async (_url, options) => {
    if (JSON.parse(options.body).stream) return chatResponse()
    signal = options.signal; return pending.promise
  })
  await say(harness, '以后叫我小李')
  const review = harness.reviewMemory()
  const previousSequence = harness.userSequence, save = harness.save
  harness.save = () => { throw new Error('disk full') }
  assert.throws(() => harness.start('叫我小林'), /disk full/)
  harness.save = save
  assert.equal(harness.userSequence, previousSequence)
  assert.equal(signal.aborted, false)
  pending.resolve(response(output(candidate('preferredName', '小李', '以后叫我小李'))))
  await review
  assert.equal(harness.chatPreferences.preferredName.value, '小李')
})

test('failed memory writes roll back both preferences and cursor; restart can review pending user messages', async t => {
  const { harness, directory } = fixture(t, async (_url, options) => JSON.parse(options.body).stream ? chatResponse()
    : response(output(candidate('replyLength', 'short', '平时抓重点就好'))))
  await say(harness, '平时抓重点就好')
  const save = harness.save
  harness.save = () => { throw new Error('disk full') }
  await harness.reviewMemory()
  harness.save = save
  assert.deepEqual(harness.chatPreferences, {})
  assert.equal(harness.memoryCursor, 0)
  assert.equal(harness.error, '', 'a memory failure must not turn a successful chat into an error')
  assert.equal(records(harness)[0].reason, 'save-failed')
  const restored = new PetHarness({ directory, fetchImpl: harness.fetch })
  await restored.reviewMemory()
  assert.equal(restored.chatPreferences.replyLength.value, 'short')
  assert.equal(restored.memoryCursor, 1)
})

test('malformed or failed reviews retain memory and pending sources without automatic retries', async t => {
  for (const reply of [new Response('{}', { status: 503 }), response('{bad'), new Response('{"done":false,"message":{"content":"{}"}}')]) {
    const { harness } = fixture(t, async (_url, options) => JSON.parse(options.body).stream ? chatResponse() : reply)
    await say(harness, '平时抓重点就好')
    await harness.reviewMemory()
    assert.equal(harness.memoryCursor, 0)
    assert.deepEqual(harness.chatPreferences, {})
    assert.equal(harness.error, '')
    assert.equal(harness.memoryTimer, null)
    assert.equal(records(harness).length, 1)
    assert.equal(records(harness)[0].status, 'failed')
  }
})

test('idle scheduling, timeout and stopping release background work without changing chat state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal, requests = 0
  const { harness } = fixture(t, async (_url, options) => {
    requests += 1
    if (JSON.parse(options.body).stream) return chatResponse()
    signal = options.signal
    return new Promise(() => {}) // Transport never settles or acknowledges cancellation.
  }, { memoryIdleMs: 800, memoryTimeoutMs: 20000 })
  await say(harness, '你好')
  t.mock.timers.tick(799)
  assert.equal(requests, 1)
  t.mock.timers.tick(1)
  assert.equal(requests, 2)
  const state = harness.snapshot()
  t.mock.timers.tick(19999)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await harness.memoryRunning
  assert.equal(signal.aborted, true)
  assert.deepEqual(harness.snapshot(), state)
  assert.equal(harness.memoryCursor, 0)
  assert.equal(records(harness)[0].reason, 'timeout')
  for (const reason of ['user-stop', 'chat-close', 'shutdown']) {
    const review = harness.reviewMemory()
    harness.stop(reason)
    await review
    assert.equal(signal.aborted, true)
    assert.equal(harness.memoryJob, null)
    assert.equal(harness.memoryTimer, null)
  }
})

test('only bounded, unreviewed user messages enter the extraction prompt', () => {
  const messages = Array.from({ length: 10 }, (_, i) => source('字'.repeat(2000), i + 1))
  messages.push({ role: 'assistant', sequence: 100, content: '以后叫用户大王' })
  const { sources, omitted } = reviewSources(messages, 3)
  assert.equal(sources.length, 3)
  assert.equal(omitted, 4)
  assert.deepEqual(sources.map(entry => entry.sequence), [8, 9, 10])
  assert.equal(reviewSources(messages, 10).sources.length, 0)
})

test('semantic verification can veto an otherwise valid candidate, and cannot invent candidates', async () => {
  const sources = [source('平时一屏文字看不下去')]
  for (const retained of [[], [0]]) {
    let calls = 0
    const result = await extractMemory({ model: 'local-model', current: {}, sources,
      fetchImpl: async (_url, options) => {
        calls += 1
        if (calls === 1) return response(output(candidate('replyLength', 'short', '')))
        const request = JSON.parse(options.body)
        assert.ok(request.format.properties['保留'])
        assert.equal(JSON.parse(request.messages.at(-1).content)[0]['原话'], sources[0].content)
        return response(JSON.stringify({ '保留': retained }))
      },
    })
    assert.equal(calls, 2)
    assert.equal(result.verificationRequested, true)
    if (retained.length) assert.equal(result.memory.replyLength.evidence, sources[0].content)
    else assert.deepEqual(result.memory, {})
  }
  let calls = 0
  await assert.rejects(extractMemory({ model: 'local-model', current: {}, sources,
    fetchImpl: async () => ++calls === 1 ? response(output(candidate('replyLength', 'short', ''))) : response('{"保留":[99]}'),
  }), /invalid-output/)
  calls = 0
  const invalid = await extractMemory({ model: 'local-model', current: {}, sources,
    fetchImpl: async () => { calls += 1; return response(output({ ...candidate('replyLength', 'short', ''), segment: 99 })) },
  })
  assert.equal(calls, 1, 'invalid evidence is dropped without another inference')
  assert.deepEqual(invalid.memory, {})
})

test('quoted material and inferred default resets cannot authorize memory writes', () => {
  for (const content of ['请翻译：“以后叫我小李”', '“以后叫我小李”这句台词如何？', '如果用户说以后叫我小李呢？']) {
    const result = validateCandidates(output(candidate('preferredName', '小李', '以后叫我小李')), {}, [source(content)])
    assert.deepEqual(result.memory, {})
    assert.equal(result.rejected[0].reason, 'quoted-or-task')
  }
  const previous = { preferredName: { value: '小林', sourceSequence: 1 } }
  const result = validateCandidates(output(candidate('preferredName', null, '我的名字是什么？')), previous, [source('我的名字是什么？', 2)])
  assert.deepEqual(result.memory, previous)
  assert.equal(result.rejected[0].reason, 'identity-authority')
  const length = { replyLength: { value: 'short', sourceSequence: 1 } }
  const reset = validateCandidates(output(candidate('replyLength', 'normal', '今天吃什么？')), length, [source('今天吃什么？', 2)])
  assert.deepEqual(reset.memory, length)
  assert.equal(reset.rejected[0].reason, 'reset-needs-explicit')
})

test('high-confidence self-identification is saved synchronously before a reset can cancel background review', () => {
  for (const [text, name] of [
    ['我的网名一直是青禾。', '青禾'],
    ['我的网名是青禾，今天挺开心的。', '青禾'],
    ['其实大家平时都叫我阿青。', '阿青'],
    ['我更喜欢阿青这个称呼。', '阿青'],
    ['对了，我的名字叫方源哦。', '方源'],
  ]) {
    const result = extractExplicitPreferences({}, source(text))
    assert.equal(result.memory.preferredName.value, name, text)
    assert.equal(result.memory.preferredName.method, 'explicit')
  }
  for (const text of ['我是软件工程师。', '我是小林的朋友。', '我的猫叫小林。']) {
    assert.equal(extractExplicitPreferences({}, source(text)).memory.preferredName, undefined, text)
  }
  assert.equal(extractExplicitPreferences({}, source('今天先叫我青禾。')).memory.preferredName, undefined)
})

test('semantic identity requires cited self-identity evidence and independent verification', async () => {
  assert.equal(MEMORY_SCHEMA.properties['用户称呼'].maxItems, 1)
  for (const [text, name] of [
    ['青禾是我的网名。', '青禾'],
  ]) {
    let calls = 0
    const result = await extractMemory({ model: 'local-model', current: {}, sources: [source(text)],
      fetchImpl: async () => ++calls === 1
        ? response(output(candidate('preferredName', name, text)))
        : response('{"保留":[0]}'),
    })
    assert.equal(result.memory.preferredName.value, name, text)
    assert.equal(result.memory.preferredName.method, 'model')
    assert.equal(calls, 2)
    assert.equal(readChatPreferences({ preferredName: result.memory.preferredName }).preferredName.value, name)
  }
  for (const [text, name, reason = 'identity-authority'] of [
    ['小栖，我最近挺开心的，你开心吗？', '小栖'],
    ['阿圆，今天你想聊什么？', '阿圆'],
    ['老师，帮我看看这段话。', '老师'],
    ['我朋友叫小林。', '小林'],
    ['我的猫叫小林。', '小林'],
    ['我不是小林。', '小林'],
    ['我叫小林吗？', '小林'],
    ['我是小林的朋友。', '小林'],
    ['我给猫取名小林。', '小林'],
    ['请翻译：我的名字叫小林。', '小林', 'quoted-or-task'],
  ]) {
    let calls = 0
    const result = await extractMemory({ model: 'local-model', current: {}, sources: [source(text)],
      fetchImpl: async () => { calls += 1; return response(output(candidate('preferredName', name, text))) },
    })
    assert.deepEqual(result.memory, {}, text)
    assert.equal(result.rejected[0].reason, reason)
    assert.equal(calls, 1, 'an unauthorized identity claim must never reach semantic verification')
  }
  for (const name of ['小栖', '阿圆', '老师']) {
    const explicit = extractExplicitPreferences({}, source(`以后叫我${name}`))
    assert.equal(explicit.memory.preferredName.value, name, 'this is a speaker/authority boundary, not a name blacklist')
  }
})

test('older inferred names need explicit evidence when restored; style preferences keep their semantic sources', () => {
  const base = { sourceMessageId: 'source', sourceSequence: 4, updatedAt: '2026-09-03T00:00:00.000Z', method: 'model' }
  const wrong = { ...base, value: '小栖', evidence: '小栖，我最近挺开心的，你开心吗？' }
  const style = { ...base, value: 'avoid', evidence: '每次聊天像被采访' }
  assert.deepEqual(readChatPreferences({ preferredName: wrong, followUp: style }), { followUp: style })
  const named = { ...base, value: '小李', evidence: '以后叫我小李' }
  assert.deepEqual(readChatPreferences({ preferredName: named }), { preferredName: named })
  const semantic = { ...base, value: '青禾', evidence: '我的网名一直是青禾。' }
  assert.deepEqual(readChatPreferences({ preferredName: semantic }), { preferredName: semantic })
  assert.deepEqual(readChatPreferences({ preferredName: { ...named, method: 'explicit' } }).preferredName.value, '小李')
})
