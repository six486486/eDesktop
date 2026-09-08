// node desktop-pet/tests/focus-context-ollama.cjs [model] [seed] [case-id,...]
const fs = require('node:fs')
const path = require('node:path')
const { PetHarness } = require('../harness.cjs')
const { FocusService } = require('../focus-service.cjs')
const { createFocusPreview } = require('../focus-preview.cjs')
const { createWidget } = require('../../electron/widget-model.cjs')
const cases = require('./focus-context-cases.cjs')
const model = process.argv[2] || 'qwen3:4b-instruct-2507-q4_K_M'
const seed = Number(process.argv[3] || 42)
const selected = process.argv[4]?.split(',')
const directory = path.resolve('.artifacts/desktop-pet-focus-context', `run-${Date.now()}`)

async function main() {
  const results = []
  for (const scenario of cases.filter(item => !selected || selected.includes(item.id))) {
    const dataDirectory = path.join(directory, scenario.id)
    const host = createFocusPreview(dataDirectory)
    if (scenario.defaultMinutes) await host.transact(workspace => {
      const widget = createWidget('pomodoro', { index: 0, primaryOffset: { x: 0, y: 0 } })
      widget.data.focusMinutes = scenario.defaultMinutes
      workspace.widgets.push(widget)
      return { changed: true, value: null }
    })
    const focus = new FocusService({ host })
    focus.start()
    const harness = new PetHarness({ directory: dataDirectory, focusTools: focus, memoryIdleMs: 60000,
      fetchImpl: (url, options) => {
        const body = JSON.parse(options.body)
        body.options.seed = seed
        return fetch(url, { ...options, body: JSON.stringify(body) })
      },
    })
    harness.setPreferences({ model })
    try {
      for (const [input, expected, minutes] of scenario.turns) {
        const before = structuredClone(host.read().widgets)
        harness.start(input)
        const activeRun = harness.activeRun
        await harness.running
        harness.stop('eval-idle')
        const log = JSON.parse(fs.readFileSync(harness.logFile, 'utf8').trim().split('\n').at(-1))
        const actual = log.toolDecision?.status || null
        const allowed = Array.isArray(expected) ? expected : [expected]
        const unchanged = JSON.stringify(before) === JSON.stringify(host.read().widgets)
        const pass = !harness.error && allowed.includes(actual)
          && (minutes === undefined || log.toolDecision?.minutes === minutes)
          && (!allowed.includes(null) || unchanged)
        const last = harness.messages.at(-1)
        const result = { id: scenario.id, input, expected, actual, pass, reply: last?.role === 'assistant' ? last.content : '',
          error: harness.error, permission: log.toolPermission, tool: log.toolDecision,
          rawReply: activeRun.rawReply,
          durationMs: log.durationMs, firstTokenMs: log.firstTokenMs, unchanged }
        results.push(result)
        console.log(`${pass ? 'PASS' : 'FAIL'} ${scenario.id}: ${input} -> ${actual}${!pass ? `; ${result.reply}; ${result.error}` : ''}`)
      }
    } finally { harness.stop('shutdown'); await focus.dispose() }
  }
  const passed = results.filter(result => result.pass).length
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ model, seed, passed, total: results.length, results }, null, 2))
  console.log(`${passed}/${results.length}; ${directory}`)
  if (passed !== results.length) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
