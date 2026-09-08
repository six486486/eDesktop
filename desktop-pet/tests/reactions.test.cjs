const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PetHarness } = require('../harness.cjs')
const { CHAT_SCHEMA, readChatEnvelope } = require('../reply-format.cjs')
const { reactionDecision } = require('../reactions.cjs')

const tick = () => new Promise(resolve => setImmediate(resolve))
const part = (content, done = false) => Buffer.from(JSON.stringify({ message: { content }, done }) + '\n')
function fixture(t, fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-reaction-test-'))
  const harness = new PetHarness({ directory, fetchImpl, memoryIdleMs: 60000 })
  t.after(() => { harness.stop('shutdown'); fs.rmSync(directory, { recursive: true, force: true }) })
  harness.setPreferences({ model: 'local-model' })
  return { harness, directory }
}
const logs = harness => fs.readFileSync(harness.logFile, 'utf8').trim().split('\n').map(JSON.parse)
const model = kind => ({ state: 'model', kind })

test('structured streaming exposes only decoded speech and never executes incomplete metadata', () => {
  const reply = '你好🙂\n路径 C:\\猫；他说："好呀"。代码 {"action":"rest"} 也是正文。'
  const escaped = JSON.stringify({ reply, action: 'focus' }).replace('🙂', '\\ud83d\\ude42')
  for (const raw of [escaped, JSON.stringify({ action: 'focus', reply })]) {
    let previous = ''
    for (let end = 0; end <= raw.length; end += 1) {
      const envelope = readChatEnvelope(raw.slice(0, end))
      assert.equal(envelope.state, 'pending')
      assert.equal(envelope.kind, null)
      assert.ok(reply.startsWith(envelope.text), `invalid visible prefix at ${end}`)
      assert.ok(envelope.text.startsWith(previous), 'visible speech must not rewind')
      assert.ok(!/[\uD800-\uDBFF]$/.test(envelope.text), 'hold incomplete surrogate pairs')
      previous = envelope.text
    }
    assert.deepEqual(readChatEnvelope(raw, true), { text: reply, state: 'model', kind: 'focus' })
  }
})

test('missing, invalid, duplicate or truncated metadata preserves speech without executing a gesture', () => {
  for (const raw of [
    '{"reply":"好呀","action":"fly"}', '{"reply":"好呀","action":"__proto__"}',
    '{"reply":"好呀","action":true}', '{"reply":"好呀"}',
    '{"reply":"好呀","action":["rest"]}', '{"reply":"好呀","action":{"toString":"rest"}}',
    '{"reply":"好呀","action":true,"action":"rest"}',
    '{"reply":"好呀","action":"rest","extra":"x"}',
    '{"reply":"好呀","action":"none","action":"rest"}',
    '{"reply":"好呀","reply":"晚安","action":"rest"}',
    '{"reply":"好呀","action":"re', '{"reply":"好呀',
  ]) assert.deepEqual(readChatEnvelope(raw, true), { text: '好呀', state: 'invalid', kind: null }, raw)
  assert.deepEqual(readChatEnvelope('{"reply":"好呀","action":"none"}', true), { text: '好呀', state: 'model', kind: null })
  assert.deepEqual(readChatEnvelope('普通回复。', true), { text: '普通回复。', state: 'missing', kind: null })
})

test('model intent replaces keyword triggers while runtime honors explicit limits and a fixed action set', () => {
  assert.equal(reactionDecision(model('focus'), '好，接着说吧。').kind, 'focus')
  assert.equal(reactionDecision(model(null), '好，接着说吧。').kind, null)
  assert.equal(reactionDecision(model(null), '你真贴心。').kind, null, 'a neutral model decision must not fall back to praise rules')
  for (const [text, proposed, reason] of [
    ['今天下雨了', 'fly', 'invalid-action'],
    ['你别做动作了，安静陪我吧', 'happy', 'user-suppressed'],
    ['别动了，安静一会儿', 'focus', 'user-suppressed'],
    ['今天很累，但我不想睡，想和你聊聊', 'rest', 'still-chatting'],
    ['还是想和你多待会儿，陪我聊聊', 'rest', 'still-chatting'],
    ['我不去忙了，继续聊', 'rest', 'still-chatting'],
    ['请翻译“晚安”', 'rest', 'quoted-or-task'],
    ['“谢谢你”是什么意思', 'happy', 'quoted-or-task'],
  ]) {
    const result = reactionDecision(model(proposed), text)
    assert.equal(result.kind, null, text)
    assert.equal(result.reason, reason, text)
  }
  assert.equal(reactionDecision(model('rest'), '你先趴下陪我聊吧').kind, 'rest', 'an explicit pose does not end chatting')
  assert.equal(reactionDecision(model('rest'), '别趴下，陪我聊').kind, null)
  assert.equal(reactionDecision({ state: 'missing' }, '谢谢你').source, 'rule')
  assert.equal(reactionDecision({ state: 'invalid' }, '谢谢你').kind, null)
})

test('repeated happy/focus gestures cool down for eight seconds; a different gesture or rest is allowed', () => {
  for (const kind of ['happy', 'focus']) {
    const last = { kind, startedAt: 1000 }
    assert.equal(reactionDecision(model(kind), '继续', last, 8999).reason, 'cooldown')
    assert.equal(reactionDecision(model(kind), '继续', last, 9000).kind, kind)
  }
  assert.equal(reactionDecision(model('focus'), '再解释一下', { kind: 'happy', startedAt: 1000 }, 1100).kind, 'focus')
  assert.equal(reactionDecision(model('rest'), '晚安', { kind: 'rest', startedAt: 1000 }, 1100).kind, 'rest')
})

test('speech streams before the validated action, shares one request and persists no protocol or replay state', async t => {
  let stream, request, calls = 0
  const { harness, directory } = fixture(t, async (_url, options) => {
    calls += 1
    request = JSON.parse(options.body)
    return new Response(new ReadableStream({ start(controller) { stream = controller } }))
  })
  const frames = []
  harness.onChange = state => frames.push(state)
  harness.start('第二种具体怎么做？')
  await tick()
  stream.enqueue(part('{"reply":"'))
  await tick()
  assert.equal(harness.activeRun.firstTokenMs, null, 'hidden protocol is not the first visible character')
  assert.notEqual(harness.activeRun.modelFirstTokenMs, null)
  stream.enqueue(part('我们先做一个最小例子。","action":"focus"}'))
  await tick()
  assert.equal(harness.snapshot().reply, '我们先做一个最小例子。')
  assert.equal(harness.reaction, null, 'no gesture until the final completion signal')
  stream.enqueue(part('', true))
  stream.close()
  await harness.running
  assert.equal(harness.error, '')
  assert.equal(calls, 1)
  assert.deepEqual(request.format, CHAT_SCHEMA)
  assert.equal(harness.reaction.kind, 'focus')
  assert.equal(harness.messages.at(-1).content, '我们先做一个最小例子。')
  assert.ok(frames.every(frame => '我们先做一个最小例子。'.startsWith(frame.reply)))
  assert.equal(new Set(frames.filter(frame => frame.reaction).map(frame => frame.reaction.startedAt)).size, 1)
  const record = logs(harness)[0]
  assert.deepEqual(record.reactionDecision, { proposed: 'focus', kind: 'focus', source: 'model', reason: 'accepted' })
  assert.ok(record.firstTokenMs >= record.modelFirstTokenMs)
  assert.ok(!fs.readFileSync(harness.logFile, 'utf8').includes('最小例子'))
  const restored = new PetHarness({ directory })
  assert.equal(restored.reaction, null)
  assert.equal(restored.lastReaction, null)
  assert.deepEqual(restored.messages, harness.messages)
})

test('an interrupted structured reply keeps only visible speech; a late valid action cannot reach the new run', async t => {
  let resolveLate, reads = 0, calls = 0
  const late = new Promise(resolve => { resolveLate = resolve })
  const reader = {
    read: () => ++reads === 1 ? Promise.resolve({ value: part('{"reply":"讲到一半'), done: false }) : late,
    cancel: async () => {}, releaseLock() {},
  }
  const { harness } = fixture(t, async () => ++calls === 1
    ? { ok: true, body: { getReader: () => reader } }
    : new Response(part('{"reply":"好，我听着。","action":"none"}', true)))
  harness.start('帮我解释一下')
  const oldWork = harness.running
  await tick()
  harness.start('先别分析了，陪我吐槽一下')
  await harness.running
  const finished = harness.snapshot()
  resolveLate({ value: part('的话。","action":"focus"}', true), done: false })
  await oldWork
  assert.deepEqual(harness.snapshot(), finished)
  assert.equal(harness.reaction, null)
  assert.equal(harness.messages[1].content, '讲到一半')
  assert.equal(harness.messages[1].interrupted, true)
  assert.deepEqual(logs(harness).map(record => [record.status, record.reaction]), [['cancelled', null], ['completed', null]])
})

test('bad action metadata does not break readable chat, and decoded replies still honor the follow-up preference', async t => {
  const { harness } = fixture(t, async () => new Response(part('{"reply":"好，我听着。","action":"fly"}', true)))
  harness.start('谢谢你')
  await harness.running
  assert.equal(harness.error, '')
  assert.equal(harness.messages.at(-1).content, '好，我听着。')
  assert.equal(harness.reaction, null)
  assert.equal(logs(harness)[0].reactionDecision.reason, 'invalid-action')
  harness.fetch = async () => new Response(part(JSON.stringify({ reply: '好，我听着。今天发生什么事了？', action: 'none' }), true))
  harness.start('别总反问我，听我说就好')
  await harness.running
  assert.equal(harness.error, '')
  assert.equal(harness.messages.at(-1).content, '好，我听着。')
  assert.equal(logs(harness)[1].followUpsRemoved, 1)
})
