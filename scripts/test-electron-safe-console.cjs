const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const packagedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : null
const executable = packagedExecutable || require('electron')
const args = packagedExecutable ? [] : [projectRoot]

const child = spawn(executable, args, {
  cwd: projectRoot,
  env: {
    ...process.env,
    EDESKTOP_SAFE_CONSOLE_TEST: '1',
    EDESKTOP_USER_DATA_PATH: path.join(projectRoot, '.artifacts', 'safe-console-pipe-test-user-data'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let receivedReady = false
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
  if (!receivedReady && stdout.includes('[safe-console] electron ready')) {
    receivedReady = true
    child.stdout.destroy()
  }
})
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

const main = async () => {
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Electron did not exit after its stdout pipe was closed'))
    }, 8_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })

  assert.equal(receivedReady, true, `Electron never emitted its ready marker. stdout=${stdout} stderr=${stderr}`)
  assert.equal(exitCode, 0, `Electron crashed or hung after the stdout pipe closed. stderr=${stderr}`)
  console.log(`[safe-console] ${packagedExecutable ? 'packaged' : 'source'} Electron closed-pipe assertion passed`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
