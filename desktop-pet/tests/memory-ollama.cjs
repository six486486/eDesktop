// Run manually with Node and an optional installed model name; writes only isolated test data.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PetHarness } = require('../harness.cjs')
const directory = path.resolve(__dirname, '../../.artifacts/desktop-pet-memory', `run-${Date.now()}`)
const model = process.argv[2] || 'qwen2.5:3b'

async function say(harness, text) {
  harness.start(text)
  await harness.running
  assert.equal(harness.error, '')
  const reply = harness.messages.at(-1).content
  await harness.reviewMemory()
  console.log(`[memory] ${text}\n  ${reply}`)
  return reply
}

function rollContextForward(harness) {
  // Represent a later session whose recent context no longer includes the preference statements.
  harness.messages = Array.from({ length: 40 }, (_, i) => ({ id: `later-${i}`, role: i % 2 ? 'assistant' : 'user', content: i % 2 ? '嗯，慢慢来。' : '随便聊聊天。' }))
  harness.save()
  return new PetHarness({ directory })
}

async function main() {
  let harness = new PetHarness({ directory })
  assert.ok((await harness.listModels()).includes(model), `install ${model} first`)
  harness.setPreferences({ model })
  const unknownNameReply = await say(harness, '你知道我叫什么吗？')
  assert.match(unknownNameReply, /还没|尚未|不知道|不清楚|没有.*(?:告诉|名字|称呼)/)
  assert.equal(harness.chatPreferences.preferredName, undefined)
  await say(harness, '以后叫我小李，回答短一点，可以问我问题。')
  assert.equal(harness.chatPreferences.preferredName.value, '小李')
  await say(harness, '怎么每次聊天都像被采访一样，轻松一点就好。')
  assert.equal(harness.chatPreferences.followUp.value, 'avoid')
  assert.equal(harness.chatPreferences.followUp.method, 'model', 'semantic preference must come from model extraction')
  harness = rollContextForward(harness)
  const greeting = await say(harness, '我回来了，跟我打个招呼。')
  assert.match(greeting, /小李/)
  assert.ok(greeting.length <= 100, 'a greeting with the brief preference should remain short')
  assert.ok(!/[?？]/.test(greeting), 'avoid-follow-up preference should avoid a question in this greeting')
  await say(harness, '以后叫我小林，回答详细一点，可以问我问题。')
  assert.equal(harness.chatPreferences.preferredName.value, '小林')
  assert.equal(harness.chatPreferences.replyLength.value, 'detailed')
  assert.equal(harness.chatPreferences.followUp.value, 'natural')
  harness = rollContextForward(harness)
  const reply = await say(harness, '我的名字是什么')
  assert.match(reply, /小林/)
  assert.doesNotMatch(reply, /小李/)
  assert.doesNotMatch(reply, /没有.*(?:告诉|名字)|不知道|不清楚/)
  assert.equal(harness.chatPreferences.preferredName.value, '小林', 'asking for a name must not overwrite it')
  await say(harness, '对了，青禾是我的网名。')
  assert.equal(harness.chatPreferences.preferredName.value, '青禾')
  assert.equal(harness.chatPreferences.preferredName.method, 'model', 'natural self-identification should use verified semantic memory')
  harness.resetConversation()
  harness = new PetHarness({ directory })
  const semanticNameReply = await say(harness, '重新聊以后，你还记得我的名字吗？')
  assert.match(semanticNameReply, /青禾/)
  assert.equal(harness.chatPreferences.preferredName.value, '青禾')
  const runs = fs.readFileSync(harness.logFile, 'utf8').trim().split('\n').map(JSON.parse)
  const reviews = fs.readFileSync(harness.memoryLogFile, 'utf8').trim().split('\n').map(JSON.parse)
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ model: harness.model, unknownNameReply, greeting, correctedNameReply: reply, semanticNameReply,
    firstTokenMs: runs.map(run => run.firstTokenMs), reviewMs: reviews.map(review => review.durationMs), passed: true }, null, 2))
  console.log('[memory] PASS: real Ollama, verified semantic name, reset/restart, source context gone, style and correction')
  console.log(`[memory] Isolated result: ${directory}`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
