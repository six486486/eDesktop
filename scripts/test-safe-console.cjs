const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { installSafeConsole, isClosedOutputError } = require('../electron/safe-console.cjs')

const main = async () => {
const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
assert.equal(isClosedOutputError(epipe), true)
assert.equal(isClosedOutputError(Object.assign(new Error('denied'), { code: 'EACCES' })), false)

const stream = new EventEmitter()
let writes = 0
const fakeConsole = {
  log: () => {
    writes += 1
    throw epipe
  },
  info: () => { writes += 1 },
  warn: () => { writes += 1 },
  error: () => { writes += 1 },
}
const guard = installSafeConsole({ targetConsole: fakeConsole, stdout: stream, stderr: stream })
assert.doesNotThrow(() => fakeConsole.log('closed'))
assert.equal(guard.isOutputClosed(), true)
fakeConsole.warn('ignored after close')
assert.equal(writes, 1)
guard.restore()

const safeConsolePath = path.join(__dirname, '..', 'electron', 'safe-console.cjs')
const childSource = `
  const { installSafeConsole } = require(${JSON.stringify(safeConsolePath)});
  installSafeConsole();
  console.log('ready');
  setTimeout(() => {
    console.log('after-close');
    if (process.send) process.send({ alive: true });
    setTimeout(() => process.exit(0), 80);
  }, 120);
`

const child = spawn(process.execPath, ['-e', childSource], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})

let pipeClosed = false
let childStayedAlive = false
child.stdout.once('data', () => {
  pipeClosed = true
  child.stdout.destroy()
})
child.on('message', (message) => {
  if (message?.alive) childStayedAlive = true
})

const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('safe console child timed out')), 5_000)
  child.once('error', reject)
  child.once('exit', (code) => {
    clearTimeout(timeout)
    resolve(code)
  })
})

assert.equal(pipeClosed, true)
assert.equal(childStayedAlive, true)
assert.equal(exitCode, 0)
console.log('[safe-console] assertions passed: sync EPIPE + closed real stdout pipe')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
