// One paired, warm-model latency sample; not a benchmark or a zero-overhead claim.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PetHarness } = require('../harness.cjs')
const directory = path.resolve(__dirname, '../../.artifacts/desktop-pet-memory', `latency-${Date.now()}`)
const runs = harness => fs.readFileSync(harness.logFile, 'utf8').trim().split('\n').map(JSON.parse)

async function main() {
  const seed = new PetHarness({ directory: path.join(directory, 'seed'), memoryIdleMs: 60000 })
  seed.setPreferences({ model: 'qwen2.5:3b' })
  seed.start('你好，简单打个招呼。')
  await seed.running
  assert.equal(seed.error, '')
  seed.stop('shutdown')
  const state = fs.readFileSync(seed.file)
  const measurements = []
  for (const preempt of [false, true]) {
    const target = path.join(directory, preempt ? 'preempt' : 'baseline')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'state.json'), state)
    let reviewSignal, markStarted
    const started = new Promise(resolve => { markStarted = resolve })
    const harness = new PetHarness({ directory: target, memoryIdleMs: 60000, fetchImpl: (url, options) => {
      if (JSON.parse(options.body).stream === false) { reviewSignal = options.signal; markStarted() }
      return fetch(url, options)
    } })
    let review
    if (preempt) {
      review = harness.reviewMemory()
      await started
      await new Promise(resolve => setTimeout(resolve, 75))
      assert.ok(harness.memoryJob, 'the review must still be running when the user speaks')
    }
    harness.start('我回来了，简单打个招呼。')
    if (preempt) assert.equal(reviewSignal.aborted, true)
    await harness.running
    await review
    harness.stop('shutdown')
    assert.equal(harness.error, '')
    if (preempt) {
      const record = JSON.parse(fs.readFileSync(harness.memoryLogFile, 'utf8').trim())
      assert.equal(record.reason, 'chat-priority')
      assert.equal(harness.memoryCursor, 0, 'cancelled extraction must remain pending')
    }
    measurements.push({ preempt, firstTokenMs: runs(harness).at(-1).firstTokenMs })
  }
  const result = { model: seed.model, measurements, passed: true }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, artifact: path.join(directory, 'result.json') }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
