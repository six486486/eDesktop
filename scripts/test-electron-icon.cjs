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
    EDESKTOP_ICON_TEST: '1',
    EDESKTOP_USER_DATA_PATH: path.join(projectRoot, '.artifacts', 'icon-test-user-data'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

const main = async () => {
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Electron icon test timed out'))
    }, 8_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })

  assert.equal(exitCode, 0, `Electron icon test failed. stdout=${stdout} stderr=${stderr}`)
  assert.match(stdout, /unified application and tray icon assertion passed: 16x16 with 1x\/1\.25x\/1\.5x\/2x representations/)
  console.log(`[icon] ${packagedExecutable ? 'packaged' : 'source'} application/tray identity assertion passed`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
