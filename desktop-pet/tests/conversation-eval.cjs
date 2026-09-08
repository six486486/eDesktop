// CLI: node desktop-pet/tests/conversation-eval.cjs <installed-model>
// Produces complete transcripts for rubric-based review, not an automatic intelligence score.
const fs = require('node:fs')
const path = require('node:path')
const { PetHarness } = require('../harness.cjs')
const cases = require('./conversation-cases.cjs')
const model = process.argv[2] || 'qwen2.5:3b'
const directory = path.resolve(__dirname, '../../.artifacts/desktop-pet-conversation', `run-${Date.now()}`)

;(async () => {
  const results = []
  for (const sample of cases) {
    const harness = new PetHarness({ directory: path.join(directory, sample.id), memoryIdleMs: 60000,
      fetchImpl: (url, options) => {
        const request = JSON.parse(options.body)
        request.options.seed = 42
        return fetch(url, { ...options, body: JSON.stringify(request) })
      },
    })
    harness.setPreferences({ model })
    harness.messages = (sample.history || []).map((content, index) => ({ id: `context-${index}`, role: index % 2 ? 'assistant' : 'user', content }))
    const transcript = []
    for (const text of sample.turns) {
      harness.start(text)
      await harness.running
      transcript.push({ user: text, assistant: harness.messages.at(-1)?.role === 'assistant' ? harness.messages.at(-1).content : '', error: harness.error })
      harness.stop('eval-idle')
    }
    const runs = fs.readFileSync(harness.logFile, 'utf8').trim().split('\n').map(JSON.parse)
    const result = { ...sample, transcript, firstTokenMs: runs.map(run => run.firstTokenMs), durationMs: runs.map(run => run.durationMs) }
    results.push(result)
    console.log(JSON.stringify({ id: sample.id, transcript, firstTokenMs: result.firstTokenMs }))
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ model, seed: 42, results }, null, 2))
  console.log(`Review artifact: ${path.join(directory, 'result.json')}`)
  if (results.some(sample => sample.transcript.some(turn => turn.error))) process.exitCode = 1
})().catch(error => { console.error(error); process.exitCode = 1 })
