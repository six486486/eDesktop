const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const testRoot = path.join(projectRoot, '.artifacts', 'workspace-snapshot-integration')
fs.rmSync(testRoot, { recursive: true, force: true })

const child = spawn(require('electron'), [projectRoot], {
  cwd: projectRoot,
  env: {
    ...process.env,
    EDESKTOP_SNAPSHOT_TEST: '1',
    EDESKTOP_USER_DATA_PATH: testRoot,
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
      reject(new Error(`snapshot integration timed out; stdout=${stdout} stderr=${stderr}`))
    }, 15_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
  assert.equal(exitCode, 0, `snapshot integration failed; stdout=${stdout} stderr=${stderr}`)
  assert.match(stdout, /integration assertion passed/)
  const snapshotFiles = fs.readdirSync(path.join(testRoot, 'workspace-snapshots')).filter((name) => name.endsWith('.json'))
  assert.ok(snapshotFiles.length >= 2, 'manual and pre-restore snapshots should both exist')
  for (const name of snapshotFiles) {
    const document = JSON.parse(fs.readFileSync(path.join(testRoot, 'workspace-snapshots', name), 'utf8'))
    assert.equal(document.fileDataIncluded, false)
    assert.equal(Object.prototype.hasOwnProperty.call(document, 'fileData'), false)
  }
  console.log('[snapshots] isolated Electron persistence/restore assertion passed')
}

main().finally(() => {
  fs.rmSync(testRoot, { recursive: true, force: true })
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
