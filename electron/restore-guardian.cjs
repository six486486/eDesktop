const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { restoreDesktopIconLayout } = require('./desktop-icon-layout-core.cjs')
const { storedDesktopShellVisibility } = require('./desktop-shell-visibility-core.cjs')

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (typeof key === 'string' && key.startsWith('--')) args.set(key.slice(2), value || '')
}

const parentPid = Number.parseInt(args.get('parent-pid') || '', 10)
const sessionPath = path.resolve(args.get('session') || '')
const skipShell = args.get('skip-shell') === '1'

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const desktopShellItemAliases = new Map([
  ['{20d04fe0-3aea-1069-a2d8-08002b30309d}', ['此电脑', 'This PC']],
  ['{645ff040-5081-101b-9f08-00aa002f954e}', ['回收站', 'Recycle Bin']],
  ['{f02c1a0d-be21-4350-88b0-7367fc96ef3c}', ['网络', 'Network']],
  ['{5399e694-6ce5-4d6c-8fce-1d8870fdcba0}', ['控制面板', 'Control Panel']],
  ['{59031a47-3f72-44a7-89c5-5595fe6b30ee}', [
    '用户的文件',
    "User's Files",
    process.env.USERNAME,
    path.basename(process.env.USERPROFILE || ''),
  ].filter(Boolean)],
])

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const writeLog = (logPath, message) => {
  if (!logPath) return
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {}
}

const pathIsInside = (parentPath, childPath) => {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const availableDestination = (directory, sourcePath, isDirectory) => {
  const originalName = path.basename(sourcePath)
  const parsed = isDirectory ? { name: originalName, ext: '' } : path.parse(originalName)
  let destinationPath = path.join(directory, originalName)
  let suffix = 2
  while (fs.existsSync(destinationPath)) {
    destinationPath = path.join(directory, `${parsed.name} (${suffix})${parsed.ext}`)
    suffix += 1
  }
  return destinationPath
}

const movePath = async (sourcePath, destinationPath) => {
  try {
    await fs.promises.rename(sourcePath, destinationPath)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await fs.promises.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: true })
    try {
      await fs.promises.rm(sourcePath, { recursive: true })
    } catch (removeError) {
      await fs.promises.rm(destinationPath, { recursive: true, force: true }).catch(() => {})
      throw removeError
    }
  }
}

const atomicWriteJson = async (filePath, value) => {
  const tempPath = `${filePath}.guardian-${process.pid}.tmp`
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8')
  await fs.promises.rename(tempPath, filePath)
}

class DesktopIconHelper {
  constructor(helperPath) {
    this.helperPath = helperPath
    this.child = null
    this.buffer = ''
    this.nextId = 0
    this.pending = new Map()
  }

  start() {
    if (skipShell || !this.helperPath || !fs.existsSync(this.helperPath)) return false
    const powershellPath = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    this.child = spawn(powershellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.helperPath,
      '-Mode',
      'server',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.consume(chunk))
    const close = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('desktop icon helper exited'))
      }
      this.pending.clear()
      this.child = null
    }
    this.child.once('error', close)
    this.child.once('exit', close)
    return true
  }

  consume(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() || ''
    for (const rawLine of lines) {
      const line = rawLine.replace(/^\uFEFF/, '').trim()
      if (!line) continue
      try {
        const response = JSON.parse(line)
        const pending = this.pending.get(response.id)
        if (!pending) continue
        this.pending.delete(response.id)
        clearTimeout(pending.timer)
        if (response.ok) pending.resolve(response.result)
        else pending.reject(new Error(response.error || 'desktop icon helper request failed'))
      } catch {}
    }
  }

  request(command, payload = {}, timeoutMs = 3000) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('desktop icon helper unavailable'))
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`desktop icon helper timeout (${command})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  stop() {
    try { this.child?.stdin?.end() } catch {}
  }
}

const desktopIconNamesForPath = (filePath, isDirectory) => {
  const basename = path.basename(filePath)
  return [...new Set([
    basename,
    ...(!isDirectory ? [path.parse(basename).name] : []),
  ].filter(Boolean).map((name) => name.toLocaleLowerCase()))]
}

const restoreIconPositions = async (helper, protectedPositions, restorations) => {
  try {
    return await restoreDesktopIconLayout({
      entries: [...protectedPositions, ...restorations],
      setPositions: (positions) => helper.request('set-many', { positions }, 2_500),
      listPositions: () => helper.request('list', {}, 2_500),
      delay,
    })
  } catch {
    return null
  }
}

const restoreAfterAbruptExit = async (session) => {
  const logPath = typeof session.logPath === 'string' ? session.logPath : ''
  const workspacePath = path.resolve(session.workspacePath || '')
  const storageRoot = path.resolve(session.storageRoot || '')
  const desktopPath = path.resolve(session.desktopPath || '')
  const helper = new DesktopIconHelper(path.resolve(session.iconHelperPath || ''))
  helper.start()
  let workspace
  try {
    workspace = JSON.parse(await fs.promises.readFile(workspacePath, 'utf8'))
  } catch (error) {
    helper.stop()
    writeLog(logPath, `workspace read failed: ${error.message}`)
    return
  }

  const protectedPositions = (await helper.request('list', {}, 3_000).catch(() => [])) || []
  const protectedEntries = protectedPositions.map((entry) => ({
    names: [String(entry?.Name || '').toLocaleLowerCase()],
    position: { x: Number(entry?.X), y: Number(entry?.Y) },
    required: true,
  }))
  const iconRestorations = []
  const shellMoves = []
  let restoredShellItems = 0
  const errors = []
  let restored = 0
  let changed = false

  for (const widget of Array.isArray(workspace.widgets) ? workspace.widgets : []) {
    if (widget?.kind !== 'organizer') continue
    const safeWidgetId = String(widget.id || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'default'
    const widgetStoragePath = path.join(storageRoot, safeWidgetId)
    const files = Array.isArray(widget.data?.files) ? widget.data.files : []
    const nextFiles = []
    for (const file of files) {
      if (typeof file?.shellClsid === 'string' && file.shellClsid) {
        const visibility = storedDesktopShellVisibility(file)
        const result = await helper.request('shell-item-visibility-set', {
          clsid: file.shellClsid,
          exists: visibility.newStartPanel.exists,
          value: visibility.newStartPanel.value,
          states: visibility,
        }, 2_000).catch((error) => ({ error }))
        if (result?.error) {
          errors.push(`${file.name || file.shellClsid}: ${result.error.message}`)
          nextFiles.push(file)
          continue
        }
        if (file.originalDesktopPosition) {
          const aliases = desktopShellItemAliases.get(file.shellClsid.toLocaleLowerCase()) || []
          iconRestorations.push({
            names: [...new Set([file.name, ...aliases].filter(Boolean).map((name) => name.toLocaleLowerCase()))],
            position: file.originalDesktopPosition,
            required: true,
          })
        }
        nextFiles.push({ ...file, temporarilyRestoredOnExit: true })
        restoredShellItems += 1
        restored += 1
        changed = true
        continue
      }

      const sourcePath = typeof file?.path === 'string' && file.path ? path.resolve(file.path) : ''
      if (!sourcePath || !fs.existsSync(sourcePath) || !pathIsInside(widgetStoragePath, sourcePath)) {
        nextFiles.push(file)
        continue
      }
      try {
        const stat = await fs.promises.lstat(sourcePath)
        const originalPath = typeof file.originalPath === 'string' && file.originalPath
          ? path.resolve(file.originalPath)
          : ''
        const originalParent = originalPath ? path.dirname(originalPath) : ''
        const canUseOriginal = originalPath
          && !pathIsInside(storageRoot, originalPath)
          && fs.existsSync(originalParent)
        let destinationPath
        if (canUseOriginal && !fs.existsSync(originalPath)) destinationPath = originalPath
        else if (canUseOriginal) destinationPath = availableDestination(originalParent, originalPath, stat.isDirectory())
        else {
          await fs.promises.mkdir(desktopPath, { recursive: true })
          destinationPath = availableDestination(desktopPath, sourcePath, stat.isDirectory())
        }
        try {
          await movePath(sourcePath, destinationPath)
        } catch (preferredError) {
          // Public Desktop may reject a non-elevated rename even though the item was
          // previously readable there. Match the main process recovery policy and
          // fall back to the current user's desktop instead of leaving the shortcut
          // stranded in organizer storage after an abrupt exit.
          const fallbackDirectory = path.resolve(desktopPath)
          if (path.dirname(path.resolve(destinationPath)).toLocaleLowerCase() === fallbackDirectory.toLocaleLowerCase()) {
            throw preferredError
          }
          await fs.promises.mkdir(fallbackDirectory, { recursive: true })
          destinationPath = availableDestination(fallbackDirectory, sourcePath, stat.isDirectory())
          try {
            await movePath(sourcePath, destinationPath)
          } catch (fallbackError) {
            throw new Error(`${preferredError.message}; fallback restore failed: ${fallbackError.message}`)
          }
        }
        shellMoves.push({ sourcePath, destinationPath, isDirectory: stat.isDirectory() })
        if (file.originalDesktopPosition && pathIsInside(desktopPath, destinationPath)) {
          iconRestorations.push({
            names: desktopIconNamesForPath(destinationPath, stat.isDirectory()),
            position: file.originalDesktopPosition,
            required: true,
          })
        }
        nextFiles.push({
          ...file,
          path: destinationPath,
          temporarilyRestoredOnExit: true,
        })
        restored += 1
        changed = true
      } catch (error) {
        errors.push(`${file.name || path.basename(sourcePath)}: ${error.message}`)
        nextFiles.push(file)
      }
    }
    widget.data = { ...(widget.data || {}), files: nextFiles }
  }

  if (shellMoves.length) {
    await helper.request('notify-moves-flush', { moves: shellMoves }, 5_000).catch(() => null)
  }
  // A crash can leave Explorer's existing Desktop FolderView enumerated with
  // the old system-icon state even after the registry is restored. Rebuild the
  // shell once before replaying coordinates so the visible view and saved state
  // cannot diverge.
  if (restoredShellItems) {
    await helper.request('desktop-shell-restart', {}, 12_000).catch((error) => {
      errors.push(`Windows desktop refresh: ${error.message}`)
    })
  }
  if (changed) await atomicWriteJson(workspacePath, workspace)
  await restoreIconPositions(helper, protectedEntries, iconRestorations)
  helper.stop()
  writeLog(logPath, `abrupt-exit restore completed: restored=${restored} errors=${errors.length}`)
  for (const error of errors) writeLog(logPath, `restore warning: ${error}`)
}

const main = async () => {
  if (!Number.isInteger(parentPid) || parentPid <= 0 || !sessionPath) return
  while (processIsAlive(parentPid)) await delay(200)
  let session
  try {
    session = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8'))
  } catch {
    return
  }
  if (Number(session.parentPid) !== parentPid || session.armed !== true) return
  await restoreAfterAbruptExit(session)
  await fs.promises.rm(sessionPath, { force: true }).catch(() => {})
}

main().catch((error) => {
  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
    writeLog(session.logPath, `guardian failed: ${error.stack || error.message}`)
  } catch {}
  process.exitCode = 1
})
