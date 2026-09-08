const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PetHarness, trimHistory } = require('../harness.cjs')
const { reactionForMessage } = require('../reactions.cjs')
const { extractExplicitPreferences, readChatPreferences } = require('../memory.cjs')
const { shouldLimitFollowUps, withoutTrailingQuestions } = require('../follow-up.cjs')

function fixture(t, fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'edesktop-pet-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, harness: new PetHarness({ directory, fetchImpl }) }
}

function replyStream(content) {
  const bytes = Buffer.from(JSON.stringify({ message: { content } }) + '\n' + JSON.stringify({ done: true }))
  // Single-byte chunks split both JSON lines and Chinese UTF-8 characters.
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }))
}

test('streams split UTF-8, persists conversation and restores it into the next request', async (t) => {
  const requests = []
  const fetchImpl = async (_url, options) => { requests.push(JSON.parse(options.body)); return replyStream('记住了，喜欢雨天。') }
  const { directory, harness } = fixture(t, fetchImpl)
  harness.setPreferences({ model: 'local-model', position: { x: -100, y: 200 } })
  harness.start('我喜欢雨天。')
  await harness.running
  assert.equal(harness.snapshot().error, '')
  assert.equal(harness.messages[1].content, '记住了，喜欢雨天。')
  const restored = new PetHarness({ directory, fetchImpl })
  assert.deepEqual(restored.position, { x: -100, y: 200 })
  assert.equal(restored.model, 'local-model')
  restored.start('我刚才说喜欢什么？')
  await restored.running
  assert.deepEqual(requests[1].messages.slice(1).map((message) => message.content), ['我喜欢雨天。', '记住了，喜欢雨天。', '我刚才说喜欢什么？'])
})

test('stop aborts the in-flight request and allows a later message without stale output', async (t) => {
  let receivedSignal
  let first = true
  const { harness } = fixture(t, async (_url, options) => {
    if (!first) return replyStream('接着聊。')
    first = false
    receivedSignal = options.signal
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(JSON.stringify({ message: { content: '说到一半' } }) + '\n'))
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
    } }))
  })
  harness.setPreferences({ model: 'local-model' })
  harness.start('聊两句')
  await new Promise((resolve) => setImmediate(resolve))
  harness.stop()
  assert.equal(harness.snapshot().busy, false, 'stopping releases the conversation immediately')
  await harness.running
  assert.equal(receivedSignal.aborted, true)
  assert.equal(harness.snapshot().busy, false)
  assert.equal(harness.messages.at(-1).interrupted, true)
  assert.equal(harness.snapshot().error, '')
  harness.start('换个话题')
  await harness.running
  assert.equal(harness.messages.at(-1).content, '接着聊。')
})

test('missing model, malformed stream and premature EOF surface errors without invented answers', async (t) => {
  const { harness } = fixture(t, async () => new Response('not JSON\n'))
  assert.throws(() => harness.start('你好'), /选择一个本地模型/)
  harness.setPreferences({ model: 'local-model' })
  assert.throws(() => harness.start(' '.repeat(3)), /请输入/)
  assert.throws(() => harness.start('长'.repeat(2001)), /请输入/)
  harness.start('你好')
  await harness.running
  assert.match(harness.error, /格式不完整/)
  assert.equal(harness.messages.length, 1)
  harness.fetch = async () => new Response(JSON.stringify({ message: { content: '半句' } }) + '\n')
  harness.start('再试一次')
  await harness.running
  assert.match(harness.error, /回复中断/)
  assert.equal(harness.messages.at(-1).interrupted, true)
  harness.fetch = async () => new Response('{}', { status: 404 })
  harness.start('你好')
  await harness.running
  assert.match(harness.error, /模型还没有安装/)
})

test('Ollama being offline remains a recoverable error', async (t) => {
  const { harness } = fixture(t, async () => { throw new TypeError('fetch failed') })
  await assert.rejects(harness.listModels(), /未连接 Ollama/)
  harness.setPreferences({ model: 'local-model' })
  harness.start('你好')
  await harness.running
  assert.match(harness.error, /未连接 Ollama/)
  assert.equal(harness.snapshot().busy, false)
})

test('recent context is bounded and begins with a user message', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index}:` + '字'.repeat(1000) }))
  const result = trimHistory(messages)
  assert.ok(result.length <= 40)
  assert.ok(result.reduce((sum, message) => sum + message.content.length, 0) <= 12000)
  assert.equal(result[0].role, 'user')
  assert.equal(result.at(-1), messages.at(-1))
})

test('unreadable history is preserved instead of overwritten', (t) => {
  const { directory } = fixture(t)
  const file = path.join(directory, 'state.json')
  fs.writeFileSync(file, '{broken history')
  const harness = new PetHarness({ directory })
  assert.match(harness.error, /读取失败/)
  assert.throws(() => harness.setPreferences({ model: 'local-model' }), /读取失败/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken history')
})

test('reactions accompany plain streamed replies without extra requests or persisted gestures', async (t) => {
  for (const [message, kind] of [['谢谢你', 'happy'], ['请解释一下递归', 'focus'], ['晚安', 'rest'], ['今天下雨了', null]]) {
    let calls = 0
    const { harness, directory } = fixture(t, async () => { calls += 1; return replyStream('接着聊。') })
    const frames = []
    harness.onChange = (frame) => frames.push(frame)
    harness.setPreferences({ model: 'local-model' })
    harness.start(message)
    await harness.running
    assert.equal(calls, 1, 'reactions must share the chat request')
    assert.ok(frames.every((frame) => '接着聊。'.startsWith(frame.reply)))
    assert.equal(harness.messages.at(-1).content, '接着聊。')
    assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')), 'reaction'))
    assert.equal(harness.snapshot().reaction?.kind ?? null, kind)
    const gestures = frames.filter((frame) => frame.reaction)
    if (kind) assert.equal(new Set(gestures.map((frame) => frame.reaction.startedAt)).size, 1, 'stream updates must not restart the gesture')
    if (['happy', 'focus'].includes(kind)) assert.ok(harness.reaction.endsAt >= Date.now() + 5000)
    if (kind === 'rest') { assert.equal(harness.reaction.endsAt, null); harness.wake(); assert.equal(harness.reaction, null) }
    assert.equal(new PetHarness({ directory }).reaction, null, 'old gestures must not replay after restart')
  }
})

test('direct praise, discussion and goodbyes trigger gestures; quotes and negations stay neutral', () => {
  for (const [message, kind] of [
    ['小栖，你真可爱，我很喜欢你！', 'happy'], ['谢谢你', 'happy'],
    ['我们认真讨论一下：递归是什么？', 'focus'], ['请解释一下递归', 'focus'],
    ['我先去忙了，回头聊。', 'rest'], ['晚安', 'rest'], ['我累了想休息一下', 'rest'],
    ['我不去忙了，继续聊会儿', null], ['我不是要去忙', null], ['“我去忙了”是什么意思？', null],
    ['你觉得这只猫可爱吗？', null], ['例如我去忙了', null], ['不要解释了', null], ['今天下雨了', null],
  ]) assert.equal(reactionForMessage(message), kind, message)
})

test('stopping or losing a reply clears its gesture, and the next turn starts neutral', async (t) => {
  const { harness } = fixture(t, async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(JSON.stringify({ message: { content: '回头' } }) + '\n'))
    options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
  } })))
  harness.setPreferences({ model: 'local-model' })
  harness.start('我去忙了')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.reaction?.kind, 'rest')
  harness.stop()
  assert.equal(harness.snapshot().reaction, null)
  await harness.running
  assert.equal(harness.messages.at(-1).content, '回头')
  harness.fetch = async () => new Response(JSON.stringify({ message: { content: '好呀' } }) + '\n')
  harness.start('你真可爱')
  assert.equal(harness.reaction, null)
  await harness.running
  assert.match(harness.error, /中断/)
  assert.equal(harness.reaction, null)
})

const tick = () => new Promise((resolve) => setImmediate(resolve))
const part = (content, done = false) => Buffer.from(JSON.stringify({ message: { content }, done }) + '\n')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const logs = (directory) => fs.readFileSync(path.join(directory, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)

test('a correction takes over immediately and late bytes cannot change the current reply, gesture or history', async (t) => {
  const lateRead = deferred()
  const requests = []
  let reads = 0, oldCancelled = false, nextStream
  // This transport deliberately returns bytes after cancellation to exercise run ownership.
  const oldReader = {
    read: () => ++reads === 1 ? Promise.resolve({ value: part('先去休息吧'), done: false }) : lateRead.promise,
    cancel: async () => { oldCancelled = true }, releaseLock() {},
  }
  const { directory, harness } = fixture(t, async (_url, options) => {
    requests.push({ body: JSON.parse(options.body), signal: options.signal })
    if (requests.length === 1) return { ok: true, body: { getReader: () => oldReader } }
    return new Response(new ReadableStream({ start(controller) { nextStream = controller; controller.enqueue(part('好，解释一下')) } }))
  })
  harness.setPreferences({ model: 'local-model' })
  harness.start('晚安')
  const oldWork = harness.running
  await tick()
  assert.equal(harness.reaction.kind, 'rest')
  harness.start('请解释一下递归')
  const newRunId = harness.activeRun.id
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(oldCancelled, true)
  assert.equal(harness.snapshot().busy, true)
  assert.equal(harness.snapshot().reply, '')
  assert.equal(harness.reaction, null)
  assert.deepEqual(harness.messages.map(({ role, content }) => [role, content]), [
    ['user', '晚安'], ['assistant', '先去休息吧'], ['user', '请解释一下递归'],
  ])
  assert.equal(harness.messages[1].interrupted, true)
  assert.match(requests[1].body.messages[2].content, /先去休息吧.*\n.*回复已中断/)
  await tick()
  const beforeLateBytes = harness.snapshot()
  const savedBeforeLateBytes = fs.readFileSync(harness.file, 'utf8')
  lateRead.resolve({ value: part('旧回答又冒出来了', true), done: false })
  await oldWork
  assert.deepEqual(harness.snapshot(), beforeLateBytes)
  assert.equal(fs.readFileSync(harness.file, 'utf8'), savedBeforeLateBytes)
  assert.equal(harness.activeRun.id, newRunId)
  assert.equal(harness.reaction.kind, 'focus')
  nextStream.enqueue(part('，它会调用自身。', true))
  nextStream.close()
  await harness.running
  assert.equal(harness.messages.at(-1).content, '好，解释一下，它会调用自身。')
  const records = logs(directory)
  assert.equal(records.length, 2)
  assert.equal(new Set(records.map((record) => record.runId)).size, 2)
  assert.deepEqual(records.map(({ status, reason, reactionResult }) => [status, reason, reactionResult]), [
    ['cancelled', 'superseded', 'cleared'], ['completed', null, 'completed'],
  ])
  assert.ok(records.every((record) => record.firstTokenMs >= 0 && record.durationMs >= record.firstTokenMs))
  assert.ok(!fs.readFileSync(harness.logFile, 'utf8').includes('晚安'))
  const restoredRequests = []
  const restored = new PetHarness({ directory, fetchImpl: async (_url, options) => {
    restoredRequests.push(JSON.parse(options.body)); return replyStream('接着聊。')
  } })
  assert.equal(restored.messages[1].interrupted, true)
  restored.start('接着说')
  await restored.running
  assert.match(restoredRequests[0].messages[2].content, /回复已中断/)
})

test('rapid messages keep their order before any token; late HTTP success and failure cannot overwrite the finished run', async (t) => {
  const first = deferred(), second = deferred(), requests = []
  let staleBodyCancelled = false
  const { directory, harness } = fixture(t, async (_url, options) => {
    requests.push({ body: JSON.parse(options.body), signal: options.signal })
    if (requests.length === 1) return first.promise
    if (requests.length === 2) return second.promise
    return replyStream('好，我听着。')
  })
  harness.setPreferences({ model: 'local-model' })
  harness.start('今天工作好烦')
  const firstWork = harness.running
  harness.start('先别给建议')
  const secondWork = harness.running
  harness.start('陪我吐槽一下')
  await harness.running
  assert.deepEqual(requests[2].body.messages.slice(1).map((message) => message.content), ['今天工作好烦', '先别给建议', '陪我吐槽一下'])
  assert.ok(requests.slice(0, 2).every((request) => request.signal.aborted))
  assert.equal(harness.messages.length, 4, 'no empty assistant bubbles for runs interrupted before the first token')
  const finished = harness.snapshot()
  const saved = fs.readFileSync(harness.file, 'utf8')
  first.resolve({ ok: false, status: 500, body: { cancel: async () => { staleBodyCancelled = true } } })
  second.reject(new TypeError('late network failure'))
  await Promise.all([firstWork, secondWork])
  assert.equal(staleBodyCancelled, true)
  assert.deepEqual(harness.snapshot(), finished)
  assert.equal(fs.readFileSync(harness.file, 'utf8'), saved)
  assert.deepEqual(logs(directory).map(({ status, reason, firstTokenMs }) => [status, reason, firstTokenMs === null]), [
    ['cancelled', 'superseded', true], ['cancelled', 'superseded', true], ['completed', null, false],
  ])
})

test('invalid or unsaved corrections leave the current run intact', async (t) => {
  let signal
  const { harness } = fixture(t, async (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(part('正在说')) } }))
  })
  harness.setPreferences({ model: 'local-model' })
  harness.start('你好')
  await tick()
  const before = harness.snapshot()
  assert.throws(() => harness.start(' '), /请输入/)
  assert.throws(() => harness.start('字'.repeat(2001)), /请输入/)
  assert.throws(() => harness.setPreferences({ model: 'another-model' }), /请先停止/)
  const save = harness.save
  harness.save = () => { throw new Error('disk full') }
  assert.throws(() => harness.start('以后叫我小李，回复短一点'), /disk full/)
  harness.save = save
  assert.equal(signal.aborted, false)
  assert.deepEqual(harness.snapshot(), before)
  assert.deepEqual(harness.chatPreferences, {}, 'a rejected message must not leave a preference behind')
  harness.stop()
  await harness.running
})

test('timeout releases a stalled run and cannot later affect a replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stalled = deferred()
  let first = true, signal
  const { directory, harness } = fixture(t, async (_url, options) => {
    if (!first) return replyStream('现在好了。')
    first = false
    signal = options.signal
    return stalled.promise
  })
  harness.setPreferences({ model: 'local-model' })
  harness.start('你好')
  const timedOutWork = harness.running
  t.mock.timers.tick(59999)
  assert.equal(harness.snapshot().busy, true)
  t.mock.timers.tick(1)
  assert.equal(harness.snapshot().busy, false)
  assert.equal(signal.aborted, true)
  assert.match(harness.error, /超时/)
  harness.start('再聊一句')
  await harness.running
  const finished = harness.snapshot()
  stalled.resolve(replyStream('已经过时的回复'))
  await timedOutWork
  assert.deepEqual(harness.snapshot(), finished)
  assert.deepEqual(logs(directory).map(({ status, reason }) => [status, reason]), [['failed', 'model-start-timeout'], ['completed', null]])
})

test('explicit commands keep their deterministic memory path without adding a foreground request', async (t) => {
  const requests = []
  const { harness } = fixture(t, async (_url, options) => { requests.push(JSON.parse(options.body)); return replyStream('好呀。') })
  harness.setPreferences({ model: 'local-model' })
  harness.start('以后叫我“小李”，回答短一点，别总反问我。')
  await harness.running
  assert.equal(requests.length, 1)
  assert.equal(harness.chatPreferences.preferredName.value, '小李')
  assert.equal(harness.chatPreferences.replyLength.value, 'short')
  assert.equal(harness.chatPreferences.followUp.value, 'avoid')
  assert.ok(Object.values(harness.chatPreferences).every(entry => entry.method === 'explicit'))
  assert.match(requests[0].messages[0].content, /"小李"/)
  assert.match(requests[0].messages[0].content, /一到两句/)
  assert.match(requests[0].messages[0].content, /不主动追加问题/)
  assert.ok(!harness.messages[0].content.includes('已表达的聊天偏好'))
})

test('an unknown user name is explicit context and cannot be borrowed from the pet identity', async (t) => {
  let request
  const { harness } = fixture(t, async (_url, options) => { request = JSON.parse(options.body); return replyStream('你还没有告诉我呢。') })
  harness.setPreferences({ model: 'local-model' })
  harness.start('你知道我叫什么吗？')
  await harness.running
  assert.match(request.messages[0].content, /小栖.*只指你自己/)
  assert.match(request.messages[0].content, /尚不知道用户的姓名或称呼/)
  assert.match(request.messages[0].content, /不能拿你自己的名字“小栖”/)
  assert.equal(harness.chatPreferences.preferredName, undefined)
})

test('explicit turn overrides leave existing durable memory intact', async (t) => {
  const requests = []
  const { harness } = fixture(t, async (_url, options) => { requests.push(JSON.parse(options.body)); return replyStream('好。') })
  harness.setPreferences({ model: 'local-model' })
  harness.chatPreferences = {
    replyLength: { value: 'short', sourceMessageId: 'old', evidence: '平时讲重点', updatedAt: new Date().toISOString() },
    followUp: { value: 'avoid', sourceMessageId: 'old', evidence: '别追问', updatedAt: new Date().toISOString() },
  }
  const permanent = structuredClone(harness.chatPreferences)
  harness.start('这次说详细一点，可以问我问题')
  await harness.running
  assert.deepEqual(harness.chatPreferences, permanent)
  assert.match(requests.at(-1).messages[0].content, /默认稍微展开/)
  assert.match(requests.at(-1).messages[0].content, /可以自然地问一个/)
  harness.start('今天有点累')
  await harness.running
  assert.deepEqual(harness.chatPreferences, permanent)
  assert.match(requests.at(-1).messages[0].content, /一到两句/)
  assert.match(requests.at(-1).messages[0].content, /不主动追加问题/)
})

test('quoted examples, hypothetical requests, negation and ordinary task instructions do not become preferences', () => {
  for (const content of [
    '“叫我小李，回复短一点，别总反问我。”',
    '例如以后叫我小李，回复短一点', '如果以后回复短一点会怎么样？',
    '请翻译：以后回复短一点', '他说：叫我小林', '我朋友叫小李', '我不是小李',
    '我叫什么', '我的名字是什么', '我叫小李吗', '你叫我小李对吧',
    '我喜欢蓝色', '今天有点累', '请详细解释一下递归', '别回答短一点这句话是什么意思？',
    '```\n叫我小李，回复短一点\n```', '叫我' + '李'.repeat(25),
  ]) {
    const result = extractExplicitPreferences({}, { id: 'user-message', role: 'user', content })
    assert.deepEqual(result.hintedKeys, [], content)
  }
  const boundary = extractExplicitPreferences({}, { id: 'user-message', content: '叫我' + '李'.repeat(24) })
  assert.equal(boundary.effective.preferredName.length, 24)
  const correction = extractExplicitPreferences({}, { id: 'user-message', content: '回答短一点，回答详细一点' })
  assert.equal(correction.effective.replyLength, 'detailed')
  const today = extractExplicitPreferences({}, { id: 'user-message', content: '今天有点累，回复短一点' })
  assert.equal(today.effective.replyLength, 'short')
})

test('old state works without preferences and invalid preference records are ignored independently', (t) => {
  const { directory } = fixture(t)
  const source = { sourceMessageId: 'user-message', evidence: '回答短一点', updatedAt: '2026-09-03T00:00:00.000Z' }
  const saved = { replyLength: { ...source, value: 'short' }, preferredName: { ...source, value: 'bad\nname' }, followUp: { ...source, value: 'always' }, unknown: { ...source, value: 'anything' } }
  assert.deepEqual(readChatPreferences(saved), { replyLength: saved.replyLength })
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ model: 'local-model', messages: [{ id: 'one', role: 'user', content: '你好' }] }))
  const old = new PetHarness({ directory })
  assert.deepEqual(old.chatPreferences, {})
  assert.equal(old.messages.length, 1)
  assert.equal(old.readError, false)
})

test('unwanted trailing questions stay out of streaming frames and history without losing ordinary statements', async (t) => {
  let output
  const { harness, directory } = fixture(t, async () => new Response(new ReadableStream({ start(controller) { output = controller } })))
  t.after(() => harness.stop())
  harness.setPreferences({ model: 'local-model' })
  harness.start('别总反问我')
  await tick()
  output.enqueue(part('欢迎回来。最近怎么样'))
  await tick()
  assert.equal(harness.snapshot().reply, '欢迎回来。')
  output.enqueue(part('？有趣的事愿意分享吗？', true))
  output.close()
  await harness.running
  assert.equal(harness.messages.at(-1).content, '欢迎回来。')
  assert.equal(logs(directory).at(-1).followUpsRemoved, 2)
  assert.deepEqual(withoutTrailingQuestions('欢迎回来。坐下来歇一会儿', true), { text: '欢迎回来。坐下来歇一会儿', removed: 0 })
  assert.deepEqual(withoutTrailingQuestions('想想看。什么是递归？它会调用自身。', true), { text: '想想看。什么是递归？它会调用自身。', removed: 0 })
  assert.deepEqual(withoutTrailingQuestions('需要处理哪个文件？', true), { text: '需要处理哪个文件？', removed: 0 })
  assert.equal(shouldLimitFollowUps({ followUp: 'avoid' }, '请给我三个面试问题'), false)
  assert.equal(shouldLimitFollowUps({ followUp: 'avoid' }, '翻译“你好吗？”'), false)
  assert.equal(shouldLimitFollowUps({ followUp: 'natural' }, '我回来了'), false)
})

require('./memory.test.cjs')
require('./reactions.test.cjs')
require('./reset.test.cjs')
require('./focus.test.cjs')
require('./reminder.test.cjs')

test('reminder sound defaults on and its mute preference survives reload', (t) => {
  const { harness, directory } = fixture(t)
  assert.equal(harness.snapshot().reminderSoundEnabled, true)
  harness.setPreferences({ reminderSoundEnabled: false })
  assert.equal(new PetHarness({ directory }).snapshot().reminderSoundEnabled, false)
  harness.setPreferences({ reminderSoundEnabled: true })
  assert.equal(new PetHarness({ directory }).snapshot().reminderSoundEnabled, true)
  fs.writeFileSync(harness.file, JSON.stringify({ model: 'old-profile', messages: [] }))
  assert.equal(new PetHarness({ directory }).snapshot().reminderSoundEnabled, true)
})

test('reminder sound rejects invalid values and rolls back a failed save', (t) => {
  const { harness } = fixture(t)
  for (const value of ['false', null, 0]) assert.throws(() => harness.setPreferences({ reminderSoundEnabled: value }), /设置无效/)
  harness.save = () => { throw new Error('write failed') }
  assert.throws(() => harness.setPreferences({ reminderSoundEnabled: false }), /write failed/)
  assert.equal(harness.snapshot().reminderSoundEnabled, true)
})
