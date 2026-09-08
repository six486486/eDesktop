// Run manually: node desktop-pet/tests/memory-eval.cjs. Requires local qwen2.5:3b.
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { extractMemory } = require('../memory-review.cjs')
const { extractExplicitPreferences } = require('../memory.cjs')
const cases = require('./memory-cases.cjs')
const directory = path.resolve(__dirname, '../../.artifacts/desktop-pet-memory', `eval-${Date.now()}`)
const model = process.argv[2] || 'qwen2.5:3b'

async function main() {
  fs.mkdirSync(directory, { recursive: true })
  const results = []
  for (const [index, sample] of cases.entries()) {
    const sources = (sample.texts || [sample.text]).map((content, i) => ({ id: `source-${i}`, sequence: i + 1, content }))
    let explicit = {}
    for (const source of sources) explicit = extractExplicitPreferences(explicit, source).memory
    const started = performance.now()
    let raw, actual = {}, rejected = [], error = null, verificationRequested = 0
    try {
      const result = await extractMemory({ model, current: explicit, sources, signal: AbortSignal.timeout(20000) })
      raw = result.raw
      verificationRequested = result.verificationRequested
      actual = Object.fromEntries(Object.entries(result.memory).map(([key, entry]) => [key, entry.value]))
      rejected = result.rejected
    } catch (failure) { error = failure.message }
    const keys = new Set([...Object.keys(sample.expected), ...Object.keys(actual)])
    const falseWrites = [...keys].filter(key => Object.hasOwn(actual, key) && actual[key] !== sample.expected[key]).length
    const missed = [...keys].filter(key => Object.hasOwn(sample.expected, key) && actual[key] !== sample.expected[key]).length
    const passed = !error && falseWrites === 0 && missed === 0
    const result = { ...sample, explicit: Object.keys(explicit), actual, rejected, raw, verificationRequested, error, passed, falseWrites, missed, durationMs: Math.round(performance.now() - started) }
    results.push(result)
    console.log(`[memory-eval] ${index + 1}/${cases.length} ${passed ? 'PASS' : 'FAIL'} ${result.durationMs}ms ${passed ? '' : JSON.stringify({ text: sample.text || sample.texts, actual, expected: sample.expected, error })}`)
  }
  const times = results.map(result => result.durationMs).sort((a, b) => a - b)
  const summary = {
    model, cases: results.length, passed: results.filter(result => result.passed).length,
    falseWrites: results.reduce((sum, result) => sum + result.falseWrites, 0),
    missed: results.reduce((sum, result) => sum + result.missed, 0),
    medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1],
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ summary, results }, null, 2))
  console.log(JSON.stringify({ ...summary, artifact: path.join(directory, 'result.json') }))
  if (summary.passed !== results.length) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
