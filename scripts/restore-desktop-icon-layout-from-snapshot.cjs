const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { restoreDesktopIconLayout } = require('../electron/desktop-icon-layout-core.cjs')

const workspacePath = process.argv[2] ? path.resolve(process.argv[2]) : ''
const snapshotPath = process.argv[3] ? path.resolve(process.argv[3]) : ''
if (!workspacePath || !snapshotPath) {
  throw new Error('usage: node scripts/restore-desktop-icon-layout-from-snapshot.cjs <workspace.json> <snapshot.json>')
}

const workspace = JSON.parse(fs.readFileSync(workspacePath, 'utf8'))
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
const snapshotFiles = new Map((snapshot.workspace?.widgets || [])
  .filter((widget) => widget.kind === 'organizer')
  .flatMap((widget) => (widget.data?.files || []).map((file) => [file.id, file])))
const entries = (workspace.widgets || [])
  .filter((widget) => widget.kind === 'organizer')
  .flatMap((widget) => (widget.data?.files || []).flatMap((file) => {
    const saved = snapshotFiles.get(file.id)
    if (!saved?.originalDesktopPosition) return []
    const names = [file.name]
    if (!file.isDirectory && !file.shellClsid) names.push(path.parse(file.name).name)
    return [{
      names: [...new Set(names.filter(Boolean).map((name) => name.toLocaleLowerCase()))],
      position: saved.originalDesktopPosition,
      required: true,
    }]
  }))

const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const helper = spawn(powershell, [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  path.join(__dirname, '..', 'electron', 'windows-desktop-icons.ps1'),
  '-Mode',
  'server',
], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let requestId = 0
readline.createInterface({ input: helper.stdout }).on('line', (line) => {
  let response
  try {
    response = JSON.parse(line)
  } catch {
    return
  }
  const request = pending.get(response.id)
  if (!request) return
  pending.delete(response.id)
  if (response.ok) request.resolve(response.result)
  else request.reject(new Error(response.error || 'desktop helper request failed'))
})
const request = (command, payload = {}) => new Promise((resolve, reject) => {
  const id = ++requestId
  pending.set(id, { resolve, reject })
  helper.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`)
})

const main = async () => {
  const result = await restoreDesktopIconLayout({
    entries,
    setPositions: (positions) => request('set-many', { positions }),
    listPositions: () => request('list'),
    delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  })
  console.log(`[desktop-icon-repair] matched=${result.matched} missing=${result.missingRequired.length}`)
  if (result.missingRequired.length) process.exitCode = 1
}

main().finally(() => {
  helper.stdin.end()
  helper.kill()
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
