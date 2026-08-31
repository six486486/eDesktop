const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const testRoot = path.join(process.cwd(), '.artifacts', 'restore-guardian-test')
const readyPath = path.join(testRoot, 'ready.json')
const workspacePath = path.join(testRoot, 'desktop-workspace.json')
const storageRoot = path.join(testRoot, 'storage')
const desktopPath = path.join(testRoot, 'desktop')
const sessionPath = path.join(testRoot, 'guardian-session.json')
const guardianPath = path.join(process.cwd(), 'electron', 'restore-guardian.cjs')

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const waitFor = async (predicate, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await delay(50)
  }
  return false
}

const runParent = async () => {
  const widgetId = 'guardian-test-widget'
  const widgetStorage = path.join(storageRoot, widgetId)
  const sourcePath = path.join(widgetStorage, 'abrupt-exit.txt')
  const originalPath = path.join(desktopPath, 'abrupt-exit.txt')
  await fs.promises.mkdir(widgetStorage, { recursive: true })
  await fs.promises.mkdir(desktopPath, { recursive: true })
  await fs.promises.writeFile(sourcePath, 'restore guardian fixture', 'utf8')
  await fs.promises.writeFile(workspacePath, JSON.stringify({
    version: 1,
    widgets: [{
      id: widgetId,
      kind: 'organizer',
      data: {
        files: [{
          id: 'fixture',
          name: 'abrupt-exit.txt',
          path: sourcePath,
          originalPath,
          originalDesktopPosition: { x: 160, y: 240 },
          isDirectory: false,
        }],
      },
    }],
    settings: {},
  }, null, 2), 'utf8')
  await fs.promises.writeFile(sessionPath, JSON.stringify({
    version: 1,
    armed: true,
    parentPid: process.pid,
    workspacePath,
    storageRoot,
    desktopPath,
    iconHelperPath: '',
    logPath: path.join(testRoot, 'guardian.log'),
  }, null, 2), 'utf8')

  const guardian = spawn(process.execPath, [
    guardianPath,
    '--parent-pid',
    String(process.pid),
    '--session',
    sessionPath,
    '--skip-shell',
    '1',
  ], { detached: true, windowsHide: true, stdio: 'ignore' })
  guardian.unref()
  await fs.promises.writeFile(readyPath, JSON.stringify({
    parentPid: process.pid,
    guardianPid: guardian.pid,
    sourcePath,
    originalPath,
  }), 'utf8')
  setInterval(() => {}, 60_000)
}

const runTest = async () => {
  await fs.promises.rm(testRoot, { recursive: true, force: true })
  await fs.promises.mkdir(testRoot, { recursive: true })
  const parent = spawn(process.execPath, [__filename, '--parent'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  const becameReady = await waitFor(() => fs.existsSync(readyPath))
  if (!becameReady) throw new Error('guardian test parent did not become ready')
  const ready = JSON.parse(await fs.promises.readFile(readyPath, 'utf8'))
  process.kill(parent.pid)

  const restored = await waitFor(() => (
    fs.existsSync(ready.originalPath)
    && !fs.existsSync(ready.sourcePath)
    && !fs.existsSync(sessionPath)
  ))
  if (!restored) throw new Error('guardian did not restore the file after abrupt parent termination')
  const workspace = JSON.parse(await fs.promises.readFile(workspacePath, 'utf8'))
  const restoredFile = workspace.widgets?.[0]?.data?.files?.[0]
  if (
    restoredFile?.path !== ready.originalPath
    || restoredFile?.temporarilyRestoredOnExit !== true
    || fs.existsSync(sessionPath)
  ) {
    throw new Error(`guardian workspace state mismatch: ${JSON.stringify(restoredFile)}`)
  }
  console.log('[restore-guardian] abrupt parent termination assertion passed: file restored + restart membership preserved')
  await fs.promises.rm(testRoot, { recursive: true, force: true })
}

if (process.argv.includes('--parent')) {
  runParent().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  runTest().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
