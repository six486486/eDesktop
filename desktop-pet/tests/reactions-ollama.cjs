// Run manually with the installed local model. Every case uses isolated state.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PetHarness } = require('../harness.cjs')
const directory = path.resolve(__dirname, '../../.artifacts/desktop-pet-reactions', `run-${Date.now()}`)
const model = process.argv[2] || 'qwen2.5:3b'
const cases = [
  { text: '小栖，你真贴心。', expected: 'happy' },
  { history: ['我还没懂递归，能用套娃举个例子吗？', '好呀，我们可以从打开最外面的套娃开始讲。'], text: '好，接着说吧。', expected: 'focus' },
  { history: ['今天只想随便聊聊，别给我讲道理。', '好，那就随意聊聊生活里的小事情。'], text: '好，接着说吧。', expected: null },
  { history: ['这个问题有什么解决办法？', '可以先缩小排查范围，或者复现出一个最小例子。'], text: '第二种具体怎么做？', expected: 'focus' },
  { history: ['今天有点困了。', '那早点休息也好，我们明天还可以聊。'], text: '那就明天接着说吧。', expected: 'rest' },
  { history: ['今天有点困了。', '你想先去睡一会儿吗？'], text: '还是想和你多待会儿，陪我聊聊。', expected: null },
  { history: ['刚说不想被问，你又问了三个问题。', '抱歉，我又问多了。'], text: '你可真贴心啊。', expected: null },
  { text: '请把“晚安”翻译成英文。', expected: null },
  { text: '今天累坏了，但我现在不想睡，想和你聊聊。', expected: null },
  { text: '我不去忙了，继续聊一会儿。', expected: null },
  { history: ['说说怎么提高工作效率。', '我们可以先分析时间花在哪几个部分。'], text: '先别分析了，陪我吐槽两句。', expected: null },
  { text: '你先趴下休息吧。', expected: 'rest' },
  { text: '我终于把那个折腾好久的 bug 修好了，好开心！', expected: 'happy' },
  { text: '你别做动作了，陪我安静聊会儿就好。', expected: null },
]

async function main() {
  const results = []
  for (const [index, sample] of cases.entries()) {
    const target = path.join(directory, String(index + 1))
    let requests = 0
    const frames = []
    const harness = new PetHarness({ directory: target, memoryIdleMs: 60000,
      fetchImpl: (...args) => { requests += 1; return fetch(...args) },
      onChange: frame => frames.push(frame.reply),
    })
    harness.setPreferences({ model })
    harness.messages = (sample.history || []).map((content, i) => ({ id: `context-${i}`, role: i % 2 ? 'assistant' : 'user', content }))
    harness.start(sample.text)
    await harness.running
    harness.stop('shutdown')
    const record = JSON.parse(fs.readFileSync(harness.logFile, 'utf8').trim())
    assert.equal(requests, 1, 'actions must share the chat request')
    const clean = frames.every(frame => !/^[{]|\n(?:动作|action|reply)\s*[:：]|<\/?tool_call>/.test(frame))
    const passed = !harness.error && clean && record.reaction === sample.expected && record.reactionDecision?.source === 'model'
    results.push({ ...sample, actual: record.reaction, decision: record.reactionDecision, reply: harness.messages.at(-1).content,
      error: harness.error, clean, firstTokenMs: record.firstTokenMs, modelFirstTokenMs: record.modelFirstTokenMs, passed })
    console.log(`[reactions] ${index + 1}/${cases.length} ${passed ? 'PASS' : 'FAIL'} ${JSON.stringify(results.at(-1))}`)
  }
  const summary = { cases: cases.length, passed: results.filter(result => result.passed).length,
    medianFirstTokenMs: results.map(result => result.firstTokenMs).sort((a, b) => a - b)[Math.floor(results.length / 2)] }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ model, summary, results }, null, 2))
  console.log(JSON.stringify({ ...summary, artifact: path.join(directory, 'result.json') }))
  if (summary.passed !== cases.length) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
