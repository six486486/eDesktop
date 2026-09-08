// Actual model decisions and actual isolated clock execution, no user workspace.
// node desktop-pet/tests/focus-ollama.cjs [installed model]
const fs = require('node:fs')
const path = require('node:path')
const { PetHarness } = require('../harness.cjs')
const { FocusService } = require('../focus-service.cjs')
const { createFocusPreview } = require('../focus-preview.cjs')
const model = process.argv[2] || 'qwen3:4b-instruct-2507-q4_K_M'
const directory = path.resolve('.artifacts/desktop-pet-focus-ollama', `run-${Date.now()}`)
const cases = [
  ['chat', [['今天写代码好累，陪我聊一会儿。', null]]],
  ['quiet', [['你安静陪我一会儿就好，不用计时。', null]]],
  ['negation', [['不要开始二十分钟计时，我还没准备好。', null]]],
  ['quote', [['翻译这句话：帮我开始二十分钟专注。', null]]],
  ['capability', [['你能帮我计时吗？', null]]],
  ['future', [['明天上午九点帮我开始二十分钟专注。', null]]],
  ['flow', [
    ['陪我专注二十分钟。', 'started', 20], ['还剩多久？', 'running'],
    ['再帮我开始三十分钟。', ['running', 'already-running']], ['先把计时停了吧。', 'stopped'], ['现在还有计时吗？', 'idle'],
  ]],
  ['default', [['开始专注吧，用默认时长。', 'started', 25], ['不计时了，我们随便聊聊。', 'stopped']]],
  ['correction', [['我想写一会儿代码。', 'started', 25], ['先别开始，陪我说说话。', 'stopped'], ['现在准备好了，帮我计时十分钟。', 'started', 10]]],
  ['context', [['我打算花十五分钟读书，先不计时。', null], ['现在开始吧。', 'started', 15]]],
  ['heldout-translation', [['请把“开始四十分钟的番茄钟”翻译成英文。', null]]],
  ['heldout-plan', [['我准备先画几张草图。', 'started', 25]]],
  ['heldout-request', [['能帮我开始十二分钟专注吗？', 'started', 12], ['不用继续倒数了。', 'stopped'], ['停止计时。', 'idle']]],
]

async function main() {
  const results = []
  for (const [id, turns] of cases) {
    const dataDirectory = path.join(directory, id)
    const host = createFocusPreview(dataDirectory)
    const focus = new FocusService({ host })
    focus.start()
    const harness = new PetHarness({ directory: dataDirectory, focusTools: focus, memoryIdleMs: 60000,
      fetchImpl: (url, options) => {
        const body = JSON.parse(options.body)
        body.options.seed = 42
        return fetch(url, { ...options, body: JSON.stringify(body) })
      },
    })
    harness.setPreferences({ model })
    try {
      for (const [text, expected, minutes] of turns) {
        const before = Date.now()
        const widgetsBefore = JSON.stringify(host.read().widgets)
        harness.start(text)
        await harness.running
        harness.stop('eval-idle')
        const runs = fs.readFileSync(harness.logFile, 'utf8').trim().split('\n').map(JSON.parse)
        const log = runs.at(-1), actual = log.toolDecision?.status || null
        const allowed = Array.isArray(expected) ? expected : [expected]
        const unchanged = widgetsBefore === JSON.stringify(host.read().widgets)
        const pass = !harness.error && allowed.includes(actual) && (minutes === undefined || log.toolDecision?.minutes === minutes)
          && (!allowed.some(value => [null, 'running', 'already-running', 'idle'].includes(value)) || unchanged)
        results.push({ id, text, expected, actual, pass, reply: harness.messages.at(-1)?.content,
          error: harness.error, tool: log.toolDecision, durationMs: Date.now() - before,
          firstTokenMs: log.firstTokenMs, widgets: host.read().widgets })
        console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${text} -> ${actual}; ${harness.messages.at(-1)?.content}`)
      }
    } finally { harness.stop('shutdown'); await focus.dispose() }
  }
  const passed = results.filter(result => result.pass).length
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ model, passed, total: results.length, results }, null, 2))
  console.log(`${passed}/${results.length}; ${directory}`)
  if (passed !== results.length) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
