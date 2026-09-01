const { app, BaseWindow, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } = require('electron')
const { execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')
const { resolveWindowsLoginLauncherPath } = require('./login-item-path.cjs')
const { installSafeConsole } = require('./safe-console.cjs')
const {
  findDesktopIconPositionByNames,
  restoreDesktopIconLayout,
} = require('./desktop-icon-layout-core.cjs')
const {
  remapWorkspaceLayout,
  snapshotSchemaVersion,
  validateSnapshotDocument,
} = require('./workspace-snapshot-core.cjs')

// A packaged GUI app can outlive the terminal or redirected pipe that started
// it. Logging to that closed pipe throws EPIPE synchronously on Windows unless
// console writes and stream error events are guarded before any startup work.
installSafeConsole()

const execFileAsync = promisify(execFile)
const capturePath = process.env.EDESKTOP_CAPTURE_PATH
const captureSurface = process.env.EDESKTOP_CAPTURE_SURFACE === 'desktop' ? 'desktop' : 'control'
let captureFixtureRoot = null
const desktopHostTest = process.env.EDESKTOP_HOST_TEST === '1'
const desktopHostTestDemo = process.env.EDESKTOP_HOST_TEST_DEMO === '1'
const desktopHostRegressionTest = process.env.EDESKTOP_HOST_TEST_REGRESSION === '1'
const desktopDragTest = process.env.EDESKTOP_DRAG_TEST === '1'
const desktopWidgetWindowTest = process.env.EDESKTOP_WIDGET_WINDOW_TEST === '1'
const desktopWidgetWindowManualTest = process.env.EDESKTOP_WIDGET_WINDOW_MANUAL_TEST === '1'
const desktopOrganizerPromotionTest = process.env.EDESKTOP_ORGANIZER_PROMOTION_TEST === '1'
const desktopTrayTest = process.env.EDESKTOP_TRAY_TEST === '1'
const iconTest = process.env.EDESKTOP_ICON_TEST === '1'
const safeConsolePipeTest = process.env.EDESKTOP_SAFE_CONSOLE_TEST === '1'
const workspaceSnapshotTest = process.env.EDESKTOP_SNAPSHOT_TEST === '1'
const desktopHostSelfCapturePath = process.env.EDESKTOP_HOST_SELF_CAPTURE_PATH
const squirrelCommand = process.platform === 'win32' ? process.argv[1] : ''

// Organizer widgets live as real children of Explorer's desktop host. Chromium's
// Windows occlusion tracker can still mistake those visible child windows for
// fully covered and hide their Chrome_RenderWidgetHostHWND, leaving the outer
// BrowserWindow visible but unable to receive pointer input.
// backgroundThrottling=false does not disable that separate native path.
if (process.platform === 'win32') {
  const disabledFeatures = new Set(
    app.commandLine.getSwitchValue('disable-features')
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean),
  )
  disabledFeatures.add('CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-features', [...disabledFeatures].join(','))
}

if (squirrelCommand === '--squirrel-uninstall') {
  try {
    const executableName = path.basename(process.execPath)
    const launcherPath = path.resolve(path.dirname(process.execPath), '..', executableName)
    app.setLoginItemSettings({ openAtLogin: false, path: launcherPath, args: [] })
  } catch {}
}

const handleSquirrelStartup = () => {
  if (process.platform !== 'win32') return false
  const actions = {
    '--squirrel-install': `--createShortcut=${path.basename(process.execPath)}`,
    '--squirrel-updated': `--createShortcut=${path.basename(process.execPath)}`,
    '--squirrel-uninstall': `--removeShortcut=${path.basename(process.execPath)}`,
  }
  if (squirrelCommand === '--squirrel-obsolete') {
    app.quit()
    return true
  }
  const action = actions[squirrelCommand]
  if (!action) return false
  const updateExecutable = path.resolve(path.dirname(process.execPath), '..', 'Update.exe')
  const updater = spawn(updateExecutable, [action], { detached: true, windowsHide: true })
  const quit = () => app.quit()
  updater.once('error', quit)
  updater.once('close', quit)
  return true
}

const squirrelStartup = handleSquirrelStartup()
const enforceSingleInstance = !squirrelStartup
  && !capturePath
  && !desktopHostTest
  && !desktopTrayTest
  && !iconTest
  && !safeConsolePipeTest
  && !workspaceSnapshotTest
const hasPrimaryInstance = !enforceSingleInstance || app.requestSingleInstanceLock()
if (squirrelStartup || !hasPrimaryInstance) app.quit()

if (process.env.EDESKTOP_USER_DATA_PATH) {
  app.setPath('userData', path.resolve(process.env.EDESKTOP_USER_DATA_PATH))
} else if (desktopTrayTest || iconTest) {
  app.setPath('userData', path.join(process.cwd(), '.artifacts', 'tray-test-user-data'))
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'eDesktop'))
}

let controlWindow = null
let tray = null
let controlClosePromptVisible = false
let fullQuitRequested = false
let desktopWindow = null
const desktopOrganizerHostWindows = new Map()
const desktopWindows = new Map()
const desktopWidgetWindows = new Map()
// Organizer DPI hand-offs are double buffered. Replacement windows live here
// while their target-DPI Chromium surface is being prepared, but they do not
// become the workspace window until that surface is complete.
const desktopOrganizerTransitionWindows = new Set()
const fileIconCache = new Map()
let workspacePath = ''
let workspaceState = null
let desktopHostState = 'disabled'
let desktopStatusMessage = '桌面组件尚未启用'
let displayRefreshTimer = null
let desktopTopologySignature = ''
let desktopPointerHitTestTimer = null
let desktopOrganizerBandHealthTimer = null
let desktopOrganizerBandHealthInFlight = false
let desktopOrganizerBandOrder = []
const desktopOrganizerDeferredPromotions = new Set()
let desktopWidgetGeometryHealthTimer = null
let desktopWidgetGeometryHealthInFlight = false
let desktopWidgetGeometryHealthLastAt = 0
const desktopWidgetGeometryMismatchCounts = new Map()
const desktopWidgetGeometryRecoveryTokens = new Map()
let desktopIconHelperProcess = null
let desktopIconHelperRequestId = 0
let desktopIconPositionRefresh = null
let desktopIconPositionCacheUpdatedAt = 0
const desktopIconHelperPending = new Map()
const desktopIconPositionCache = new Map()
let restoreOnQuitPromise = null
let quitAfterRestore = false
let restoreGuardianProcess = null
let restoreGuardianSessionPath = ''
let organizerStorageReconcileRetryTimer = null
let snapshotMutationTail = Promise.resolve()
let snapshotRestoreInProgress = false
let workspaceMutationTail = Promise.resolve()
let fileOpenRequestSequence = 0
let activeOrganizerFileSelection = null
let organizerFileSelectionRevision = 0
let activeOrganizerContextMenu = null
let organizerContextMenuSequence = 0

const useDesktopWidgetWindows = !capturePath && (
  !desktopHostTest
  || desktopWidgetWindowTest
  || desktopWidgetWindowManualTest
  || desktopOrganizerPromotionTest
)
// Keep the native window exactly the same size as its widget. Extra transparent
// margins intercept desktop input and prevent a widget from reaching screen edges.
const desktopWidgetWindowMargin = 0
// Chromium draws the visible edge with antialiased pixels. Keep the binary
// native region slightly outside that edge so setShape() never cuts those
// partially transparent pixels into a stair-step outline.
const desktopOrganizerVisualRadius = 10
const desktopOrganizerNativeShapeInset = 2
const desktopOrganizerNativeShapeRadius = Math.max(
  0,
  desktopOrganizerVisualRadius - desktopOrganizerNativeShapeInset,
)
const liveDisplayDesktopWindows = () => [...desktopWindows.values()].filter((win) => !win.isDestroyed())
const liveDesktopWidgetWindows = () => [...desktopWidgetWindows.values()].filter((win) => !win.isDestroyed())
const liveDesktopOrganizerHostWindows = () => [...desktopOrganizerHostWindows.values()]
  .filter((win) => !win.isDestroyed())
const liveDesktopWindows = () => [...liveDisplayDesktopWindows(), ...liveDesktopWidgetWindows()]
const liveAppWindows = () => [controlWindow, ...liveDesktopWindows()].filter((win) => win && !win.isDestroyed())
const isDesktopWindow = (win) => liveDesktopWindows().includes(win)

const clearOrganizerFileSelections = (exceptWebContentsId = null) => {
  for (const win of liveDesktopWidgetWindows()) {
    if (!isOrganizerWidgetWindow(win) || win.webContents.id === exceptWebContentsId) continue
    win.webContents.send('organizer:file-selection-cleared')
  }
}

const pointerButtonsDown = (pointer) => Boolean(
  pointer?.LeftDown || pointer?.RightDown || pointer?.MiddleDown
)

const closeActiveOrganizerContextMenu = (expectedToken = null) => {
  const activeMenu = activeOrganizerContextMenu
  if (!activeMenu || (expectedToken && activeMenu.token !== expectedToken)) return false
  activeOrganizerContextMenu = null
  if (desktopWidgetWindowTest) desktopWidgetTestContextMenuCloses.push(activeMenu.token)
  try {
    activeMenu.menu.closePopup(activeMenu.window && !activeMenu.window.isDestroyed()
      ? activeMenu.window
      : undefined)
  } catch (error) {
    console.warn(`[organizer] unable to close context menu: ${error.message}`)
  }
  return true
}

const scheduleOrganizerContextMenuClose = (activeMenu, delayMs = 160) => {
  if (!activeMenu) return
  setTimeout(() => closeActiveOrganizerContextMenu(activeMenu.token), delayMs)
}

const watchNextGlobalPointerDown = async (revision) => {
  if (process.platform !== 'win32') return
  // The selecting press is still down when this starts. Arm only after all
  // buttons are released, then the next press anywhere on Windows clears it.
  let armed = false
  while (activeOrganizerFileSelection && organizerFileSelectionRevision === revision) {
    const pointer = await desktopIconHelperRequest('button-state', {}, 1_200).catch(() => null)
    if (!activeOrganizerFileSelection || organizerFileSelectionRevision !== revision) return
    if (!pointer) {
      await new Promise((resolve) => setTimeout(resolve, 80))
      continue
    }
    const pressed = pointerButtonsDown(pointer)
    if (!armed) {
      armed = !pressed
    } else if (pressed) {
      const contextMenuAtPress = activeOrganizerContextMenu
      // A native menu command closes itself on mouse-up. Delay the fallback so
      // command clicks still execute; if Windows leaves the no-activate menu
      // open after an outside click, closePopup then dismisses it explicitly.
      scheduleOrganizerContextMenuClose(contextMenuAtPress)
      // Renderer pointer events normally arrive first for an eDesktop window.
      // Give them one turn to preserve/reselect the clicked item before treating
      // this as a click outside the app.
      await new Promise((resolve) => setTimeout(resolve, 40))
      if (activeOrganizerFileSelection && organizerFileSelectionRevision === revision) {
        activeOrganizerFileSelection = null
        organizerFileSelectionRevision += 1
        clearOrganizerFileSelections()
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 24))
  }
}

const selectOrganizerFile = (event, widgetId, filePath) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (
    !win
    || !isOrganizerWidgetWindow(win)
    || win.desktopWidgetId !== widgetId
    || typeof filePath !== 'string'
    || !filePath
  ) return
  activeOrganizerFileSelection = { webContentsId: event.sender.id, widgetId, filePath }
  organizerFileSelectionRevision += 1
  clearOrganizerFileSelections(event.sender.id)
  void watchNextGlobalPointerDown(organizerFileSelectionRevision)
}

const clearOrganizerFileSelection = (event, widgetId) => {
  if (
    !activeOrganizerFileSelection
    || activeOrganizerFileSelection.webContentsId !== event.sender.id
    || activeOrganizerFileSelection.widgetId !== widgetId
  ) return
  activeOrganizerFileSelection = null
  organizerFileSelectionRevision += 1
}

const defaultWorkspace = () => ({
  version: 1,
  widgets: [],
  desktopLayout: null,
  settings: {
    desktopEnabled: true,
    launchAtLogin: false,
    snapshotAutoEnabled: true,
    snapshotRetention: 30,
  },
})

const describePath = async (entryPath) => {
  try {
    const stat = await fs.promises.stat(entryPath)
    const parsed = path.parse(entryPath)
    return {
      id: Buffer.from(entryPath.toLowerCase()).toString('base64url'),
      path: entryPath,
      name: parsed.base,
      extension: stat.isDirectory() ? 'folder' : parsed.ext.slice(1).toLowerCase() || 'file',
      size: stat.isDirectory() ? 0 : stat.size,
      isDirectory: stat.isDirectory(),
      modifiedAt: stat.mtime.toISOString(),
    }
  } catch {
    return null
  }
}

const imageThumbnailExtensions = new Set(['.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.webp'])
const windowsShellLinkExtensions = new Set(['.lnk', '.url'])
const desktopShellItemDefinitions = [
  {
    clsid: '{20D04FE0-3AEA-1069-A2D8-08002B30309D}',
    aliases: ['此电脑', 'This PC'],
    iconResourcePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'imageres.dll'),
    iconResourceIndex: -109,
  },
  {
    clsid: '{645FF040-5081-101B-9F08-00AA002F954E}',
    aliases: ['回收站', 'Recycle Bin'],
    iconResourcePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'imageres.dll'),
    iconResourceIndex: -55,
  },
  {
    clsid: '{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}',
    aliases: ['网络', 'Network'],
    iconResourcePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'imageres.dll'),
    iconResourceIndex: -25,
  },
  {
    clsid: '{5399E694-6CE5-4D6C-8FCE-1D8870FDCBA0}',
    aliases: ['控制面板', 'Control Panel'],
    iconResourcePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'imageres.dll'),
    iconResourceIndex: -27,
  },
  {
    clsid: '{59031A47-3F72-44A7-89C5-5595FE6B30EE}',
    aliases: [...new Set([
      '用户的文件',
      "User's Files",
      process.env.USERNAME,
      path.basename(app.getPath('home')),
    ].filter(Boolean))],
    iconResourcePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'imageres.dll'),
    iconResourceIndex: -123,
  },
]
let preparedOrganizerShellItems = []
let preparedOrganizerShellItemsAt = 0
const handledOrganizerFileDrops = new Map()
const desktopWidgetTestOpenedPaths = []
const desktopWidgetTestContextMenus = []
const desktopWidgetTestContextMenuCloses = []

const desktopShellItemPath = (clsid) => `shell:::${clsid}`
const desktopShellItemDefinitionForName = (name) => desktopShellItemDefinitions.find((definition) => (
  definition.aliases.some((alias) => alias.toLocaleLowerCase() === String(name || '').toLocaleLowerCase())
))
const desktopShellItemDefinitionForClsid = (clsid) => desktopShellItemDefinitions.find((definition) => (
  definition.clsid.toLocaleLowerCase() === String(clsid || '').toLocaleLowerCase()
))
const isOrganizerShellItem = (file) => Boolean(
  file
  && typeof file.shellClsid === 'string'
  && desktopShellItemDefinitionForClsid(file.shellClsid),
)
const organizerFileKey = (filePath, file = null) => {
  if (isOrganizerShellItem(file) || String(filePath || '').toLocaleLowerCase().startsWith('shell:::')) {
    return String(filePath || '').toLocaleLowerCase()
  }
  return path.resolve(filePath).toLocaleLowerCase()
}

const desktopHostFileTestRoot = path.join(process.cwd(), '.artifacts', 'desktop-host-file-test')

const currentOrganizerStorageRoot = () => path.join(app.getPath('documents'), 'eDesktop', '收纳文件')

const organizerStorageRoot = () => (
  desktopHostTest ? path.join(desktopHostFileTestRoot, 'storage') : currentOrganizerStorageRoot()
)

const organizerReleaseRoot = () => (
  desktopHostTest ? path.join(desktopHostFileTestRoot, 'released') : app.getPath('desktop')
)

const organizerStoragePath = (widgetId) => {
  const safeId = String(widgetId || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'default'
  return path.join(organizerStorageRoot(), safeId)
}

const pathIsInside = (parentPath, childPath) => {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const desktopDirectories = () => {
  const directories = [path.resolve(app.getPath('desktop'))]
  if (process.platform === 'win32' && process.env.PUBLIC) {
    directories.push(path.resolve(process.env.PUBLIC, 'Desktop'))
  }
  return [...new Set(directories.map((directory) => directory.toLocaleLowerCase()))]
}

const pathIsDesktopItem = (entryPath) => {
  const normalizedPath = path.resolve(entryPath)
  return desktopDirectories().some((directory) => (
    normalizedPath.toLocaleLowerCase() !== directory
    && pathIsInside(directory, normalizedPath)
  ))
}

const windowsPowerShellPath = () => path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

const runtimeElectronResourcePath = (name) => {
  if (!app.isPackaged) return path.join(__dirname, name)
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', name)
}

const windowsLoginLauncherPath = () => resolveWindowsLoginLauncherPath({
  platform: process.platform,
  isPackaged: app.isPackaged,
  execPath: process.execPath,
})

const applyLoginItemSettings = (openAtLogin) => {
  const settings = { openAtLogin: Boolean(openAtLogin) }
  if (process.platform === 'win32' && app.isPackaged) {
    settings.path = windowsLoginLauncherPath()
    settings.args = []
  }
  app.setLoginItemSettings(settings)
}

const startRestoreGuardian = () => {
  if (process.platform !== 'win32' || capturePath || desktopHostTest || restoreGuardianProcess) return
  const guardianPath = runtimeElectronResourcePath('restore-guardian.cjs')
  if (!fs.existsSync(guardianPath) || !workspacePath) return
  restoreGuardianSessionPath = path.join(
    app.getPath('userData'),
    `desktop-restore-guardian-${process.pid}.json`,
  )
  const session = {
    version: 1,
    armed: true,
    parentPid: process.pid,
    workspacePath,
    storageRoot: organizerStorageRoot(),
    desktopPath: organizerReleaseRoot(),
    iconHelperPath: runtimeElectronResourcePath('windows-desktop-icons.ps1'),
    logPath: path.join(app.getPath('userData'), 'desktop-restore-guardian.log'),
  }
  fs.mkdirSync(path.dirname(restoreGuardianSessionPath), { recursive: true })
  fs.writeFileSync(restoreGuardianSessionPath, JSON.stringify(session, null, 2), 'utf8')
  try {
    restoreGuardianProcess = spawn(process.execPath, [
      guardianPath,
      '--parent-pid',
      String(process.pid),
      '--session',
      restoreGuardianSessionPath,
    ], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    restoreGuardianProcess.unref()
    restoreGuardianProcess.once('error', (error) => {
      console.warn(`[organizer] restore guardian failed to start: ${error.message}`)
      restoreGuardianProcess = null
    })
  } catch (error) {
    console.warn(`[organizer] restore guardian failed to start: ${error.message}`)
    restoreGuardianProcess = null
  }
}

const disarmRestoreGuardian = () => {
  if (!restoreGuardianSessionPath) return
  try {
    fs.rmSync(restoreGuardianSessionPath, { force: true })
  } catch (error) {
    console.warn(`[organizer] restore guardian could not be disarmed: ${error.message}`)
    return
  }
  restoreGuardianSessionPath = ''
  restoreGuardianProcess = null
}

const rejectDesktopIconHelperPending = (child, error) => {
  for (const [id, pending] of desktopIconHelperPending.entries()) {
    if (child && pending.child !== child) continue
    desktopIconHelperPending.delete(id)
    clearTimeout(pending.timer)
    pending.reject(error)
  }
}

const retireDesktopIconHelper = (child, error, terminate = false) => {
  if (!child) return
  if (desktopIconHelperProcess === child) desktopIconHelperProcess = null
  rejectDesktopIconHelperPending(child, error)
  if (!terminate) return
  try { child.stdin.destroy() } catch {}
  try { child.kill() } catch {}
}

const stopDesktopIconHelper = () => {
  const child = desktopIconHelperProcess
  if (child) retireDesktopIconHelper(child, new Error('桌面图标辅助程序已停止'), true)
  rejectDesktopIconHelperPending(null, new Error('桌面图标辅助程序已停止'))
}

const startDesktopIconHelper = () => {
  if (
    process.platform !== 'win32'
    || capturePath
    || (desktopHostTest && !desktopDragTest && !desktopWidgetWindowTest && !desktopOrganizerPromotionTest)
  ) return null
  if (desktopIconHelperProcess && !desktopIconHelperProcess.killed) return desktopIconHelperProcess
  const helperPath = runtimeElectronResourcePath('windows-desktop-icons.ps1')
  const child = spawn(windowsPowerShellPath(), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-Mode',
    'server',
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let responseBuffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    responseBuffer += chunk
    const lines = responseBuffer.split(/\r?\n/)
    responseBuffer = lines.pop() || ''
    for (const rawLine of lines) {
      const line = rawLine.replace(/^\uFEFF/, '').trim()
      if (!line) continue
      try {
        const response = JSON.parse(line)
        const pending = desktopIconHelperPending.get(response.id)
        if (!pending || pending.child !== child) continue
        desktopIconHelperPending.delete(response.id)
        clearTimeout(pending.timer)
        if (response.ok) pending.resolve(response.result)
        else pending.reject(new Error(response.error || '桌面图标操作失败'))
      } catch (error) {
        console.warn(`[desktop-icons] invalid helper response: ${error.message}`)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => console.warn(`[desktop-icons] ${chunk.trim()}`))
  const close = (error) => {
    retireDesktopIconHelper(
      child,
      error instanceof Error ? error : new Error('桌面图标辅助程序已退出'),
    )
  }
  child.once('error', close)
  child.once('exit', () => close(new Error('桌面图标辅助程序已退出')))
  desktopIconHelperProcess = child
  return child
}

const desktopIconHelperRequest = (command, payload = {}, timeoutMs = 3000) => new Promise((resolve, reject) => {
  const child = startDesktopIconHelper()
  if (!child?.stdin.writable) {
    reject(new Error('桌面图标辅助程序不可用'))
    return
  }
  const id = ++desktopIconHelperRequestId
  const timer = setTimeout(() => {
    retireDesktopIconHelper(child, new Error(`桌面图标操作超时（${command}）`), true)
  }, timeoutMs)
  desktopIconHelperPending.set(id, { resolve, reject, timer, child, command })
  child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`, (error) => {
    if (error) retireDesktopIconHelper(child, error, true)
  })
})

const loadWindowsShellIconData = async (filePath) => {
  if (process.platform !== 'win32' || typeof filePath !== 'string' || !filePath) return ''
  return desktopIconHelperRequest('icon-data', { path: filePath }, 1_500).catch(() => '')
}

const loadDesktopShellItemIconData = async (definition) => {
  if (process.platform !== 'win32' || !definition) return ''
  const namespaceIcon = await desktopIconHelperRequest('shell-namespace-icon-data', {
    clsid: definition.clsid,
  }, 1_500).catch(() => '')
  if (namespaceIcon) return namespaceIcon
  return desktopIconHelperRequest('resource-icon-data', {
    path: definition.iconResourcePath,
    index: definition.iconResourceIndex,
  }, 1_500).catch(() => '')
}

const desktopShellItemVisibility = async (clsid) => (
  desktopIconHelperRequest('shell-item-visibility-get', { clsid }, 1_500)
)

const writeDesktopShellItemVisibility = async (clsid, visibility) => (
  desktopIconHelperRequest('shell-item-visibility-set', {
    clsid,
    exists: Boolean(visibility?.exists),
    value: Number.isFinite(visibility?.value) ? Math.trunc(visibility.value) : 0,
  }, 2_000)
)

const setDesktopShellItemVisibility = async (clsid, visibility) => {
  const expected = {
    exists: Boolean(visibility?.exists),
    value: Number.isFinite(visibility?.value) ? Math.trunc(visibility.value) : 0,
  }
  let lastError = null
  for (const delayMs of [0, 80, 240]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
      await writeDesktopShellItemVisibility(clsid, expected)
    } catch (error) {
      lastError = error
    }
    try {
      const current = await desktopShellItemVisibility(clsid)
      const matches = Boolean(current?.exists) === expected.exists
        && (!expected.exists || Number(current?.value) === expected.value)
      if (matches) return true
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('系统桌面项可见性更新未生效')
}

const captureSelectedDesktopShellItems = async () => {
  const selected = await desktopIconHelperRequest('selected', {}, 1_500).catch(() => [])
  const captured = []
  const seen = new Set()
  for (const item of Array.isArray(selected) ? selected : []) {
    const definition = desktopShellItemDefinitionForName(item?.Name)
    if (!definition || seen.has(definition.clsid)) continue
    seen.add(definition.clsid)
    captured.push({
      clsid: definition.clsid,
      name: item.Name,
      position: Number.isFinite(item.X) && Number.isFinite(item.Y) ? { x: item.X, y: item.Y } : null,
    })
  }
  return captured
}

const parseHelperJson = (value) => JSON.parse(String(value || '').replace(/^\uFEFF/, '').trim())

const readWindowsShortcut = async (shortcutPath) => {
  if (process.platform !== 'win32' || path.extname(shortcutPath).toLocaleLowerCase() !== '.lnk') return null
  try {
    return await desktopIconHelperRequest('shortcut-info', { path: shortcutPath }, 1_200)
  } catch {
    const helperPath = runtimeElectronResourcePath('windows-desktop-icons.ps1')
    try {
      const { stdout } = await execFileAsync(windowsPowerShellPath(), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helperPath,
        '-Mode',
        'shortcut',
        '-Name',
        shortcutPath,
      ], { windowsHide: true, encoding: 'utf8', timeout: 5_000 })
      return parseHelperJson(stdout)
    } catch {
      return null
    }
  }
}

const expandWindowsEnvironmentPath = (value) => String(value || '').replace(/%([^%]+)%/g, (match, name) => {
  const key = Object.keys(process.env).find((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase())
  return key ? process.env[key] : match
})

const shortcutResourcePath = (rawValue, shortcutPath, workingDirectory = '') => {
  const withoutResourceIndex = String(rawValue || '').replace(/,\s*-?\d+\s*$/, '').trim()
  const expanded = expandWindowsEnvironmentPath(withoutResourceIndex).replace(/^"|"$/g, '').trim()
  if (!expanded) return ''
  if (path.isAbsolute(expanded)) return fs.existsSync(expanded) ? expanded : ''
  const bases = [workingDirectory, path.dirname(shortcutPath)].filter(Boolean)
  for (const base of bases) {
    const candidate = path.resolve(base, expanded)
    if (fs.existsSync(candidate)) return candidate
  }
  return ''
}

const activateWindowsApplication = async ({
  executablePath = '',
  processId = 0,
  windowHandle = 0,
  timeoutMs = 6000,
} = {}) => {
  if (process.platform !== 'win32' || (!executablePath && !processId && !windowHandle)) return ''
  const helperPath = runtimeElectronResourcePath('windows-activate-app.ps1')
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-TimeoutMs',
    String(timeoutMs),
  ]
  if (executablePath) args.push('-ExecutablePath', executablePath)
  if (processId) args.push('-ProcessId', String(processId))
  if (windowHandle) args.push('-WindowHandle', String(windowHandle))
  try {
    const { stdout } = await execFileAsync(windowsPowerShellPath(), args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: Math.max(2_000, timeoutMs + 2_000),
    })
    return stdout.trim()
  } catch (error) {
    const output = String(error?.stdout || '').trim()
    if (output) return output
    throw error
  }
}

const activateWindowsShortcutTarget = async (shortcutPath) => {
  if (process.platform !== 'win32' || path.extname(shortcutPath).toLocaleLowerCase() !== '.lnk') return ''
  const shortcut = await readWindowsShortcut(shortcutPath)
  const targetPath = shortcutResourcePath(
    shortcut?.targetPath,
    shortcutPath,
    shortcut?.workingDirectory,
  )
  if (!targetPath || !fs.existsSync(targetPath)) return ''
  return activateWindowsApplication({ executablePath: targetPath })
}

const resolveShortcutVisualPath = async (shortcutPath) => {
  const shortcut = await readWindowsShortcut(shortcutPath)
  if (!shortcut) return ''
  const candidates = [shortcut.iconLocation, shortcut.targetPath]
  for (const candidate of candidates) {
    const resolved = shortcutResourcePath(candidate, shortcutPath, shortcut.workingDirectory)
    if (resolved) return resolved
  }
  return ''
}

const loadDirectFileVisual = async (filePath) => {
  const normalizedPath = path.resolve(filePath).toLocaleLowerCase()
  const cached = fileIconCache.get(normalizedPath)
  if (cached && !cached.isEmpty()) return cached

  let visual = null
  if (imageThumbnailExtensions.has(path.extname(filePath).toLocaleLowerCase())) {
    try {
      const thumbnail = await nativeImage.createThumbnailFromPath(filePath, { width: 64, height: 64 })
      if (!thumbnail.isEmpty()) visual = thumbnail
    } catch {}
  }
  if (!visual) visual = await app.getFileIcon(filePath, { size: 'large' })
  if (visual && !visual.isEmpty()) fileIconCache.set(normalizedPath, visual)
  return visual
}

const loadFileVisual = async (filePath) => {
  const normalizedPath = path.resolve(filePath).toLocaleLowerCase()
  const cached = fileIconCache.get(normalizedPath)
  if (cached && !cached.isEmpty()) return cached

  let visual = null
  if (path.extname(filePath).toLocaleLowerCase() === '.lnk') {
    const visualPath = await resolveShortcutVisualPath(filePath)
    if (visualPath && path.resolve(visualPath).toLocaleLowerCase() !== normalizedPath) {
      visual = await loadDirectFileVisual(visualPath).catch(() => null)
    }
  }
  if (!visual || visual.isEmpty()) visual = await loadDirectFileVisual(filePath)
  if (visual && !visual.isEmpty()) fileIconCache.set(normalizedPath, visual)
  return visual
}

const refreshDesktopIconPositions = (force = false) => {
  if (desktopIconPositionRefresh) return desktopIconPositionRefresh
  if (!force && desktopIconPositionCache.size && Date.now() - desktopIconPositionCacheUpdatedAt < 2_000) {
    return Promise.resolve(desktopIconPositionCache)
  }
  desktopIconPositionRefresh = desktopIconHelperRequest('list')
    .then((items) => {
      desktopIconPositionCache.clear()
      for (const item of Array.isArray(items) ? items : []) {
        if (typeof item?.Name === 'string') {
          desktopIconPositionCache.set(item.Name.toLocaleLowerCase(), { x: item.X, y: item.Y })
        }
      }
      desktopIconPositionCacheUpdatedAt = Date.now()
      return desktopIconPositionCache
    })
    .finally(() => {
      desktopIconPositionRefresh = null
    })
  return desktopIconPositionRefresh
}

const desktopIconPositionForPath = (filePath, isDirectory) => {
  const basename = path.basename(filePath)
  const candidates = [basename]
  if (!isDirectory) candidates.push(path.parse(basename).name)
  for (const label of candidates) {
    const position = desktopIconPositionCache.get(label.toLocaleLowerCase())
    if (position) return { ...position }
  }
  return null
}

const desktopIconPositionForShellItem = (file, definition) => findDesktopIconPositionByNames(
  desktopIconPositionCache,
  [file?.name, ...(definition?.aliases || [])],
)

const desktopIconNamesForPath = (filePath, isDirectory) => {
  const basename = path.basename(filePath)
  return [...new Set([
    basename,
    ...(!isDirectory ? [path.parse(basename).name] : []),
  ].filter(Boolean).map((name) => name.toLocaleLowerCase()))]
}

const desktopIconPositionSnapshot = async () => {
  await refreshDesktopIconPositions(true)
  return [...desktopIconPositionCache.entries()].map(([name, position]) => ({
    names: [name],
    position: { ...position },
    required: true,
  }))
}

const waitForDesktopPointerRelease = async (timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pointer = await desktopIconHelperRequest('pointer-state', {}, 1_200).catch(() => null)
    if (
      pointer
      && Number.isFinite(pointer.X)
      && Number.isFinite(pointer.Y)
      && pointer.LeftDown === false
    ) {
      return { x: pointer.X, y: pointer.Y }
    }
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
  throw new Error('等待鼠标松开超时')
}

const restoreDesktopIconPositions = async (entries) => {
  let status
  try {
    status = await restoreDesktopIconLayout({
      entries,
      setPositions: (positions) => desktopIconHelperRequest('set-many', { positions }, 2_500),
      listPositions: () => desktopIconHelperRequest('list', {}, 2_500),
      delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    })
  } catch (error) {
    console.warn(`[desktop-icons] layout restore interrupted: ${error.message}`)
    return 0
  }
  desktopIconPositionCacheUpdatedAt = 0
  if (status.missingRequired.length) {
    console.warn(`[desktop-icons] ${status.missingRequired.length} icon(s) did not settle at the saved position`)
  }
  return status.matched
}

const restoreDesktopIconPosition = async (filePath, position, isDirectory) => {
  const positioned = await restoreDesktopIconPositions([{
    names: desktopIconNamesForPath(filePath, isDirectory),
    position,
    required: true,
  }])
  return positioned > 0
}

const availableDestination = (directory, sourcePath, isDirectory) => {
  const originalName = path.basename(sourcePath)
  const parsed = isDirectory ? { name: originalName, ext: '' } : path.parse(originalName)
  let destination = path.join(directory, originalName)
  let suffix = 2
  while (fs.existsSync(destination)) {
    destination = path.join(directory, `${parsed.name} (${suffix})${parsed.ext}`)
    suffix += 1
  }
  return destination
}

const notifyShellMove = async (sourcePath, destinationPath, isDirectory) => {
  if (process.platform !== 'win32' || capturePath || (desktopHostTest && !desktopDragTest)) return
  if (!pathIsDesktopItem(sourcePath) && !pathIsDesktopItem(destinationPath)) return
  await desktopIconHelperRequest('notify-move', {
    sourcePath,
    destinationPath,
    isDirectory,
  }, 750).catch((error) => console.warn(`[desktop-icons] shell refresh failed: ${error.message}`))
}

const notifyShellDirectories = async (directoryPaths) => {
  if (process.platform !== 'win32' || capturePath || (desktopHostTest && !desktopDragTest)) return
  const paths = [...new Set(
    (Array.isArray(directoryPaths) ? directoryPaths : [])
      .filter((entry) => typeof entry === 'string' && entry)
      .map((entry) => path.resolve(entry).toLocaleLowerCase()),
  )]
  if (!paths.length) return
  await desktopIconHelperRequest('notify-directories', { paths }, 750)
    .catch((error) => console.warn(`[desktop-icons] batch shell refresh failed: ${error.message}`))
}

const notifyShellMoves = async (moves, options = {}) => {
  if (process.platform !== 'win32' || capturePath || (desktopHostTest && !desktopDragTest)) return
  const validMoves = (Array.isArray(moves) ? moves : []).filter((move) => (
    typeof move?.sourcePath === 'string'
    && move.sourcePath
    && typeof move?.destinationPath === 'string'
    && move.destinationPath
    && (pathIsDesktopItem(move.sourcePath) || pathIsDesktopItem(move.destinationPath))
  ))
  if (!validMoves.length) return
  try {
    await desktopIconHelperRequest(
      options.flush === true ? 'notify-moves-flush' : 'notify-moves',
      { moves: validMoves },
      options.flush === true ? 5_000 : 750,
    )
  } catch (error) {
    console.warn(`[desktop-icons] batch move notification failed: ${error.message}`)
    await notifyShellDirectories(validMoves.flatMap((move) => [
      path.dirname(move.sourcePath),
      path.dirname(move.destinationPath),
    ]))
  }
}

const movePath = async (sourcePath, destinationPath, options = {}) => {
  const isDirectory = (await fs.promises.lstat(sourcePath)).isDirectory()
  try {
    await fs.promises.rename(sourcePath, destinationPath)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    await fs.promises.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: true })
    try {
      await fs.promises.rm(sourcePath, { recursive: true })
    } catch (removeError) {
      await fs.promises.rm(destinationPath, { recursive: true, force: true }).catch(() => {})
      throw removeError
    }
  }
  // The file move is already complete. Shell notification is deliberately detached so
  // Explorer can refresh while the organizer UI updates in the same frame.
  if (options.notifyShell !== false) void notifyShellMove(sourcePath, destinationPath, isDirectory)
}

const movePathWithTransientRetry = async (sourcePath, destinationPath, options = {}) => {
  const retryDelays = Array.isArray(options.retryDelays)
    ? options.retryDelays
    : [80, 180, 360, 720]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await movePath(sourcePath, destinationPath, options)
      return
    } catch (error) {
      const transient = ['EBUSY', 'EACCES', 'EPERM'].includes(error?.code)
      if (!transient || attempt >= retryDelays.length || !fs.existsSync(sourcePath)) throw error
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]))
    }
  }
}

const importOrganizerFiles = async (widgetId, filePaths) => {
  const sources = [...new Set(
    (Array.isArray(filePaths) ? filePaths : [])
      .filter((entry) => typeof entry === 'string' && entry)
      .map((entry) => path.resolve(entry)),
  )].slice(0, 100)
  const sourceVisuals = new Map()
  await Promise.all(sources.map(async (sourcePath) => {
    if (!fs.existsSync(sourcePath)) return
    try {
      const stat = await fs.promises.lstat(sourcePath)
      const shouldCaptureShellIcon = stat.isDirectory()
        || windowsShellLinkExtensions.has(path.extname(sourcePath).toLocaleLowerCase())
      if (!shouldCaptureShellIcon) return
      const shellIconDataUrl = await loadWindowsShellIconData(sourcePath)
      const shellVisual = shellIconDataUrl ? nativeImage.createFromDataURL(shellIconDataUrl) : null
      const visual = shellVisual && !shellVisual.isEmpty() ? shellVisual : await loadFileVisual(sourcePath)
      if (visual && !visual.isEmpty()) {
        sourceVisuals.set(sourcePath.toLocaleLowerCase(), {
          visual,
          iconDataUrl: shellIconDataUrl || visual.toDataURL(),
        })
      }
    } catch {}
  }))
  const containsDesktopFiles = sources.some(pathIsDesktopItem)
  if (containsDesktopFiles) {
    // Capture every batch from Explorer immediately before moving it. Desktop icons can be
    // rearranged at any time, so the two-second cache is not authoritative here.
    await refreshDesktopIconPositions(true).catch(() => {})
  }
  const nextState = cloneWorkspace()
  const widget = nextState.widgets.find((candidate) => candidate.id === widgetId && candidate.kind === 'organizer')
  if (!widget) return { imported: 0, errors: ['收纳盒不存在'] }
  const storagePath = organizerStoragePath(widgetId)
  await fs.promises.mkdir(storagePath, { recursive: true })

  const importedFiles = []
  const movedSources = new Set()
  const errors = []
  for (const sourcePath of sources) {
    try {
      if (desktopDirectories().includes(sourcePath.toLocaleLowerCase())) {
        throw new Error('不能把整个桌面目录移入收纳盒')
      }
      const stat = await fs.promises.lstat(sourcePath)
      const existingFile = workspaceState.widgets
        .filter((candidate) => candidate.kind === 'organizer')
        .flatMap((candidate) => Array.isArray(candidate.data?.files) ? candidate.data.files : [])
        .find((candidate) => path.resolve(candidate.path).toLocaleLowerCase() === sourcePath.toLocaleLowerCase())
      const sourceIsOnDesktop = pathIsDesktopItem(sourcePath)
      const currentDesktopPosition = sourceIsOnDesktop
        ? desktopIconPositionForPath(sourcePath, stat.isDirectory())
        : null
      const originalDesktopPosition = currentDesktopPosition || existingFile?.originalDesktopPosition || null
      if (pathIsInside(sourcePath, storagePath) && !pathIsInside(storagePath, sourcePath)) {
        throw new Error('不能收纳包含应用存储目录的文件夹')
      }
      let destinationPath = sourcePath
      const sourceVisual = sourceVisuals.get(sourcePath.toLocaleLowerCase())
      if (!pathIsInside(storagePath, sourcePath)) {
        destinationPath = availableDestination(storagePath, sourcePath, stat.isDirectory())
        await movePath(sourcePath, destinationPath)
        movedSources.add(sourcePath.toLocaleLowerCase())
      }
      if (sourceVisual?.visual) {
        fileIconCache.set(path.resolve(destinationPath).toLocaleLowerCase(), sourceVisual.visual)
      }
      const file = await describePath(destinationPath)
      if (file) {
        importedFiles.push({
          ...file,
          ...(sourceVisual?.iconDataUrl || existingFile?.iconDataUrl
            ? { iconDataUrl: sourceVisual?.iconDataUrl || existingFile.iconDataUrl }
            : {}),
          originalPath: sourceIsOnDesktop ? sourcePath : (existingFile?.originalPath || sourcePath),
          originalDesktopPosition,
        })
      }
    } catch (error) {
      errors.push(`${path.basename(sourcePath)}：${error.message}`)
    }
  }

  if (importedFiles.length) {
    const existingFiles = Array.isArray(widget.data?.files) ? widget.data.files : []
    const importedPaths = new Set(importedFiles.map((file) => file.path.toLocaleLowerCase()))
    widget.data = {
      ...widget.data,
      files: [
        ...existingFiles.filter((file) => {
          const normalizedPath = path.resolve(file.path).toLocaleLowerCase()
          return !movedSources.has(normalizedPath) && !importedPaths.has(normalizedPath)
        }),
        ...importedFiles,
      ],
    }
    await updateWorkspace(nextState)
  }
  return { imported: importedFiles.length, errors }
}

const importOrganizerShellItems = async (widgetId, selectedItems) => {
  const selections = (Array.isArray(selectedItems) ? selectedItems : []).slice(0, 10)
  if (!selections.length) return { imported: 0, errors: [] }
  const nextState = cloneWorkspace()
  const widget = nextState.widgets.find((candidate) => candidate.id === widgetId && candidate.kind === 'organizer')
  if (!widget) return { imported: 0, errors: ['收纳盒不存在'] }
  const existingClsids = new Set(nextState.widgets
    .filter((candidate) => candidate.kind === 'organizer')
    .flatMap((candidate) => Array.isArray(candidate.data?.files) ? candidate.data.files : [])
    .filter(isOrganizerShellItem)
    .map((file) => file.shellClsid.toLocaleLowerCase()))
  const importedFiles = []
  const hiddenItems = []
  const errors = []

  for (const selection of selections) {
    const definition = desktopShellItemDefinitionForClsid(selection?.clsid)
    if (!definition || existingClsids.has(definition.clsid.toLocaleLowerCase())) continue
    try {
      const visibility = await desktopShellItemVisibility(definition.clsid)
      if (visibility?.visible === false) continue
      const iconDataUrl = await loadDesktopShellItemIconData(definition)
      const displayName = typeof selection.name === 'string' && selection.name
        ? selection.name
        : definition.aliases[0]
      const shellPath = desktopShellItemPath(definition.clsid)
      const position = selection.position || desktopIconPositionCache.get(displayName.toLocaleLowerCase()) || null
      await setDesktopShellItemVisibility(definition.clsid, { exists: true, value: 1 })
      hiddenItems.push({ definition, visibility })
      importedFiles.push({
        id: Buffer.from(shellPath.toLocaleLowerCase()).toString('base64url'),
        path: shellPath,
        name: displayName,
        extension: 'system',
        size: 0,
        isDirectory: true,
        modifiedAt: new Date().toISOString(),
        ...(iconDataUrl ? { iconDataUrl } : {}),
        originalPath: shellPath,
        originalDesktopPosition: position,
        shellClsid: definition.clsid,
        shellVisibilityValueExists: Boolean(visibility?.exists),
        shellVisibilityValue: Number.isFinite(visibility?.value) ? visibility.value : 0,
      })
      existingClsids.add(definition.clsid.toLocaleLowerCase())
    } catch (error) {
      errors.push(`${selection?.name || definition.aliases[0]}：${error.message}`)
    }
  }

  if (importedFiles.length) {
    try {
      const existingFiles = Array.isArray(widget.data?.files) ? widget.data.files : []
      widget.data = { ...widget.data, files: [...existingFiles, ...importedFiles] }
      await updateWorkspace(nextState)
    } catch (error) {
      await Promise.all(hiddenItems.map(({ definition, visibility }) => (
        setDesktopShellItemVisibility(definition.clsid, visibility).catch(() => {})
      )))
      throw error
    }
  }
  return { imported: importedFiles.length, errors }
}

const findOrganizerFile = (widgetId, filePath, state = workspaceState) => {
  const widget = state?.widgets?.find((candidate) => candidate.id === widgetId && candidate.kind === 'organizer')
  if (!widget || typeof filePath !== 'string') throw new Error('收纳文件不存在')
  const files = Array.isArray(widget.data?.files) ? widget.data.files : []
  const requestedKey = organizerFileKey(filePath)
  const file = files.find((candidate) => organizerFileKey(candidate.path, candidate) === requestedKey)
  const sourcePath = isOrganizerShellItem(file) ? file.path : path.resolve(filePath)
  if (!file || (!isOrganizerShellItem(file) && !fs.existsSync(sourcePath))) throw new Error('收纳文件不存在')
  return { widget, files, file, sourcePath }
}

const restoreDestinationForFile = (file, sourcePath, isDirectory) => {
  const storageRoot = path.resolve(organizerStorageRoot())
  const originalPath = typeof file.originalPath === 'string' && file.originalPath
    ? path.resolve(file.originalPath)
    : ''
  const originalParent = originalPath ? path.dirname(originalPath) : ''
  const canUseOriginal = originalPath
    && !pathIsInside(storageRoot, originalPath)
    && fs.existsSync(originalParent)
  if (canUseOriginal && !fs.existsSync(originalPath)) return originalPath
  if (canUseOriginal) return availableDestination(originalParent, originalPath, isDirectory)

  const fallbackDirectory = path.resolve(organizerReleaseRoot())
  fs.mkdirSync(fallbackDirectory, { recursive: true })
  return availableDestination(fallbackDirectory, sourcePath, isDirectory)
}

const moveOrganizerFileToRestoreDestination = async (file, sourcePath, isDirectory, options = {}) => {
  const preferredPath = restoreDestinationForFile(file, sourcePath, isDirectory)
  try {
    await movePath(sourcePath, preferredPath, options)
    return preferredPath
  } catch (preferredError) {
    const fallbackDirectory = path.resolve(organizerReleaseRoot())
    if (path.dirname(path.resolve(preferredPath)).toLocaleLowerCase() === fallbackDirectory.toLocaleLowerCase()) {
      throw preferredError
    }
    const fallbackPath = availableDestination(fallbackDirectory, sourcePath, isDirectory)
    try {
      await movePath(sourcePath, fallbackPath, options)
      return fallbackPath
    } catch (fallbackError) {
      throw new Error(`${preferredError.message}；回退到当前用户桌面也失败：${fallbackError.message}`)
    }
  }
}

const removeOrganizerFileReference = async (widgetId, filePath) => {
  const nextState = cloneWorkspace()
  const widget = nextState.widgets.find((candidate) => candidate.id === widgetId && candidate.kind === 'organizer')
  if (!widget) return false
  const sourcePath = organizerFileKey(filePath)
  const files = Array.isArray(widget.data?.files) ? widget.data.files : []
  const remainingFiles = files.filter((candidate) => organizerFileKey(candidate.path, candidate) !== sourcePath)
  if (remainingFiles.length === files.length) return false
  widget.data = { ...widget.data, files: remainingFiles }
  await updateWorkspace(nextState)
  return true
}

const restoreOrganizerShellItem = async (file, position = file.originalDesktopPosition) => {
  const definition = desktopShellItemDefinitionForClsid(file.shellClsid)
  if (!definition) throw new Error('不支持的系统桌面项')
  await setDesktopShellItemVisibility(file.shellClsid, {
    exists: Boolean(file.shellVisibilityValueExists),
    value: Number.isFinite(file.shellVisibilityValue) ? file.shellVisibilityValue : 0,
  })
  if (position) {
    await restoreDesktopIconPositions([{
      names: [...new Set([file.name, ...definition.aliases].map((name) => name.toLocaleLowerCase()))],
      position,
      required: true,
    }]).catch(() => 0)
  }
  return file.path
}

const reorderOrganizerFiles = async (widgetId, orderedFileIds) => {
  const nextState = cloneWorkspace()
  const widget = nextState.widgets.find((candidate) => candidate.id === widgetId && candidate.kind === 'organizer')
  if (!widget) return nextState
  const files = Array.isArray(widget.data?.files) ? widget.data.files : []
  const requestedIds = [...new Set(
    (Array.isArray(orderedFileIds) ? orderedFileIds : []).filter((id) => typeof id === 'string'),
  )]
  const filesById = new Map(files.map((file) => [file.id, file]))
  const reorderedFiles = [
    ...requestedIds.map((id) => filesById.get(id)).filter(Boolean),
    ...files.filter((file) => !requestedIds.includes(file.id)),
  ]
  if (
    reorderedFiles.length !== files.length
    || reorderedFiles.every((file, index) => file.path === files[index]?.path)
  ) {
    return nextState
  }
  widget.data = { ...widget.data, files: reorderedFiles }
  return updateWorkspace(nextState)
}

const moveOrganizerFileBetweenWidgets = async (
  sourceWidgetId,
  targetWidgetId,
  filePath,
  targetFileId = '',
  edge = 'after',
) => {
  if (sourceWidgetId === targetWidgetId) return false
  const previousState = cloneWorkspace()
  const nextState = cloneWorkspace()
  const { widget: sourceWidget, files: sourceFiles, file, sourcePath } = findOrganizerFile(
    sourceWidgetId,
    filePath,
    nextState,
  )
  const targetWidget = nextState.widgets.find((candidate) => (
    candidate.id === targetWidgetId && candidate.kind === 'organizer'
  ))
  if (!targetWidget) throw new Error('目标收纳盒不存在')
  const targetFiles = Array.isArray(targetWidget.data?.files) ? targetWidget.data.files : []
  if (targetFiles.some((candidate) => organizerFileKey(candidate.path, candidate) === organizerFileKey(file.path, file))) {
    throw new Error('目标收纳盒中已存在该项目')
  }

  let transferredFile = { ...file }
  let movedPath = null
  let sourceCachedVisual = null
  const rollbackTransferredPath = async () => {
    if (!movedPath || !fs.existsSync(movedPath.destinationPath) || fs.existsSync(movedPath.sourcePath)) return
    await movePath(movedPath.destinationPath, movedPath.sourcePath, { notifyShell: false }).catch(() => {})
    const sourceCacheKey = path.resolve(movedPath.sourcePath).toLocaleLowerCase()
    const destinationCacheKey = path.resolve(movedPath.destinationPath).toLocaleLowerCase()
    if (sourceCachedVisual) fileIconCache.set(sourceCacheKey, sourceCachedVisual)
    fileIconCache.delete(destinationCacheKey)
  }
  if (!isOrganizerShellItem(file)) {
    const stat = await fs.promises.lstat(sourcePath)
    const targetStoragePath = organizerStoragePath(targetWidgetId)
    await fs.promises.mkdir(targetStoragePath, { recursive: true })
    if (!pathIsInside(targetStoragePath, sourcePath)) {
      const destinationPath = availableDestination(targetStoragePath, sourcePath, stat.isDirectory())
      await movePath(sourcePath, destinationPath, { notifyShell: false })
      movedPath = { sourcePath, destinationPath }
      const sourceCacheKey = path.resolve(sourcePath).toLocaleLowerCase()
      const destinationCacheKey = path.resolve(destinationPath).toLocaleLowerCase()
      sourceCachedVisual = fileIconCache.get(sourceCacheKey) || null
      if (sourceCachedVisual) fileIconCache.set(destinationCacheKey, sourceCachedVisual)
      fileIconCache.delete(sourceCacheKey)
      const described = await describePath(destinationPath)
      if (!described) {
        await rollbackTransferredPath()
        throw new Error('移动后无法读取文件')
      }
      transferredFile = { ...file, ...described }
    }
  }

  sourceWidget.data = {
    ...sourceWidget.data,
    files: sourceFiles.filter((candidate) => organizerFileKey(candidate.path, candidate) !== organizerFileKey(file.path, file)),
  }
  const insertionIndex = targetFileId
    ? targetFiles.findIndex((candidate) => candidate.id === targetFileId)
    : -1
  const nextTargetFiles = [...targetFiles]
  nextTargetFiles.splice(
    insertionIndex < 0 ? nextTargetFiles.length : insertionIndex + (edge === 'before' ? 0 : 1),
    0,
    transferredFile,
  )
  targetWidget.data = { ...targetWidget.data, files: nextTargetFiles }

  try {
    await updateWorkspace(nextState)
  } catch (error) {
    await rollbackTransferredPath()
    workspaceState = previousState
    broadcastWorkspace()
    throw error
  }
  return true
}

const releaseOrganizerFile = async (widgetId, filePath) => {
  const { file, sourcePath } = findOrganizerFile(widgetId, filePath)
  if (isOrganizerShellItem(file)) {
    await restoreOrganizerShellItem(file)
    await removeOrganizerFileReference(widgetId, sourcePath)
    return { releasedPath: sourcePath, sourcePath }
  }
  const stat = await fs.promises.lstat(sourcePath)
  let releasedPath = sourcePath
  if (pathIsInside(organizerStoragePath(widgetId), sourcePath)) {
    releasedPath = await moveOrganizerFileToRestoreDestination(file, sourcePath, stat.isDirectory())
  }
  const positionRestoration = pathIsDesktopItem(releasedPath)
    ? restoreDesktopIconPosition(releasedPath, file.originalDesktopPosition, stat.isDirectory()).catch(() => false)
    : Promise.resolve(false)
  await removeOrganizerFileReference(widgetId, sourcePath)
  await positionRestoration
  return { releasedPath, sourcePath }
}

const releaseOrganizerFileToDesktop = async (widgetId, filePath) => {
  const { file, sourcePath } = findOrganizerFile(widgetId, filePath)
  if (isOrganizerShellItem(file)) {
    const cursorPosition = await waitForDesktopPointerRelease()
    await restoreOrganizerShellItem(file, cursorPosition)
    await removeOrganizerFileReference(widgetId, sourcePath)
    return { releasedPath: sourcePath, sourcePath }
  }
  const stat = await fs.promises.lstat(sourcePath)
  const desktopPath = path.resolve(app.getPath('desktop'))
  // Chromium can emit dragend when a transparent desktop window loses the drag,
  // even though the physical mouse button is still held. Never move the file until
  // Windows confirms the left button has actually been released.
  const cursorPosition = await waitForDesktopPointerRelease()
  let releasedPath = sourcePath
  if (pathIsInside(organizerStoragePath(widgetId), sourcePath)) {
    releasedPath = availableDestination(desktopPath, sourcePath, stat.isDirectory())
    await movePath(sourcePath, releasedPath)
  }
  const positionRestoration = restoreDesktopIconPosition(
    releasedPath,
    cursorPosition,
    stat.isDirectory(),
  ).catch(() => false)
  await removeOrganizerFileReference(widgetId, sourcePath)
  // Do not hold the IPC/UI response open during Explorer's short stabilization window.
  void positionRestoration
  return { releasedPath, sourcePath }
}

const restoreOrganizerFilesToOriginalLocations = async (options = {}) => {
  if (!workspaceState?.widgets) return { restored: 0, errors: [] }
  const preserveOrganizerMembership = options.preserveOrganizerMembership === true
  const nextState = cloneWorkspace()
  const hasDesktopRestorations = nextState.widgets
    .filter((candidate) => candidate.kind === 'organizer')
    .some((widget) => (Array.isArray(widget.data?.files) ? widget.data.files : []).some((file) => {
      if (isOrganizerShellItem(file)) return true
      const filePath = path.resolve(file.path)
      return Boolean(file.originalDesktopPosition)
        && fs.existsSync(filePath)
        && pathIsInside(organizerStoragePath(widget.id), filePath)
    }))
  const protectedDesktopPositions = hasDesktopRestorations
    ? await desktopIconPositionSnapshot().catch(() => [])
    : []
  const restoredShellItemNames = new Set(nextState.widgets
    .filter((candidate) => candidate.kind === 'organizer')
    .flatMap((widget) => Array.isArray(widget.data?.files) ? widget.data.files : [])
    .filter(isOrganizerShellItem)
    .flatMap((file) => {
      const definition = desktopShellItemDefinitionForClsid(file.shellClsid)
      return [file.name, ...(definition?.aliases || [])]
    })
    .filter((name) => typeof name === 'string' && name)
    .map((name) => name.toLocaleLowerCase()))
  const iconRestorations = []
  const shellMoves = []
  const errors = []
  let restored = 0
  let removedReferences = 0

  for (const widget of nextState.widgets.filter((candidate) => candidate.kind === 'organizer')) {
    const files = Array.isArray(widget.data?.files) ? widget.data.files : []
    const restoredFiles = []
    for (const file of files) {
      if (isOrganizerShellItem(file)) {
        try {
          const definition = desktopShellItemDefinitionForClsid(file.shellClsid)
          await setDesktopShellItemVisibility(file.shellClsid, {
            exists: Boolean(file.shellVisibilityValueExists),
            value: Number.isFinite(file.shellVisibilityValue) ? file.shellVisibilityValue : 0,
          })
          if (definition && file.originalDesktopPosition) {
            iconRestorations.push({
              names: [...new Set([file.name, ...definition.aliases].map((name) => name.toLocaleLowerCase()))],
              position: file.originalDesktopPosition,
              required: true,
            })
          }
          if (preserveOrganizerMembership) {
            restoredFiles.push({ ...file, temporarilyRestoredOnExit: true })
          }
          restored += 1
        } catch (error) {
          restoredFiles.push(file)
          errors.push(`${file.name}：${error.message}`)
        }
        continue
      }
      const sourcePath = path.resolve(file.path)
      if (!fs.existsSync(sourcePath) || !pathIsInside(organizerStoragePath(widget.id), sourcePath)) {
        removedReferences += 1
        continue
      }
      try {
        const stat = await fs.promises.lstat(sourcePath)
        const destinationPath = await moveOrganizerFileToRestoreDestination(
          file,
          sourcePath,
          stat.isDirectory(),
          { notifyShell: false },
        )
        shellMoves.push({
          sourcePath,
          destinationPath,
          isDirectory: stat.isDirectory(),
        })
        if (pathIsDesktopItem(destinationPath) && file.originalDesktopPosition) {
          iconRestorations.push({
            names: desktopIconNamesForPath(destinationPath, stat.isDirectory()),
            position: file.originalDesktopPosition,
            required: true,
          })
        }
        if (preserveOrganizerMembership) {
          restoredFiles.push({
            ...file,
            path: destinationPath,
            temporarilyRestoredOnExit: true,
          })
        }
        restored += 1
      } catch (error) {
        restoredFiles.push(file)
        errors.push(`${file.name || path.basename(sourcePath)}：${error.message}`)
      }
    }
    widget.data = { ...widget.data, files: restoredFiles }
  }

  if (restored) {
    // Explorer must finish processing the whole restore batch before coordinates are
    // replayed. Otherwise a delayed desktop refresh can reorder icons after we quit.
    await notifyShellMoves(shellMoves, { flush: true })
  }
  if (restored || removedReferences) await updateWorkspace(nextState)
  await restoreDesktopIconPositions([
    ...protectedDesktopPositions.filter((entry) => (
      !(entry.names || []).some((name) => restoredShellItemNames.has(String(name).toLocaleLowerCase()))
    )),
    ...iconRestorations,
  ]).catch(() => 0)
  return { restored, removedReferences, errors }
}

const reconcileOrganizerStorage = async () => {
  if (!workspaceState?.widgets) return false
  const nextState = cloneWorkspace()
  let changed = false
  const shellMoves = []
  const hasDesktopReconcileMutations = nextState.widgets
    .filter((candidate) => candidate.kind === 'organizer')
    .some((widget) => (Array.isArray(widget.data?.files) ? widget.data.files : []).some((file) => (
      isOrganizerShellItem(file)
      || (
        file?.temporarilyRestoredOnExit === true
        && typeof file.path === 'string'
        && fs.existsSync(file.path)
        && pathIsDesktopItem(file.path)
      )
    )))
  const protectedDesktopPositions = hasDesktopReconcileMutations
    ? await desktopIconPositionSnapshot().catch(() => [])
    : []
  const removedDesktopIconNames = new Set()
  for (const widget of nextState.widgets.filter((candidate) => candidate.kind === 'organizer')) {
    const storagePath = organizerStoragePath(widget.id)
    await fs.promises.mkdir(storagePath, { recursive: true })
    const files = Array.isArray(widget.data?.files) ? widget.data.files : []
    const retainedFiles = []
    for (const file of files) {
      if (isOrganizerShellItem(file)) {
        const definition = desktopShellItemDefinitionForClsid(file.shellClsid)
        // A shell namespace item has no filesystem path, so unlike ordinary desktop
        // files its saved position was never refreshed when a previous exit restored
        // it. That left stale coordinates behind (for example Recycle Bin and a file
        // both claiming the same grid cell), and Explorer displaced neighbouring icons
        // during the next exit. Capture the currently visible shell item's position
        // from the same coherent startup snapshot before hiding it again.
        const currentDesktopPosition = desktopIconPositionForShellItem(file, definition)
        for (const name of [file.name, ...(definition?.aliases || [])]) {
          if (typeof name === 'string' && name) removedDesktopIconNames.add(name.toLocaleLowerCase())
        }
        await setDesktopShellItemVisibility(file.shellClsid, { exists: true, value: 1 }).catch(() => {})
        const retainedShellItem = currentDesktopPosition
          ? { ...file, originalDesktopPosition: currentDesktopPosition }
          : file
        if (file.temporarilyRestoredOnExit === true) {
          const restoredFile = { ...retainedShellItem }
          delete restoredFile.temporarilyRestoredOnExit
          retainedFiles.push(restoredFile)
          changed = true
        } else {
          retainedFiles.push(retainedShellItem)
          if (currentDesktopPosition && (
            currentDesktopPosition.x !== file.originalDesktopPosition?.x
            || currentDesktopPosition.y !== file.originalDesktopPosition?.y
          )) changed = true
        }
        continue
      }
      const filePath = path.resolve(file.path)
      if (file.temporarilyRestoredOnExit === true) {
        if (!fs.existsSync(filePath)) {
          changed = true
          continue
        }
        try {
          const stat = await fs.promises.lstat(filePath)
          const currentDesktopPosition = pathIsDesktopItem(filePath)
            ? desktopIconPositionForPath(filePath, stat.isDirectory())
            : null
          if (pathIsDesktopItem(filePath)) {
            for (const name of desktopIconNamesForPath(filePath, stat.isDirectory())) {
              removedDesktopIconNames.add(name)
            }
          }
          let destinationPath = filePath
          if (!pathIsInside(storagePath, filePath)) {
            destinationPath = availableDestination(storagePath, filePath, stat.isDirectory())
            // Login applications and Explorer extensions can briefly open a
            // desktop shortcut without delete sharing. A one-shot rename left
            // the entry marked as collected while the real icon stayed on the
            // desktop. Retry only transient sharing/access failures.
            await movePathWithTransientRetry(filePath, destinationPath, { notifyShell: false })
            shellMoves.push({
              sourcePath: filePath,
              destinationPath,
              isDirectory: stat.isDirectory(),
            })
          }
          const described = await describePath(destinationPath)
          if (!described) throw new Error('重新收纳后无法读取文件')
          const restoredFile = {
            ...file,
            ...described,
            originalPath: file.originalPath || filePath,
            originalDesktopPosition: currentDesktopPosition || file.originalDesktopPosition || null,
          }
          delete restoredFile.temporarilyRestoredOnExit
          retainedFiles.push(restoredFile)
          changed = true
        } catch (error) {
          retainedFiles.push(file)
          console.warn(`[organizer] startup re-import failed for ${file.name || path.basename(filePath)}: ${error.message}`)
        }
        continue
      }
      const retained = fs.existsSync(filePath) && pathIsInside(storagePath, filePath)
      if (!retained) changed = true
      if (retained) retainedFiles.push(file)
    }
    const trackedPaths = new Set(retainedFiles
      .filter((file) => !isOrganizerShellItem(file))
      .map((file) => path.resolve(file.path).toLocaleLowerCase()))
    const storageEntries = await fs.promises.readdir(storagePath, { withFileTypes: true })
    for (const entry of storageEntries) {
      const entryPath = path.join(storagePath, entry.name)
      if (trackedPaths.has(path.resolve(entryPath).toLocaleLowerCase())) continue
      const described = await describePath(entryPath)
      if (!described) continue
      retainedFiles.push({
        ...described,
        originalPath: path.join(organizerReleaseRoot(), entry.name),
        originalDesktopPosition: null,
      })
      changed = true
    }
    widget.data = { ...widget.data, files: retainedFiles }
  }
  if (shellMoves.length) await notifyShellMoves(shellMoves, { flush: true })
  if (changed) await updateWorkspace(nextState)
  if (protectedDesktopPositions.length) {
    await restoreDesktopIconPositions(protectedDesktopPositions.filter((entry) => (
      !(entry.names || []).some((name) => removedDesktopIconNames.has(String(name).toLocaleLowerCase()))
    )))
  }
  return changed
}

const hasPendingOrganizerStorageReconcile = () => Boolean(workspaceState?.widgets?.some((widget) => (
  widget.kind === 'organizer'
  && (Array.isArray(widget.data?.files) ? widget.data.files : [])
    .some((file) => file?.temporarilyRestoredOnExit === true)
)))

const scheduleOrganizerStorageReconcileRetry = (attempt = 0) => {
  if (capturePath || desktopHostTest || desktopTrayTest || !hasPendingOrganizerStorageReconcile()) return
  const delays = [500, 1_500, 4_000, 10_000]
  if (attempt >= delays.length) return
  if (organizerStorageReconcileRetryTimer) clearTimeout(organizerStorageReconcileRetryTimer)
  organizerStorageReconcileRetryTimer = setTimeout(() => {
    organizerStorageReconcileRetryTimer = null
    void enqueueWorkspaceMutation(() => reconcileOrganizerStorage())
      .catch((error) => console.warn(`[organizer] startup reconcile retry failed: ${error.message}`))
      .finally(() => {
        if (hasPendingOrganizerStorageReconcile()) scheduleOrganizerStorageReconcileRetry(attempt + 1)
      })
  }, delays[attempt])
}

const loadWorkspace = async () => {
  workspacePath = path.join(app.getPath('userData'), 'desktop-workspace.json')
  try {
    const parsed = JSON.parse(await fs.promises.readFile(workspacePath, 'utf8'))
    workspaceState = {
      ...defaultWorkspace(),
      ...parsed,
      version: 1,
      widgets: Array.isArray(parsed.widgets) ? parsed.widgets : [],
      desktopLayout: parsed.desktopLayout && Array.isArray(parsed.desktopLayout.displays)
        ? parsed.desktopLayout
        : null,
      settings: { ...defaultWorkspace().settings, ...(parsed.settings || {}) },
    }
  } catch {
    workspaceState = defaultWorkspace()
  }

  if (capturePath || desktopHostTestDemo) {
    workspaceState.widgets = createCaptureWidgets()
    if (desktopWidgetWindowTest || desktopOrganizerPromotionTest) {
      const firstOrganizer = workspaceState.widgets.find((widget) => widget.kind === 'organizer')
      const secondOrganizer = createWidget('organizer')
      secondOrganizer.title = '第二收纳盒'
      secondOrganizer.x = (firstOrganizer?.x || 90) + 48
      secondOrganizer.y = (firstOrganizer?.y || 130) + 48
      secondOrganizer.width = firstOrganizer?.width || 390
      secondOrganizer.height = firstOrganizer?.height || 280
      workspaceState.widgets.push(secondOrganizer)
      // Match the user's dense production workspace: ten independent native
      // organizer HWNDs, including two minimum-width cards at the screen top.
      // The first two remain the overlapping gesture fixtures used below.
      for (let index = 2; index < 10; index += 1) {
        const organizer = createWidget('organizer')
        organizer.title = `回归收纳盒 ${index + 1}`
        organizer.width = 110
        organizer.height = 157
        if (index < 4) {
          // Keep physical gesture fixtures clear of note/todo windows, which
          // intentionally remain above every organizer.
          organizer.x = 490 + (index - 2) * 110
          organizer.y = index - 2
        } else {
          organizer.x = 20 + ((index - 4) % 4) * 125
          organizer.y = 480 + Math.floor((index - 4) / 4) * 165
        }
        workspaceState.widgets.push(organizer)
      }
      if (screen.getAllDisplays().length > 1) {
        const primaryBounds = currentDesktopInfo().primaryBounds
        const primaryDisplayOrganizer = createWidget('organizer')
        primaryDisplayOrganizer.title = '跨屏 DPI 回归收纳盒'
        primaryDisplayOrganizer.x = primaryBounds.x + 80
        primaryDisplayOrganizer.y = primaryBounds.y + 80
        primaryDisplayOrganizer.width = 220
        primaryDisplayOrganizer.height = 180
        workspaceState.widgets.push(primaryDisplayOrganizer)
      }
      if (desktopOrganizerPromotionTest) {
        console.log(`[desktop-host] focused organizer fixtures=${workspaceState.widgets.filter((widget) => widget.kind === 'organizer').length}`)
      }
    }
  } else if (!desktopHostTest && !desktopTrayTest) {
    const remapped = await remapWorkspaceForCurrentDesktop({ useSnapshotFallback: true })
    if (remapped.changed) await persistWorkspace()
  }
}

const writeJsonAtomically = async (destination, value) => {
  const temporary = `${destination}.${process.pid}.tmp`
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
    await fs.promises.rename(temporary, destination)
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
  }
}

const persistWorkspace = async () => {
  if (capturePath || desktopHostTest || !workspacePath || !workspaceState) return
  await writeJsonAtomically(workspacePath, workspaceState)
}

const cloneWorkspace = () => JSON.parse(JSON.stringify(workspaceState || defaultWorkspace()))

const broadcastWorkspace = () => {
  const state = cloneWorkspace()
  for (const win of liveAppWindows()) {
    win.webContents.send('workspace:changed', state)
  }
}

const currentDesktopStatus = () => ({
  hostState: desktopHostState,
  message: desktopStatusMessage,
})

const broadcastDesktopStatus = () => {
  const status = currentDesktopStatus()
  for (const win of liveAppWindows()) {
    win.webContents.send('desktop:status-changed', status)
  }
}

const logDesktopGeometry = async (label) => {
  const displays = screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    primary: display.id === screen.getPrimaryDisplay().id,
  }))
  const snapshots = []
  for (const win of liveDesktopWindows()) {
    const renderer = await win.webContents.executeJavaScript(`({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      screenX: window.screenX,
      screenY: window.screenY,
      widgets: [...document.querySelectorAll('.desktop-widget')].map((element) => {
        const rect = element.getBoundingClientRect()
        const titleElement = element.querySelector('[data-widget-title]')
        return {
          title: titleElement?.value || titleElement?.textContent || '',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }
      })
    })`)
    snapshots.push({
      displayId: win.desktopDisplayId,
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
      renderer,
    })
  }
  console.log(`[desktop-geometry] ${label} ${JSON.stringify({ windows: snapshots, displays })}`)
  return snapshots
}

const updateWorkspace = async (nextState) => {
  workspaceState = {
    ...nextState,
    desktopLayout: nextState?.desktopLayout || workspaceState?.desktopLayout || captureSnapshotDesktop(),
  }
  syncDesktopWidgetWindows()
  broadcastWorkspace()
  await persistWorkspace()
  if (!snapshotRestoreInProgress) void maybeCreateAutomaticSnapshot('定时自动快照')
  return cloneWorkspace()
}

const snapshotDirectory = () => path.join(app.getPath('userData'), 'workspace-snapshots')
const snapshotFilePath = (snapshotId) => {
  if (typeof snapshotId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(snapshotId)) {
    throw new Error('快照编号无效')
  }
  return path.join(snapshotDirectory(), `${snapshotId}.json`)
}

const enqueueSnapshotMutation = (operation) => {
  const result = snapshotMutationTail.then(operation, operation)
  snapshotMutationTail = result.catch(() => {})
  return result
}

const captureSnapshotDesktop = () => {
  const info = currentDesktopInfo()
  const primaryId = String(screen.getPrimaryDisplay().id)
  const displaysById = new Map(screen.getAllDisplays().map((display) => [String(display.id), display]))
  return {
    virtualBounds: info.virtualBounds,
    displays: info.displays.map((display) => ({
      ...display,
      label: displaysById.get(display.id)?.label || '',
      primary: display.id === primaryId,
    })),
  }
}

const desktopLayoutSignature = (layout) => JSON.stringify(
  (Array.isArray(layout?.displays) ? layout.displays : [])
    .map((display) => ({
      id: String(display.id),
      primary: display.primary === true,
      scaleFactor: Number(display.scaleFactor) || 1,
      bounds: display.bounds,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
)

const latestDifferentSnapshotDesktopLayout = async (currentLayout) => {
  let entries = []
  try {
    entries = await fs.promises.readdir(snapshotDirectory(), { withFileTypes: true })
  } catch {
    return null
  }
  const currentSignature = desktopLayoutSignature(currentLayout)
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.tmp.json'))
    .sort((left, right) => right.name.localeCompare(left.name))
  for (const entry of candidates) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(snapshotDirectory(), entry.name), 'utf8'))
      if (
        parsed?.desktop
        && Array.isArray(parsed.desktop.displays)
        && parsed.desktop.displays.length
        && desktopLayoutSignature(parsed.desktop) !== currentSignature
      ) return parsed.desktop
    } catch {}
  }
  return null
}

const remapWorkspaceForCurrentDesktop = async ({ useSnapshotFallback = false } = {}) => {
  if (!workspaceState) return { changed: false, remappedWidgets: 0 }
  const currentLayout = captureSnapshotDesktop()
  let sourceLayout = workspaceState.desktopLayout
  if (
    (!sourceLayout || !Array.isArray(sourceLayout.displays) || !sourceLayout.displays.length)
    && useSnapshotFallback
  ) {
    sourceLayout = await latestDifferentSnapshotDesktopLayout(currentLayout)
  }
  const previousState = JSON.stringify(workspaceState)
  let remappedWidgets = 0
  if (sourceLayout?.displays?.length) {
    const remapped = remapWorkspaceLayout(workspaceState, sourceLayout.displays, currentLayout.displays)
    workspaceState = remapped.workspace
    remappedWidgets = remapped.remappedWidgets
  }
  workspaceState.desktopLayout = currentLayout
  return {
    changed: JSON.stringify(workspaceState) !== previousState,
    remappedWidgets,
    sourceLayout,
    currentLayout,
  }
}

const snapshotContentHash = (workspace, desktop) => crypto
  .createHash('sha256')
  .update(JSON.stringify({ workspace, desktop }))
  .digest('hex')

const snapshotRetention = () => Math.min(
  100,
  Math.max(5, Number.parseInt(workspaceState?.settings?.snapshotRetention, 10) || 30),
)

const readSnapshotDocument = async (filePath) => {
  const stat = await fs.promises.stat(filePath)
  if (stat.size > 10 * 1024 * 1024) throw new Error('快照文件超过 10 MB，已拒绝读取')
  const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'))
  return validateSnapshotDocument(parsed)
}

const listWorkspaceSnapshots = async () => {
  const directory = snapshotDirectory()
  let entries = []
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const summaries = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.tmp.json')) continue
    const filePath = path.join(directory, entry.name)
    try {
      const [document, stat] = await Promise.all([
        readSnapshotDocument(filePath),
        fs.promises.stat(filePath),
      ])
      summaries.push({
        id: document.id,
        createdAt: document.createdAt,
        reason: document.reason || '配置快照',
        appVersion: document.appVersion || '',
        widgetCount: document.workspace.widgets.length,
        displayCount: document.desktop.displays.length,
        sizeBytes: stat.size,
        contentHash: document.contentHash || '',
        fileDataIncluded: false,
      })
    } catch (error) {
      console.warn(`[snapshots] ignored invalid snapshot ${entry.name}: ${error.message}`)
    }
  }
  return summaries.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

const pruneWorkspaceSnapshots = async () => {
  const snapshots = await listWorkspaceSnapshots()
  for (const snapshot of snapshots.slice(snapshotRetention())) {
    await fs.promises.unlink(snapshotFilePath(snapshot.id)).catch(() => {})
  }
}

const createWorkspaceSnapshot = async (reason = '手动快照') => {
  if (capturePath || desktopHostTest || desktopTrayTest || !workspaceState) return null
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/\D/g, '').slice(0, 17)}-${crypto.randomBytes(5).toString('hex')}`
  const desktop = captureSnapshotDesktop()
  const workspace = cloneWorkspace()
  const document = {
    schemaVersion: snapshotSchemaVersion,
    id,
    createdAt,
    reason: String(reason || '配置快照').slice(0, 80),
    appVersion: app.getVersion(),
    fileDataIncluded: false,
    desktop,
    workspace,
  }
  document.contentHash = snapshotContentHash(workspace, desktop)
  const destination = snapshotFilePath(id)
  await writeJsonAtomically(destination, document)
  await pruneWorkspaceSnapshots()
  return (await listWorkspaceSnapshots()).find((snapshot) => snapshot.id === id) || null
}

const maybeCreateAutomaticSnapshot = async (reason = '自动快照') => {
  if (
    capturePath
    || desktopHostTest
    || desktopTrayTest
    || snapshotRestoreInProgress
    || workspaceState?.settings?.snapshotAutoEnabled === false
  ) return null
  return enqueueSnapshotMutation(async () => {
    const snapshots = await listWorkspaceSnapshots()
    const latest = snapshots[0]
    const desktop = captureSnapshotDesktop()
    const contentHash = snapshotContentHash(cloneWorkspace(), desktop)
    if (latest?.contentHash === contentHash) return latest
    const latestTime = Date.parse(latest?.createdAt || '')
    if (Number.isFinite(latestTime) && Date.now() - latestTime < 6 * 60 * 60 * 1000) return latest
    return createWorkspaceSnapshot(reason)
  })
}

const createAutomaticSafetySnapshot = async (reason) => {
  if (workspaceState?.settings?.snapshotAutoEnabled === false || capturePath || desktopHostTest || desktopTrayTest) {
    return null
  }
  return enqueueSnapshotMutation(() => createWorkspaceSnapshot(reason))
}

const organizerFileIdentityKeys = (file) => {
  const keys = []
  if (typeof file?.shellClsid === 'string' && file.shellClsid) keys.push(`shell:${file.shellClsid.toLocaleLowerCase()}`)
  if (typeof file?.originalPath === 'string' && file.originalPath) keys.push(`original:${path.resolve(file.originalPath).toLocaleLowerCase()}`)
  if (typeof file?.path === 'string' && file.path) {
    keys.push(file.path.toLocaleLowerCase().startsWith('shell:::')
      ? `shell-path:${file.path.toLocaleLowerCase()}`
      : `path:${path.resolve(file.path).toLocaleLowerCase()}`)
  }
  if (typeof file?.id === 'string' && file.id) keys.push(`id:${file.id}`)
  return keys
}

const currentOrganizerEntries = () => (workspaceState?.widgets || []).flatMap((widget) => (
  widget.kind === 'organizer'
    ? (Array.isArray(widget.data?.files) ? widget.data.files : []).map((file) => ({ widget, file }))
    : []
))

const findCurrentOrganizerEntry = (snapshotFile, excludedPaths = new Set()) => {
  const requestedKeys = new Set(organizerFileIdentityKeys(snapshotFile))
  return currentOrganizerEntries().find(({ file }) => (
    !excludedPaths.has(file.path)
    && organizerFileIdentityKeys(file).some((key) => requestedKeys.has(key))
  )) || null
}

const restoreWorkspaceSnapshot = async (snapshotId) => {
  const snapshot = await readSnapshotDocument(snapshotFilePath(snapshotId))
  await createWorkspaceSnapshot('恢复前保护')
  snapshotRestoreInProgress = true
  const missingFiles = []
  const movementErrors = []
  try {
    const snapshotOrganizers = snapshot.workspace.widgets.filter((widget) => widget.kind === 'organizer')
    const staging = cloneWorkspace()
    for (const organizer of snapshotOrganizers) {
      if (staging.widgets.some((widget) => widget.id === organizer.id && widget.kind === 'organizer')) continue
      staging.widgets.push({ ...organizer, data: { ...organizer.data, files: [] } })
    }
    await updateWorkspace(staging)

    for (const targetOrganizer of snapshotOrganizers) {
      for (const snapshotFile of Array.isArray(targetOrganizer.data?.files) ? targetOrganizer.data.files : []) {
        const currentEntry = findCurrentOrganizerEntry(snapshotFile)
        if (!currentEntry) {
          missingFiles.push(snapshotFile.name || snapshotFile.path || '未知文件')
          continue
        }
        if (currentEntry.widget.id === targetOrganizer.id) continue
        try {
          await moveOrganizerFileBetweenWidgets(
            currentEntry.widget.id,
            targetOrganizer.id,
            currentEntry.file.path,
          )
        } catch (error) {
          movementErrors.push(`${snapshotFile.name || '未知文件'}：${error.message}`)
        }
      }
    }

    const finalWorkspace = JSON.parse(JSON.stringify(snapshot.workspace))
    finalWorkspace.version = 1
    finalWorkspace.settings = { ...defaultWorkspace().settings, ...(snapshot.workspace.settings || {}) }
    const consumedPaths = new Set()
    for (const organizer of finalWorkspace.widgets.filter((widget) => widget.kind === 'organizer')) {
      const restoredFiles = []
      for (const snapshotFile of Array.isArray(organizer.data?.files) ? organizer.data.files : []) {
        const currentEntry = findCurrentOrganizerEntry(snapshotFile, consumedPaths)
        if (!currentEntry || currentEntry.widget.id !== organizer.id) continue
        consumedPaths.add(currentEntry.file.path)
        restoredFiles.push(currentEntry.file)
      }
      organizer.data = { ...organizer.data, files: restoredFiles }
    }

    let preservedFiles = 0
    for (const { widget: currentWidget, file } of currentOrganizerEntries()) {
      if (consumedPaths.has(file.path)) continue
      let target = finalWorkspace.widgets.find((widget) => widget.id === currentWidget.id && widget.kind === 'organizer')
      if (!target) {
        target = {
          ...currentWidget,
          title: `${currentWidget.title}（恢复保留）`,
          data: { ...currentWidget.data, files: [] },
        }
        finalWorkspace.widgets.push(target)
      }
      const targetFiles = Array.isArray(target.data?.files) ? target.data.files : []
      if (!targetFiles.some((candidate) => candidate.path === file.path)) targetFiles.push(file)
      target.data = { ...target.data, files: targetFiles }
      consumedPaths.add(file.path)
      preservedFiles += 1
    }

    const remapped = remapWorkspaceLayout(
      finalWorkspace,
      snapshot.desktop.displays,
      captureSnapshotDesktop().displays,
    )
    await updateWorkspace(remapped.workspace)
    applyLoginItemSettings(Boolean(remapped.workspace.settings.launchAtLogin))
    await setDesktopEnabled(remapped.workspace.settings.desktopEnabled !== false)
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu())
    return {
      workspace: cloneWorkspace(),
      missingFiles,
      preservedFiles,
      remappedWidgets: remapped.remappedWidgets,
      movementErrors,
    }
  } finally {
    snapshotRestoreInProgress = false
  }
}

const runWorkspaceSnapshotIntegration = async () => {
  const missingPath = path.join(app.getPath('userData'), 'missing-snapshot-file.txt')
  const currentOnlyPath = path.join(app.getPath('userData'), 'current-only-file.txt')
  await fs.promises.mkdir(app.getPath('userData'), { recursive: true })
  await fs.promises.writeFile(currentOnlyPath, 'current-only', 'utf8')
  workspaceState = {
    version: 1,
    settings: {
      ...defaultWorkspace().settings,
      snapshotAutoEnabled: false,
      snapshotRetention: 10,
    },
    widgets: [
      {
        id: 'snapshot-note',
        kind: 'note',
        title: '快照前标题',
        tone: 'yellow',
        x: 40,
        y: 50,
        width: 280,
        height: 220,
        hidden: false,
        data: { content: '快照内容', updatedAt: '2026-08-22T00:00:00.000Z' },
      },
      {
        id: 'snapshot-organizer',
        kind: 'organizer',
        title: '快照收纳盒',
        tone: 'paper',
        x: 420,
        y: 80,
        width: 360,
        height: 260,
        hidden: false,
        data: {
          files: [{
            id: 'missing-file',
            path: missingPath,
            originalPath: missingPath,
            name: 'missing-snapshot-file.txt',
            extension: 'txt',
            size: 12,
            isDirectory: false,
            modifiedAt: '2026-08-22T00:00:00.000Z',
          }],
        },
      },
    ],
  }
  await persistWorkspace()
  const snapshot = await createWorkspaceSnapshot('集成测试快照')
  if (!snapshot) throw new Error('snapshot integration could not create snapshot')
  const mutated = cloneWorkspace()
  mutated.widgets[0].title = '已修改标题'
  mutated.widgets[0].x = 900
  const currentOnlyFile = await describePath(currentOnlyPath)
  mutated.widgets.find((widget) => widget.id === 'snapshot-organizer').data.files = [{
    ...currentOnlyFile,
    originalPath: currentOnlyPath,
  }]
  await updateWorkspace(mutated)
  const restored = await restoreWorkspaceSnapshot(snapshot.id)
  const restoredNote = restored.workspace.widgets.find((widget) => widget.id === 'snapshot-note')
  const restoredOrganizer = restored.workspace.widgets.find((widget) => widget.id === 'snapshot-organizer')
  const snapshots = await listWorkspaceSnapshots()
  const rawSnapshot = await readSnapshotDocument(snapshotFilePath(snapshot.id))
  if (
    restoredNote?.title !== '快照前标题'
    || restoredNote?.data?.content !== '快照内容'
    || restored.missingFiles.length !== 1
    || restored.preservedFiles !== 1
    || restoredOrganizer?.data?.files?.[0]?.path !== currentOnlyPath
    || rawSnapshot.fileDataIncluded !== false
    || snapshots.length < 2
  ) {
    throw new Error(`snapshot integration mismatch: ${JSON.stringify({ restoredNote, restoredOrganizer, restored, snapshots: snapshots.length })}`)
  }
  console.log('[snapshots] integration assertion passed: atomic create + pre-restore protection + missing-file skip + newer-reference preservation + configuration restore')
}

const enqueueWorkspaceMutation = (operation) => {
  const result = workspaceMutationTail.then(operation, operation)
  workspaceMutationTail = result.catch(() => {})
  return result
}

const virtualScreenBounds = () => {
  const displays = screen.getAllDisplays()
  const left = Math.min(...displays.map((display) => display.workArea.x))
  const top = Math.min(...displays.map((display) => display.workArea.y))
  const right = Math.max(...displays.map((display) => display.workArea.x + display.workArea.width))
  const bottom = Math.max(...displays.map((display) => display.workArea.y + display.workArea.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

const runtimeDisplayTopologySignature = () => JSON.stringify(
  screen.getAllDisplays()
    .map((display) => ({
      id: String(display.id),
      primary: display.id === screen.getPrimaryDisplay().id,
      scaleFactor: display.scaleFactor,
      bounds: display.bounds,
      workArea: display.workArea,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
)

const waitForStableDisplayTopology = async ({ stableMs = 900, timeoutMs = 5_000 } = {}) => {
  const startedAt = Date.now()
  let signature = runtimeDisplayTopologySignature()
  let stableSince = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const nextSignature = runtimeDisplayTopologySignature()
    if (nextSignature !== signature) {
      signature = nextSignature
      stableSince = Date.now()
      continue
    }
    if (Date.now() - stableSince >= stableMs) break
  }
  return signature
}

const primaryScreenOffset = () => {
  const virtualBounds = virtualScreenBounds()
  const primaryBounds = screen.getPrimaryDisplay().workArea
  return {
    x: primaryBounds.x - virtualBounds.x,
    y: primaryBounds.y - virtualBounds.y,
  }
}

const currentDesktopInfo = () => {
  const virtualBounds = virtualScreenBounds()
  const primaryBounds = screen.getPrimaryDisplay().workArea
  const primaryId = String(screen.getPrimaryDisplay().id)
  return {
    desktopPath: app.getPath('desktop'),
    virtualBounds,
    primaryBounds: {
      x: primaryBounds.x - virtualBounds.x,
      y: primaryBounds.y - virtualBounds.y,
      width: primaryBounds.width,
      height: primaryBounds.height,
    },
    displays: screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      primary: String(display.id) === primaryId,
      scaleFactor: display.scaleFactor,
      bounds: {
        x: display.workArea.x - virtualBounds.x,
        y: display.workArea.y - virtualBounds.y,
        width: display.workArea.width,
        height: display.workArea.height,
      },
    })),
  }
}

const widgetEdgeGap = 8
const widgetTopEdgeGap = 0

const widgetMinimumSize = (kind) => (
  kind === 'organizer'
    ? { width: 88, height: 122 }
    : { width: 240, height: 190 }
)

const distanceToBounds = (point, bounds) => {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width))
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height))
  return dx * dx + dy * dy
}

const nearestDisplayBounds = (point) => currentDesktopInfo().displays.reduce((nearest, display) => {
  if (!nearest) return display.bounds
  return distanceToBounds(point, display.bounds) < distanceToBounds(point, nearest) ? display.bounds : nearest
}, null)

const constrainWidgetFrame = (widget) => {
  const minimumSize = widgetMinimumSize(widget.kind)
  const width = Number.isFinite(widget.width)
    ? Math.max(minimumSize.width, Math.min(900, widget.width))
    : 280
  const height = Number.isFinite(widget.height)
    ? Math.max(minimumSize.height, Math.min(760, widget.height))
    : 220
  const x = Number.isFinite(widget.x) ? widget.x : widgetEdgeGap
  const y = Number.isFinite(widget.y) ? widget.y : widgetEdgeGap
  const bounds = nearestDisplayBounds({ x: x + width / 2, y: y + height / 2 })
  if (!bounds) return { ...widget, x, y, width, height }

  // Only shrink a component when it physically cannot fit on the target display.
  const fittedWidth = Math.min(width, Math.max(1, bounds.width - widgetEdgeGap * 2))
  const fittedHeight = Math.min(height, Math.max(1, bounds.height - widgetTopEdgeGap - widgetEdgeGap))
  const minX = bounds.x + widgetEdgeGap
  const minY = bounds.y + widgetTopEdgeGap
  const maxX = Math.max(minX, bounds.x + bounds.width - fittedWidth - widgetEdgeGap)
  const maxY = Math.max(minY, bounds.y + bounds.height - fittedHeight - widgetEdgeGap)
  return {
    ...widget,
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
    width: Math.round(fittedWidth),
    height: Math.round(fittedHeight),
  }
}

const constrainWorkspaceWidgetFrames = () => {
  if (!workspaceState) return false
  let changed = false
  workspaceState.widgets = workspaceState.widgets.map((widget) => {
    const constrained = constrainWidgetFrame(widget)
    if (['x', 'y', 'width', 'height'].some((key) => constrained[key] !== widget[key])) changed = true
    return constrained
  })
  return changed
}

const pointInsideBounds = (point, bounds) => (
  point.x >= bounds.x
  && point.x < bounds.x + bounds.width
  && point.y >= bounds.y
  && point.y < bounds.y + bounds.height
)

const setDesktopWindowInteractive = (win, interactive) => {
  if (!win || win.isDestroyed()) return
  const nextInteractive = Boolean(interactive)
  if (win.desktopPointerInteractive === nextInteractive) return
  win.desktopPointerInteractive = nextInteractive
  if (nextInteractive) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}

const ensureDesktopOrganizerInteractive = (win, { force = false } = {}) => {
  if (!win || win.isDestroyed()) return
  // Changing the native mouse-ignore state while Chromium owns pointer capture
  // cancels otherwise valid drag/resize gestures. Keep the known-good state
  // stable; the native band health check explicitly forces a repair only after
  // it has detected real WS_EX_TRANSPARENT/style drift.
  if (win.desktopInteractionLocked) return
  if (!force && win.desktopPointerInteractive === true) return
  win.setIgnoreMouseEvents(false)
  win.desktopOrganizerInputMutationCount = (win.desktopOrganizerInputMutationCount || 0) + 1
  win.desktopPointerInteractive = true
  win.desktopOrganizerInteractionAppliedAt = Date.now()
}

const refreshDesktopPointerHitTest = (cursorOverride = null) => {
  if (!workspaceState?.settings.desktopEnabled) return
  if (desktopDragTest) {
    for (const win of liveDesktopWindows()) setDesktopWindowInteractive(win, true)
    return
  }
  // Organizer BrowserWindows are permanently interactive, clipped to their
  // own rounded shapes and parented below applications. They do not need the
  // legacy 32 ms overlay hit-test used by note/todo/pomodoro windows.
  const hitTestWindows = liveDesktopWindows().filter((win) => win.desktopWidgetKind !== 'organizer')
  if (!hitTestWindows.length) return
  const virtualBounds = virtualScreenBounds()
  const cursor = cursorOverride || screen.getCursorScreenPoint()
  const point = { x: cursor.x - virtualBounds.x, y: cursor.y - virtualBounds.y }
  const displays = currentDesktopInfo().displays
  for (const win of hitTestWindows) {
    const hostedWidget = win.desktopWidgetId
      ? workspaceState.widgets.find((widget) => widget.id === win.desktopWidgetId && !widget.hidden)
      : null
    const display = displays.find((candidate) => candidate.id === win.desktopDisplayId)
    const nativeBounds = hostedWidget ? win.getBounds() : null
    const hostedWidgetBounds = nativeBounds ? {
      x: nativeBounds.x - virtualBounds.x + desktopWidgetWindowMargin,
      y: nativeBounds.y - virtualBounds.y + desktopWidgetWindowMargin,
      width: hostedWidget.width,
      height: hostedWidget.height,
    } : null
    const overWidget = hostedWidgetBounds
      ? pointInsideBounds(point, hostedWidgetBounds)
      : Boolean(display && pointInsideBounds(point, display.bounds) && workspaceState.widgets.some((widget) => (
        !widget.hidden
        && pointInsideBounds(point, widget)
      )))
    setDesktopWindowInteractive(win, win.desktopInteractionLocked || overWidget)
  }
}

const startDesktopPointerHitTest = () => {
  if (desktopPointerHitTestTimer) return
  desktopPointerHitTestTimer = setInterval(refreshDesktopPointerHitTest, 32)
}

const refreshDesktopOrganizerBandHealth = async () => {
  if (
    desktopOrganizerBandHealthInFlight
    || !useDesktopWidgetWindows
    || !workspaceState?.settings.desktopEnabled
  ) return null
  let organizers = desktopOrganizerBandWindows()
    .filter((win) => !win.desktopAttachmentInFlight)
  if (!organizers.length) return null

  desktopOrganizerBandHealthInFlight = true
  try {
    const lockedOrganizers = organizers
      .filter((win) => win.desktopInteractionLocked)
      .sort((left, right) => (
        (left.desktopInteractionLockedAt || 0) - (right.desktopInteractionLockedAt || 0)
      ))
    if (lockedOrganizers.length) {
      const pointer = await desktopIconHelperRequest('pointer-state', {}, 1_200)
      if (!pointer || pointer.LeftDown !== false) return null
      for (const win of lockedOrganizers) finishDesktopWindowInteraction(win)
      organizers = desktopOrganizerBandWindows()
      console.warn(`[desktop-host] released ${lockedOrganizers.length} stale organizer interaction lock(s) after native pointer-up`)
    }
    const results = []
    const displayIds = [...new Set(organizers.map((win) => win.desktopDisplayId))]
    for (const displayId of displayIds) {
      const displayOrganizers = organizers.filter((win) => win.desktopDisplayId === displayId)
      const organizerHost = desktopOrganizerHostForDisplay(displayId)
      if (!organizerHost) continue
      const result = await desktopIconHelperRequest('organizer-band-health', {
        organizerHostHwnd: getWindowHandle(organizerHost),
        hwnds: displayOrganizers.map(getWindowHandle),
      }, 1_200)
      results.push(result)
      const healthyAfter = Boolean(result?.HealthyAfter ?? result?.healthyAfter)
      const repairedOrganizerHandles = new Set(
        (result?.RepairedHandles || result?.repairedHandles || []).map(String),
      )
      let recoveredAttachmentMetadata = false
      if (healthyAfter) {
        for (const win of displayOrganizers) {
          win.desktopOrganizerChildAttached = true
          if (
            win.desktopAttached !== true
            || !win.desktopOrganizerLayerResult?.includes('placement=desktop-child')
          ) {
            win.desktopAttached = true
            win.desktopOrganizerLayerResult = `recovered parent=${getWindowHandle(organizerHost)} placement=desktop-child no-activate=False`
            recoveredAttachmentMetadata = true
          }
        }
      }
      // A pointer press may have started while the native helper was inspecting
      // the band. Never touch Chromium's input state until that gesture ends.
      if (
        ((result?.Repaired || result?.repaired) || recoveredAttachmentMetadata)
        && !displayOrganizers.some((win) => win.desktopInteractionLocked)
      ) {
        for (const win of displayOrganizers) {
          if (repairedOrganizerHandles.has(getWindowHandle(win))) {
            ensureDesktopOrganizerInteractive(win, { force: true })
          }
        }
        console.log(`[desktop-host] organizer band recovered on display=${displayId}: ${result.Reason || result.reason || 'native desktop topology drift'}; touched=${repairedOrganizerHandles.size}${recoveredAttachmentMetadata ? ' + attachment metadata' : ''}`)
      }
    }
    if (results.length === 1) return results[0]
    return {
      HealthyAfter: results.length > 0 && results.every((result) => Boolean(result?.HealthyAfter ?? result?.healthyAfter)),
      Repaired: results.some((result) => Boolean(result?.Repaired ?? result?.repaired)),
      RepairedHandles: results.flatMap((result) => result?.RepairedHandles || result?.repairedHandles || []),
      Reason: results.map((result) => result?.Reason || result?.reason).filter(Boolean).join('; '),
    }
  } catch (error) {
    console.warn(`[desktop-host] organizer band health check failed: ${error.message}`)
    return null
  } finally {
    desktopOrganizerBandHealthInFlight = false
    flushDesktopOrganizerDeferredPromotions()
  }
}

const startDesktopOrganizerBandHealth = () => {
  if (desktopOrganizerBandHealthTimer || !useDesktopWidgetWindows) return
  desktopOrganizerBandHealthTimer = setInterval(() => {
    void refreshDesktopOrganizerBandHealth()
    // Child Z-order is owned by Progman and does not need continuous global
    // reassertion. This timer now only detects Explorer/GPU host replacement,
    // stale interaction locks and stable outer-window style damage.
  }, 1_000)
}

const startDesktopWidgetGeometryHealth = () => {
  if (desktopWidgetGeometryHealthTimer || !useDesktopWidgetWindows) return
  // Display and GPU events schedule immediate targeted reconciliation. This
  // low-frequency audit is only a fallback for missed native notifications.
  desktopWidgetGeometryHealthTimer = setInterval(() => {
    void refreshDesktopWidgetGeometryHealth()
  }, 8_000)
}

const broadcastDesktopInfo = () => {
  const info = currentDesktopInfo()
  for (const win of liveAppWindows()) {
    win.webContents.send('desktop:info-changed', info)
  }
}

const scheduleDisplayRefresh = () => {
  if (displayRefreshTimer) clearTimeout(displayRefreshTimer)
  const topologyChanged = runtimeDisplayTopologySignature() !== desktopTopologySignature
  const hiddenForTopologyChange = topologyChanged ? workspaceDesktopOrganizerWindows() : []
  if (topologyChanged) {
    for (const win of hiddenForTopologyChange) win.setOpacity(0.01)
  }
  displayRefreshTimer = setTimeout(async () => {
    try {
      displayRefreshTimer = null
      const settledSignature = await waitForStableDisplayTopology({ stableMs: 750, timeoutMs: 3_500 })
      const confirmedTopologyChange = settledSignature !== desktopTopologySignature
      if (confirmedTopologyChange) {
        const remapped = await remapWorkspaceForCurrentDesktop()
        if (remapped.changed) await persistWorkspace()
        desktopTopologySignature = settledSignature
      }
      if (useDesktopWidgetWindows) {
        if (confirmedTopologyChange) await rebuildDesktopOrganizerHosts()
        else await ensureDesktopOrganizerHostWindows()
        if (constrainWorkspaceWidgetFrames()) await persistWorkspace()
        syncDesktopWidgetWindows()
        broadcastDesktopInfo()
        broadcastWorkspace()
        if (workspaceState?.settings.desktopEnabled) await attachMissingDesktopWindows()
        // A metrics notification with an unchanged topology is not evidence of
        // damaged widget geometry. Windows emits these while native children are
        // still attaching; auditing every organizer at that moment used to turn
        // a harmless transient into a destructive resize/recreation cycle.
        return
      }
      const displays = screen.getAllDisplays()
      const liveIds = new Set(displays.map((display) => String(display.id)))
      for (const [displayId, win] of desktopWindows) {
        if (!liveIds.has(displayId)) {
          desktopWindows.delete(displayId)
          win.destroy()
        }
      }
      for (const display of displays) {
        const displayId = String(display.id)
        const win = desktopWindows.get(displayId)
        if (win && !win.isDestroyed()) win.setBounds(display.workArea)
        else createDesktopWindow(display)
      }
      desktopWindow = desktopWindows.get(String(screen.getPrimaryDisplay().id)) || liveDesktopWindows()[0] || null
      broadcastDesktopInfo()
      if (constrainWorkspaceWidgetFrames()) {
        await persistWorkspace()
        broadcastWorkspace()
      }
      if (workspaceState?.settings.desktopEnabled) await attachDesktopWindows()
    } catch (error) {
      console.error(`[desktop-host] display refresh failed: ${error.message}`)
    } finally {
      // A failed or superseded topology refresh must never leave previously
      // healthy widgets effectively invisible.
      for (const win of hiddenForTopologyChange) {
        if (!win.isDestroyed() && !win.desktopAttachmentInFlight) win.setOpacity(1)
      }
    }
  }, 850)
}

const getWindowHandle = (win) => {
  const handle = win.getNativeWindowHandle()
  return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : handle.readUInt32LE(0).toString()
}

const desktopWidgetGeometryMetricValue = (metric, key) => metric?.[key] ?? metric?.[
  `${key.charAt(0).toLowerCase()}${key.slice(1)}`
]

const desktopWidgetExpectedPhysicalSize = (widget, metric) => {
  const requestedBounds = desktopWidgetWindowBounds(widget)
  const widgetWindow = desktopWidgetWindows.get(widget.id)
  const display = widgetWindow && isOrganizerWidgetWindow(widgetWindow)
    ? desktopDisplayById(widgetWindow.desktopDisplayId)
    : null
  const scaleFactor = display?.scaleFactor
    || (Number(desktopWidgetGeometryMetricValue(metric, 'Dpi')) || 96) / 96
  return {
    width: Math.max(1, Math.round(requestedBounds.width * scaleFactor)),
    height: Math.max(1, Math.round(requestedBounds.height * scaleFactor)),
  }
}

const desktopWidgetNativeGeometryMismatch = (widget, metric, renderer = null) => {
  if (!metric || desktopWidgetGeometryMetricValue(metric, 'Valid') === false) return true
  const fallbackExpected = desktopWidgetExpectedPhysicalSize(widget, metric)
  const rendererScale = Number(renderer?.devicePixelRatio)
  const rendererInnerWidth = Number(renderer?.innerWidth)
  const rendererInnerHeight = Number(renderer?.innerHeight)
  // Once a BrowserWindow becomes a child of the per-monitor-DPI Progman host,
  // Windows may round its client size a few DIPs away from the bounds Electron
  // originally requested. That is stable and harmless as long as Chromium's
  // committed surface matches the native client. Comparing it forever against
  // the pre-parenting request made every window look damaged at 175% scaling.
  const expected = (
    Number.isFinite(rendererScale)
    && rendererScale > 0
    && Number.isFinite(rendererInnerWidth)
    && rendererInnerWidth > 0
    && Number.isFinite(rendererInnerHeight)
    && rendererInnerHeight > 0
  ) ? {
      width: rendererInnerWidth * rendererScale,
      height: rendererInnerHeight * rendererScale,
    } : fallbackExpected
  const width = Number(desktopWidgetGeometryMetricValue(metric, 'ClientWidth'))
  const height = Number(desktopWidgetGeometryMetricValue(metric, 'ClientHeight'))
  const renderWidth = Number(desktopWidgetGeometryMetricValue(metric, 'RenderWidth'))
  const renderHeight = Number(desktopWidgetGeometryMetricValue(metric, 'RenderHeight'))
  const rendererOwnsCompleteSurface = (
    Number.isFinite(rendererInnerWidth)
    && Number.isFinite(rendererInnerHeight)
    && rendererInnerWidth + 1 >= widget.width
    && rendererInnerHeight + 1 >= widget.height
    && rendererInnerWidth - widget.width <= 6
    && rendererInnerHeight - widget.height <= 6
  )
  return (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || Math.abs(width - expected.width) > 4
    || Math.abs(height - expected.height) > 4
    // Chrome_RenderWidgetHostHWND is DPI-virtualized after its BrowserWindow
    // becomes a cross-process Explorer child. Its rectangle can be smaller
    // than the DComp surface even when the DOM viewport and outer client are
    // exact. Treating that as damage caused the health pass itself to shrink
    // otherwise healthy organizer renderers.
    || (!rendererOwnsCompleteSurface && renderWidth > 0 && Math.abs(renderWidth - expected.width) > 4)
    || (!rendererOwnsCompleteSurface && renderHeight > 0 && Math.abs(renderHeight - expected.height) > 4)
  )
}

const inspectDesktopWidgetRendererGeometry = async (win) => {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null
  try {
    return await win.webContents.executeJavaScript(`(() => {
      const widget = document.querySelector('.desktop-widget')
      const rect = widget?.getBoundingClientRect()
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        widgetWidth: rect?.width || 0,
        widgetHeight: rect?.height || 0,
      }
    })()`)
  } catch {
    return null
  }
}

const desktopWidgetRendererGeometryMismatch = (widget, renderer) => {
  if (!renderer) return true
  const targetDisplay = screen.getAllDisplays().find((display) => String(display.id) === desktopWidgetDisplayId(widget))
  const innerWidth = Number(renderer.innerWidth)
  const innerHeight = Number(renderer.innerHeight)
  const widgetWidth = Number(renderer.widgetWidth)
  const widgetHeight = Number(renderer.widgetHeight)
  return (
    !Number.isFinite(innerWidth)
    || !Number.isFinite(innerHeight)
    || innerWidth + 1 < widgetWidth
    || innerHeight + 1 < widgetHeight
    || innerWidth - widgetWidth > 6
    || innerHeight - widgetHeight > 6
    || Math.abs(widgetWidth - widget.width) > 1
    || Math.abs(widgetHeight - widget.height) > 1
    || (targetDisplay && Math.abs(Number(renderer.devicePixelRatio) - targetDisplay.scaleFactor) > 0.01)
  )
}

const commitDesktopWidgetSurface = async (win, widget, reason) => {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false
  try {
    win.webContents.send('desktop:info-changed', currentDesktopInfo())
    win.webContents.send('workspace:changed', cloneWorkspace())
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      window.dispatchEvent(new Event('resize'))
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })`)
    if (win.isDestroyed() || win.webContents.isDestroyed()) return false
    if (widget.kind === 'organizer') {
      const bounds = desktopWidgetWindowBounds(widget)
      applyDesktopOrganizerWindowShape(win, desktopWidgetNativeBounds(win, bounds))
    }
    if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate()
    // A capture forces Chromium/DComp to publish the new alpha surface. This is
    // required even when HWND and DOM metrics already look correct after a DPI
    // hand-off or a compositor/GPU reset.
    await win.webContents.capturePage()
    if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate()
    win.desktopLastGeometrySurfaceCommitAt = Date.now()
    win.desktopLastGeometrySurfaceCommitReason = reason
    return true
  } catch (error) {
    console.warn(`[desktop-geometry] widget=${widget.id} surface commit failed (${reason}): ${error.message}`)
    return false
  }
}

const reconcileDesktopWidgetGeometry = async (win, options = {}) => {
  if (
    !win
    || win.isDestroyed()
    || win.desktopAttachmentInFlight
    || win.desktopInteractionLocked
    || win.desktopGeometryReconcileInFlight
    || win.desktopNativeClientBoundsInFlight
    || win.desktopPendingNativeClientBounds
  ) return false
  const widget = workspaceState?.widgets.find((candidate) => (
    candidate.id === win.desktopWidgetId && !candidate.hidden
  ))
  if (!widget) return false

  win.desktopGeometryReconcileInFlight = true
  const reason = options.reason || 'periodic-health'
  try {
    const handle = getWindowHandle(win)
    const metrics = await desktopIconHelperRequest('window-geometries', { hwnds: [handle] }, 1_200)
    const metric = Array.isArray(metrics) ? metrics[0] : metrics
    const renderer = await inspectDesktopWidgetRendererGeometry(win)
    const nativeMismatch = desktopWidgetNativeGeometryMismatch(widget, metric, renderer)
    const rendererMismatch = desktopWidgetRendererGeometryMismatch(widget, renderer)

    if (widget.kind === 'organizer' && (nativeMismatch || rendererMismatch)) {
      await recreateDesktopOrganizerWindow(win, widget, reason)
      console.warn(`[desktop-geometry] recreated organizer=${widget.id} reason=${reason} native=${nativeMismatch} renderer=${rendererMismatch}`)
      return true
    }

    if (nativeMismatch) {
      const requestedBounds = desktopWidgetWindowBounds(widget)
      const nativeRequestedBounds = desktopWidgetNativeBounds(win, requestedBounds)
      win.desktopProgrammaticMoveUntil = Date.now() + 200
      setDesktopWidgetWindowBounds(win, requestedBounds)
      await desktopIconHelperRequest('resize-window-for-dpi', {
        hwnd: handle,
        logicalWidth: nativeRequestedBounds.width,
        logicalHeight: nativeRequestedBounds.height,
      }, 1_200)
    }

    if (nativeMismatch || rendererMismatch || options.forceSurface) {
      await commitDesktopWidgetSurface(win, widget, reason)
      console.warn(`[desktop-geometry] reconciled widget=${widget.id} reason=${reason} native=${nativeMismatch} renderer=${rendererMismatch}`)
    }
    return nativeMismatch || rendererMismatch
  } catch (error) {
    console.warn(`[desktop-geometry] widget=${widget.id} reconciliation failed (${reason}): ${error.message}`)
    return false
  } finally {
    if (!win.isDestroyed()) win.desktopGeometryReconcileInFlight = false
  }
}

const scheduleDesktopWidgetGeometryReconcile = (win, options = {}) => {
  if (!win || win.isDestroyed()) return
  const widgetId = win.desktopWidgetId
  const token = Symbol(widgetId || 'desktop-widget')
  desktopWidgetGeometryRecoveryTokens.set(widgetId, token)
  const delays = Array.isArray(options.delays) && options.delays.length ? options.delays : [80, 260]
  for (const delay of delays) {
    setTimeout(() => {
      if (
        desktopWidgetGeometryRecoveryTokens.get(widgetId) !== token
        || win.isDestroyed()
      ) return
      void reconcileDesktopWidgetGeometry(win, {
        reason: options.reason || 'scheduled-reconcile',
        forceSurface: options.forceSurface !== false,
      })
    }, delay)
  }
}

const scheduleAllDesktopWidgetGeometryReconcile = (
  reason,
  delays = [120, 420],
  { forceSurface = true } = {},
) => {
  for (const win of liveDesktopWidgetWindows()) {
    scheduleDesktopWidgetGeometryReconcile(win, { reason, delays, forceSurface })
  }
}

const refreshDesktopWidgetGeometryHealth = async () => {
  const now = Date.now()
  if (
    desktopWidgetGeometryHealthInFlight
    || now - desktopWidgetGeometryHealthLastAt < 750
    || !workspaceState?.settings.desktopEnabled
    || liveDesktopWidgetWindows().some((win) => win.desktopInteractionLocked)
  ) return false
  const windows = liveDesktopWidgetWindows().filter((win) => (
    !win.desktopAttachmentInFlight
    && !win.desktopInteractionLocked
    && !win.desktopNativeClientBoundsInFlight
    && !win.desktopPendingNativeClientBounds
  ))
  if (!windows.length) return false

  desktopWidgetGeometryHealthInFlight = true
  desktopWidgetGeometryHealthLastAt = now
  try {
    const metrics = await desktopIconHelperRequest('window-geometries', {
      hwnds: windows.map(getWindowHandle),
    }, 1_500)
    const metricByHandle = new Map((Array.isArray(metrics) ? metrics : [metrics]).map((metric) => [
      String(desktopWidgetGeometryMetricValue(metric, 'Handle')),
      metric,
    ]))
    for (const win of windows) {
      if (liveDesktopWidgetWindows().some((candidate) => candidate.desktopInteractionLocked)) return false
      const widget = workspaceState.widgets.find((candidate) => candidate.id === win.desktopWidgetId)
      if (!widget) continue
      const metric = metricByHandle.get(getWindowHandle(win))
      const renderer = await inspectDesktopWidgetRendererGeometry(win)
      const mismatch = desktopWidgetNativeGeometryMismatch(widget, metric, renderer)
        || desktopWidgetRendererGeometryMismatch(widget, renderer)
      if (!mismatch) {
        desktopWidgetGeometryMismatchCounts.delete(widget.id)
        continue
      }
      const count = (desktopWidgetGeometryMismatchCounts.get(widget.id) || 0) + 1
      desktopWidgetGeometryMismatchCounts.set(widget.id, count)
      // Confirm twice to ignore the short, valid WM_DPICHANGED transition.
      if (count >= 2) {
        desktopWidgetGeometryMismatchCounts.delete(widget.id)
        void reconcileDesktopWidgetGeometry(win, { reason: 'periodic-health', forceSurface: true })
      }
    }
    return true
  } catch (error) {
    console.warn(`[desktop-geometry] periodic health check failed: ${error.message}`)
    return false
  } finally {
    desktopWidgetGeometryHealthInFlight = false
  }
}

const runDesktopHostHelper = async (win, options = {}) => {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return false
  const helperPath = runtimeElectronResourcePath('windows-desktop-host.ps1')
  const powershellPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-Hwnd',
    getWindowHandle(win),
  ]
  const helperDisplay = desktopDisplayById(win.desktopDisplayId)
  const helperClientScale = Number(helperDisplay?.scaleFactor) || 1
  args.push('-ClientScale', String(helperClientScale))
  if (options.noActivate) args.push('-NoActivate')
  if (options.desktopChild) args.push('-DesktopChild')
  if (options.parentWindow && !options.parentWindow.isDestroyed()) {
    args.push('-ParentHwnd', getWindowHandle(options.parentWindow))
  }
  if (options.inspectOnly) args.push('-InspectOnly')
  if (options.displaceOrganizerBand) args.push('-DisplaceOrganizerBand')
  if (options.clientBounds) {
    args.push(
      '-SetClientX', String(Math.round(options.clientBounds.x)),
      '-SetClientY', String(Math.round(options.clientBounds.y)),
      '-SetClientWidth', String(Math.max(1, Math.round(options.clientBounds.width))),
      '-SetClientHeight', String(Math.max(1, Math.round(options.clientBounds.height))),
    )
  }
  if (options.shapePoint && Number.isFinite(options.shapePoint.x) && Number.isFinite(options.shapePoint.y)) {
    args.push(
      '-ShapeClientX', String(Math.round(options.shapePoint.x)),
      '-ShapeClientY', String(Math.round(options.shapePoint.y)),
    )
  }
  if (options.hoverPoint && Number.isFinite(options.hoverPoint.x) && Number.isFinite(options.hoverPoint.y)) {
    args.push(
      '-HoverClientX', String(Math.round(options.hoverPoint.x)),
      '-HoverClientY', String(Math.round(options.hoverPoint.y)),
    )
  }
  if (options.inputHealthPoint && Number.isFinite(options.inputHealthPoint.x) && Number.isFinite(options.inputHealthPoint.y)) {
    args.push(
      '-InputHealthClientX', String(Math.round(options.inputHealthPoint.x)),
      '-InputHealthClientY', String(Math.round(options.inputHealthPoint.y)),
    )
  }
  if (options.directClickPoint && Number.isFinite(options.directClickPoint.x) && Number.isFinite(options.directClickPoint.y)) {
    args.push(
      '-DirectClickClientX', String(Math.round(options.directClickPoint.x)),
      '-DirectClickClientY', String(Math.round(options.directClickPoint.y)),
      '-DirectClickCount', String(Math.max(1, Math.round(options.directClickCount || 1))),
    )
  }
  if (
    options.directDragStartPoint
    && options.directDragEndPoint
    && Number.isFinite(options.directDragStartPoint.x)
    && Number.isFinite(options.directDragStartPoint.y)
    && Number.isFinite(options.directDragEndPoint.x)
    && Number.isFinite(options.directDragEndPoint.y)
  ) {
    args.push(
      '-DirectDragStartClientX', String(Math.round(options.directDragStartPoint.x)),
      '-DirectDragStartClientY', String(Math.round(options.directDragStartPoint.y)),
      '-DirectDragEndClientX', String(Math.round(options.directDragEndPoint.x)),
      '-DirectDragEndClientY', String(Math.round(options.directDragEndPoint.y)),
      '-DirectDragSteps', String(Math.max(2, Math.round(options.directDragSteps || 12))),
    )
  }
  if (options.clickPoint && Number.isFinite(options.clickPoint.x) && Number.isFinite(options.clickPoint.y)) {
    args.push(
      '-ClickClientX', String(Math.round(options.clickPoint.x)),
      '-ClickClientY', String(Math.round(options.clickPoint.y)),
      '-ClickCount', String(Math.max(1, Math.round(options.clickCount || 1))),
    )
  }
  if (
    options.dragStartPoint
    && options.dragEndPoint
    && Number.isFinite(options.dragStartPoint.x)
    && Number.isFinite(options.dragStartPoint.y)
    && Number.isFinite(options.dragEndPoint.x)
    && Number.isFinite(options.dragEndPoint.y)
  ) {
    args.push(
      '-DragStartClientX', String(Math.round(options.dragStartPoint.x)),
      '-DragStartClientY', String(Math.round(options.dragStartPoint.y)),
      '-DragEndClientX', String(Math.round(options.dragEndPoint.x)),
      '-DragEndClientY', String(Math.round(options.dragEndPoint.y)),
      '-DragSteps', String(Math.max(2, Math.round(options.dragSteps || 12))),
    )
  }
  if (options.compareWindow && !options.compareWindow.isDestroyed()) {
    args.push('-CompareHwnd', getWindowHandle(options.compareWindow))
  }
  const { stdout } = await execFileAsync(powershellPath, args, { windowsHide: true, timeout: 8000 })
  return stdout.trim()
}

const isOrganizerWidgetWindow = (win) => {
  if (!win?.desktopWidgetId || !workspaceState) return false
  return workspaceState.widgets.some((widget) => (
    widget.id === win.desktopWidgetId
    && !widget.hidden
    && widget.kind === 'organizer'
  ))
}

const workspaceDesktopOrganizerWindows = () => (workspaceState?.widgets || [])
  .filter((widget) => !widget.hidden && widget.kind === 'organizer')
  .map((widget) => desktopWidgetWindows.get(widget.id))
  .filter((win) => win && !win.isDestroyed())

// The array is bottom -> top inside Progman's child list. Workspace order seeds
// new windows, then a pointer press may move one organizer to the end. Because
// every organizer is a WS_CHILD, this order can never cross a normal application.
const desktopOrganizerBandWindows = (displayId = null) => {
  const workspaceWindows = workspaceDesktopOrganizerWindows()
  const windowsById = new Map(workspaceWindows.map((win) => [win.desktopWidgetId, win]))
  const orderedIds = desktopOrganizerBandOrder.filter((id) => windowsById.has(id))
  for (const win of workspaceWindows) {
    if (!orderedIds.includes(win.desktopWidgetId)) orderedIds.push(win.desktopWidgetId)
  }
  desktopOrganizerBandOrder = orderedIds
  const ordered = orderedIds.map((id) => windowsById.get(id)).filter(Boolean)
  return displayId === null
    ? ordered
    : ordered.filter((win) => win.desktopDisplayId === String(displayId))
}

const applyDesktopOrganizerBand = () => {
  if (!useDesktopWidgetWindows || !workspaceState?.settings.desktopEnabled) return false
  const organizers = desktopOrganizerBandWindows()
  if (!organizers.length || organizers.some((win) => !win.desktopOrganizerChildAttached)) return false
  try {
    // moveTop() is scoped to the common Progman parent for WS_CHILD windows.
    // Iterating bottom -> top yields the requested organizer order while all
    // intermediate states remain inside the desktop child hierarchy.
    const displayIds = [...new Set(organizers.map((win) => win.desktopDisplayId))]
    for (const displayId of displayIds) {
      for (const win of organizers.filter((candidate) => candidate.desktopDisplayId === displayId)) {
        win.moveTop()
        win.desktopOrganizerMoveTopCount = (win.desktopOrganizerMoveTopCount || 0) + 1
      }
    }
    return true
  } catch (error) {
    console.warn(`[desktop-host] organizer stack sync failed: ${error.message}`)
    return false
  }
}

const desktopOrganizerOverlapsSibling = (win, organizers) => {
  const widget = workspaceState?.widgets.find((candidate) => (
    candidate.id === win?.desktopWidgetId && !candidate.hidden && candidate.kind === 'organizer'
  ))
  if (!widget) return false
  return organizers.some((candidate) => {
    if (candidate === win) return false
    const sibling = workspaceState.widgets.find((item) => (
      item.id === candidate.desktopWidgetId && !item.hidden && item.kind === 'organizer'
    ))
    return Boolean(
      sibling
      && widget.x < sibling.x + sibling.width
      && widget.x + widget.width > sibling.x
      && widget.y < sibling.y + sibling.height
      && widget.y + widget.height > sibling.y
    )
  })
}

const promoteDesktopOrganizerWindow = (win) => {
  if (!isOrganizerWidgetWindow(win)) return false
  const organizers = desktopOrganizerBandWindows(win.desktopDisplayId)
  if (
    organizers.length < 2
    || organizers.at(-1) === win
    || organizers.some((candidate) => !candidate.desktopOrganizerChildAttached)
    || !desktopOrganizerOverlapsSibling(win, organizers)
  ) return false
  try {
    // Moving one child to the top preserves every sibling-to-sibling relation.
    // Replaying moveTop() across the whole group caused unrelated Chromium
    // transparent surfaces to be recomposed and visibly flash on every click.
    win.moveTop()
    win.desktopOrganizerMoveTopCount = (win.desktopOrganizerMoveTopCount || 0) + 1
    desktopOrganizerBandOrder = [
      ...organizers.map((candidate) => candidate.desktopWidgetId)
        .filter((id) => id !== win.desktopWidgetId),
      win.desktopWidgetId,
    ]
    ensureDesktopOrganizerInteractive(win)
    return true
  } catch (error) {
    console.warn(`[desktop-host] organizer promotion failed: ${error.message}`)
    return false
  }
}

const flushDesktopOrganizerDeferredPromotions = () => {
  const queued = [...desktopOrganizerDeferredPromotions]
  desktopOrganizerDeferredPromotions.clear()
  for (const win of queued) {
    if (!win || win.isDestroyed() || win.desktopInteractionLocked) continue
    if (win.desktopOrganizerPromotionPending !== true) continue
    win.desktopOrganizerPromotionPending = false
    promoteDesktopOrganizerWindow(win)
  }
}

const finishDesktopWindowInteraction = (win) => {
  if (!win || win.isDestroyed()) return
  const organizerWindow = isOrganizerWidgetWindow(win)
  const promoteAfterGesture = organizerWindow && win.desktopOrganizerPromotionPending === true
  win.desktopInteractionLocked = false
  win.desktopInteractionLockedAt = 0
  const pendingDisplayId = organizerWindow ? win.desktopPendingDisplayId : null
  if (pendingDisplayId && pendingDisplayId !== win.desktopDisplayId) {
    void transitionDesktopOrganizerToDisplay(win, pendingDisplayId)
  }
  if (!promoteAfterGesture) return
  if (desktopOrganizerBandHealthInFlight) {
    desktopOrganizerDeferredPromotions.add(win)
    return
  }
  win.desktopOrganizerPromotionPending = false
  promoteDesktopOrganizerWindow(win)
}

const lowerDesktopOrganizerWindow = async (win) => {
  if (
    !useDesktopWidgetWindows
    || !win
    || win.isDestroyed()
    || !workspaceState?.settings.desktopEnabled
    || !isOrganizerWidgetWindow(win)
  ) return ''
  try {
    win.setAlwaysOnTop(false)
    const organizerHost = await ensureDesktopOrganizerHostWindow(win.desktopDisplayId)
    if (!organizerHost) throw new Error('收纳盒桌面宿主不可用')
    const hostResult = await runDesktopHostHelper(win, {
      noActivate: false,
      desktopChild: true,
      parentWindow: organizerHost,
    })
    win.desktopOrganizerLayerResult = hostResult
    win.desktopOrganizerChildAttached = hostResult.includes('placement=desktop-child')
    win.desktopOrganizerLayeredAt = Date.now()
    syncDesktopOrganizerRendererScale(win)
    win.desktopOrganizerShapeApplied = false
    const widget = workspaceState.widgets.find((candidate) => candidate.id === win.desktopWidgetId)
    if (widget) {
      syncDesktopWidgetWindowFrame(win, widget)
      await stabilizeAttachedDesktopOrganizerGeometry(win, widget)
    }
    ensureDesktopOrganizerInteractive(win, { force: true })
    console.log(`[desktop-host] organizer=${win.desktopWidgetId} lowered; ${hostResult}`)
    return hostResult
  } catch (error) {
    win.desktopOrganizerLayerResult = ''
    win.desktopOrganizerChildAttached = false
    console.error(`[desktop-host] organizer=${win.desktopWidgetId} lower failed: ${error.message}`)
    return ''
  }
}

const queueDesktopOrganizerLowering = (win) => {
  const previous = win?.desktopOrganizerLoweringPromise || Promise.resolve()
  const next = previous
    .catch(() => '')
    .then(() => lowerDesktopOrganizerWindow(win))
  if (win && !win.isDestroyed()) win.desktopOrganizerLoweringPromise = next
  return next
}

const normalizeDesktopOrganizerZOrder = async () => {
  if (!useDesktopWidgetWindows || !workspaceState?.settings.desktopEnabled) return []
  const organizers = desktopOrganizerBandWindows()

  // Once every organizer is already a child of the common host, reattaching
  // them one by one would create needless intermediate sibling orders. Keep
  // the normal path entirely in-process and reserve the helper for actual
  // parent/style recovery.
  if (organizers.length && organizers.every((win) => win.desktopOrganizerChildAttached)) {
    applyDesktopOrganizerBand()
    return organizers.map((win) => win.desktopOrganizerLayerResult || 'desktop-child-attached')
  }

  const results = []
  for (const win of organizers) {
    results.push(await queueDesktopOrganizerLowering(win))
  }
  applyDesktopOrganizerBand()
  return results
}

const attachDesktopWindow = async (win) => {
  if (!win || win.isDestroyed() || !workspaceState.settings.desktopEnabled) return false
  win.desktopAttachmentAttemptCount = (win.desktopAttachmentAttemptCount || 0) + 1
  win.setAlwaysOnTop(false)
  const organizerWindow = isOrganizerWidgetWindow(win)
  try {
    if (organizerWindow) {
      const organizerHost = await ensureDesktopOrganizerHostWindow(win.desktopDisplayId)
      if (!organizerHost) throw new Error('收纳盒桌面宿主不可用')
    }
    // Preserve the proven legacy startup sequence: expose the HWND before the
    // native desktop-band helper runs, then show it again after placement.
    if (organizerWindow) ensureDesktopOrganizerInteractive(win, { force: true })
    else {
      win.setIgnoreMouseEvents(true, { forward: true })
      win.desktopPointerInteractive = false
    }
    win.showInactive()
    const hostResult = await runDesktopHostHelper(win, {
      noActivate: false,
      desktopChild: organizerWindow,
      parentWindow: organizerWindow ? desktopOrganizerHostForWindow(win) : null,
    })
    const attached = Boolean(hostResult)
    win.showInactive()
    if (organizerWindow) ensureDesktopOrganizerInteractive(win, { force: true })
    if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate()
    const hostLabel = win.desktopWidgetId
      ? `widget=${win.desktopWidgetId} display=${win.desktopDisplayId}`
      : `display=${win.desktopDisplayId}`
    console.log(`[desktop-host] ${hostLabel} ${attached ? 'attached' : 'fallback'}; ${hostResult}`)
    win.desktopAttached = attached
    if (organizerWindow) {
      win.desktopOrganizerLayerResult = hostResult
      win.desktopOrganizerChildAttached = hostResult.includes('placement=desktop-child')
      syncDesktopOrganizerRendererScale(win)
      win.desktopOrganizerShapeApplied = false
      const widget = workspaceState.widgets.find((candidate) => candidate.id === win.desktopWidgetId)
      if (widget) {
        syncDesktopWidgetWindowFrame(win, widget)
        await stabilizeAttachedDesktopOrganizerGeometry(win, widget)
      }
      applyDesktopOrganizerBand()
    }
    return attached
  } catch (error) {
    console.error(`[desktop-host] display=${win.desktopDisplayId} fallback: ${error.message}`)
    if (organizerWindow) ensureDesktopOrganizerInteractive(win, { force: true })
    else {
      win.setIgnoreMouseEvents(true, { forward: true })
      win.desktopPointerInteractive = false
    }
    if (organizerWindow) {
      // Never expose an unattached organizer as a global top-level fallback.
      // The host health path will show it after a safe child reattachment.
      win.desktopOrganizerChildAttached = false
      win.hide()
    } else {
      win.showInactive()
      win.moveBottom()
    }
    win.desktopAttached = false
    return false
  }
}

const refreshDesktopHostStatus = () => {
  const windows = liveDesktopWindows()
  if (!windows.length || windows.some((win) => typeof win.desktopAttached !== 'boolean')) return
  const attached = windows.every((win) => win.desktopAttached)
  desktopHostState = attached ? 'attached' : 'fallback'
  desktopStatusMessage = attached
    ? useDesktopWidgetWindows
      ? `已将 ${windows.length} 个组件挂载到 Windows 桌面层`
      : `已覆盖 ${windows.length} 个显示器并挂载到 Windows 桌面层`
    : '部分显示器桌面层挂载失败，已使用兼容模式'
  broadcastDesktopStatus()
}

const attachDesktopWindows = async () => {
  const windows = liveDesktopWindows()
  if (!windows.length || !workspaceState.settings.desktopEnabled) return
  const results = await Promise.all(windows.map(attachDesktopWindow))
  if (useDesktopWidgetWindows) applyDesktopOrganizerBand()
  const attached = results.every(Boolean)
  desktopHostState = attached ? 'attached' : 'fallback'
  desktopStatusMessage = attached
    ? useDesktopWidgetWindows
      ? `已将 ${windows.length} 个组件挂载到 Windows 桌面层`
      : `已覆盖 ${windows.length} 个显示器并挂载到 Windows 桌面层`
    : '部分显示器桌面层挂载失败，已使用兼容模式'
  broadcastDesktopStatus()

  if (desktopHostSelfCapturePath && desktopWindow && !desktopWindow.isDestroyed()) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 700))
      const image = await desktopWindow.webContents.capturePage()
      const outputPath = path.resolve(process.cwd(), desktopHostSelfCapturePath)
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.promises.writeFile(outputPath, image.toPNG())
      console.log(`[desktop-host] self-capture ${outputPath}`)
    } catch (error) {
      console.error(`[desktop-host] self-capture failed: ${error.message}`)
    }
  }
}

const attachMissingDesktopWindows = async () => {
  if (!workspaceState?.settings.desktopEnabled) return []
  const missing = liveDesktopWindows().filter((win) => (
    !win.desktopAttachmentInFlight
    && (
      win.desktopAttached !== true
      || (isOrganizerWidgetWindow(win) && win.desktopOrganizerChildAttached !== true)
    )
  ))
  if (!missing.length) {
    refreshDesktopHostStatus()
    return []
  }
  const results = await Promise.all(missing.map(attachDesktopWindow))
  refreshDesktopHostStatus()
  return results
}

const setDesktopEnabled = async (enabled) => {
  const nextState = cloneWorkspace()
  nextState.settings.desktopEnabled = Boolean(enabled)
  const result = await updateWorkspace(nextState)

  const windows = liveDesktopWindows()
  if (!enabled) {
    for (const win of windows) win.hide()
    desktopHostState = 'disabled'
    desktopStatusMessage = '桌面组件已暂停显示'
    broadcastDesktopStatus()
  } else {
    if (!windows.length) return result
    await attachDesktopWindows()
  }
  return result
}

const appIconPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'app-icon.ico')
  : path.join(process.cwd(), 'assets', 'app-icon.ico')

const trayIconRepresentations = [
  { size: 16, scaleFactor: 1 },
  { size: 20, scaleFactor: 1.25 },
  { size: 24, scaleFactor: 1.5 },
  { size: 32, scaleFactor: 2 },
]

const trayIconPath = (size) => app.isPackaged
  ? path.join(process.resourcesPath, `app-icon-${size}.png`)
  : path.join(process.cwd(), 'assets', `app-icon-${size}.png`)

const loadAppIcon = () => {
  const icon = nativeImage.createFromPath(appIconPath())
  if (icon.isEmpty()) throw new Error(`Unable to load app icon: ${appIconPath()}`)
  return icon
}

const createTrayIcon = () => {
  const icon = nativeImage.createEmpty()
  for (const { size, scaleFactor } of trayIconRepresentations) {
    const representation = nativeImage.createFromPath(trayIconPath(size))
    if (representation.isEmpty()) throw new Error(`Unable to load tray icon: ${trayIconPath(size)}`)
    icon.addRepresentation({ scaleFactor, dataURL: representation.toDataURL() })
  }
  return icon
}

const showControlCenter = () => {
  if (!controlWindow || controlWindow.isDestroyed()) createControlWindow()
  if (controlWindow.isMinimized()) controlWindow.restore()
  controlWindow.show()
  controlWindow.focus()
}

if (enforceSingleInstance && hasPrimaryInstance) {
  app.on('second-instance', showControlCenter)
}

const requestFullQuit = () => {
  if (fullQuitRequested) return
  fullQuitRequested = true
  app.quit()
}

const buildTrayMenu = () => {
  const desktopEnabled = workspaceState?.settings?.desktopEnabled !== false
  return Menu.buildFromTemplate([
    { label: '打开控制中心', click: showControlCenter },
    { label: '隐藏控制中心', click: () => controlWindow?.hide() },
    { type: 'separator' },
    {
      label: desktopEnabled ? '暂停桌面组件' : '显示桌面组件',
      click: () => {
        void enqueueWorkspaceMutation(() => setDesktopEnabled(!desktopEnabled))
          .finally(() => tray?.setContextMenu(buildTrayMenu()))
      },
    },
    { type: 'separator' },
    { label: '彻底退出', click: requestFullQuit },
  ])
}

const ensureTray = () => {
  if (tray && !tray.isDestroyed()) return tray
  tray = new Tray(createTrayIcon())
  tray.setToolTip('eDesktop')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', showControlCenter)
  return tray
}

const minimizeControlToTray = () => {
  const appTray = ensureTray()
  controlWindow?.hide()
  if (desktopTrayTest) {
    const testMenu = buildTrayMenu()
    const labels = testMenu.items.filter((item) => item.type !== 'separator').map((item) => item.label)
    const expectedLabels = ['打开控制中心', '隐藏控制中心', '暂停桌面组件', '彻底退出']
    if (JSON.stringify(labels) !== JSON.stringify(expectedLabels)) {
      throw new Error(`tray menu mismatch: ${JSON.stringify(labels)}`)
    }
    setTimeout(() => appTray.popUpContextMenu(testMenu), 250)
    setTimeout(() => {
      appTray.closeContextMenu()
      testMenu.items[0].click()
    }, 900)
  }
}

const requestControlWindowClose = () => {
  if (!controlWindow || controlWindow.isDestroyed()) return
  if (controlWindow.isMinimized()) controlWindow.restore()
  controlWindow.show()
  controlWindow.focus()
  if (controlClosePromptVisible) return
  controlClosePromptVisible = true
  controlWindow.webContents.send('window:close-requested')
}

const widgetDefaults = {
  organizer: { title: '新收纳盒', tone: 'paper', width: 360, height: 260, data: { files: [] } },
  note: {
    title: '新便签',
    tone: 'yellow',
    width: 280,
    height: 220,
    data: { content: '', updatedAt: new Date().toISOString() },
  },
  todo: {
    title: '待办列表',
    tone: 'paper',
    width: 320,
    height: 300,
    data: { items: [], activeList: 'my-day' },
  },
  pomodoro: {
    title: '番茄钟',
    tone: 'emerald',
    width: 280,
    height: 300,
    data: {
      mode: 'focus',
      focusMinutes: 25,
      breakMinutes: 5,
      remainingSeconds: 25 * 60,
      running: false,
      endsAt: null,
      sessions: 0,
    },
  },
}

const createWidget = (kind) => {
  const defaults = widgetDefaults[kind] || widgetDefaults.note
  const index = workspaceState.widgets.length
  const primaryOffset = primaryScreenOffset()
  return {
    id: crypto.randomUUID(),
    kind: widgetDefaults[kind] ? kind : 'note',
    title: defaults.title,
    tone: defaults.tone,
    x: primaryOffset.x + 48 + (index % 5) * 34,
    y: primaryOffset.y + 96 + (index % 4) * 32,
    width: defaults.width,
    height: defaults.height,
    hidden: false,
    data: JSON.parse(JSON.stringify(defaults.data)),
  }
}

const createCaptureWidgets = () => {
  const original = workspaceState?.widgets || []
  workspaceState = workspaceState || defaultWorkspace()
  workspaceState.widgets = []
  const primaryOffset = primaryScreenOffset()
  const organizer = createWidget('organizer')
  organizer.title = '项目资料'
  organizer.x = 90
  organizer.y = primaryOffset.y + 130
  organizer.width = 390
  organizer.height = 280
  if (capturePath) {
    captureFixtureRoot = path.join(app.getPath('temp'), `edesktop-capture-${process.pid}`)
    const fixturePaths = ['项目文档', '参考资料', '待处理', '已归档'].map((name) => {
      const fixturePath = path.join(captureFixtureRoot, name)
      fs.mkdirSync(fixturePath, { recursive: true })
      return fixturePath
    })
    organizer.data.files = fixturePaths.map((fixturePath) => {
      const fixtureStat = fs.statSync(fixturePath)
      return {
        id: Buffer.from(fixturePath.toLowerCase()).toString('base64url'),
        path: fixturePath,
        name: path.basename(fixturePath),
        extension: fixtureStat.isDirectory() ? '' : path.extname(fixturePath).slice(1),
        size: fixtureStat.size,
        isDirectory: fixtureStat.isDirectory(),
        modifiedAt: fixtureStat.mtime.toISOString(),
        originalPath: fixturePath,
        originalDesktopPosition: null,
      }
    })
  }
  if (desktopDragTest || desktopWidgetWindowTest) {
    const fixtureDirectory = organizerStoragePath(organizer.id)
    fs.mkdirSync(fixtureDirectory, { recursive: true })
    const fixtureNames = desktopWidgetWindowTest
      ? ['Codex-Native-Drag-Test-A.txt', 'Codex-Native-Drag-Test-B.txt', 'Codex-Native-Drag-Test-C.txt']
      : ['Codex-Native-Drag-Test.txt']
    organizer.data.files = fixtureNames.map((fixtureName) => {
      const fixturePath = path.join(fixtureDirectory, fixtureName)
      fs.writeFileSync(fixturePath, `desktop organizer native drag test: ${fixtureName}`, 'utf8')
      const fixtureStat = fs.statSync(fixturePath)
      return {
        id: Buffer.from(fixturePath.toLowerCase()).toString('base64url'),
        path: fixturePath,
        name: path.basename(fixturePath),
        extension: 'txt',
        size: fixtureStat.size,
        isDirectory: false,
        modifiedAt: fixtureStat.mtime.toISOString(),
        originalPath: fixturePath,
        originalDesktopPosition: null,
      }
    })
  }
  const note = createWidget('note')
  note.title = '今天的想法'
  note.x = primaryOffset.x + 520
  note.y = primaryOffset.y + 160
  note.data.content = '保持桌面清楚，只留下正在推进的事情。'
  const todo = createWidget('todo')
  todo.x = primaryOffset.x + 710
  todo.y = primaryOffset.y + 120
  todo.width = 620
  const captureDate = new Date()
  const captureToday = `${captureDate.getFullYear()}-${String(captureDate.getMonth() + 1).padStart(2, '0')}-${String(captureDate.getDate()).padStart(2, '0')}`
  todo.data.activeList = 'my-day'
  todo.data.items = [
    { id: 'capture-1', text: '整理产品资料', completed: true, completedOn: captureToday, list: 'my-day', startTime: '09:00', endTime: '10:30' },
    { id: 'capture-3', text: '每日复盘', completed: true, completedOn: '2000-01-01', list: 'my-day' },
    { id: 'capture-2', text: '完成首页原型', completed: false, list: 'temporary' },
  ]
  const pomodoro = createWidget('pomodoro')
  pomodoro.x = primaryOffset.x + 1360
  pomodoro.y = primaryOffset.y + 150
  workspaceState.widgets = original
  return [organizer, note, todo, pomodoro]
}

const safeWidgetPatch = (patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {}
  const safe = {}
  for (const key of ['title', 'tone', 'x', 'y', 'width', 'height', 'hidden', 'data']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) safe[key] = patch[key]
  }
  if (typeof safe.title === 'string') safe.title = safe.title.slice(0, 80)
  if (Number.isFinite(safe.x)) safe.x = Math.round(safe.x)
  if (Number.isFinite(safe.y)) safe.y = Math.round(safe.y)
  if (Number.isFinite(safe.width)) safe.width = Math.max(1, Math.min(900, Math.round(safe.width)))
  if (Number.isFinite(safe.height)) safe.height = Math.max(1, Math.min(760, Math.round(safe.height)))
  return safe
}

const loadSurface = (win, surface, extraQuery = {}) => {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  const query = { surface, capture: capturePath ? '1' : '0', ...extraQuery }
  if (devServerUrl) {
    const url = new URL(devServerUrl)
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value))
    return win.loadURL(url.toString())
  }
  return win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query })
}

const commonWebPreferences = () => ({
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
  backgroundThrottling: false,
})

const createControlWindow = () => {
  controlWindow = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 680,
    minHeight: 500,
    show: !capturePath,
    frame: false,
    icon: loadAppIcon(),
    backgroundColor: '#F3F3F3',
    webPreferences: commonWebPreferences(),
  })
  loadSurface(controlWindow, 'control')
  controlWindow.on('close', (event) => {
    if (fullQuitRequested || capturePath || desktopHostTest || quitAfterRestore) return
    event.preventDefault()
    void requestControlWindowClose()
  })
  controlWindow.on('closed', () => {
    controlClosePromptVisible = false
    controlWindow = null
  })
  return controlWindow
}

const createDesktopWindow = (display = screen.getPrimaryDisplay()) => {
  const displayId = String(display.id)
  const existing = desktopWindows.get(displayId)
  if (existing && !existing.isDestroyed()) return existing

  const win = new BrowserWindow({
    ...display.workArea,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: commonWebPreferences(),
  })
  win.desktopDisplayId = displayId
  desktopWindows.set(displayId, win)
  if (displayId === String(screen.getPrimaryDisplay().id)) desktopWindow = win
  loadSurface(win, 'desktop', { displayId })
  win.webContents.once('did-finish-load', () => {
    if (desktopDragTest) {
      // Keep the isolated test surface as a regular top-level window so Computer Use can
      // exercise the real Chromium -> Electron -> Windows native drag chain end to end.
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setIgnoreMouseEvents(false)
      win.desktopPointerInteractive = true
      win.showInactive()
      win.desktopAttached = false
    } else if (capturePath) {
      win.setIgnoreMouseEvents(false)
      win.show()
      desktopHostState = 'attached'
      desktopStatusMessage = '桌面预览模式'
      broadcastDesktopStatus()
    } else if (workspaceState.settings.desktopEnabled) {
      attachDesktopWindow(win).then(refreshDesktopHostStatus)
    }
  })
  win.on('closed', () => {
    desktopWindows.delete(displayId)
    if (desktopWindow === win) desktopWindow = null
  })
  return win
}

const createDesktopWindows = () => {
  const windows = screen.getAllDisplays().map(createDesktopWindow)
  desktopWindow = desktopWindows.get(String(screen.getPrimaryDisplay().id)) || windows[0] || null
  return windows
}

const desktopDisplayById = (displayId) => screen.getAllDisplays()
  .find((display) => String(display.id) === String(displayId)) || null

const desktopOrganizerHostScaleRatio = (displayId) => {
  const display = desktopDisplayById(displayId)
  const hostScale = Number(screen.getPrimaryDisplay().scaleFactor) || 1
  return display ? (Number(display.scaleFactor) || 1) / hostScale : 1
}

const desktopOrganizerHostForDisplay = (displayId) => {
  const host = desktopOrganizerHostWindows.get(String(displayId))
  return host && !host.isDestroyed() ? host : null
}

const desktopOrganizerHostForWindow = (win) => desktopOrganizerHostForDisplay(win?.desktopDisplayId)

const physicalScreenRect = (rect) => {
  if (typeof screen.dipToScreenRect === 'function') {
    return screen.dipToScreenRect(null, rect)
  }
  const display = screen.getDisplayNearestPoint({
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  })
  const scale = Number(display?.scaleFactor) || 1
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  }
}

const physicalVirtualScreenBounds = () => {
  const rects = screen.getAllDisplays().map((display) => physicalScreenRect(display.bounds))
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

const desktopOrganizerHostBounds = () => {
  const physicalVirtualBounds = physicalVirtualScreenBounds()
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.round(physicalVirtualBounds.width)),
    height: Math.max(1, Math.round(physicalVirtualBounds.height)),
  }
}

const syncDesktopOrganizerHostBounds = async (host, display) => {
  if (!host || host.isDestroyed() || !display) return
  const bounds = desktopOrganizerHostBounds()
  // SetParent changes this BaseWindow from the target monitor's DPI to
  // Explorer's DPI asynchronously. Wait for that transition, then place the
  // child in Explorer's physical client coordinates. Electron's setBounds()
  // still treats x/y as top-level screen DIPs after SetParent and subtracts the
  // virtual origin twice, which is the source of the off-screen host.
  await new Promise((resolve) => setTimeout(resolve, 40))
  if (!host.isDestroyed()) {
    await runDesktopHostHelper(host, { clientBounds: bounds })
  }
}

const ensureDesktopOrganizerHostWindow = async (displayId = String(screen.getPrimaryDisplay().id)) => {
  if (!useDesktopWidgetWindows || !workspaceState?.settings.desktopEnabled) return null
  const normalizedDisplayId = String(displayId)
  const existing = desktopOrganizerHostForDisplay(normalizedDisplayId)
  if (existing) return existing
  const display = desktopDisplayById(normalizedDisplayId)
  if (!display) return null

  // BaseWindow deliberately has no WebContents. A transparent BrowserWindow
  // would add its own Chrome_RenderWidgetHostHWND, which can intermittently
  // sit above child organizers and steal their pointer input.
  const host = new BaseWindow({
    ...display.workArea,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
  })
  host.setTitle(`eDesktop · 收纳盒桌面宿主 · ${normalizedDisplayId}`)
  host.desktopDisplayId = normalizedDisplayId
  // Do not make this parent HWND mouse-transparent. On Windows,
  // WS_EX_TRANSPARENT also removes its child organizers from native hit
  // testing. The host is instead clipped to the union of organizer shapes so
  // the uncovered desktop remains fully interactive.
  host.setIgnoreMouseEvents(false)
  host.desktopOrganizerHostAttached = false
  desktopOrganizerHostWindows.set(normalizedDisplayId, host)
  host.on('closed', () => {
    if (desktopOrganizerHostWindows.get(normalizedDisplayId) === host) {
      desktopOrganizerHostWindows.delete(normalizedDisplayId)
    }
  })

  host.showInactive()
  try {
    const result = await runDesktopHostHelper(host, {
      noActivate: true,
      desktopChild: true,
    })
    host.desktopOrganizerHostAttached = result.includes('placement=desktop-child')
    await syncDesktopOrganizerHostBounds(host, display)
    host.setIgnoreMouseEvents(false)
    applyDesktopOrganizerHostShape(normalizedDisplayId)
    console.log(`[desktop-host] organizer root attached; ${result}`)
    return host.desktopOrganizerHostAttached ? host : null
  } catch (error) {
    console.error(`[desktop-host] organizer root attachment failed: ${error.message}`)
    host.hide()
    return null
  }
}

const ensureDesktopOrganizerHostWindows = async () => {
  const displayIds = new Set((workspaceState?.widgets || [])
    .filter((widget) => widget.kind === 'organizer' && !widget.hidden)
    .map((widget) => desktopWidgetDisplayId(widget)))
  return Promise.all([...displayIds].map(ensureDesktopOrganizerHostWindow))
}

const desktopWidgetWindowBounds = (widget) => {
  const virtualBounds = virtualScreenBounds()
  return {
    x: Math.round(virtualBounds.x + widget.x - desktopWidgetWindowMargin),
    y: Math.round(virtualBounds.y + widget.y - desktopWidgetWindowMargin),
    width: Math.max(1, Math.round(widget.width + desktopWidgetWindowMargin * 2)),
    height: Math.max(1, Math.round(widget.height + desktopWidgetWindowMargin * 2)),
  }
}

const desktopWidgetNativeBounds = (win, screenBounds) => {
  if (!win?.desktopOrganizerChildAttached) return screenBounds
  const display = desktopDisplayById(win.desktopDisplayId)
  if (!display) return screenBounds
  const ratio = desktopOrganizerHostScaleRatio(win.desktopDisplayId)
  return {
    x: Math.round((screenBounds.x - display.workArea.x) * ratio),
    y: Math.round((screenBounds.y - display.workArea.y) * ratio),
    width: Math.max(1, Math.round(screenBounds.width * ratio)),
    height: Math.max(1, Math.round(screenBounds.height * ratio)),
  }
}

const desktopWidgetPhysicalClientBounds = (_win, screenBounds) => {
  const physicalBounds = physicalScreenRect(screenBounds)
  const physicalVirtualBounds = physicalVirtualScreenBounds()
  return {
    x: Math.round(physicalBounds.x - physicalVirtualBounds.x),
    y: Math.round(physicalBounds.y - physicalVirtualBounds.y),
    width: Math.max(1, Math.round(physicalBounds.width)),
    height: Math.max(1, Math.round(physicalBounds.height)),
  }
}

const desktopWidgetLockedPreviewClientBounds = (win, screenBounds) => {
  const targetBounds = desktopWidgetPhysicalClientBounds(win, screenBounds)
  const sourceDisplay = desktopDisplayById(win?.desktopDisplayId)
  const sourceScale = Number(sourceDisplay?.scaleFactor) || 1
  return {
    ...targetBounds,
    // A parented Chromium HWND keeps the source monitor's backing surface
    // until pointer capture ends. Growing its native client immediately to the
    // target monitor's physical size exposes pixels Chromium has not rendered,
    // which looks like the organizer was clipped. Keep the complete source
    // surface during the gesture; the prepared target-DPI window takes over on
    // pointer-up.
    width: Math.max(1, Math.round(screenBounds.width * sourceScale)),
    height: Math.max(1, Math.round(screenBounds.height * sourceScale)),
  }
}

const queueDesktopOrganizerClientBounds = (win, screenBounds, clientBounds = null) => {
  if (!win || win.isDestroyed()) return
  win.desktopPendingNativeClientBounds = clientBounds || desktopWidgetPhysicalClientBounds(win, screenBounds)
  if (win.desktopNativeClientBoundsInFlight) return
  win.desktopNativeClientBoundsInFlight = true
  const flush = async () => {
    try {
      while (!win.isDestroyed() && win.desktopPendingNativeClientBounds) {
        const bounds = win.desktopPendingNativeClientBounds
        win.desktopPendingNativeClientBounds = null
        win.desktopProgrammaticMoveUntil = Date.now() + 500
        await desktopIconHelperRequest('set-window-client-bounds', {
          hwnd: getWindowHandle(win),
          ...bounds,
        }, 1_200)
        win.desktopProgrammaticMoveUntil = Date.now() + 120
      }
    } catch (error) {
      if (!win.desktopNativeClientBoundsWarningLogged) {
        console.warn(`[desktop-geometry] organizer=${win.desktopWidgetId} native frame update failed: ${error.message}`)
        win.desktopNativeClientBoundsWarningLogged = true
      }
    } finally {
      win.desktopNativeClientBoundsInFlight = false
      if (!win.isDestroyed() && win.desktopPendingNativeClientBounds) {
        queueDesktopOrganizerClientBounds(win, screenBounds)
      }
    }
  }
  void flush()
}

const setDesktopWidgetWindowBounds = (win, screenBounds) => {
  if (win?.desktopOrganizerChildAttached) {
    queueDesktopOrganizerClientBounds(win, screenBounds)
    return
  }
  win.setBounds(screenBounds, false)
}

const setDesktopWidgetWindowPosition = (win, screenX, screenY) => {
  if (win?.desktopOrganizerChildAttached) {
    const previous = win.desktopRequestedBounds || win.getBounds()
    queueDesktopOrganizerClientBounds(win, { ...previous, x: screenX, y: screenY })
    return
  }
  win.setPosition(screenX, screenY, false)
}

const setDesktopOrganizerLockedPreviewBounds = (win, screenBounds) => {
  if (!win?.desktopOrganizerChildAttached) {
    win?.setBounds(screenBounds, false)
    return
  }
  queueDesktopOrganizerClientBounds(
    win,
    screenBounds,
    desktopWidgetLockedPreviewClientBounds(win, screenBounds),
  )
}

const roundedDesktopOrganizerShape = (width, height) => {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const radius = Math.min(
    desktopOrganizerNativeShapeRadius,
    Math.floor(safeWidth / 2),
    Math.floor(safeHeight / 2),
  )
  if (radius <= 0) return [{ x: 0, y: 0, width: safeWidth, height: safeHeight }]

  const shape = []
  for (let y = 0; y < radius; y += 1) {
    const distanceFromCenter = radius - y - 0.5
    const inset = Math.ceil(radius - Math.sqrt(radius ** 2 - distanceFromCenter ** 2))
    const rowWidth = safeWidth - inset * 2
    if (rowWidth <= 0) continue
    shape.push({ x: inset, y, width: rowWidth, height: 1 })
    const bottomY = safeHeight - y - 1
    if (bottomY !== y) shape.push({ x: inset, y: bottomY, width: rowWidth, height: 1 })
  }
  if (safeHeight > radius * 2) {
    shape.push({ x: 0, y: radius, width: safeWidth, height: safeHeight - radius * 2 })
  }
  return shape
}

const applyDesktopOrganizerHostShape = (requestedDisplayId = null) => {
  const hosts = requestedDisplayId
    ? [desktopOrganizerHostForDisplay(requestedDisplayId)].filter(Boolean)
    : liveDesktopOrganizerHostWindows()
  for (const host of hosts) {
    if (typeof host.setShape !== 'function') continue
    const display = desktopDisplayById(host.desktopDisplayId)
    if (!display) continue
    const shapeUnitScale = Number(screen.getPrimaryDisplay().scaleFactor) || 1
    const organizerWindows = workspaceState?.settings.desktopEnabled
      ? [...new Set([
          ...workspaceDesktopOrganizerWindows(),
          ...desktopOrganizerTransitionWindows,
        ])].filter((win) => (
          win
          && !win.isDestroyed()
          && win.desktopDisplayId === host.desktopDisplayId
        ))
      : []
    const shape = organizerWindows.flatMap((organizerWindow) => {
      const widget = workspaceState.widgets.find((candidate) => (
        candidate.id === organizerWindow.desktopWidgetId
        && candidate.kind === 'organizer'
        && !candidate.hidden
      ))
      if (!widget) return []
      const bounds = desktopWidgetWindowBounds(widget)
      // Once the host is parented into Explorer, its region and organizer
      // children share physical client coordinates. Derive both from the same
      // screen-to-client conversion. Electron scales BaseWindow.setShape input
      // by the primary display factor even for this Explorer child, so convert
      // the physical rectangle back to those input units exactly. Scaling the
      // original DIP delta by target/primary was only an approximation and
      // drifted when the organizer crossed displays or the primary changed.
      const physicalBounds = desktopWidgetPhysicalClientBounds(null, bounds)
      const width = Math.max(1, Math.round(physicalBounds.width / shapeUnitScale))
      const height = Math.max(1, Math.round(physicalBounds.height / shapeUnitScale))
      const offsetX = Math.round(physicalBounds.x / shapeUnitScale)
      const offsetY = Math.round(physicalBounds.y / shapeUnitScale)
      return roundedDesktopOrganizerShape(width, height).map((rect) => ({
        x: offsetX + rect.x,
        y: offsetY + rect.y,
        width: rect.width,
        height: rect.height,
      }))
    })
    const signature = JSON.stringify(shape)
    if (host.desktopOrganizerShapeSignature === signature) continue
    try {
      // A hidden, one-pixel host is safer than an empty region whose exact
      // interpretation differs across Electron/Windows versions.
      if (!shape.length) {
        host.desktopOrganizerShapeSignature = signature
        host.hide()
        continue
      }
      host.setShape(shape)
      host.desktopOrganizerShapeSignature = signature
      if (host.desktopOrganizerHostAttached && !host.isVisible()) {
        host.showInactive()
        // Showing a BaseWindow after it became a Progman child makes Electron
        // replay its cached top-level frame once. Correct the host only after
        // that replay so children remain inside the native hit-test region.
        void syncDesktopOrganizerHostBounds(host, display)
      }
    } catch (error) {
      if (!host.desktopOrganizerShapeWarningLogged) {
        console.warn(`[desktop-host] organizer host shape failed: ${error.message}`)
        host.desktopOrganizerShapeWarningLogged = true
      }
    }
  }
}

const rebuildDesktopOrganizerHosts = async () => {
  if (!useDesktopWidgetWindows || !workspaceState?.settings.desktopEnabled) return []
  const oldHosts = liveDesktopOrganizerHostWindows()
  const organizerWindows = desktopOrganizerBandWindows()
  for (const win of organizerWindows) {
    desktopWidgetWindows.delete(win.desktopWidgetId)
    if (!win.isDestroyed()) win.destroy()
  }
  for (const win of desktopOrganizerTransitionWindows) {
    if (!win.isDestroyed()) win.destroy()
  }
  desktopOrganizerTransitionWindows.clear()
  for (const host of oldHosts) {
    if (!host.isDestroyed()) host.destroy()
  }
  desktopOrganizerHostWindows.clear()
  await ensureDesktopOrganizerHostWindows()
  for (const widget of workspaceState.widgets) {
    if (widget.kind === 'organizer' && !widget.hidden) createDesktopWidgetWindow(widget)
  }
  applyDesktopOrganizerHostShape()
  applyDesktopOrganizerBand()
  return liveDesktopOrganizerHostWindows()
}

const applyDesktopOrganizerWindowShape = (win, bounds) => {
  if (!win || win.isDestroyed() || typeof win.setShape !== 'function') return
  const signature = `${Math.max(1, Math.round(bounds.width))}x${Math.max(1, Math.round(bounds.height))}@${desktopOrganizerNativeShapeRadius}`
  if (win.desktopOrganizerShapeSignature === signature) {
    win.desktopOrganizerShapeApplied = true
    return
  }
  try {
    win.setShape(roundedDesktopOrganizerShape(bounds.width, bounds.height))
    win.desktopOrganizerShapeSignature = signature
    win.desktopOrganizerShapeMutationCount = (win.desktopOrganizerShapeMutationCount || 0) + 1
    win.desktopOrganizerShapeApplied = true
  } catch (error) {
    if (!win.desktopOrganizerShapeWarningLogged) {
      console.warn(`[desktop-host] organizer native shape failed: ${error.message}`)
      win.desktopOrganizerShapeWarningLogged = true
    }
  }
}

const desktopWidgetDisplayId = (widget) => {
  const virtualBounds = virtualScreenBounds()
  const display = screen.getDisplayNearestPoint({
    x: Math.round(virtualBounds.x + widget.x + widget.width / 2),
    y: Math.round(virtualBounds.y + widget.y + widget.height / 2),
  })
  return String(display.id)
}

const syncDesktopOrganizerRendererScale = (win) => {
  if (!isOrganizerWidgetWindow(win) || win.webContents.isDestroyed()) return 1
  // Organizer BrowserWindows are recreated on their destination display, so
  // Chromium already owns the correct per-monitor device scale. Native host
  // coordinate compensation must never be copied into page zoom: doing so
  // produced a 2.45 DPR on a 1.75 display after a round trip.
  if (Math.abs((win.desktopOrganizerZoomFactor || 1) - 1) > 0.001) {
    win.webContents.setZoomFactor(1)
    win.desktopOrganizerZoomFactor = 1
  }
  return 1
}

const recreateDesktopOrganizerWindow = async (win, widget, reason = 'geometry-recovery') => {
  if (
    !win
    || win.isDestroyed()
    || widget?.kind !== 'organizer'
    || !workspaceState?.settings.desktopEnabled
  ) return null
  await ensureDesktopOrganizerHostWindow(desktopWidgetDisplayId(widget))
  desktopWidgetWindows.delete(widget.id)
  win.desktopGeometryReplacementReason = reason
  win.destroy()
  return createDesktopWidgetWindow(widget)
}

const cancelPreparedDesktopOrganizerTransition = (win) => {
  const prepared = win?.desktopPreparedDisplayTransition
  if (!prepared) return
  prepared.cancelled = true
  if (prepared.replacement && !prepared.replacement.isDestroyed()) prepared.replacement.destroy()
  win.desktopPreparedDisplayTransition = null
}

const prepareDesktopOrganizerTransition = (win, displayId) => {
  if (!win || win.isDestroyed() || !isOrganizerWidgetWindow(win)) return Promise.resolve(null)
  const normalizedDisplayId = String(displayId)
  const existing = win.desktopPreparedDisplayTransition
  if (existing?.displayId === normalizedDisplayId && !existing.cancelled) return existing.promise
  cancelPreparedDesktopOrganizerTransition(win)

  const prepared = {
    displayId: normalizedDisplayId,
    cancelled: false,
    replacement: null,
    promise: null,
  }
  prepared.promise = (async () => {
    await ensureDesktopOrganizerHostWindow(normalizedDisplayId)
    if (prepared.cancelled || win.isDestroyed()) return null
    const widget = workspaceState?.widgets.find((candidate) => candidate.id === win.desktopWidgetId)
    if (!widget || desktopWidgetDisplayId(widget) !== normalizedDisplayId) return null
    const replacement = createDesktopWidgetWindow(widget, {
      replacement: true,
      deferReveal: true,
    })
    prepared.replacement = replacement
    const ready = await Promise.race([
      replacement.desktopReadyPromise,
      new Promise((resolve) => setTimeout(() => resolve(false), 4_000)),
    ])
    if (prepared.cancelled || !ready || replacement.isDestroyed()) {
      if (!replacement.isDestroyed()) replacement.destroy()
      return null
    }
    return replacement
  })().catch((error) => {
    console.warn(`[desktop-geometry] organizer=${win.desktopWidgetId} DPI prewarm failed: ${error.message}`)
    return null
  })
  win.desktopPreparedDisplayTransition = prepared
  return prepared.promise
}

const transitionDesktopOrganizerToDisplay = async (win, displayId) => {
  if (!win || win.isDestroyed() || !isOrganizerWidgetWindow(win)) return false
  const normalizedDisplayId = String(displayId)
  if (win.desktopOrganizerDisplayTransitionInFlight) {
    win.desktopPendingDisplayId = normalizedDisplayId
    return false
  }
  win.desktopOrganizerDisplayTransitionInFlight = true
  win.desktopPendingDisplayId = null
  win.desktopAttachmentInFlight = true
  let replacement = null
  try {
    const widget = workspaceState?.widgets.find((candidate) => candidate.id === win.desktopWidgetId)
    if (!widget) return false
    replacement = await prepareDesktopOrganizerTransition(win, normalizedDisplayId)
    if (!replacement || replacement.isDestroyed()) {
      throw new Error('target-DPI organizer surface was not prepared')
    }

    const latestDisplayId = desktopWidgetDisplayId(widget)
    if (latestDisplayId !== normalizedDisplayId) {
      replacement.destroy()
      replacement = null
      win.desktopPendingDisplayId = latestDisplayId
      return false
    }

    // The destination surface may have finished prewarming while the pointer
    // was still moving. Align that hidden HWND to the final release rectangle
    // and wait for the native move queue before making it visible.
    syncDesktopWidgetWindowFrame(replacement, widget)
    const alignmentDeadline = Date.now() + 1_500
    while (
      !replacement.isDestroyed()
      && (replacement.desktopNativeClientBoundsInFlight || replacement.desktopPendingNativeClientBounds)
      && Date.now() < alignmentDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
    if (replacement.isDestroyed()) throw new Error('prepared target-DPI organizer was lost before hand-off')

    // Both HWNDs now occupy the final physical rectangle. Publish the fully
    // painted target-DPI surface before retiring the source HWND, eliminating
    // the blank/partial frame from the old destroy-then-create sequence.
    replacement.desktopTransitionSourceHandle = getWindowHandle(win)
    replacement.desktopTransitionSourcePreserved = (
      !win.isDestroyed()
      && win.isVisible()
      && win.getOpacity() > 0.99
      && replacement.desktopFirstFramePrepared === true
      && replacement.desktopOrganizerChildAttached === true
    )
    desktopWidgetWindows.set(widget.id, replacement)
    win.desktopPreparedDisplayTransition = null
    replacement.desktopIsTransitionReplacement = false
    applyDesktopOrganizerHostShape(normalizedDisplayId)
    ensureDesktopOrganizerInteractive(replacement, { force: true })
    replacement.setOpacity(1)
    replacement.desktopFirstFrameRevealed = true
    if (typeof replacement.webContents.invalidate === 'function') replacement.webContents.invalidate()
    applyDesktopOrganizerBand()
    const sourceDisplayId = win.desktopDisplayId
    win.destroy()
    desktopOrganizerTransitionWindows.delete(replacement)
    applyDesktopOrganizerHostShape(sourceDisplayId)
    applyDesktopOrganizerHostShape(normalizedDisplayId)
    scheduleDesktopWidgetGeometryReconcile(replacement, {
      reason: 'display-transition',
      delays: [80, 260],
      forceSurface: false,
    })
    return true
  } catch (error) {
    if (replacement && !replacement.isDestroyed()) replacement.destroy()
    cancelPreparedDesktopOrganizerTransition(win)
    console.warn(`[desktop-geometry] organizer=${win.desktopWidgetId} display hand-off failed: ${error.message}`)
    return false
  } finally {
    if (replacement) desktopOrganizerTransitionWindows.delete(replacement)
    if (!win.isDestroyed()) {
      win.desktopAttachmentInFlight = false
      win.desktopOrganizerDisplayTransitionInFlight = false
      const pendingDisplayId = win.desktopPendingDisplayId
      win.desktopPendingDisplayId = null
      if (pendingDisplayId && pendingDisplayId !== win.desktopDisplayId) {
        void transitionDesktopOrganizerToDisplay(win, pendingDisplayId)
      }
    }
  }
}

const syncDesktopWidgetWindowFrame = (win, widget) => {
  if (!win || win.isDestroyed()) return
  const nextDisplayId = desktopWidgetDisplayId(widget)
  const displayChanged = win.desktopDisplayId !== nextDisplayId
  if (widget.kind === 'organizer' && displayChanged && win.desktopOrganizerChildAttached) {
    win.desktopPendingDisplayId = nextDisplayId
    // Start creating and painting the destination-DPI surface as soon as the
    // pointer crosses a monitor boundary. Pointer capture remains on the old
    // HWND; on release the already-prepared replacement can be published in a
    // single frame instead of making the user wait for a new renderer.
    void prepareDesktopOrganizerTransition(win, nextDisplayId)
    if (!win.desktopInteractionLocked) {
      void transitionDesktopOrganizerToDisplay(win, nextDisplayId)
      return
    }
    // Every per-DPI organizer host spans the complete physical virtual desktop.
    // Keep the old-display child following the pointer while the gesture owns
    // Chromium capture, then recreate it on the destination DPI after release.
    // Previously this branch returned without moving, which visibly pinned the
    // organizer to the monitor edge until pointer-up.
    const nextBounds = desktopWidgetWindowBounds(widget)
    win.desktopProgrammaticMoveUntil = Date.now() + 150
    setDesktopOrganizerLockedPreviewBounds(win, nextBounds)
    win.desktopRequestedBounds = nextBounds
    applyDesktopOrganizerHostShape(win.desktopDisplayId)
    return
  }
  if (widget.kind === 'organizer' && win.desktopInteractionLocked) {
    // The pointer can cross a boundary and come back before release.
    win.desktopPendingDisplayId = null
    cancelPreparedDesktopOrganizerTransition(win)
  }
  win.desktopDisplayId = nextDisplayId
  if (widget.kind === 'organizer') syncDesktopOrganizerRendererScale(win)
  const nextBounds = desktopWidgetWindowBounds(widget)
  const requestedBounds = win.desktopRequestedBounds
  const sizeChanged = !requestedBounds
    || requestedBounds.width !== nextBounds.width
    || requestedBounds.height !== nextBounds.height
  const positionChanged = !requestedBounds
    || requestedBounds.x !== nextBounds.x
    || requestedBounds.y !== nextBounds.y
  if (displayChanged || sizeChanged) {
    win.desktopProgrammaticMoveUntil = Date.now() + 150
    setDesktopWidgetWindowBounds(win, nextBounds)
  } else if (positionChanged) {
    // Position-only updates avoid repeatedly resizing a high-DPI transparent window while dragging.
    win.desktopProgrammaticMoveUntil = Date.now() + 150
    setDesktopWidgetWindowPosition(win, nextBounds.x, nextBounds.y)
  }
  if (widget.kind === 'organizer' && (displayChanged || sizeChanged || !win.desktopOrganizerShapeApplied)) {
    applyDesktopOrganizerWindowShape(win, desktopWidgetNativeBounds(win, nextBounds))
  }
  win.desktopRequestedBounds = nextBounds
  if (widget.kind === 'organizer') applyDesktopOrganizerHostShape()
  if (displayChanged) {
    scheduleDesktopWidgetGeometryReconcile(win, {
      reason: 'display-transition',
      delays: [60, 220, 600],
      forceSurface: true,
    })
  } else if (sizeChanged) {
    scheduleDesktopWidgetGeometryReconcile(win, {
      reason: 'logical-resize',
      delays: [80, 260],
      forceSurface: false,
    })
  }
}

const commitDesktopWidgetNativeMove = (win) => enqueueWorkspaceMutation(async () => {
  if (!win || win.isDestroyed()) return cloneWorkspace()
  const currentWidget = workspaceState.widgets.find((widget) => widget.id === win.desktopWidgetId)
  if (!currentWidget) return cloneWorkspace()
  const bounds = win.getBounds()
  const virtualBounds = virtualScreenBounds()
  const display = win.desktopOrganizerChildAttached ? desktopDisplayById(win.desktopDisplayId) : null
  const ratio = display ? desktopOrganizerHostScaleRatio(win.desktopDisplayId) : 1
  const screenX = display
    ? display.workArea.x + (bounds.x - display.workArea.x) / ratio
    : bounds.x
  const screenY = display
    ? display.workArea.y + (bounds.y - display.workArea.y) / ratio
    : bounds.y
  const constrainedWidget = constrainWidgetFrame({
    ...currentWidget,
    x: screenX - virtualBounds.x + desktopWidgetWindowMargin,
    y: screenY - virtualBounds.y + desktopWidgetWindowMargin,
  })
  const constrainedBounds = desktopWidgetWindowBounds(constrainedWidget)
  const targetWindowPosition = { x: constrainedBounds.x, y: constrainedBounds.y }
  if (bounds.x !== targetWindowPosition.x || bounds.y !== targetWindowPosition.y) {
    win.desktopProgrammaticMoveUntil = Date.now() + 150
    setDesktopWidgetWindowPosition(win, targetWindowPosition.x, targetWindowPosition.y)
  }
  win.desktopRequestedBounds = {
    ...constrainedBounds,
    ...targetWindowPosition,
  }
  const nextState = cloneWorkspace()
  const index = nextState.widgets.findIndex((widget) => widget.id === win.desktopWidgetId)
  if (index < 0) return nextState
  nextState.widgets[index] = {
    ...nextState.widgets[index],
    x: constrainedWidget.x,
    y: constrainedWidget.y,
  }
  return updateWorkspace(nextState)
})

const prepareDesktopWidgetFirstFrame = async (win) => {
  if (!win || win.isDestroyed()) return false
  try {
    const result = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const expectedWidgetId = ${JSON.stringify(win.desktopWidgetId)}
      const deadline = performance.now() + 2500
      const inspect = () => {
        const widget = [...document.querySelectorAll('.desktop-widget')]
          .find((element) => element.dataset.widgetId === expectedWidgetId)
        const rect = widget?.getBoundingClientRect()
        const style = widget ? getComputedStyle(widget) : null
        if (
          widget
          && rect?.width > 0
          && rect?.height > 0
          && style?.clipPath?.includes('inset')
        ) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            ready: true,
            width: rect.width,
            height: rect.height,
            clipPath: style.clipPath,
          })))
          return
        }
        if (performance.now() >= deadline) {
          resolve({ ready: false, reason: 'widget DOM did not paint before startup deadline' })
          return
        }
        setTimeout(inspect, 16)
      }
      inspect()
    })`)
    win.desktopFirstFramePrepared = Boolean(result?.ready)
    if (!result?.ready) {
      console.warn(`[desktop-host] widget=${win.desktopWidgetId} first-frame preparation timed out: ${result?.reason || 'unknown reason'}`)
    }
    if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate()
    if (result?.ready) await win.webContents.capturePage()
    return Boolean(result?.ready)
  } catch (error) {
    console.warn(`[desktop-host] widget=${win.desktopWidgetId} first-frame preparation failed: ${error.message}`)
    return false
  }
}

const establishDesktopOrganizerTopLevelDpi = async (win, widget) => {
  if (!isOrganizerWidgetWindow(win) || win.isDestroyed()) return false
  const bounds = desktopWidgetWindowBounds(widget)
  try {
    // Keep the HWND top-level for this one operation. GetDpiForWindow can then
    // observe the monitor under its real screen coordinates, and the native
    // client plus Chromium child are sized once from that DPI before SetParent
    // crosses into Explorer's primary-DPI process.
    const display = desktopDisplayById(desktopWidgetDisplayId(widget))
    const metricsResult = await desktopIconHelperRequest('window-geometries', {
      hwnds: [getWindowHandle(win)],
    }, 1_200)
    const metric = Array.isArray(metricsResult) ? metricsResult[0] : metricsResult
    const currentScale = Math.max(0.25, (Number(desktopWidgetGeometryMetricValue(metric, 'Dpi')) || 96) / 96)
    const targetScale = Number(display?.scaleFactor) || currentScale
    await desktopIconHelperRequest('resize-window-for-dpi', {
      hwnd: getWindowHandle(win),
      logicalWidth: Math.round(bounds.width * targetScale / currentScale),
      logicalHeight: Math.round(bounds.height * targetScale / currentScale),
    }, 1_200)
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      window.dispatchEvent(new Event('resize'))
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })`)
    return true
  } catch (error) {
    console.warn(`[desktop-geometry] organizer=${widget.id} initial DPI sizing failed: ${error.message}`)
    return false
  }
}

const stabilizeAttachedDesktopOrganizerGeometry = async (win, widget) => {
  if (!isOrganizerWidgetWindow(win) || win.isDestroyed() || !win.desktopOrganizerChildAttached) return false
  const display = desktopDisplayById(win.desktopDisplayId)
  if (!display) return false
  const clientBounds = desktopWidgetPhysicalClientBounds(win, desktopWidgetWindowBounds(widget))
  try {
    // SetParent posts a DPI transition after the helper returns. Let it settle,
    // then restore the target monitor's complete physical parent-client frame.
    // BrowserWindow.setBounds still treats a parented HWND as a top-level DIP
    // window and double-subtracts the virtual desktop origin on mixed-DPI
    // layouts, so both position and size are committed natively here.
    await new Promise((resolve) => setTimeout(resolve, 40))
    await runDesktopHostHelper(win, { clientBounds })
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      window.dispatchEvent(new Event('resize'))
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })`)
    return true
  } catch (error) {
    console.warn(`[desktop-geometry] organizer=${widget.id} attached DPI stabilization failed: ${error.message}`)
    return false
  }
}

const revealDesktopWidgetFirstFrame = async (win) => {
  if (!win || win.isDestroyed()) return false
  try {
    if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate()
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })`)
    // capturePage forces Chromium to commit the complete alpha surface while
    // the native window is still invisible. This prevents white corner pixels
    // from surviving until the first mouse-triggered repaint on Windows.
    await win.webContents.capturePage()
  } catch (error) {
    console.warn(`[desktop-host] widget=${win.desktopWidgetId} first-frame commit failed: ${error.message}`)
  }
  if (!win || win.isDestroyed()) return false
  win.setOpacity(1)
  win.desktopFirstFrameRevealed = true
  if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate()
  return true
}

const createDesktopWidgetWindow = (widget, options = {}) => {
  const existing = desktopWidgetWindows.get(widget.id)
  if (existing && !existing.isDestroyed() && !options.replacement) {
    syncDesktopWidgetWindowFrame(existing, widget)
    return existing
  }

  const initialDisplayId = desktopWidgetDisplayId(widget)
  const initialRendererScale = Number(desktopDisplayById(initialDisplayId)?.scaleFactor) || 1
  const initialZoomFactor = 1
  const requestedBounds = desktopWidgetWindowBounds(widget)
  const win = new BrowserWindow({
    ...requestedBounds,
    // Windows assigns hidden top-level HWNDs the primary monitor's DPI even
    // when their coordinates are on another display. Organizer windows start
    // almost transparent and are made mouse-pass-through synchronously below,
    // so they can receive the correct target-monitor DPI at construction.
    show: widget.kind === 'organizer',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // Keep the HWND visible to the native desktop helper while making any
    // pre-commit pixels effectively invisible to the user.
    opacity: 0.01,
    hasShadow: false,
    skipTaskbar: true,
    // Organizer windows are true children of the eDesktop/Progman host. They
    // can use normal Chromium focus and pointer capture without participating
    // in the global top-level activation order.
    focusable: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      ...commonWebPreferences(),
      zoomFactor: initialZoomFactor,
    },
  })
  win.desktopWidgetId = widget.id
  win.desktopWidgetKind = widget.kind
  win.desktopDisplayId = initialDisplayId
  win.desktopOrganizerRendererBaseScale = initialRendererScale
  win.desktopOrganizerZoomFactor = initialZoomFactor
  win.desktopRequestedBounds = requestedBounds
  win.desktopIsTransitionReplacement = Boolean(options.replacement)
  let resolveDesktopReady
  win.desktopReadyPromise = new Promise((resolve) => {
    resolveDesktopReady = resolve
  })
  // Exclude the HWND from organizer health checks from construction
  // until its first desktop attachment has fully completed.
  win.desktopAttachmentInFlight = true
  if (widget.kind === 'organizer') {
    applyDesktopOrganizerWindowShape(win, win.desktopRequestedBounds)
    // A hidden BrowserWindow can be sized using the primary display's DPI even
    // when its coordinates belong to another monitor. Briefly exposing the
    // almost-transparent, mouse-pass-through HWND lets Windows assign the real
    // monitor DPI before Chromium creates its first surface.
    win.setIgnoreMouseEvents(true)
    win.desktopPointerInteractive = false
    win.showInactive()
    win.setBounds(requestedBounds, false)
  }
  if (options.replacement) desktopOrganizerTransitionWindows.add(win)
  else desktopWidgetWindows.set(widget.id, win)
  if (!desktopWindow || desktopWindow.isDestroyed()) desktopWindow = win
  loadSurface(win, 'desktop', {
    widgetId: widget.id,
    widgetWindow: '1',
    widgetMargin: String(desktopWidgetWindowMargin),
    organizerRadius: String(desktopOrganizerVisualRadius),
  })
  win.webContents.once('did-finish-load', async () => {
    if (!workspaceState?.settings.desktopEnabled || win.isDestroyed()) return
    win.desktopAttachmentInFlight = true
    try {
      if (widget.kind === 'organizer') await establishDesktopOrganizerTopLevelDpi(win, widget)
      await prepareDesktopWidgetFirstFrame(win)
      if (!workspaceState?.settings.desktopEnabled || win.isDestroyed()) return
      await attachDesktopWindow(win)
      if (!workspaceState?.settings.desktopEnabled || win.isDestroyed()) return
      if (options.deferReveal) {
        // The window must stay genuinely invisible until the old source-DPI
        // HWND is still present at the same rectangle. Its compositor surface
        // has already been forced to commit by prepareDesktopWidgetFirstFrame.
        await win.webContents.executeJavaScript(`new Promise((resolve) => {
          window.dispatchEvent(new Event('resize'))
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        })`)
        if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate()
        await win.webContents.capturePage()
        win.setOpacity(0)
        win.desktopFirstFrameRevealed = false
      } else {
        await revealDesktopWidgetFirstFrame(win)
      }
      resolveDesktopReady(Boolean(win.desktopOrganizerChildAttached || widget.kind !== 'organizer'))
    } catch (error) {
      if (!win.isDestroyed()) {
        if (!options.deferReveal) win.setOpacity(1)
        console.error(`[desktop-host] widget=${widget.id} startup attachment failed: ${error.message}`)
      }
      resolveDesktopReady(false)
    } finally {
      if (!win.isDestroyed()) win.desktopAttachmentInFlight = false
      refreshDesktopHostStatus()
    }
  })
  win.on('will-move', () => {
    // React-driven drag previews call setPosition once per animation frame.
    // Electron reports those as native move events too; they must not start a
    // second interaction or let the health loop unlock the active gesture.
    if (Date.now() <= (win.desktopProgrammaticMoveUntil || 0)) return
    if (!win.desktopNativeMoveStart) win.desktopNativeMoveStart = { startedAt: Date.now() }
    win.desktopInteractionLocked = true
  })
  win.on('moved', () => {
    if (Date.now() <= (win.desktopProgrammaticMoveUntil || 0)) return
    const moveStart = win.desktopNativeMoveStart
    if (!moveStart) return
    win.desktopNativeMoveStart = null
    win.desktopInteractionLocked = false
    refreshDesktopPointerHitTest()
    void commitDesktopWidgetNativeMove(win)
    scheduleDesktopWidgetGeometryReconcile(win, {
      reason: 'native-move-complete',
      delays: [60, 240, 600],
      forceSurface: true,
    })
  })
  win.on('closed', () => {
    resolveDesktopReady(false)
    desktopOrganizerTransitionWindows.delete(win)
    if (!win.desktopIsTransitionReplacement) {
      desktopWidgetGeometryRecoveryTokens.delete(widget.id)
      desktopWidgetGeometryMismatchCounts.delete(widget.id)
    }
    if (desktopWidgetWindows.get(widget.id) === win) desktopWidgetWindows.delete(widget.id)
    if (desktopWindow === win) desktopWindow = liveDesktopWindows()[0] || null
  })
  return win
}

const syncDesktopWidgetWindows = () => {
  if (!useDesktopWidgetWindows) return []
  const visibleWidgets = workspaceState?.settings.desktopEnabled
    ? workspaceState.widgets.filter((widget) => !widget.hidden)
    : []
  const visibleIds = new Set(visibleWidgets.map((widget) => widget.id))

  for (const [widgetId, win] of desktopWidgetWindows) {
    if (visibleIds.has(widgetId)) continue
    desktopWidgetWindows.delete(widgetId)
    if (!win.isDestroyed()) win.destroy()
  }
  const windows = visibleWidgets.map((widget) => {
    const win = createDesktopWidgetWindow(widget)
    syncDesktopWidgetWindowFrame(win, widget)
    return win
  })
  desktopWindow = windows[0] || null
  applyDesktopOrganizerHostShape()
  return windows
}

const createDesktopWidgetWindows = () => syncDesktopWidgetWindows()

const startDesktopForegroundProbe = async ({ name = 'foreground', x = 1120, y = 24 } = {}) => {
  const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, '') || 'foreground'
  const readyPath = path.join(desktopHostFileTestRoot, `${safeName}.ready`)
  const stopPath = path.join(desktopHostFileTestRoot, `${safeName}.stop`)
  const clickPath = path.join(desktopHostFileTestRoot, `${safeName}.click`)
  await fs.promises.mkdir(desktopHostFileTestRoot, { recursive: true })
  await Promise.all([readyPath, stopPath, clickPath].map((target) => fs.promises.rm(target, { force: true })))
  const quotePowerShellLiteral = (value) => String(value).replace(/'/g, "''")
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ProbeMouse { [DllImport(\"user32.dll\")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo); }'",
    '$form = New-Object System.Windows.Forms.Form',
    `$form.Text = 'eDesktop ${safeName} input probe'`,
    '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
    `$form.Location = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})`,
    '$form.Size = New-Object System.Drawing.Size(260, 120)',
    '$form.TopMost = $true',
    '$form.Show()',
    '$form.Activate()',
    '[System.Windows.Forms.Application]::DoEvents()',
    `Set-Content -LiteralPath '${quotePowerShellLiteral(readyPath)}' -Value $form.Handle.ToInt64() -Encoding ascii`,
    `$stopPath = '${quotePowerShellLiteral(stopPath)}'`,
    `$clickPath = '${quotePowerShellLiteral(clickPath)}'`,
    'while (-not (Test-Path -LiteralPath $stopPath)) {',
    '  [System.Windows.Forms.Application]::DoEvents()',
    '  if (Test-Path -LiteralPath $clickPath) {',
    '    Remove-Item -LiteralPath $clickPath -Force',
    '    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(($form.Left + 48), ($form.Top + 48))',
    '    [ProbeMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)',
    '    Start-Sleep -Milliseconds 70',
    '    [ProbeMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)',
    '  }',
    '  Start-Sleep -Milliseconds 20',
    '}',
    '$form.Close()',
  ].join('; ')
  const child = spawn(windowsPowerShellPath(), [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, stdio: 'ignore' })
  const deadline = Date.now() + 5_000
  while (!fs.existsSync(readyPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  if (!fs.existsSync(readyPath)) {
    child.kill()
    throw new Error('external foreground probe did not become ready')
  }
  await new Promise((resolve) => setTimeout(resolve, 160))
  return {
    processId: child.pid,
    windowHandle: Number.parseInt(await fs.promises.readFile(readyPath, 'ascii'), 10),
    click: async () => {
      await fs.promises.writeFile(clickPath, 'click', 'ascii')
      const clickDeadline = Date.now() + 2_000
      while (fs.existsSync(clickPath) && Date.now() < clickDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      if (fs.existsSync(clickPath)) throw new Error('external foreground probe click timed out')
      await new Promise((resolve) => setTimeout(resolve, 160))
    },
    stop: async () => {
      await fs.promises.writeFile(stopPath, 'stop', 'ascii').catch(() => {})
      if (child.exitCode === null) {
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ])
      }
      if (child.exitCode === null) child.kill()
    },
  }
}

const runDesktopWidgetWindowRegression = () => {
  setTimeout(async () => {
    try {
      const expectedWidgets = workspaceState.widgets.filter((widget) => !widget.hidden)
      const windows = liveDesktopWidgetWindows()
      if (liveDisplayDesktopWindows().length !== 0 || windows.length !== expectedWidgets.length) {
        throw new Error(`independent widget window count mismatch: ${windows.length}/${expectedWidgets.length}`)
      }

      const startupDeadline = Date.now() + 6_000
      while (
        windows.some((win) => !win.isDestroyed() && win.desktopFirstFrameRevealed !== true)
        && Date.now() < startupDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const nativeHandles = windows.map(getWindowHandle)
      if (new Set(nativeHandles).size !== windows.length) {
        throw new Error('multiple widgets unexpectedly share one native window')
      }
      for (const widget of expectedWidgets) {
        const win = desktopWidgetWindows.get(widget.id)
        if (!win || win.isDestroyed()) throw new Error(`widget window missing: ${widget.id}`)
        const renderer = await win.webContents.executeJavaScript(`(() => {
          const widgets = [...document.querySelectorAll('.desktop-widget')]
          const element = widgets[0]
          const rect = element?.getBoundingClientRect()
          const dragHandle = element?.querySelector('.widget-drag-handle')
          const interactiveHeaderControl = dragHandle?.querySelector('button, input, textarea')
          const titleInput = element?.querySelector('.widget-title-input')
          const titleStatic = element?.querySelector('.widget-title-static')
          const dragAffordance = element?.querySelector('.drag-affordance')
          const elementStyle = element ? getComputedStyle(element) : null
          const compactRect = (node) => {
            const bounds = node?.getBoundingClientRect()
            return bounds ? { left: bounds.left, right: bounds.right, width: bounds.width } : null
          }
          return {
            count: widgets.length,
            id: element?.dataset.widgetId || '',
            rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
            dragRegion: dragHandle ? getComputedStyle(dragHandle).getPropertyValue('-webkit-app-region') : '',
            controlRegion: interactiveHeaderControl
              ? getComputedStyle(interactiveHeaderControl).getPropertyValue('-webkit-app-region')
              : '',
            titleInputRect: compactRect(titleInput),
            titleStaticRect: compactRect(titleStatic),
            dragAffordanceRect: compactRect(dragAffordance),
            dragAffordanceRegion: dragAffordance
              ? getComputedStyle(dragAffordance).getPropertyValue('-webkit-app-region')
              : '',
            nativeTitleCount: element?.querySelectorAll('[title]').length || 0,
            boxShadow: elementStyle?.boxShadow || '',
            clipPath: elementStyle?.clipPath || '',
            backdropFilter: elementStyle?.backdropFilter || elementStyle?.webkitBackdropFilter || '',
          }
        })()`)
        if (
          !win.isMovable()
          || Math.abs(win.getOpacity() - 1) > 0.001
          || win.desktopFirstFramePrepared !== true
          || win.desktopFirstFrameRevealed !== true
          || renderer.count !== 1
          || renderer.id !== widget.id
          || !renderer.rect
          || Math.abs(renderer.rect.x - desktopWidgetWindowMargin) > 2
          || Math.abs(renderer.rect.y - desktopWidgetWindowMargin) > 2
          || Math.abs(renderer.rect.width - widget.width) > 1
          || Math.abs(renderer.rect.height - widget.height) > 1
          || renderer.dragRegion !== (widget.kind === 'organizer' ? 'no-drag' : 'drag')
          || (renderer.controlRegion && renderer.controlRegion !== 'no-drag')
          || (widget.kind !== 'organizer' && renderer.boxShadow !== 'none')
          || (widget.kind === 'organizer' && (
            !renderer.boxShadow.includes('inset')
            || !renderer.clipPath.includes('round 10px')
          ))
          || !renderer.clipPath.includes('inset')
          || (widget.kind === 'organizer' && renderer.nativeTitleCount !== 0)
          || (widget.kind === 'organizer' && renderer.backdropFilter !== 'none')
          || (widget.kind === 'todo' && (
            !renderer.titleStaticRect
            || !renderer.dragAffordanceRect
            || renderer.titleStaticRect.right > renderer.dragAffordanceRect.left
            || renderer.dragAffordanceRect.width < 28
            || renderer.dragAffordanceRegion !== 'drag'
          ))
        ) {
          throw new Error(`isolated widget renderer mismatch: ${widget.id} ${JSON.stringify({
            renderer,
            opacity: win.getOpacity(),
            firstFramePrepared: win.desktopFirstFramePrepared,
            firstFrameRevealed: win.desktopFirstFrameRevealed,
            attachmentInFlight: win.desktopAttachmentInFlight,
          })}`)
        }
        if (widget.kind === 'organizer') {
          const nativeShape = roundedDesktopOrganizerShape(widget.width, widget.height)
          const topRow = nativeShape.find((rect) => rect.y === 0)
          if (
            desktopOrganizerVisualRadius !== 10
            || desktopOrganizerNativeShapeRadius !== 8
            || !topRow
            || topRow.x >= desktopOrganizerVisualRadius
          ) {
            throw new Error(`organizer antialias shape mismatch: ${JSON.stringify({
              visualRadius: desktopOrganizerVisualRadius,
              nativeRadius: desktopOrganizerNativeShapeRadius,
              topInset: topRow?.x,
            })}`)
          }
        }
      }
      console.log('[desktop-host] startup alpha assertion passed: every widget painted while hidden and revealed only after an explicit compositor commit')

      const organizerWidgets = expectedWidgets.filter((widget) => widget.kind === 'organizer')
      let organizerWindows = organizerWidgets.map((widget) => desktopWidgetWindows.get(widget.id))
      if (organizerWindows.length < 2 || organizerWindows.some((win) => !win || win.isDestroyed())) {
        throw new Error('multi-organizer z-order test windows were not created')
      }
      const mixedDpiDisplays = screen.getAllDisplays()
      let mixedDpiWindow = organizerWindows[0]
      const mixedDpiWidget = workspaceState.widgets.find((widget) => widget.id === mixedDpiWindow.desktopWidgetId)
      const mixedDpiSourceDisplay = screen.getDisplayMatching(mixedDpiWindow.getBounds())
      const mixedDpiSourceScaleFactor = Number(mixedDpiSourceDisplay.scaleFactor)
      const mixedDpiTargetDisplay = mixedDpiDisplays.find((display) => (
        Math.abs(display.scaleFactor - mixedDpiSourceScaleFactor) > 0.01
      ))
      if (mixedDpiWidget && mixedDpiTargetDisplay) {
        const waitForMixedDpiWindow = async () => {
          const deadline = Date.now() + 4_000
          do {
            const current = desktopWidgetWindows.get(mixedDpiWidget.id)
            if (current && !current.isDestroyed() && !current.desktopAttachmentInFlight) return current
            await new Promise((resolve) => setTimeout(resolve, 40))
          } while (Date.now() < deadline)
          return desktopWidgetWindows.get(mixedDpiWidget.id) || null
        }
        const mixedDpiTargetScaleFactor = Number(mixedDpiTargetDisplay.scaleFactor)
        const originalFrame = {
          x: mixedDpiWidget.x,
          y: mixedDpiWidget.y,
          width: mixedDpiWidget.width,
          height: mixedDpiWidget.height,
        }
        const virtualBounds = virtualScreenBounds()
        mixedDpiWidget.x = mixedDpiTargetDisplay.workArea.x - virtualBounds.x + 24
        mixedDpiWidget.y = mixedDpiTargetDisplay.workArea.y - virtualBounds.y + 40
        const dragPreviewHandle = getWindowHandle(mixedDpiWindow)
        // Keep the synthetic lock alive without injecting a real mouse-down;
        // the health loop correctly releases locks when Windows reports every
        // button up, which is covered separately below.
        desktopOrganizerBandHealthInFlight = true
        mixedDpiWindow.desktopInteractionLocked = true
        mixedDpiWindow.desktopInteractionLockedAt = Date.now()
        syncDesktopWidgetWindowFrame(mixedDpiWindow, mixedDpiWidget)
        const previewDeadline = Date.now() + 2_000
        while (
          (mixedDpiWindow.desktopNativeClientBoundsInFlight || mixedDpiWindow.desktopPendingNativeClientBounds)
          && Date.now() < previewDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        const previewMetrics = await desktopIconHelperRequest('window-geometries', {
          hwnds: [dragPreviewHandle],
        }, 1_200)
        const previewMetric = Array.isArray(previewMetrics) ? previewMetrics[0] : previewMetrics
        const expectedPreviewRect = physicalScreenRect(desktopWidgetWindowBounds(mixedDpiWidget))
        const expectedLockedPreviewRect = desktopWidgetLockedPreviewClientBounds(
          mixedDpiWindow,
          desktopWidgetWindowBounds(mixedDpiWidget),
        )
        const previewInvalid = (
          desktopWidgetWindows.get(mixedDpiWidget.id) !== mixedDpiWindow
          || getWindowHandle(mixedDpiWindow) !== dragPreviewHandle
          || mixedDpiWindow.desktopPendingDisplayId !== String(mixedDpiTargetDisplay.id)
          || Math.abs(Number(desktopWidgetGeometryMetricValue(previewMetric, 'X')) - expectedPreviewRect.x) > 3
          || Math.abs(Number(desktopWidgetGeometryMetricValue(previewMetric, 'Y')) - expectedPreviewRect.y) > 3
          || Math.abs(Number(desktopWidgetGeometryMetricValue(previewMetric, 'ClientWidth')) - expectedLockedPreviewRect.width) > 3
          || Math.abs(Number(desktopWidgetGeometryMetricValue(previewMetric, 'ClientHeight')) - expectedLockedPreviewRect.height) > 3
        )
        desktopOrganizerBandHealthInFlight = false
        if (previewInvalid) {
          throw new Error(`mixed-DPI locked preview stopped at the source edge: ${JSON.stringify({
            pendingDisplayId: mixedDpiWindow.desktopPendingDisplayId,
            previewMetric,
            expectedPreviewRect,
            expectedLockedPreviewRect,
          })}`)
        }
        finishDesktopWindowInteraction(mixedDpiWindow)
        mixedDpiWindow = await waitForMixedDpiWindow()
        if (!mixedDpiWindow || mixedDpiWindow.isDestroyed()) {
          throw new Error('mixed-DPI move did not recreate the organizer on its target display')
        }
        if (
          mixedDpiWindow.desktopTransitionSourceHandle !== dragPreviewHandle
          || mixedDpiWindow.desktopTransitionSourcePreserved !== true
        ) {
          throw new Error('mixed-DPI move was not switched from a prepared double-buffered surface')
        }
        await reconcileDesktopWidgetGeometry(mixedDpiWindow, {
          reason: 'mixed-dpi-regression',
          forceSurface: true,
        })
        const readMixedDpiState = async () => {
          const result = await desktopIconHelperRequest('window-geometries', {
            hwnds: [getWindowHandle(mixedDpiWindow)],
          }, 1_200)
          const metric = Array.isArray(result) ? result[0] : result
          const renderer = await inspectDesktopWidgetRendererGeometry(mixedDpiWindow)
          return {
            metric,
            renderer,
            mismatch: desktopWidgetNativeGeometryMismatch(mixedDpiWidget, metric, renderer)
              || desktopWidgetRendererGeometryMismatch(mixedDpiWidget, renderer),
          }
        }
        const assertMixedDpiHostShape = async (phase) => {
          const host = desktopOrganizerHostForWindow(mixedDpiWindow)
          if (!host) throw new Error(`mixed-DPI ${phase} host is missing`)
          const clientBounds = desktopWidgetPhysicalClientBounds(
            mixedDpiWindow,
            desktopWidgetWindowBounds(mixedDpiWidget),
          )
          const shapeResult = await runDesktopHostHelper(host, {
            shapePoint: {
              x: clientBounds.x + Math.floor(clientBounds.width / 2),
              y: clientBounds.y + Math.floor(clientBounds.height / 2),
            },
          })
          if (!shapeResult.includes('inside=True')) {
            throw new Error(`mixed-DPI ${phase} organizer was clipped out: ${JSON.stringify({
              clientBounds,
              shapeResult,
            })}`)
          }
        }
        const movedMixedDpiState = await readMixedDpiState()
        if (movedMixedDpiState.mismatch) {
          throw new Error(`mixed-DPI move was not reconciled: ${JSON.stringify(movedMixedDpiState)}`)
        }
        await assertMixedDpiHostShape('move')

        Object.assign(mixedDpiWidget, originalFrame)
        const restorePreviewHandle = getWindowHandle(mixedDpiWindow)
        desktopOrganizerBandHealthInFlight = true
        mixedDpiWindow.desktopInteractionLocked = true
        mixedDpiWindow.desktopInteractionLockedAt = Date.now()
        syncDesktopWidgetWindowFrame(mixedDpiWindow, mixedDpiWidget)
        const restorePreviewDeadline = Date.now() + 2_000
        while (
          (mixedDpiWindow.desktopNativeClientBoundsInFlight || mixedDpiWindow.desktopPendingNativeClientBounds)
          && Date.now() < restorePreviewDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        const restorePreviewMetrics = await desktopIconHelperRequest('window-geometries', {
          hwnds: [restorePreviewHandle],
        }, 1_200)
        const restorePreviewMetric = Array.isArray(restorePreviewMetrics)
          ? restorePreviewMetrics[0]
          : restorePreviewMetrics
        const expectedRestorePreviewRect = desktopWidgetLockedPreviewClientBounds(
          mixedDpiWindow,
          desktopWidgetWindowBounds(mixedDpiWidget),
        )
        if (
          desktopWidgetWindows.get(mixedDpiWidget.id) !== mixedDpiWindow
          || mixedDpiWindow.desktopPendingDisplayId !== String(mixedDpiSourceDisplay.id)
          || Math.abs(Number(desktopWidgetGeometryMetricValue(restorePreviewMetric, 'ClientWidth')) - expectedRestorePreviewRect.width) > 3
          || Math.abs(Number(desktopWidgetGeometryMetricValue(restorePreviewMetric, 'ClientHeight')) - expectedRestorePreviewRect.height) > 3
        ) {
          throw new Error(`mixed-DPI reverse locked preview exposed an incomplete surface: ${JSON.stringify({
            restorePreviewMetric,
            expectedRestorePreviewRect,
          })}`)
        }
        desktopOrganizerBandHealthInFlight = false
        finishDesktopWindowInteraction(mixedDpiWindow)
        mixedDpiWindow = await waitForMixedDpiWindow()
        if (!mixedDpiWindow || mixedDpiWindow.isDestroyed()) {
          throw new Error('mixed-DPI restore did not recreate the organizer on its source display')
        }
        if (
          mixedDpiWindow.desktopTransitionSourceHandle !== restorePreviewHandle
          || mixedDpiWindow.desktopTransitionSourcePreserved !== true
        ) {
          throw new Error('mixed-DPI restore was not switched from a prepared double-buffered surface')
        }
        await reconcileDesktopWidgetGeometry(mixedDpiWindow, {
          reason: 'mixed-dpi-restore-regression',
          forceSurface: true,
        })
        const restoredMixedDpiState = await readMixedDpiState()
        if (restoredMixedDpiState.mismatch) {
          throw new Error(`mixed-DPI restore did not settle: ${JSON.stringify(restoredMixedDpiState)}`)
        }
        await assertMixedDpiHostShape('restore')
        desktopWidgetGeometryRecoveryTokens.set(mixedDpiWidget.id, Symbol('mixed-dpi-regression-complete'))
        console.log(`[desktop-geometry] mixed-DPI live-drag + geometry + host-clip assertion passed: ${mixedDpiSourceScaleFactor} -> ${mixedDpiTargetScaleFactor} -> ${mixedDpiSourceScaleFactor}`)
      } else {
        console.log('[desktop-geometry] mixed-DPI assertion skipped: no displays with different scale factors')
      }
      organizerWindows = organizerWidgets.map((widget) => desktopWidgetWindows.get(widget.id))
      if (organizerWindows.some((win) => !win || win.isDestroyed())) {
        throw new Error('organizer windows were not restored after the mixed-DPI regression')
      }
      await normalizeDesktopOrganizerZOrder()
      const inspectOrganizerBandOrder = async () => {
        const inspections = []
        const displayIds = new Set(desktopOrganizerBandWindows().map((win) => win.desktopDisplayId))
        for (const displayId of displayIds) {
          const orderedWindows = desktopOrganizerBandWindows(displayId)
          inspections.push(...await Promise.all(orderedWindows.slice(1).map((win, index) => (
            runDesktopHostHelper(win, { inspectOnly: true, compareWindow: orderedWindows[index] })
          ))))
        }
        return inspections
      }
      if (organizerWindows.some((win) => !win.desktopPointerInteractive)) {
        throw new Error('an organizer window unexpectedly started in mouse pass-through mode')
      }
      const startupWindowStyles = await Promise.all(organizerWindows.map((win) => (
        runDesktopHostHelper(win, { inspectOnly: true })
      )))
      if (startupWindowStyles.some((result) => !result.includes('transparent=False'))) {
        throw new Error(`an organizer window retained WS_EX_TRANSPARENT after first show: ${JSON.stringify(startupWindowStyles)}`)
      }
      console.log('[desktop-host] organizer interaction assertion passed: organizer windows start interactive without WS_EX_TRANSPARENT')
      const bottomOrganizerWindow = organizerWindows[0]
      if (
        !bottomOrganizerWindow.desktopOrganizerLayerResult?.includes('placement=desktop-child')
        || organizerWindows.some((win) => (
          !win.desktopOrganizerLayerResult?.includes(`parent=${getWindowHandle(desktopOrganizerHostForWindow(win))}`)
          || !win.desktopOrganizerLayerResult?.includes('no-activate=False')
        ))
      ) {
        throw new Error(`first organizer was not attached to the native desktop child host: ${bottomOrganizerWindow.desktopOrganizerLayerResult || 'missing result'}`)
      }
      const stableBandOrder = await inspectOrganizerBandOrder()
      if (stableBandOrder.some((result) => (
        !result.includes('compare-above=False') || !result.includes('window-above-compare=True')
      ))) {
        throw new Error(`organizer startup order was not preserved in the desktop band: ${JSON.stringify(stableBandOrder)}`)
      }

      const originalOrganizerGestureFrames = new Map(organizerWidgets.map((widget) => [
        widget.id,
        { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
      ]))
      const restoreOrganizerGestureFrames = async () => {
        const restoredState = cloneWorkspace()
        for (const widget of restoredState.widgets) {
          const frame = originalOrganizerGestureFrames.get(widget.id)
          if (frame) Object.assign(widget, frame)
        }
        await updateWorkspace(restoredState)
        await new Promise((resolve) => setTimeout(resolve, 120))
        await normalizeDesktopOrganizerZOrder()
      }
      const physicalGesture = async (win, startPoint, endPoint, dragSteps = 30) => {
        const result = await runDesktopHostHelper(win, {
          dragStartPoint: startPoint,
          dragEndPoint: endPoint,
          dragSteps,
        })
        await new Promise((resolve) => setTimeout(resolve, 240))
        return result
      }

      // Exercise the exact real-world path that used to fail: the first press
      // on a lower organizer starts a long gesture while the health watchdog is
      // active. Promotion must happen only after pointerup, not mid-capture.
      const lowerDragWidget = organizerWidgets[0]
      const lowerDragWindow = organizerWindows[0]
      const lowerDragStart = await lowerDragWindow.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.widget-organizer .desktop-widget-header')?.getBoundingClientRect()
        return rect ? { x: rect.left + 20, y: rect.top + rect.height / 2 } : null
      })()`)
      if (!lowerDragStart) throw new Error('lower organizer drag handle was not rendered')
      await lowerDragWindow.webContents.executeJavaScript(`(() => {
        window.__organizerGestureTrace = []
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup']) {
          window.addEventListener(type, (event) => {
            window.__organizerGestureTrace.push({
              type,
              x: event.clientX,
              y: event.clientY,
              buttons: event.buttons,
              target: event.target?.className || event.target?.tagName || '',
            })
          }, true)
        }
      })()`)
      const lowerDragBefore = { ...workspaceState.widgets.find((widget) => widget.id === lowerDragWidget.id) }
      const lowerDragResult = await physicalGesture(
        lowerDragWindow,
        lowerDragStart,
        { x: lowerDragStart.x + 26, y: lowerDragStart.y + 18 },
      )
      const lowerDragAfter = workspaceState.widgets.find((widget) => widget.id === lowerDragWidget.id)
      const lowerDragTrace = await lowerDragWindow.webContents.executeJavaScript('window.__organizerGestureTrace || []')
      if (
        !lowerDragResult.includes('dragged')
        || !lowerDragAfter
        || lowerDragAfter.x <= lowerDragBefore.x + 8
        || lowerDragAfter.y <= lowerDragBefore.y + 6
        || desktopOrganizerBandWindows(lowerDragWindow.desktopDisplayId).at(-1) !== lowerDragWindow
        || !lowerDragTrace.some((event) => event.type === 'pointerdown')
        || !lowerDragTrace.some((event) => event.type === 'pointermove' && event.buttons === 1)
        || !lowerDragTrace.some((event) => event.type === 'pointerup')
        || lowerDragTrace.some((event) => event.type === 'pointercancel')
      ) {
        throw new Error(`lower organizer first-gesture drag failed: ${JSON.stringify({ lowerDragResult, lowerDragBefore, lowerDragAfter, lowerDragTrace })}`)
      }

      await restoreOrganizerGestureFrames()
      promoteDesktopOrganizerWindow(organizerWindows[0])
      await new Promise((resolve) => setTimeout(resolve, 80))
      const lowerResizeWidget = organizerWidgets[1]
      const lowerResizeWindow = organizerWindows[1]
      const lowerResizeStart = await lowerResizeWindow.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.widget-organizer .widget-resize-grip')?.getBoundingClientRect()
        // Keep the press inside this organizer's visible grip and outside the
        // deliberately overlapping note fixture. Pointer capture may then
        // continue across the overlap during the gesture.
        return rect ? { x: rect.right - 20, y: rect.bottom - 6 } : null
      })()`)
      if (!lowerResizeStart) throw new Error('lower organizer resize grip was not rendered')
      const lowerResizeBefore = { ...workspaceState.widgets.find((widget) => widget.id === lowerResizeWidget.id) }
      const lowerResizeResult = await physicalGesture(
        lowerResizeWindow,
        lowerResizeStart,
        { x: lowerResizeStart.x + 18, y: lowerResizeStart.y + 16 },
      )
      const lowerResizeAfter = workspaceState.widgets.find((widget) => widget.id === lowerResizeWidget.id)
      if (
        !lowerResizeResult.includes('dragged')
        || !lowerResizeAfter
        || lowerResizeAfter.width < lowerResizeBefore.width + 10
        || lowerResizeAfter.height < lowerResizeBefore.height + 8
        || desktopOrganizerBandWindows(lowerResizeWindow.desktopDisplayId).at(-1) !== lowerResizeWindow
      ) {
        throw new Error(`lower organizer first-gesture resize failed: ${JSON.stringify({ lowerResizeResult, lowerResizeBefore, lowerResizeAfter })}`)
      }
      await restoreOrganizerGestureFrames()
      console.log('[desktop-input] lower organizer first-gesture assertion passed: 600 ms drag + resize survived watchdog and promoted after release')

      const topEdgeDragWidget = organizerWidgets[2]
      const topEdgeDragWindow = organizerWindows[2]
      const topEdgeDragStart = await topEdgeDragWindow.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.widget-organizer .desktop-widget-header')?.getBoundingClientRect()
        return rect ? { x: rect.left + 20, y: rect.top + rect.height / 2 } : null
      })()`)
      if (!topEdgeDragStart) throw new Error('top-edge organizer drag handle was not rendered')
      const topEdgeDragBefore = { ...workspaceState.widgets.find((widget) => widget.id === topEdgeDragWidget.id) }
      const topEdgeDragResult = await physicalGesture(
        topEdgeDragWindow,
        topEdgeDragStart,
        { x: topEdgeDragStart.x + 24, y: topEdgeDragStart.y + 18 },
      )
      const topEdgeDragAfter = workspaceState.widgets.find((widget) => widget.id === topEdgeDragWidget.id)
      if (
        !topEdgeDragResult.includes('dragged')
        || !topEdgeDragAfter
        || topEdgeDragAfter.x < topEdgeDragBefore.x + 8
        || topEdgeDragAfter.y < topEdgeDragBefore.y + 6
      ) {
        throw new Error(`top-edge minimum organizer drag failed: ${JSON.stringify({ topEdgeDragResult, topEdgeDragBefore, topEdgeDragAfter })}`)
      }
      await restoreOrganizerGestureFrames()

      const topEdgeResizeWidget = organizerWidgets[3]
      const topEdgeResizeWindow = organizerWindows[3]
      const topEdgeResizeStart = await topEdgeResizeWindow.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.widget-organizer .widget-resize-grip')?.getBoundingClientRect()
        return rect ? { x: rect.right - 6, y: rect.bottom - 6 } : null
      })()`)
      if (!topEdgeResizeStart) throw new Error('top-edge organizer resize grip was not rendered')
      const topEdgeResizeBefore = { ...workspaceState.widgets.find((widget) => widget.id === topEdgeResizeWidget.id) }
      const topEdgeResizeResult = await physicalGesture(
        topEdgeResizeWindow,
        topEdgeResizeStart,
        { x: topEdgeResizeStart.x + 18, y: topEdgeResizeStart.y + 16 },
      )
      const topEdgeResizeAfter = workspaceState.widgets.find((widget) => widget.id === topEdgeResizeWidget.id)
      if (
        !topEdgeResizeResult.includes('dragged')
        || !topEdgeResizeAfter
        || topEdgeResizeAfter.width < topEdgeResizeBefore.width + 10
        || topEdgeResizeAfter.height < topEdgeResizeBefore.height + 8
      ) {
        throw new Error(`top-edge minimum organizer resize failed: ${JSON.stringify({ topEdgeResizeResult, topEdgeResizeBefore, topEdgeResizeAfter })}`)
      }
      await restoreOrganizerGestureFrames()
      const isolatedOrganizerWindow = organizerWindows[2]
      const isolatedMoveCounts = new Map(organizerWindows.map((win) => [
        win.desktopWidgetId,
        win.desktopOrganizerMoveTopCount || 0,
      ]))
      const isolatedPromotion = promoteDesktopOrganizerWindow(isolatedOrganizerWindow)
      if (
        isolatedPromotion
        || organizerWindows.some((win) => (
          (win.desktopOrganizerMoveTopCount || 0) !== isolatedMoveCounts.get(win.desktopWidgetId)
        ))
      ) {
        throw new Error('non-overlapping organizer click path unnecessarily changed native sibling order')
      }
      promoteDesktopOrganizerWindow(organizerWindows[1])
      await new Promise((resolve) => setTimeout(resolve, 80))
      console.log('[desktop-input] top-edge organizer assertion passed: minimum-size gestures + isolated click caused no native reorder')

      const clickedOrganizerWindow = organizerWindows[0]
      const initiallyTopOrganizerWindow = organizerWindows[1]
      const clickedOrganizerBounds = clickedOrganizerWindow.getBounds()
      const initiallyTopBounds = initiallyTopOrganizerWindow.getBounds()
      const transparentCornerPoint = {
        x: initiallyTopBounds.x + 1,
        y: initiallyTopBounds.y + 1,
      }
      const exposedClickedPoint = {
        x: transparentCornerPoint.x - clickedOrganizerBounds.x,
        y: transparentCornerPoint.y - clickedOrganizerBounds.y,
      }
      const transparentShapeResult = await runDesktopHostHelper(initiallyTopOrganizerWindow, {
        shapePoint: { x: 1, y: 1 },
      })
      const visibleShapeResult = await runDesktopHostHelper(initiallyTopOrganizerWindow, {
        shapePoint: { x: 20, y: 20 },
      })
      const hoveredCornerResult = await runDesktopHostHelper(clickedOrganizerWindow, {
        hoverPoint: exposedClickedPoint,
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (
        !transparentShapeResult.includes('inside=False')
        || !visibleShapeResult.includes('inside=True')
        || desktopOrganizerBandWindows(initiallyTopOrganizerWindow.desktopDisplayId).at(-1) !== initiallyTopOrganizerWindow
      ) {
        throw new Error(`organizer hover changed the band or native rounded shape was invalid: ${JSON.stringify({ transparentShapeResult, visibleShapeResult, hoveredCornerResult })}`)
      }
      const overlapMoveCounts = new Map(organizerWindows.map((win) => [
        win.desktopWidgetId,
        win.desktopOrganizerMoveTopCount || 0,
      ]))
      const clickedCornerResult = await runDesktopHostHelper(clickedOrganizerWindow, {
        directClickPoint: exposedClickedPoint,
        directClickCount: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      const promotedCornerOrder = await runDesktopHostHelper(clickedOrganizerWindow, {
        inspectOnly: true,
        compareWindow: initiallyTopOrganizerWindow,
      })
      if (
        !clickedCornerResult.includes('direct-click count=1')
        || !promotedCornerOrder.includes('compare-above=False')
        || !promotedCornerOrder.includes('window-above-compare=True')
        || (clickedOrganizerWindow.desktopOrganizerMoveTopCount || 0)
          !== overlapMoveCounts.get(clickedOrganizerWindow.desktopWidgetId) + 1
        || organizerWindows.some((win) => (
          win !== clickedOrganizerWindow
          && (win.desktopOrganizerMoveTopCount || 0) !== overlapMoveCounts.get(win.desktopWidgetId)
        ))
      ) {
        throw new Error(`rounded-corner click-only organizer promotion failed: ${JSON.stringify({ clickedCornerResult, promotedCornerOrder })}`)
      }
      promoteDesktopOrganizerWindow(initiallyTopOrganizerWindow)
      await new Promise((resolve) => setTimeout(resolve, 60))
      console.log('[desktop-host] organizer overlap assertion passed: click promoted exactly one HWND; all unrelated siblings stayed untouched')

      if (organizerWindows.some((win) => !win.isFocusable())) {
        throw new Error('desktop-child organizers must remain focusable for Chromium pointer capture')
      }
      const clickableOrganizerWidget = organizerWidgets.find((widget) => widget.data?.files?.length)
      const clickableOrganizerWindow = clickableOrganizerWidget
        ? desktopWidgetWindows.get(clickableOrganizerWidget.id)
        : null
      const expectedOpenedPath = clickableOrganizerWidget?.data?.files?.[0]?.path || ''
      const openButtonPoint = await clickableOrganizerWindow?.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('.organizer-file-open')
        const rect = button?.getBoundingClientRect()
        // The second organizer intentionally overlaps this one by 48 px. Use
        // the exposed left side so the native click cannot land in its sibling.
        return rect ? { x: rect.left + Math.min(12, rect.width / 4), y: rect.top + rect.height / 2 } : null
      })()`)
      if (!clickableOrganizerWindow || !openButtonPoint || !expectedOpenedPath) {
        throw new Error('organizer click fixture was not rendered')
      }
      if (desktopOrganizerBandHealthTimer) {
        clearInterval(desktopOrganizerBandHealthTimer)
        desktopOrganizerBandHealthTimer = null
      }
      for (let attempt = 0; desktopOrganizerBandHealthInFlight && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (desktopOrganizerBandHealthInFlight) {
        throw new Error('organizer band health request did not settle before fault injection')
      }
      const clickableOrganizerHost = desktopOrganizerHostForWindow(clickableOrganizerWindow)
      if (!clickableOrganizerHost) throw new Error('organizer host was missing before band fault injection')
      await runDesktopHostHelper(clickableOrganizerHost, { displaceOrganizerBand: true })
      const organizerBandRecovery = await refreshDesktopOrganizerBandHealth()
      startDesktopOrganizerBandHealth()
      clickableOrganizerWindow.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(openButtonPoint.x),
        y: Math.round(openButtonPoint.y),
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      const recoveredAffordances = await clickableOrganizerWindow.webContents.executeJavaScript(`(() => {
        const widget = document.querySelector('.widget-organizer')
        const drag = widget?.querySelector('.drag-affordance')
        const resize = widget?.querySelector('.widget-resize-grip')
        return {
          dragDisplay: drag ? getComputedStyle(drag).display : '',
          resizeOpacity: resize ? Number(getComputedStyle(resize).opacity) : 0,
        }
      })()`)
      if (
        !(organizerBandRecovery?.Repaired || organizerBandRecovery?.repaired)
        || !(organizerBandRecovery?.HealthyAfter || organizerBandRecovery?.healthyAfter)
        || recoveredAffordances.dragDisplay === 'none'
        || recoveredAffordances.resizeOpacity <= 0
      ) {
        throw new Error(`organizer band watchdog did not restore hover input: ${JSON.stringify({ health: organizerBandRecovery, recoveredAffordances })}`)
      }
      console.log('[desktop-host] organizer band watchdog assertion passed: Explorer cover -> current band order + interaction affordances restored')

      // One failed organizer attachment must never disable recovery for the
      // whole band. Reproduce the production symptom with one window missing
      // its attachment metadata and a different window natively transparent:
      // hover can still be forwarded, but clicks/drag/resize would pass through.
      if (desktopOrganizerBandHealthTimer) {
        clearInterval(desktopOrganizerBandHealthTimer)
        desktopOrganizerBandHealthTimer = null
      }
      for (let attempt = 0; desktopOrganizerBandHealthInFlight && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const metadataDriftWindow = organizerWindows.at(-1)
      const inputDriftWindow = organizerWindows[0]
      metadataDriftWindow.desktopAttached = false
      metadataDriftWindow.desktopOrganizerLayerResult = ''
      inputDriftWindow.setIgnoreMouseEvents(true, { forward: true })
      inputDriftWindow.desktopPointerInteractive = true
      const sharedBandRecovery = await refreshDesktopOrganizerBandHealth()
      startDesktopOrganizerBandHealth()
      const sharedBandInputStyle = await runDesktopHostHelper(inputDriftWindow, { inspectOnly: true })
      if (
        !(sharedBandRecovery?.HealthyAfter || sharedBandRecovery?.healthyAfter)
        || metadataDriftWindow.desktopAttached !== true
        || !metadataDriftWindow.desktopOrganizerLayerResult?.includes('placement=desktop-child')
        || !metadataDriftWindow.desktopOrganizerLayerResult?.includes(`parent=${getWindowHandle(desktopOrganizerHostForWindow(metadataDriftWindow))}`)
        || !sharedBandInputStyle.includes('transparent=False')
      ) {
        throw new Error(`one organizer disabled shared band recovery: ${JSON.stringify({ sharedBandRecovery, sharedBandInputStyle })}`)
      }
      console.log('[desktop-host] shared organizer recovery assertion passed: one broken attachment cannot disable input repair for sibling windows')

      // Organizer windows no longer participate in the 32 ms overlay hit-test.
      // Hover must not rewrite a stale native style; the structural health pass
      // owns that targeted repair after confirming the real Win32 state.
      if (desktopOrganizerBandHealthTimer) {
        clearInterval(desktopOrganizerBandHealthTimer)
        desktopOrganizerBandHealthTimer = null
      }
      const hoverRepairOrder = desktopOrganizerBandWindows().map((win) => win.desktopWidgetId)
      const hoverRepairBounds = inputDriftWindow.getBounds()
      inputDriftWindow.setIgnoreMouseEvents(true, { forward: true })
      inputDriftWindow.desktopPointerInteractive = true
      refreshDesktopPointerHitTest({
        x: hoverRepairBounds.x + Math.floor(hoverRepairBounds.width / 2),
        y: hoverRepairBounds.y + 20,
      })
      const hoverObservedStyle = await runDesktopHostHelper(inputDriftWindow, { inspectOnly: true })
      const hoverRepairOrderAfter = desktopOrganizerBandWindows().map((win) => win.desktopWidgetId)
      const hoverHealthRepair = await refreshDesktopOrganizerBandHealth()
      const hoverRepairStyle = await runDesktopHostHelper(inputDriftWindow, { inspectOnly: true })
      startDesktopOrganizerBandHealth()
      if (
        !hoverObservedStyle.includes('transparent=True')
        || !Boolean(hoverHealthRepair?.Repaired ?? hoverHealthRepair?.repaired)
        || !hoverRepairStyle.includes('transparent=False')
        || JSON.stringify(hoverRepairOrderAfter) !== JSON.stringify(hoverRepairOrder)
      ) {
        throw new Error(`organizer hover observation or health repair failed: ${JSON.stringify({ hoverObservedStyle, hoverRepairStyle, hoverRepairOrder, hoverRepairOrderAfter })}`)
      }
      console.log('[desktop-input] organizer pointer-entry assertion passed: hover=0 writes; health=1 targeted repair')

      // Chromium/Windows can omit pointerup when a non-activating HWND loses
      // capture. Reproduce the resulting stale locks together with native
      // WS_EX_TRANSPARENT drift. The watchdog must consult GetAsyncKeyState,
      // release every stale lock, repair input and then flush deferred sibling
      // promotions without requiring the user to restart eDesktop.
      if (desktopOrganizerBandHealthTimer) {
        clearInterval(desktopOrganizerBandHealthTimer)
        desktopOrganizerBandHealthTimer = null
      }
      for (let attempt = 0; desktopOrganizerBandHealthInFlight && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const staleLockWindows = organizerWindows.slice(0, 2)
      for (const win of staleLockWindows) {
        win.desktopInteractionLocked = true
        win.desktopInteractionLockedAt = Date.now() - 2_000
        win.desktopOrganizerPromotionPending = true
        win.setIgnoreMouseEvents(true, { forward: true })
        // Deliberately leave the cache stale, matching the production failure.
        win.desktopPointerInteractive = true
      }
      const staleLockRecovery = await refreshDesktopOrganizerBandHealth()
      startDesktopOrganizerBandHealth()
      const staleLockStyles = await Promise.all(staleLockWindows.map((win) => (
        runDesktopHostHelper(win, { inspectOnly: true })
      )))
      if (
        staleLockWindows.some((win) => win.desktopInteractionLocked || win.desktopOrganizerPromotionPending)
        || staleLockStyles.some((style) => !style.includes('transparent=False'))
        || !(staleLockRecovery?.Repaired || staleLockRecovery?.repaired)
        || desktopOrganizerBandWindows(staleLockWindows.at(-1).desktopDisplayId).at(-1) !== staleLockWindows.at(-1)
      ) {
        throw new Error(`stale organizer interaction locks were not recovered: ${JSON.stringify({ staleLockRecovery, staleLockStyles })}`)
      }
      console.log('[desktop-host] stale organizer lock assertion passed: native pointer-up -> 2 locks released + input repaired + deferred promotion flushed')

      const activationTargetProbe = await startDesktopForegroundProbe({
        name: 'activation-target',
        x: 1120,
        y: 180,
      })
      const foregroundProbe = await startDesktopForegroundProbe({
        name: 'external-foreground',
        x: 1120,
        y: 24,
      })
      try {
        const inputHealth = await runDesktopHostHelper(clickableOrganizerWindow, {
          inputHealthPoint: openButtonPoint,
        })
        const inputHandles = /\bhit-hwnd=(\d+).*\bwindow-hwnd=(\d+)/.exec(inputHealth)
        if (
          !inputHandles
          || inputHandles[1] !== inputHandles[2]
          || !inputHealth.includes('hit-class=Chrome_WidgetWin_1')
          || !inputHealth.includes('window-visible=True')
          || !inputHealth.includes('window-enabled=True')
          || !inputHealth.includes('window-transparent=False')
        ) {
          throw new Error(`organizer desktop-child input target is unhealthy after an external process became foreground: ${inputHealth}`)
        }
        if (clickableOrganizerWindow.isFocused() || BrowserWindow.getFocusedWindow() === clickableOrganizerWindow) {
          throw new Error('organizer stole focus from the external foreground process')
        }
        const openCountBeforeForegroundClick = desktopWidgetTestOpenedPaths.length
        const directClickResult = await runDesktopHostHelper(clickableOrganizerWindow, {
          directClickPoint: openButtonPoint,
          directClickCount: 1,
        })
        await new Promise((resolve) => setTimeout(resolve, 120))
        const selectedAfterForegroundClick = await clickableOrganizerWindow.webContents.executeJavaScript(
          "document.querySelector('.organizer-file.is-selected')?.getAttribute('data-organizer-file-path') || ''",
        )
        if (
          desktopWidgetTestOpenedPaths.length !== openCountBeforeForegroundClick
          || selectedAfterForegroundClick !== expectedOpenedPath
        ) {
          throw new Error(`native top-level single click did not select without opening after an external process became foreground: ${directClickResult}`)
        }
        await foregroundProbe.click()
        const selectedAfterExternalClick = await clickableOrganizerWindow.webContents.executeJavaScript(
          "document.querySelector('.organizer-file.is-selected')?.getAttribute('data-organizer-file-path') || ''",
        )
        if (selectedAfterExternalClick) {
          throw new Error('organizer selection survived a physical click in an external application')
        }
        const activationResult = await activateWindowsApplication({
          processId: activationTargetProbe.processId,
          windowHandle: activationTargetProbe.windowHandle,
          timeoutMs: 2_000,
        })
        if (!activationResult.includes('activated=True')) {
          throw new Error(`launched application could not be foregrounded: ${activationResult}`)
        }
        const foregroundBandOrder = await inspectOrganizerBandOrder()
        if (foregroundBandOrder.some((result) => (
          !result.includes('compare-above=False') || !result.includes('window-above-compare=True')
        ))) {
          throw new Error(`external foreground transition broke the organizer band: ${JSON.stringify(foregroundBandOrder)}`)
        }
        console.log('[desktop-host] external-foreground input assertion passed: stable top-level HWND -> Electron -> React, single click selected without opening')
        console.log('[desktop-host] organizer global pointer assertion passed: external application click cleared the selected file')
        console.log('[desktop-host] launched-app activation assertion passed: background launch target -> foreground')
      } finally {
        await foregroundProbe.stop()
        await activationTargetProbe.stop()
      }

      const rendererGesture = async (startPoint, endPoint) => {
        const result = await runDesktopHostHelper(clickableOrganizerWindow, {
          directDragStartPoint: startPoint,
          directDragEndPoint: endPoint,
          directDragSteps: 12,
        })
        await new Promise((resolve) => setTimeout(resolve, 180))
        return result
      }
      const originalGestureFrame = { ...workspaceState.widgets.find((widget) => widget.id === clickableOrganizerWidget.id) }
      const originalGestureFileIds = originalGestureFrame.data.files.map((file) => file.id)
      const headerPoint = await clickableOrganizerWindow.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.widget-organizer .desktop-widget-header')?.getBoundingClientRect()
        return rect ? { x: rect.left + 20, y: rect.top + rect.height / 2 } : null
      })()`)
      if (!headerPoint) throw new Error('organizer drag handle was not rendered')
      await rendererGesture(headerPoint, { x: headerPoint.x + 24, y: headerPoint.y + 16 })
      const draggedOrganizer = workspaceState.widgets.find((widget) => widget.id === clickableOrganizerWidget.id)
      if (
        !draggedOrganizer
        || draggedOrganizer.x <= originalGestureFrame.x + 8
        || draggedOrganizer.y <= originalGestureFrame.y + 6
      ) {
        throw new Error(`organizer renderer drag did not update its frame: ${JSON.stringify(draggedOrganizer)}`)
      }
      console.log('[desktop-input] organizer renderer drag assertion passed: Chromium pointer chain -> widget frame')

      const resizePoint = await clickableOrganizerWindow.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.widget-organizer .widget-resize-grip')?.getBoundingClientRect()
        return rect ? { x: rect.left + 4, y: rect.top + 4 } : null
      })()`)
      if (!resizePoint) throw new Error('organizer resize grip was not rendered')
      const widthBeforeResize = draggedOrganizer.width
      const heightBeforeResize = draggedOrganizer.height
      await rendererGesture(resizePoint, { x: resizePoint.x + 12, y: resizePoint.y + 10 })
      const resizedOrganizer = workspaceState.widgets.find((widget) => widget.id === clickableOrganizerWidget.id)
      if (
        !resizedOrganizer
        || resizedOrganizer.width < widthBeforeResize + 8
        || resizedOrganizer.height < heightBeforeResize + 6
      ) {
        throw new Error(`organizer renderer resize did not update its size: ${JSON.stringify(resizedOrganizer)}`)
      }
      console.log('[desktop-input] organizer renderer resize assertion passed: Chromium pointer chain -> widget size')

      const orderGesturePoints = await clickableOrganizerWindow.webContents.executeJavaScript(`(() => {
        const tiles = [...document.querySelectorAll('.organizer-file')]
        const source = tiles[0]?.querySelector('.organizer-file-open')?.getBoundingClientRect()
        const target = tiles[2]?.getBoundingClientRect()
        return source && target ? {
          start: { x: source.left + source.width / 2, y: source.top + source.height / 2 },
          end: { x: target.right - 4, y: target.top + target.height / 2 },
        } : null
      })()`)
      if (!orderGesturePoints) throw new Error('organizer reorder fixtures were not rendered')
      const openCountBeforeReorder = desktopWidgetTestOpenedPaths.length
      await clickableOrganizerWindow.webContents.executeJavaScript(`(() => {
        const start = ${JSON.stringify(orderGesturePoints.start)}
        const end = ${JSON.stringify(orderGesturePoints.end)}
        const source = document.elementFromPoint(start.x, start.y)
        source?.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 31,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: start.x,
          clientY: start.y,
        }))
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId: 31,
          pointerType: 'mouse',
          isPrimary: true,
          button: -1,
          buttons: 1,
          clientX: end.x,
          clientY: end.y,
        }))
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: 31,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 0,
          clientX: end.x,
          clientY: end.y,
        }))
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 200))
      const reorderedNames = workspaceState.widgets
        .find((widget) => widget.id === clickableOrganizerWidget.id)
        ?.data.files?.map((file) => file.name)
      const expectedReorderedNames = [
        'Codex-Native-Drag-Test-B.txt',
        'Codex-Native-Drag-Test-C.txt',
        'Codex-Native-Drag-Test-A.txt',
      ]
      if (
        JSON.stringify(reorderedNames) !== JSON.stringify(expectedReorderedNames)
        || desktopWidgetTestOpenedPaths.length !== openCountBeforeReorder
      ) {
        throw new Error(`organizer renderer reorder mismatch: ${JSON.stringify({ reorderedNames, openCountBeforeReorder, openCountAfter: desktopWidgetTestOpenedPaths.length })}`)
      }
      console.log('[desktop-input] organizer renderer reorder assertion passed: drag moved first file to end without opening it')

      await reorderOrganizerFiles(clickableOrganizerWidget.id, originalGestureFileIds)
      const restoredOrganizer = workspaceState.widgets.find((widget) => widget.id === clickableOrganizerWidget.id)
      Object.assign(restoredOrganizer, {
        x: originalGestureFrame.x,
        y: originalGestureFrame.y,
        width: originalGestureFrame.width,
        height: originalGestureFrame.height,
      })
      syncDesktopWidgetWindowFrame(clickableOrganizerWindow, restoredOrganizer)
      broadcastWorkspace()
      await new Promise((resolve) => setTimeout(resolve, 120))

      const openCountBeforeSingleClick = desktopWidgetTestOpenedPaths.length
      clickableOrganizerWindow.webContents.sendInputEvent({
        type: 'mouseDown',
        x: Math.round(openButtonPoint.x),
        y: Math.round(openButtonPoint.y),
        button: 'left',
        clickCount: 1,
      })
      clickableOrganizerWindow.webContents.sendInputEvent({
        type: 'mouseUp',
        x: Math.round(openButtonPoint.x),
        y: Math.round(openButtonPoint.y),
        button: 'left',
        clickCount: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      const selectedPath = await clickableOrganizerWindow.webContents.executeJavaScript(
        "document.querySelector('.organizer-file.is-selected')?.getAttribute('data-organizer-file-path') || ''",
      )
      if (desktopWidgetTestOpenedPaths.length !== openCountBeforeSingleClick || selectedPath !== expectedOpenedPath) {
        throw new Error('organizer single click did not select the file without opening it')
      }
      console.log('[desktop-host] organizer single-click assertion passed: item selected without files:open IPC')

      const outsideSelectionWindow = windows.find((win) => (
        win !== clickableOrganizerWindow && !isOrganizerWidgetWindow(win)
      ))
      if (!outsideSelectionWindow) throw new Error('selection clear fixture window was not created')
      const outsideSelectionPoint = await outsideSelectionWindow.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.desktop-widget')?.getBoundingClientRect()
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
      })()`)
      if (!outsideSelectionPoint) throw new Error('selection clear fixture was not rendered')
      outsideSelectionWindow.webContents.sendInputEvent({
        type: 'mouseDown',
        x: Math.round(outsideSelectionPoint.x),
        y: Math.round(outsideSelectionPoint.y),
        button: 'left',
        clickCount: 1,
      })
      outsideSelectionWindow.webContents.sendInputEvent({
        type: 'mouseUp',
        x: Math.round(outsideSelectionPoint.x),
        y: Math.round(outsideSelectionPoint.y),
        button: 'left',
        clickCount: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      const selectedAfterOtherWidgetClick = await clickableOrganizerWindow.webContents.executeJavaScript(
        "document.querySelector('.organizer-file.is-selected')?.getAttribute('data-organizer-file-path') || ''",
      )
      if (selectedAfterOtherWidgetClick) {
        throw new Error('organizer selection survived a click in another component window')
      }
      console.log('[desktop-host] organizer global selection assertion passed: another component click cleared the selected file')

      clickableOrganizerWindow.webContents.sendInputEvent({
        type: 'mouseDown',
        x: Math.round(openButtonPoint.x),
        y: Math.round(openButtonPoint.y),
        button: 'left',
        clickCount: 1,
      })
      clickableOrganizerWindow.webContents.sendInputEvent({
        type: 'mouseUp',
        x: Math.round(openButtonPoint.x),
        y: Math.round(openButtonPoint.y),
        button: 'left',
        clickCount: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 40))

      clickableOrganizerWindow.webContents.sendInputEvent({
        type: 'mouseDown',
        x: Math.round(openButtonPoint.x),
        y: Math.round(openButtonPoint.y),
        button: 'left',
        clickCount: 2,
      })
      clickableOrganizerWindow.webContents.sendInputEvent({
        type: 'mouseUp',
        x: Math.round(openButtonPoint.x),
        y: Math.round(openButtonPoint.y),
        button: 'left',
        clickCount: 2,
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (desktopWidgetTestOpenedPaths.length !== openCountBeforeSingleClick + 1) {
        throw new Error('organizer double click did not reach the files:open IPC handler exactly once')
      }
      console.log('[desktop-host] organizer double-click assertion passed: files:open IPC reached exactly once')

      const contextMenuCountBefore = desktopWidgetTestContextMenus.length
      const contextMenuLabels = await clickableOrganizerWindow.webContents.executeJavaScript(`(async () => {
        const button = document.elementFromPoint(${openButtonPoint.x}, ${openButtonPoint.y})?.closest('.organizer-file-open')
        if (!button) return []
        button.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: ${openButtonPoint.x},
          clientY: ${openButtonPoint.y},
        }))
        await new Promise((resolve) => setTimeout(resolve, 80))
        return window.desktopAPI.showOrganizerFileMenu
          ? ['renderer-handler-present']
          : []
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const contextMenuRequest = desktopWidgetTestContextMenus.at(-1)
      const expectedContextMenuLabels = ['打开', '在文件资源管理器中显示', '移出收纳盒']
      if (
        contextMenuLabels?.[0] !== 'renderer-handler-present'
        || desktopWidgetTestContextMenus.length !== contextMenuCountBefore + 1
        || contextMenuRequest?.widgetId !== clickableOrganizerWidget.id
        || contextMenuRequest?.filePath !== expectedOpenedPath
        || JSON.stringify(contextMenuRequest?.labels) !== JSON.stringify(expectedContextMenuLabels)
      ) {
        throw new Error(`organizer context menu mismatch: ${JSON.stringify(contextMenuRequest)}`)
      }
      console.log('[desktop-host] organizer right-click assertion passed: native menu has open + reveal + release commands')
      const contextMenuCloseCountBefore = desktopWidgetTestContextMenuCloses.length
      outsideSelectionWindow.webContents.sendInputEvent({
        type: 'mouseDown',
        x: Math.round(outsideSelectionPoint.x),
        y: Math.round(outsideSelectionPoint.y),
        button: 'left',
        clickCount: 1,
      })
      outsideSelectionWindow.webContents.sendInputEvent({
        type: 'mouseUp',
        x: Math.round(outsideSelectionPoint.x),
        y: Math.round(outsideSelectionPoint.y),
        button: 'left',
        clickCount: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (
        activeOrganizerContextMenu
        || desktopWidgetTestContextMenuCloses.length !== contextMenuCloseCountBefore + 1
      ) {
        throw new Error('organizer context menu survived a click in another component window')
      }
      console.log('[desktop-host] organizer context-menu dismissal assertion passed: another component click closed the native menu')

      await clickableOrganizerWindow.webContents.executeJavaScript(`(() => {
        const button = document.elementFromPoint(${openButtonPoint.x}, ${openButtonPoint.y})?.closest('.organizer-file-open')
        button?.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: ${openButtonPoint.x},
          clientY: ${openButtonPoint.y},
        }))
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const externalMenuCloseCountBefore = desktopWidgetTestContextMenuCloses.length
      const contextMenuDismissalProbe = await startDesktopForegroundProbe({
        name: 'context-menu-dismissal',
        x: 1120,
        y: 24,
      })
      try {
        await contextMenuDismissalProbe.click()
        await new Promise((resolve) => setTimeout(resolve, 180))
      } finally {
        await contextMenuDismissalProbe.stop()
      }
      if (
        activeOrganizerContextMenu
        || desktopWidgetTestContextMenuCloses.length !== externalMenuCloseCountBefore + 1
      ) {
        throw new Error('organizer context menu survived a physical click in an external application')
      }
      console.log('[desktop-host] organizer global context-menu assertion passed: external application click closed the native menu')
      for (let cycle = 0; cycle < 6; cycle += 1) {
        // Emulate a native style drift without updating the JavaScript cache.
        // The periodic reconciler must restore clickability on its own.
        clickableOrganizerWindow.setIgnoreMouseEvents(true, { forward: true })
        // The structural desktop-child design no longer needs a 250 ms
        // watchdog. Allow the low-frequency 1 s recovery pass to run.
        await new Promise((resolve) => setTimeout(resolve, 1_250))
        const recoveredStyle = await runDesktopHostHelper(clickableOrganizerWindow, { inspectOnly: true })
        if (!clickableOrganizerWindow.desktopPointerInteractive || !recoveredStyle.includes('transparent=False')) {
          throw new Error(`organizer interaction did not recover from style drift: cycle=${cycle} ${recoveredStyle}`)
        }
        clickableOrganizerWindow.webContents.sendInputEvent({
          type: 'mouseDown',
          x: Math.round(openButtonPoint.x),
          y: Math.round(openButtonPoint.y),
          button: 'left',
          clickCount: 1,
        })
        clickableOrganizerWindow.webContents.sendInputEvent({
          type: 'mouseUp',
          x: Math.round(openButtonPoint.x),
          y: Math.round(openButtonPoint.y),
          button: 'left',
          clickCount: 1,
        })
        clickableOrganizerWindow.webContents.sendInputEvent({
          type: 'mouseDown',
          x: Math.round(openButtonPoint.x),
          y: Math.round(openButtonPoint.y),
          button: 'left',
          clickCount: 2,
        })
        clickableOrganizerWindow.webContents.sendInputEvent({
          type: 'mouseUp',
          x: Math.round(openButtonPoint.x),
          y: Math.round(openButtonPoint.y),
          button: 'left',
          clickCount: 2,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (desktopWidgetTestOpenedPaths.filter((filePath) => filePath === expectedOpenedPath).length < 7) {
        throw new Error('organizer repeated double clicks stopped reaching the files:open IPC handler')
      }
      console.log('[desktop-host] organizer endurance assertion passed: 6 style drifts recovered + 7 consecutive double-click opens')
      const organizerLayerTimes = new Map(organizerWindows.map((win) => [win.desktopWidgetId, win.desktopOrganizerLayeredAt]))
      const movedOrganizerWidget = organizerWidgets[1]
      const originalOrganizerX = movedOrganizerWidget.x
      movedOrganizerWidget.x += 16
      syncDesktopWidgetWindows()
      await new Promise((resolve) => setTimeout(resolve, 320))
      movedOrganizerWidget.x = originalOrganizerX
      syncDesktopWidgetWindows()
      if (organizerWindows.some((win) => win.desktopOrganizerLayeredAt !== organizerLayerTimes.get(win.desktopWidgetId))) {
        throw new Error('moving an organizer unexpectedly triggered a z-order rebuild')
      }
      const postInteractionBandOrder = await inspectOrganizerBandOrder()
      if (postInteractionBandOrder.some((result) => (
        !result.includes('compare-above=False') || !result.includes('window-above-compare=True')
      ))) {
        throw new Error(`click, drag, resize or reorder broke the dynamic organizer band: ${JSON.stringify(postInteractionBandOrder)}`)
      }
      console.log(`[desktop-host] dynamic organizer band assertion passed: ${organizerWindows.length} interactive organizers / engaged organizer on top`)

      const focusedWidgetWindow = windows.find((win) => !isOrganizerWidgetWindow(win))
      if (!focusedWidgetWindow) throw new Error('focusable widget window was not created')
      clickedOrganizerWindow.focus()
      await new Promise((resolve) => setTimeout(resolve, 80))
      const focusedOrganizerStyle = await runDesktopHostHelper(clickedOrganizerWindow, { inspectOnly: true })
      if (
        !focusedOrganizerStyle.includes(`parent=${getWindowHandle(desktopOrganizerHostForWindow(clickedOrganizerWindow))}`)
        || !focusedOrganizerStyle.includes('no-activate=False')
      ) {
        throw new Error(`focused organizer left the desktop child hierarchy: ${focusedOrganizerStyle}`)
      }
      const focusedBoundsBefore = focusedWidgetWindow.getBounds()
      focusedWidgetWindow.focus()
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (BrowserWindow.getFocusedWindow() !== focusedWidgetWindow) {
        // Windows can reject foreground activation while another eDesktop
        // instance owns the foreground. Z-order is the invariant under test,
        // so promote this test component without depending on focus stealing.
        focusedWidgetWindow.moveTop()
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      const clickSequenceOrder = await Promise.all(organizerWindows.map((win) => (
        runDesktopHostHelper(win, { inspectOnly: true, compareWindow: focusedWidgetWindow })
      )))
      if (clickSequenceOrder.some((result, index) => (
        !result.includes(`parent=${getWindowHandle(desktopOrganizerHostForWindow(organizerWindows[index]))}`)
        || !result.includes('no-activate=False')
        || !result.includes('transparent=False')
      ))) {
        throw new Error(`organizer escaped its native desktop child host: ${JSON.stringify(clickSequenceOrder)}`)
      }
      console.log('[desktop-host] organizer -> other component click sequence stayed inside the native desktop child host')
      const focusedWidget = workspaceState.widgets.find((widget) => widget.id === focusedWidgetWindow.desktopWidgetId)
      const siblingWindows = windows.filter((win) => win !== focusedWidgetWindow && !win.isDestroyed())
      const siblingBoundsBefore = new Map(siblingWindows.map((win) => [win.desktopWidgetId, win.getBounds()]))
      await focusedWidgetWindow.webContents.executeJavaScript(`window.desktopAPI.previewWidgetFrame(
        ${JSON.stringify(focusedWidget.id)},
        { x: ${focusedWidget.x + 12}, y: ${focusedWidget.y + 8} }
      )`)
      await new Promise((resolve) => setTimeout(resolve, 120))
      const movedWidget = workspaceState.widgets.find((widget) => widget.id === focusedWidget.id)
      const actualMovedBounds = focusedWidgetWindow.getBounds()
      if (
        Math.abs((actualMovedBounds.x - focusedBoundsBefore.x) - 12) > 2
        || Math.abs((actualMovedBounds.y - focusedBoundsBefore.y) - 8) > 2
        || Math.abs(actualMovedBounds.width - focusedBoundsBefore.width) > 2
        || Math.abs(actualMovedBounds.height - focusedBoundsBefore.height) > 2
      ) {
        throw new Error(`focused widget position-only frame mismatch: ${JSON.stringify({ focusedBoundsBefore, actualMovedBounds, movedWidget })}`)
      }
      for (const win of siblingWindows) {
        if (JSON.stringify(win.getBounds()) !== JSON.stringify(siblingBoundsBefore.get(win.desktopWidgetId))) {
          throw new Error(`moving one widget changed a sibling native frame: ${win.desktopWidgetId}`)
        }
      }
      console.log(`[desktop-host] independent widget z-order assertion passed: ${windows.length} widgets / ${nativeHandles.length} native windows / isolated movement`)

      console.log('[desktop-input] Chromium internal child visibility is excluded from periodic repair decisions')
    } catch (error) {
      console.error(`[desktop-host] independent widget window test failed: ${error.stack || error.message}`)
      process.exitCode = 1
    } finally {
      try { fs.rmSync(desktopHostFileTestRoot, { recursive: true, force: true }) } catch {}
      app.exit(process.exitCode || 0)
    }
  }, 1800)
}

const runDesktopOrganizerPromotionRegression = () => {
  setTimeout(async () => {
    let organizers = []
    let unrelatedHostChild = null
    const savedOrder = [...desktopOrganizerBandOrder]
    const savedFrames = new Map()
    try {
      const startupDeadline = Date.now() + 6_000
      do {
        organizers = desktopOrganizerBandWindows()
        if (organizers.length >= 2 && organizers.every((win) => win.desktopOrganizerChildAttached)) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      } while (Date.now() < startupDeadline)
      if (organizers.length < 2) throw new Error('organizer promotion regression requires at least two organizers')
      if (organizers.some((win) => !win.desktopOrganizerChildAttached)) {
        throw new Error('organizer promotion regression timed out waiting for desktop-child attachment')
      }
      const organizerDisplayIds = new Set(organizers.map((win) => win.desktopDisplayId))
      const liveHostDisplayIds = new Set(liveDesktopOrganizerHostWindows().map((host) => host.desktopDisplayId))
      if (
        organizerDisplayIds.size !== liveHostDisplayIds.size
        || [...organizerDisplayIds].some((displayId) => !liveHostDisplayIds.has(displayId))
      ) {
        throw new Error(`per-display organizer hosts are incomplete: ${JSON.stringify({
          organizers: [...organizerDisplayIds],
          hosts: [...liveHostDisplayIds],
        })}`)
      }
      for (const win of organizers) {
        const renderer = await inspectDesktopWidgetRendererGeometry(win)
        const display = desktopDisplayById(win.desktopDisplayId)
        if (!renderer || !display || Math.abs(renderer.devicePixelRatio - display.scaleFactor) > 0.01) {
          throw new Error(`organizer renderer DPI does not match its display: ${JSON.stringify({
            widgetId: win.desktopWidgetId,
            displayId: win.desktopDisplayId,
            rendererDpr: renderer?.devicePixelRatio,
            displayScale: display?.scaleFactor,
          })}`)
        }
        const widget = workspaceState.widgets.find((candidate) => candidate.id === win.desktopWidgetId)
        const organizerHost = desktopOrganizerHostForWindow(win)
        if (!widget || !organizerHost) throw new Error('organizer host-shape fixture is incomplete')
        const physicalClientBounds = desktopWidgetPhysicalClientBounds(win, desktopWidgetWindowBounds(widget))
        const hostShape = await runDesktopHostHelper(organizerHost, {
          shapePoint: {
            x: physicalClientBounds.x + Math.floor(physicalClientBounds.width / 2),
            y: physicalClientBounds.y + Math.floor(physicalClientBounds.height / 2),
          },
        })
        if (!hostShape.includes('inside=True')) {
          throw new Error(`organizer was clipped out of its display host: ${JSON.stringify({
            widgetId: win.desktopWidgetId,
            displayId: win.desktopDisplayId,
            physicalClientBounds,
            hostShape,
          })}`)
        }
      }
      console.log(`[desktop-host] per-display host + mixed-DPI + native clip assertion passed: ${organizerDisplayIds.size} hosts`)
      for (const win of organizers) {
        const widget = workspaceState.widgets.find((candidate) => candidate.id === win.desktopWidgetId)
        if (widget) savedFrames.set(widget.id, { x: widget.x, y: widget.y, width: widget.width, height: widget.height })
      }

      const clickedWindow = organizers[0]
      const topWindow = organizers[1]
      desktopOrganizerBandOrder = [
        clickedWindow.desktopWidgetId,
        ...organizers.slice(2).map((win) => win.desktopWidgetId),
        topWindow.desktopWidgetId,
      ]
      const clickedWidget = workspaceState.widgets.find((widget) => widget.id === clickedWindow.desktopWidgetId)
      const topWidget = workspaceState.widgets.find((widget) => widget.id === topWindow.desktopWidgetId)
      if (!clickedWidget || !topWidget) throw new Error('organizer promotion regression frames are missing')

      const pointerEntryCounts = new Map(organizers.map((win) => [
        win.desktopWidgetId,
        win.desktopOrganizerInputMutationCount || 0,
      ]))
      const clickedBounds = clickedWindow.getBounds()
      refreshDesktopPointerHitTest({ x: clickedBounds.x + 10, y: clickedBounds.y + 10 })
      if (organizers.some((win) => (
        (win.desktopOrganizerInputMutationCount || 0) !== pointerEntryCounts.get(win.desktopWidgetId)
      ))) {
        throw new Error('organizer pointer entry rewrote a native input style')
      }

      clickedWidget.x = -1_000_000
      clickedWidget.y = -1_000_000
      const isolatedCounts = new Map(organizers.map((win) => [
        win.desktopWidgetId,
        win.desktopOrganizerMoveTopCount || 0,
      ]))
      if (
        promoteDesktopOrganizerWindow(clickedWindow)
        || organizers.some((win) => (
          (win.desktopOrganizerMoveTopCount || 0) !== isolatedCounts.get(win.desktopWidgetId)
        ))
      ) {
        throw new Error('isolated organizer promotion changed native sibling order')
      }

      clickedWidget.x = topWidget.x
      clickedWidget.y = topWidget.y
      const overlapCounts = new Map(organizers.map((win) => [
        win.desktopWidgetId,
        win.desktopOrganizerMoveTopCount || 0,
      ]))
      if (
        !promoteDesktopOrganizerWindow(clickedWindow)
        || (clickedWindow.desktopOrganizerMoveTopCount || 0)
          !== overlapCounts.get(clickedWindow.desktopWidgetId) + 1
        || organizers.some((win) => (
          win !== clickedWindow
          && (win.desktopOrganizerMoveTopCount || 0) !== overlapCounts.get(win.desktopWidgetId)
        ))
      ) {
        throw new Error('overlapping organizer promotion did not move exactly one native window')
      }
      console.log('[desktop-host] focused organizer promotion assertion passed: isolated=0 moves; overlap=clicked HWND only')

      // Reproduce the native order change that Windows/Chromium can perform
      // while focusing a child HWND, before eDesktop receives pointer-up. This
      // is a valid dynamic organizer order and the health pass must observe it
      // without restoring the stale JavaScript order or touching any sibling.
      topWindow.moveTop()
      const focusOrderHealth = await desktopIconHelperRequest('organizer-band-health', {
        organizerHostHwnd: getWindowHandle(desktopOrganizerHostForWindow(topWindow)),
        hwnds: desktopOrganizerBandWindows(topWindow.desktopDisplayId).map(getWindowHandle),
      }, 1_500)
      if (
        !Boolean(focusOrderHealth?.HealthyBefore ?? focusOrderHealth?.healthyBefore)
        || Boolean(focusOrderHealth?.Repaired ?? focusOrderHealth?.repaired)
        || Boolean(focusOrderHealth?.Reordered ?? focusOrderHealth?.reordered)
      ) {
        throw new Error(`native focus order caused a false band repair: ${JSON.stringify(focusOrderHealth)}`)
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (liveDesktopWindows().every((win) => !win.desktopAttachmentInFlight)) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const attachmentAttempts = new Map(organizers.map((win) => [
        win.desktopWidgetId,
        win.desktopAttachmentAttemptCount || 0,
      ]))
      const shapeMutationCounts = new Map(organizers.map((win) => [
        win.desktopWidgetId,
        win.desktopOrganizerShapeMutationCount || 0,
      ]))
      await attachMissingDesktopWindows()
      for (const win of organizers) {
        const widget = workspaceState.widgets.find((candidate) => candidate.id === win.desktopWidgetId)
        if (widget) {
          const bounds = desktopWidgetNativeBounds(win, desktopWidgetWindowBounds(widget))
          applyDesktopOrganizerWindowShape(win, bounds)
          applyDesktopOrganizerWindowShape(win, bounds)
        }
      }
      if (
        organizers.some((win) => (
          (win.desktopAttachmentAttemptCount || 0) !== attachmentAttempts.get(win.desktopWidgetId)
          || (win.desktopOrganizerShapeMutationCount || 0) !== shapeMutationCounts.get(win.desktopWidgetId)
        ))
      ) {
        throw new Error('healthy display refresh path rewrote organizer attachment or native shape')
      }
      console.log('[desktop-host] organizer stable-refresh assertion passed: focus order accepted; attach=0; shape=0 writes')
      const stableSurfaceCommits = new Map(liveDesktopWidgetWindows().map((win) => [
        win.desktopWidgetId,
        win.desktopLastGeometrySurfaceCommitAt || 0,
      ]))
      desktopWidgetGeometryHealthLastAt = 0
      await refreshDesktopWidgetGeometryHealth()
      desktopWidgetGeometryHealthLastAt = 0
      await refreshDesktopWidgetGeometryHealth()
      if (liveDesktopWidgetWindows().some((win) => (
        (win.desktopLastGeometrySurfaceCommitAt || 0) !== stableSurfaceCommits.get(win.desktopWidgetId)
      ))) {
        throw new Error('stable high-DPI widget geometry triggered a periodic surface commit')
      }
      console.log('[desktop-geometry] stable high-DPI watchdog assertion passed: 2 samples; 0 surface commits')

      unrelatedHostChild = new BaseWindow({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        show: false,
        frame: false,
        transparent: true,
        focusable: false,
        skipTaskbar: true,
      })
      unrelatedHostChild.setTitle('eDesktop · unrelated compositor child regression')
      unrelatedHostChild.showInactive()
      const unrelatedResult = await runDesktopHostHelper(unrelatedHostChild, {
        noActivate: true,
        desktopChild: true,
        parentWindow: desktopOrganizerHostForWindow(clickedWindow),
      })
      if (!unrelatedResult.includes('placement=desktop-child')) {
        throw new Error(`unrelated host child fixture did not attach: ${unrelatedResult}`)
      }
      const healthWithUnrelatedChild = await desktopIconHelperRequest('organizer-band-health', {
        organizerHostHwnd: getWindowHandle(desktopOrganizerHostForWindow(clickedWindow)),
        hwnds: desktopOrganizerBandWindows(clickedWindow.desktopDisplayId).map(getWindowHandle),
      }, 1_500)
      if (
        !Boolean(healthWithUnrelatedChild?.HealthyBefore ?? healthWithUnrelatedChild?.healthyBefore)
        || Boolean(healthWithUnrelatedChild?.Repaired ?? healthWithUnrelatedChild?.repaired)
      ) {
        throw new Error(`unrelated compositor child caused a false band repair: ${JSON.stringify(healthWithUnrelatedChild)}`)
      }
      unrelatedHostChild.destroy()
      unrelatedHostChild = null
      await new Promise((resolve) => setTimeout(resolve, 60))

      const styleRepairTarget = topWindow
      const styleRepairCounts = new Map(organizers.map((win) => [
        win.desktopWidgetId,
        win.desktopOrganizerInputMutationCount || 0,
      ]))
      styleRepairTarget.setIgnoreMouseEvents(true, { forward: true })
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await refreshDesktopOrganizerBandHealth()
        if (
          (styleRepairTarget.desktopOrganizerInputMutationCount || 0)
          === styleRepairCounts.get(styleRepairTarget.desktopWidgetId) + 1
        ) break
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      const repairedStyle = await runDesktopHostHelper(styleRepairTarget, { inspectOnly: true })
      if (
        !repairedStyle.includes('transparent=False')
        || (styleRepairTarget.desktopOrganizerInputMutationCount || 0)
          !== styleRepairCounts.get(styleRepairTarget.desktopWidgetId) + 1
        || organizers.some((win) => (
          win !== styleRepairTarget
          && (win.desktopOrganizerInputMutationCount || 0) !== styleRepairCounts.get(win.desktopWidgetId)
        ))
      ) {
        throw new Error(`single organizer style drift touched siblings: ${repairedStyle}`)
      }
      console.log('[desktop-host] organizer anti-flicker assertion passed: hover=0 writes; unrelated child ignored; style repair=1 HWND')
    } catch (error) {
      console.error(`[desktop-host] focused organizer promotion test failed: ${error.message}`)
      process.exitCode = 1
    } finally {
      if (unrelatedHostChild && !unrelatedHostChild.isDestroyed()) unrelatedHostChild.destroy()
      for (const [id, frame] of savedFrames) {
        const widget = workspaceState.widgets.find((candidate) => candidate.id === id)
        if (widget) Object.assign(widget, frame)
      }
      desktopOrganizerBandOrder = savedOrder
      app.exit(process.exitCode || 0)
    }
  }, 1800)
}

const captureWindow = (win) => {
  const takeCapture = () => {
    setTimeout(async () => {
      try {
        if (captureSurface === 'control') {
          const captureWidth = Number(process.env.EDESKTOP_CAPTURE_WIDTH)
          const captureHeight = Number(process.env.EDESKTOP_CAPTURE_HEIGHT)
          if (Number.isFinite(captureWidth) && Number.isFinite(captureHeight)) {
            win.setSize(Math.max(680, Math.round(captureWidth)), Math.max(500, Math.round(captureHeight)))
          }
          const captureControlPage = process.env.EDESKTOP_CAPTURE_CONTROL_PAGE
          if (['basic', 'add', 'widgets'].includes(captureControlPage)) {
            const pageButtonIndex = { basic: 1, add: 2, widgets: 3 }[captureControlPage]
            const switched = await win.webContents.executeJavaScript(`(async () => {
              const button = document.querySelector('.control-navigation button:nth-child(${pageButtonIndex})')
              if (!button) return false
              button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
              await new Promise((resolve) => setTimeout(resolve, 200))
              for (const element of [
                document.scrollingElement,
                document.documentElement,
                document.body,
                document.querySelector('.control-page-scroll'),
              ]) {
                if (!element) continue
                element.scrollTop = 0
                element.scrollLeft = 0
              }
              return {
                active: document.querySelector('.control-navigation .is-active span')?.textContent || '',
                heading: document.querySelector('.control-page-heading h1')?.textContent || '',
              }
            })()`)
            if (!switched || !switched.active) {
              throw new Error(`capture control page button was not found: ${captureControlPage}`)
            }
            console.log(`[capture] control page=${captureControlPage} active=${switched.active} heading=${switched.heading}`)
          }
          win.showInactive()
          win.webContents.invalidate()
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        const image = await win.webContents.capturePage()
        const outputPath = path.resolve(process.cwd(), capturePath)
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
        await fs.promises.writeFile(outputPath, image.toPNG())
        console.log(`[capture] wrote ${outputPath}`)
      } finally {
        if (captureFixtureRoot) {
          await fs.promises.rm(captureFixtureRoot, { recursive: true, force: true }).catch(() => {})
          captureFixtureRoot = null
        }
        app.quit()
      }
    }, 1800)
  }

  // Local production pages can finish before the caller installs its listener.
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', takeCapture)
  else takeCapture()
}

const openDesktopFile = async (filePath, sourceWindow = null) => {
  if (typeof filePath !== 'string') return '文件不存在'
  const requestId = ++fileOpenRequestSequence
  const sourceWidgetId = sourceWindow?.desktopWidgetId || 'unknown'
  console.log(`[files:open] request=${requestId} widget=${sourceWidgetId} path=${filePath}`)
  if (desktopWidgetWindowTest) {
    desktopWidgetTestOpenedPaths.push(filePath)
    return ''
  }
  if (filePath.toLocaleLowerCase().startsWith('shell:::')) {
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [filePath], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return ''
  }
  if (!fs.existsSync(filePath)) return '文件不存在'
  const openError = await shell.openPath(filePath)
  console.log(`[files:open] request=${requestId} shell-opened=${!openError} error=${openError || 'none'}`)
  if (!openError && process.platform === 'win32' && path.extname(filePath).toLocaleLowerCase() === '.lnk') {
    try {
      const activationResult = await activateWindowsShortcutTarget(filePath)
      if (activationResult) console.log(`[files:open] shortcut target foregrounded; ${activationResult}`)
    } catch (error) {
      // The shortcut has already been handed to Windows. Activation is a
      // best-effort follow-up and must not turn a successful launch into an error.
      console.warn(`[files:open] shortcut target activation failed: ${error.message}`)
    }
  }
  return openError
}

const buildOrganizerFileMenu = ({ widgetId, filePath, sourceWindow }) => {
  const isShellItem = filePath.toLocaleLowerCase().startsWith('shell:::')
  return Menu.buildFromTemplate([
    {
      label: '打开',
      click: () => void openDesktopFile(filePath, sourceWindow),
    },
    { type: 'separator' },
    {
      label: '在文件资源管理器中显示',
      enabled: !isShellItem && fs.existsSync(filePath),
      click: () => shell.showItemInFolder(filePath),
    },
    { type: 'separator' },
    {
      label: '移出收纳盒',
      click: () => {
        void enqueueWorkspaceMutation(async () => {
          await createAutomaticSafetySnapshot('移出收纳盒前')
          return releaseOrganizerFile(widgetId, filePath)
        })
          .catch((error) => console.warn(`[organizer] context-menu release failed: ${error.message}`))
      },
    },
  ])
}

const registerIpc = () => {
  ipcMain.handle('desktop:info', currentDesktopInfo)
  ipcMain.on('app:pointer-down', (event) => {
    if (activeOrganizerContextMenu) closeActiveOrganizerContextMenu()
    if (!activeOrganizerFileSelection) return
    if (activeOrganizerFileSelection.webContentsId === event.sender.id) return
    activeOrganizerFileSelection = null
    organizerFileSelectionRevision += 1
    clearOrganizerFileSelections(event.sender.id)
  })
  ipcMain.on('desktop:cursor-position', (event) => {
    const point = screen.getCursorScreenPoint()
    const virtualBounds = virtualScreenBounds()
    event.returnValue = { x: point.x - virtualBounds.x, y: point.y - virtualBounds.y }
  })
  ipcMain.handle('files:icon', async (_event, filePath) => {
    if (typeof filePath !== 'string') return ''
    const shellDefinition = filePath.toLocaleLowerCase().startsWith('shell:::')
      ? desktopShellItemDefinitionForClsid(filePath.slice('shell:::'.length))
      : null
    if (shellDefinition) return loadDesktopShellItemIconData(shellDefinition)
    if (!fs.existsSync(filePath)) return ''
    try {
      const stat = await fs.promises.lstat(filePath)
      if (stat.isDirectory() || windowsShellLinkExtensions.has(path.extname(filePath).toLocaleLowerCase())) {
        const shellIconData = await loadWindowsShellIconData(filePath)
        if (shellIconData) return shellIconData
      }
      const visual = await loadFileVisual(filePath)
      return visual?.toDataURL() || ''
    } catch {
      return ''
    }
  })
  ipcMain.handle('files:open', (_event, filePath) => (
    openDesktopFile(filePath, BrowserWindow.fromWebContents(_event.sender))
  ))
  ipcMain.handle('files:reveal', (_event, filePath) => {
    if (typeof filePath === 'string' && fs.existsSync(filePath)) shell.showItemInFolder(filePath)
  })
  ipcMain.handle('organizer:prepare-import', async () => {
    try {
      await refreshDesktopIconPositions(true)
      preparedOrganizerShellItems = await captureSelectedDesktopShellItems()
      preparedOrganizerShellItemsAt = Date.now()
      return true
    } catch {
      preparedOrganizerShellItems = []
      preparedOrganizerShellItemsAt = 0
      return false
    }
  })
  ipcMain.handle('organizer:import-files', (_event, widgetId, filePaths) => {
    const shellItems = Date.now() - preparedOrganizerShellItemsAt <= 5_000
      ? preparedOrganizerShellItems
      : []
    preparedOrganizerShellItems = []
    preparedOrganizerShellItemsAt = 0
    return enqueueWorkspaceMutation(async () => {
      const fileResult = await importOrganizerFiles(widgetId, filePaths)
      const shellResult = await importOrganizerShellItems(widgetId, shellItems)
      return {
        imported: fileResult.imported + shellResult.imported,
        errors: [...fileResult.errors, ...shellResult.errors],
      }
    })
  })
  ipcMain.handle('organizer:move-file', (
    _event,
    sourceWidgetId,
    targetWidgetId,
    filePath,
    targetFileId,
    edge,
  ) => enqueueWorkspaceMutation(async () => {
    try {
      const moved = await moveOrganizerFileBetweenWidgets(
        sourceWidgetId,
        targetWidgetId,
        filePath,
        targetFileId,
        edge,
      )
      return { moved, error: '' }
    } catch (error) {
      return { moved: false, error: error.message }
    }
  }))
  ipcMain.on('organizer:claim-file-drop', (event, dragToken) => {
    const now = Date.now()
    for (const [token, claimedAt] of handledOrganizerFileDrops.entries()) {
      if (now - claimedAt > 10_000) handledOrganizerFileDrops.delete(token)
    }
    if (typeof dragToken === 'string' && dragToken) handledOrganizerFileDrops.set(dragToken, now)
    event.returnValue = true
  })
  ipcMain.on('organizer:complete-file-drop', (event, dragToken) => {
    const handled = typeof dragToken === 'string' && handledOrganizerFileDrops.has(dragToken)
    if (handled) handledOrganizerFileDrops.delete(dragToken)
    event.returnValue = handled
  })
  ipcMain.handle('organizer:reorder-files', (_event, widgetId, orderedFileIds) => (
    enqueueWorkspaceMutation(() => reorderOrganizerFiles(widgetId, orderedFileIds))
  ))
  ipcMain.handle('organizer:release-file', async (_event, widgetId, filePath) => {
    try {
      const released = await enqueueWorkspaceMutation(async () => {
        await createAutomaticSafetySnapshot('移出收纳盒前')
        return releaseOrganizerFile(widgetId, filePath)
      })
      return { releasedPath: released.releasedPath, error: '' }
    } catch (error) {
      return { releasedPath: '', error: error.message }
    }
  })
  ipcMain.handle('organizer:release-file-to-desktop', async (_event, widgetId, filePath) => {
    try {
      const released = await enqueueWorkspaceMutation(() => releaseOrganizerFileToDesktop(widgetId, filePath))
      return { releasedPath: released.releasedPath, error: '' }
    } catch (error) {
      return { releasedPath: '', error: error.message }
    }
  })
  ipcMain.handle('organizer:show-file-menu', (_event, widgetId, filePath) => {
    if (typeof widgetId !== 'string' || typeof filePath !== 'string') return []
    try {
      findOrganizerFile(widgetId, filePath)
    } catch {
      return []
    }
    const sourceWindow = BrowserWindow.fromWebContents(_event.sender)
    const menu = buildOrganizerFileMenu({ widgetId, filePath, sourceWindow })
    const labels = menu.items.filter((item) => item.type !== 'separator').map((item) => item.label)
    closeActiveOrganizerContextMenu()
    const token = ++organizerContextMenuSequence
    activeOrganizerContextMenu = {
      token,
      menu,
      window: sourceWindow || null,
      webContentsId: _event.sender.id,
    }
    if (desktopWidgetWindowTest) {
      desktopWidgetTestContextMenus.push({ widgetId, filePath, labels })
    } else {
      menu.popup({
        window: sourceWindow || undefined,
        callback: () => {
          if (activeOrganizerContextMenu?.token === token) activeOrganizerContextMenu = null
        },
      })
    }
    return labels
  })
  ipcMain.on('organizer:select-file', selectOrganizerFile)
  ipcMain.on('organizer:clear-file-selection', clearOrganizerFileSelection)

  ipcMain.handle('workspace:get', () => cloneWorkspace())
  ipcMain.handle('workspace:add-widget', (_event, kind) => enqueueWorkspaceMutation(async () => {
    const widget = createWidget(kind)
    const nextState = cloneWorkspace()
    nextState.widgets.push(widget)
    nextState.settings.desktopEnabled = true
      await updateWorkspace(nextState)
      for (const win of liveDesktopWindows()) win.showInactive()
      return widget
  }))
  ipcMain.handle('workspace:update-widget', (_event, id, patch) => enqueueWorkspaceMutation(async () => {
    const nextState = cloneWorkspace()
    const index = nextState.widgets.findIndex((widget) => widget.id === id)
    if (index < 0) return nextState
    const safePatch = safeWidgetPatch(patch)
    const mergedWidget = { ...nextState.widgets[index], ...safePatch, id }
    const hasFramePatch = ['x', 'y', 'width', 'height']
      .some((key) => Object.prototype.hasOwnProperty.call(safePatch, key))
    nextState.widgets[index] = hasFramePatch ? constrainWidgetFrame(mergedWidget) : mergedWidget
    return updateWorkspace(nextState)
  }))
  ipcMain.on('workspace:preview-widget-frame', (_event, id, patch) => {
    const index = workspaceState.widgets.findIndex((widget) => widget.id === id)
    if (index < 0) return
    const safePatch = safeWidgetPatch(patch)
    const framePatch = {}
    for (const key of ['x', 'y', 'width', 'height']) {
      if (Object.prototype.hasOwnProperty.call(safePatch, key)) framePatch[key] = safePatch[key]
    }
    const widget = constrainWidgetFrame({ ...workspaceState.widgets[index], ...framePatch })
    workspaceState.widgets[index] = widget
    if (useDesktopWidgetWindows) {
      // The active renderer already paints its local preview. Move only its native window;
      // broadcasting the full workspace here would rerender every widget on every pointer event.
      syncDesktopWidgetWindowFrame(desktopWidgetWindows.get(id), widget)
    } else {
      broadcastWorkspace()
    }
  })
  ipcMain.handle('workspace:remove-widget', (_event, id) => enqueueWorkspaceMutation(async () => {
    await createAutomaticSafetySnapshot('移除组件前')
    const nextState = cloneWorkspace()
    nextState.widgets = nextState.widgets.filter((widget) => widget.id !== id)
    return updateWorkspace(nextState)
  }))
  ipcMain.handle('workspace:set-desktop-enabled', (_event, enabled) => (
    enqueueWorkspaceMutation(() => setDesktopEnabled(enabled))
  ))
  ipcMain.handle('workspace:set-launch-at-login', (_event, enabled) => enqueueWorkspaceMutation(async () => {
    const launchAtLogin = Boolean(enabled)
    applyLoginItemSettings(launchAtLogin)
    const nextState = cloneWorkspace()
    nextState.settings.launchAtLogin = launchAtLogin
    return updateWorkspace(nextState)
  }))
  ipcMain.handle('snapshots:list', () => listWorkspaceSnapshots())
  ipcMain.handle('snapshots:create', () => (
    enqueueSnapshotMutation(() => createWorkspaceSnapshot('手动快照'))
  ))
  ipcMain.handle('snapshots:restore', (_event, snapshotId) => (
    enqueueWorkspaceMutation(() => enqueueSnapshotMutation(() => restoreWorkspaceSnapshot(snapshotId)))
  ))
  ipcMain.handle('snapshots:delete', (_event, snapshotId) => enqueueSnapshotMutation(async () => {
    await fs.promises.unlink(snapshotFilePath(snapshotId))
    return listWorkspaceSnapshots()
  }))
  ipcMain.handle('snapshots:export', async (_event, snapshotId) => {
    const snapshot = await readSnapshotDocument(snapshotFilePath(snapshotId))
    const suggestedDate = String(snapshot.createdAt || '').slice(0, 10).replaceAll('-', '') || 'snapshot'
    const result = await dialog.showSaveDialog(controlWindow || undefined, {
      title: '导出 eDesktop 配置快照',
      defaultPath: `eDesktop-配置快照-${suggestedDate}.edesktop-snapshot.json`,
      filters: [
        { name: 'eDesktop 配置快照', extensions: ['json'] },
      ],
    })
    if (result.canceled || !result.filePath) return { canceled: true, filePath: '' }
    await fs.promises.writeFile(result.filePath, JSON.stringify(snapshot, null, 2), 'utf8')
    return { canceled: false, filePath: result.filePath }
  })
  ipcMain.handle('snapshots:import', async () => {
    const result = await dialog.showOpenDialog(controlWindow || undefined, {
      title: '导入 eDesktop 配置快照',
      properties: ['openFile'],
      filters: [
        { name: 'eDesktop 配置快照', extensions: ['json'] },
      ],
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true, snapshot: null }
    const imported = await readSnapshotDocument(result.filePaths[0])
    const snapshot = await enqueueSnapshotMutation(async () => {
      const createdAt = new Date().toISOString()
      const id = `${createdAt.replace(/\D/g, '').slice(0, 17)}-${crypto.randomBytes(5).toString('hex')}`
      const document = {
        ...imported,
        id,
        createdAt,
        reason: `导入快照 · ${String(imported.createdAt || '').slice(0, 10) || '未知日期'}`,
        appVersion: app.getVersion(),
        fileDataIncluded: false,
      }
      document.contentHash = snapshotContentHash(document.workspace, document.desktop)
      const destination = snapshotFilePath(id)
      await writeJsonAtomically(destination, document)
      await pruneWorkspaceSnapshots()
      return (await listWorkspaceSnapshots()).find((candidate) => candidate.id === id) || null
    })
    return { canceled: false, snapshot }
  })
  ipcMain.handle('snapshots:set-settings', (_event, settings) => enqueueWorkspaceMutation(async () => {
    const nextState = cloneWorkspace()
    if (Object.prototype.hasOwnProperty.call(settings || {}, 'autoEnabled')) {
      nextState.settings.snapshotAutoEnabled = Boolean(settings.autoEnabled)
    }
    if (Object.prototype.hasOwnProperty.call(settings || {}, 'retention')) {
      nextState.settings.snapshotRetention = Math.min(100, Math.max(5, Number.parseInt(settings.retention, 10) || 30))
    }
    const updated = await updateWorkspace(nextState)
    await enqueueSnapshotMutation(() => pruneWorkspaceSnapshots())
    if (updated.settings.snapshotAutoEnabled) void maybeCreateAutomaticSnapshot('开启自动快照')
    return updated
  }))
  ipcMain.handle('desktop:status', () => currentDesktopStatus())
  ipcMain.on('desktop:set-interaction-locked', (event, locked) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !isDesktopWindow(win)) return
    const organizerWindow = isOrganizerWidgetWindow(win)
    const nextLocked = Boolean(locked)
    if (nextLocked) {
      win.desktopInteractionLocked = true
      win.desktopInteractionLockedAt = Date.now()
      if (organizerWindow) {
        desktopOrganizerDeferredPromotions.delete(win)
        win.desktopOrganizerPromotionPending = true
      }
    } else {
      // Reorder only after pointerup/dragend. Moving HWNDs or reapplying
      // setIgnoreMouseEvents between pointerdown and pointermove invalidates
      // Chromium pointer capture and was the cause of intermittent dead drag
      // and resize handles on lower organizer windows.
      finishDesktopWindowInteraction(win)
    }
    refreshDesktopPointerHitTest()
  })

  ipcMain.on('window:show-control', showControlCenter)
  ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || isDesktopWindow(win)) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('window:close', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== controlWindow) return
    requestControlWindowClose()
  })
  ipcMain.on('window:close-response', (event, action) => {
    if (BrowserWindow.fromWebContents(event.sender) !== controlWindow || !controlClosePromptVisible) return
    if (!['tray', 'quit', 'cancel'].includes(action)) return
    controlClosePromptVisible = false
    if (action === 'tray') minimizeControlToTray()
    if (action === 'quit') requestFullQuit()
  })
}

if (!squirrelStartup && hasPrimaryInstance) app.whenReady().then(async () => {
  if (iconTest) {
    const sourceIcon = loadAppIcon()
    const trayIcon = createTrayIcon()
    const traySize = trayIcon.getSize()
    if (traySize.width !== 16 || traySize.height !== 16) {
      throw new Error(`tray icon size mismatch: ${traySize.width}x${traySize.height}`)
    }
    const scaleFactors = trayIcon.getScaleFactors()
    for (const { size, scaleFactor } of trayIconRepresentations) {
      const expected = nativeImage.createFromPath(trayIconPath(size))
      if (!scaleFactors.includes(scaleFactor)) throw new Error(`tray icon scale factor is missing: ${scaleFactor}`)
      if (!expected.toBitmap().equals(trayIcon.toBitmap({ scaleFactor }))) {
        throw new Error(`tray icon pixels do not match the ${size}px source at ${scaleFactor}x`)
      }
    }
    if (sourceIcon.isEmpty()) throw new Error('application ICO is empty')
    console.log(`[icon] unified application and tray icon assertion passed: ${traySize.width}x${traySize.height} with 1x/1.25x/1.5x/2x representations`)
    app.quit()
    return
  }
  if (safeConsolePipeTest) {
    console.log('[safe-console] electron ready')
    setTimeout(() => {
      console.log('[safe-console] electron survived closed pipe')
      setTimeout(() => app.quit(), 120)
    }, 700)
    return
  }
  if (desktopHostTest) console.log('[desktop-host] startup: ready')
  app.setAppUserModelId('com.edesktop.app')
  if (!capturePath && !desktopHostTest && !desktopTrayTest) {
    await waitForStableDisplayTopology()
  }
  // Establish the baseline before subscribing to display events. Windows can
  // emit a metrics notification while Electron is creating the first native
  // windows; treating that notification as a topology change would rebuild an
  // otherwise healthy organizer host during startup.
  desktopTopologySignature = runtimeDisplayTopologySignature()
  await loadWorkspace()
  if (workspaceSnapshotTest) {
    try {
      await runWorkspaceSnapshotIntegration()
    } catch (error) {
      console.error(`[snapshots] integration failed: ${error.stack || error.message}`)
      process.exitCode = 1
    }
    app.quit()
    return
  }
  if (!capturePath && !desktopHostTest && !desktopTrayTest && workspaceState.settings.launchAtLogin) {
    applyLoginItemSettings(true)
  }
  if (desktopHostTest) console.log('[desktop-host] startup: workspace-loaded')
  if (!capturePath && !desktopTrayTest && (!desktopHostTest || desktopDragTest)) {
    startDesktopIconHelper()
    refreshDesktopIconPositions().catch(() => {})
  }
  if (!capturePath && !desktopHostTest && !desktopTrayTest) {
    await reconcileOrganizerStorage()
    scheduleOrganizerStorageReconcileRetry()
    startRestoreGuardian()
  }
  if (constrainWorkspaceWidgetFrames()) await persistWorkspace()
  registerIpc()
  if (!capturePath && !desktopHostTest && !desktopTrayTest) void maybeCreateAutomaticSnapshot('启动自动快照')
  if (!capturePath && !desktopHostTest && !desktopTrayTest) ensureTray()
  if (desktopHostTest) console.log('[desktop-host] startup: ipc-registered')
  startDesktopPointerHitTest()
  startDesktopOrganizerBandHealth()
  startDesktopWidgetGeometryHealth()
  screen.on('display-added', scheduleDisplayRefresh)
  screen.on('display-removed', scheduleDisplayRefresh)
  screen.on('display-metrics-changed', scheduleDisplayRefresh)
  app.on('child-process-gone', (_event, details) => {
    if (String(details?.type || '').toLocaleLowerCase() !== 'gpu') return
    console.warn(`[desktop-geometry] GPU process ${details?.reason || 'restarted'}; recommitting widget surfaces`)
    scheduleAllDesktopWidgetGeometryReconcile('gpu-process-restarted', [180, 600, 1_400])
  })

  if (useDesktopWidgetWindows && workspaceState.settings.desktopEnabled) {
    await ensureDesktopOrganizerHostWindows()
  }

  if (desktopTrayTest) {
    createControlWindow()
  } else if (capturePath) {
    const win = captureSurface === 'desktop' ? createDesktopWindow() : createControlWindow()
    captureWindow(win)
  } else if (desktopHostTest) {
    console.log(`[desktop-host] startup: create-${useDesktopWidgetWindows ? 'widget' : 'display'}-windows`)
    if (desktopWidgetWindowTest || desktopWidgetWindowManualTest || desktopOrganizerPromotionTest) {
      createDesktopWidgetWindows()
      if (desktopOrganizerPromotionTest) runDesktopOrganizerPromotionRegression()
      else if (desktopWidgetWindowTest) runDesktopWidgetWindowRegression()
    } else {
      createDesktopWindows()
      if (desktopHostRegressionTest) {
      setTimeout(async () => {
        try {
          await new Promise((resolve) => setTimeout(resolve, 120))
          const activeGeometry = await logDesktopGeometry('always-interactive')
          for (const display of screen.getAllDisplays()) {
            const geometry = activeGeometry.find((entry) => entry.displayId === String(display.id))
            const boundsMatch = geometry
              && Math.abs(geometry.bounds.x - display.workArea.x) <= 1
              && Math.abs(geometry.bounds.y - display.workArea.y) <= 1
              && Math.abs(geometry.renderer.innerWidth - display.workArea.width) <= 4
              && Math.abs(geometry.renderer.innerHeight - display.workArea.height) <= 4
              && Math.abs(geometry.renderer.devicePixelRatio - display.scaleFactor) < 0.01
            if (!boundsMatch) {
              throw new Error(`display coverage mismatch: ${display.id}`)
            }
          }
          console.log(`[desktop-geometry] display coverage assertion passed: ${activeGeometry.length} windows`)
          let organizer = workspaceState.widgets.find((widget) => widget.kind === 'organizer')
          if (!organizer) throw new Error('edge test organizer was not created')
          const todo = workspaceState.widgets.find((widget) => widget.kind === 'todo')
          const organizerDisplay = currentDesktopInfo().displays.find((display) => (
            organizer.x >= display.bounds.x
            && organizer.x < display.bounds.x + display.bounds.width
          ))
          const todoDisplay = todo && currentDesktopInfo().displays.find((display) => (
            todo.x >= display.bounds.x
            && todo.x < display.bounds.x + display.bounds.width
          ))
          const organizerTitleUi = await desktopWindows.get(organizerDisplay?.id)?.webContents.executeJavaScript(`(() => {
            const widget = document.querySelector('.widget-organizer')
            const title = widget?.querySelector('[data-widget-title]')
            const widgetRect = widget?.getBoundingClientRect()
            const titleRect = title?.getBoundingClientRect()
            return {
              value: title?.value || '',
              iconCount: widget?.querySelectorAll('.desktop-widget-icon').length || 0,
              nativeTitleCount: widget?.querySelectorAll('[title]').length || 0,
              centerDelta: widgetRect && titleRect
                ? Math.abs((titleRect.left + titleRect.width / 2) - (widgetRect.left + widgetRect.width / 2))
                : Number.POSITIVE_INFINITY,
            }
          })()`)
          const todoUi = await desktopWindows.get(todoDisplay?.id)?.webContents.executeJavaScript(`(() => {
            const widget = document.querySelector('.widget-todo')
            const itemText = widget?.querySelector('.todo-item-copy > span')
            const titleElement = widget?.querySelector('[data-widget-title]')
            const dragAffordance = widget?.querySelector('.drag-affordance')
            const titleRect = titleElement?.getBoundingClientRect()
            const dragRect = dragAffordance?.getBoundingClientRect()
            return {
              title: titleElement?.textContent || '',
              titleTag: titleElement?.tagName || '',
              titleInputCount: widget?.querySelectorAll('.desktop-widget-header input').length || 0,
              itemFontSize: itemText ? Number.parseFloat(getComputedStyle(itemText).fontSize) : 0,
              timeText: widget?.querySelector('.todo-time-range')?.textContent || '',
              addFormTimeInputCount: widget?.querySelectorAll('.desktop-todo-add input[type="time"]').length || 0,
              menuButtonCount: widget?.querySelectorAll('.todo-item-menu').length || 0,
              listCount: widget?.querySelectorAll('.todo-list-section').length || 0,
              listLabels: [...(widget?.querySelectorAll('.todo-list-header > strong') || [])].map((element) => element.textContent),
              listLefts: [...(widget?.querySelectorAll('.todo-list-section') || [])].map((element) => element.getBoundingClientRect().left),
              dragHandleCount: widget?.querySelectorAll('.todo-item-drag-handle').length || 0,
              titleDragOverlap: titleRect && dragRect ? titleRect.right > dragRect.left : true,
              dragAffordanceWidth: dragRect?.width || 0,
            }
          })()`)
          const todoSettingsUi = await desktopWindows.get(todoDisplay?.id)?.webContents.executeJavaScript(`(async () => {
            const widget = document.querySelector('.widget-todo')
            widget?.querySelector('.todo-item-menu')?.click()
            await new Promise((resolve) => setTimeout(resolve, 60))
            const form = widget?.querySelector('.todo-item-settings')
            const textInput = form?.querySelector('input[name="text"]')
            const startInput = form?.querySelector('input[name="startTime"]')
            const endInput = form?.querySelector('input[name="endTime"]')
            const result = {
              opened: Boolean(form),
              animationName: form ? getComputedStyle(form).animationName : '',
              textValue: textInput?.value || '',
              startValue: startInput?.value || '',
              endValue: endInput?.value || '',
            }
            if (!form || !textInput || !startInput || !endInput) return result
            const setValue = (input, value) => {
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
              input.dispatchEvent(new Event('input', { bubbles: true }))
            }
            setValue(textInput, '修改后的待办事项')
            setValue(startInput, '11:15')
            setValue(endInput, '12:45')
            await new Promise((resolve) => setTimeout(resolve, 30))
            form.requestSubmit()
            return result
          })()`)
          await new Promise((resolve) => setTimeout(resolve, 120))
          const configuredTodo = workspaceState.widgets.find((widget) => widget.id === todo?.id)
          const configuredTodoItem = configuredTodo?.data?.items?.find((item) => item.id === 'capture-1')
          const configuredTodoUi = await desktopWindows.get(todoDisplay?.id)?.webContents.executeJavaScript(`(() => ({
            timeText: document.querySelector('.widget-todo .todo-time-range')?.textContent || '',
            itemText: document.querySelector('.widget-todo .todo-item-copy > span')?.textContent || '',
            settingsClosed: !document.querySelector('.widget-todo .todo-item-settings'),
          }))()`)
          if (
            organizerTitleUi?.value !== organizer.title
            || organizerTitleUi.iconCount !== 0
            || organizerTitleUi.nativeTitleCount !== 0
            || organizerTitleUi.centerDelta > 1
            || todoUi?.title !== todo?.title
            || todoUi.titleTag !== 'SPAN'
            || todoUi.titleInputCount !== 0
            || todoUi.titleDragOverlap
            || todoUi.dragAffordanceWidth < 28
            || todoUi.itemFontSize < 12
            || todoUi.timeText !== '09:00 – 10:30'
            || todoUi.addFormTimeInputCount !== 0
            || todoUi.menuButtonCount !== 3
            || todoUi.listCount !== 2
            || todoUi.listLabels?.join('|') !== '我的一天|临时安排'
            || todoUi.listLefts?.[1] <= todoUi.listLefts?.[0]
            || todoUi.dragHandleCount !== 3
            || !todoSettingsUi?.opened
            || todoSettingsUi.animationName !== 'todo-bubble-pop'
            || todoSettingsUi.textValue !== '整理产品资料'
            || todoSettingsUi.startValue !== '09:00'
            || todoSettingsUi.endValue !== '10:30'
            || configuredTodoItem?.startTime !== '11:15'
            || configuredTodoItem?.endTime !== '12:45'
            || configuredTodoItem?.text !== '修改后的待办事项'
            || configuredTodoUi?.timeText !== '11:15 – 12:45'
            || configuredTodoUi?.itemText !== '修改后的待办事项'
            || !configuredTodoUi.settingsClosed
          ) {
            throw new Error(`widget title or todo time UI mismatch: ${JSON.stringify({ organizerTitleUi, todoUi, todoSettingsUi, configuredTodoItem, configuredTodoUi })}`)
          }
          console.log('[desktop-geometry] read-only desktop title and editable todo item assertions passed: content + optional range')

          const staleMyDayItem = configuredTodo?.data?.items?.find((item) => item.id === 'capture-3')
          if (staleMyDayItem?.completed || staleMyDayItem?.completedOn) {
            throw new Error(`my-day daily reset mismatch: ${JSON.stringify(staleMyDayItem)}`)
          }
          const todoDragResult = await desktopWindows.get(todoDisplay?.id)?.webContents.executeJavaScript(`(async () => {
            const source = document.querySelector('[data-todo-item-id="capture-1"] .todo-item-drag-handle')
            const target = document.querySelector('[data-todo-item-id="capture-3"]')
            if (!source || !target) return { dispatched: false }
            const transfer = new DataTransfer()
            source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }))
            await new Promise((resolve) => setTimeout(resolve, 30))
            const rect = target.getBoundingClientRect()
            target.dispatchEvent(new DragEvent('dragover', {
              bubbles: true,
              cancelable: true,
              clientY: rect.bottom - 1,
              dataTransfer: transfer,
            }))
            await new Promise((resolve) => setTimeout(resolve, 20))
            target.dispatchEvent(new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              clientY: rect.bottom - 1,
              dataTransfer: transfer,
            }))
            source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
            return { dispatched: true }
          })()`)
          await new Promise((resolve) => setTimeout(resolve, 120))
          const reorderedTodo = workspaceState.widgets.find((widget) => widget.id === todo?.id)
          const reorderedMyDayIds = reorderedTodo?.data?.items
            ?.filter((item) => item.list === 'my-day')
            .map((item) => item.id)
          if (!todoDragResult?.dispatched || reorderedMyDayIds?.join('|') !== 'capture-3|capture-1') {
            throw new Error(`todo drag reorder mismatch: ${JSON.stringify({ todoDragResult, reorderedMyDayIds })}`)
          }

          const crossListDragResult = await desktopWindows.get(todoDisplay?.id)?.webContents.executeJavaScript(`(async () => {
            const source = document.querySelector('[data-todo-item-id="capture-1"] .todo-item-drag-handle')
            const target = document.querySelector('[data-todo-item-id="capture-2"]')
            if (!source || !target) return { dispatched: false }
            const transfer = new DataTransfer()
            source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }))
            await new Promise((resolve) => setTimeout(resolve, 30))
            const rect = target.getBoundingClientRect()
            target.dispatchEvent(new DragEvent('dragover', {
              bubbles: true,
              cancelable: true,
              clientY: rect.bottom - 1,
              dataTransfer: transfer,
            }))
            await new Promise((resolve) => setTimeout(resolve, 20))
            target.dispatchEvent(new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              clientY: rect.bottom - 1,
              dataTransfer: transfer,
            }))
            source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
            return { dispatched: true }
          })()`)
          await new Promise((resolve) => setTimeout(resolve, 120))
          const crossListTodo = workspaceState.widgets.find((widget) => widget.id === todo?.id)
          const crossListGroups = {
            myDay: crossListTodo?.data?.items?.filter((item) => item.list === 'my-day').map((item) => item.id),
            temporary: crossListTodo?.data?.items?.filter((item) => item.list === 'temporary').map((item) => item.id),
          }
          if (
            !crossListDragResult?.dispatched
            || crossListGroups.myDay?.join('|') !== 'capture-3'
            || crossListGroups.temporary?.join('|') !== 'capture-2|capture-1'
          ) {
            throw new Error(`todo cross-list drag mismatch: ${JSON.stringify({ crossListDragResult, crossListGroups })}`)
          }

          await desktopWindows.get(todoDisplay?.id)?.webContents.executeJavaScript(`window.desktopAPI.updateWidget(${JSON.stringify(todo.id)}, { width: 320 })`)
          await new Promise((resolve) => setTimeout(resolve, 160))
          const compactTodoUi = await desktopWindows.get(todoDisplay?.id)?.webContents.executeJavaScript(`(async () => {
            const widget = document.querySelector('.widget-todo')
            const selector = widget?.querySelector('.todo-list-selector')
            selector?.click()
            await new Promise((resolve) => setTimeout(resolve, 30))
            const temporary = [...(widget?.querySelectorAll('.todo-list-menu button') || [])]
              .find((button) => button.textContent?.includes('临时安排'))
            temporary?.click()
            await new Promise((resolve) => setTimeout(resolve, 80))
            return {
              compact: widget?.querySelector('.todo-widget-content')?.classList.contains('is-compact'),
              sectionCount: widget?.querySelectorAll('.todo-list-section').length || 0,
              selectedLabel: widget?.querySelector('.todo-list-selector strong')?.textContent || '',
              visibleItemIds: [...(widget?.querySelectorAll('[data-todo-item-id]') || [])].map((element) => element.getAttribute('data-todo-item-id')),
              menuClosed: !widget?.querySelector('.todo-list-menu'),
            }
          })()`)
          if (
            !compactTodoUi?.compact
            || compactTodoUi.sectionCount !== 1
            || compactTodoUi.selectedLabel !== '临时安排'
            || compactTodoUi.visibleItemIds?.join('|') !== 'capture-2|capture-1'
            || !compactTodoUi.menuClosed
          ) {
            throw new Error(`todo responsive list switch mismatch: ${JSON.stringify(compactTodoUi)}`)
          }
          const compactCrossListUi = await desktopWindows.get(todoDisplay?.id)?.webContents.executeJavaScript(`(async () => {
            const source = document.querySelector('[data-todo-item-id="capture-1"] .todo-item-drag-handle')
            if (!source) return { dispatched: false }
            const transfer = new DataTransfer()
            source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }))
            await new Promise((resolve) => setTimeout(resolve, 40))
            const target = document.querySelector('[data-todo-group-target="my-day"]')
            if (!target) return { dispatched: false, targetMissing: true }
            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
            await new Promise((resolve) => setTimeout(resolve, 20))
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
            source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
            await new Promise((resolve) => setTimeout(resolve, 100))
            return {
              dispatched: true,
              selectedLabel: document.querySelector('.widget-todo .todo-list-selector strong')?.textContent || '',
              visibleItemIds: [...document.querySelectorAll('.widget-todo [data-todo-item-id]')].map((element) => element.getAttribute('data-todo-item-id')),
              dropTargetsClosed: !document.querySelector('.widget-todo .todo-compact-group-targets'),
            }
          })()`)
          await new Promise((resolve) => setTimeout(resolve, 100))
          const compactMovedTodo = workspaceState.widgets.find((widget) => widget.id === todo?.id)
          const compactMovedItem = compactMovedTodo?.data?.items?.find((item) => item.id === 'capture-1')
          if (
            !compactCrossListUi?.dispatched
            || compactCrossListUi.selectedLabel !== '我的一天'
            || compactCrossListUi.visibleItemIds?.join('|') !== 'capture-3|capture-1'
            || !compactCrossListUi.dropTargetsClosed
            || compactMovedItem?.list !== 'my-day'
            || !compactMovedItem.completedOn
          ) {
            throw new Error(`todo compact cross-list drag mismatch: ${JSON.stringify({ compactCrossListUi, compactMovedItem })}`)
          }
          console.log('[desktop-geometry] todo planning assertions passed: daily reset + same/cross-list drag + compact drop targets + responsive switch')

          const pomodoro = workspaceState.widgets.find((widget) => widget.kind === 'pomodoro')
          const pomodoroDisplay = pomodoro && currentDesktopInfo().displays.find((display) => (
            pomodoro.x >= display.bounds.x
            && pomodoro.x < display.bounds.x + display.bounds.width
          ))
          const pomodoroWindow = desktopWindows.get(pomodoroDisplay?.id)
          const settingsOpened = await pomodoroWindow?.webContents.executeJavaScript(`(async () => {
            const widget = document.querySelector('.widget-pomodoro')
            widget?.querySelector('.pomodoro-settings-button')?.click()
            await new Promise((resolve) => setTimeout(resolve, 60))
            const focusInput = widget?.querySelector('input[name="focusMinutes"]')
            const breakInput = widget?.querySelector('input[name="breakMinutes"]')
            if (!focusInput || !breakInput) return false
            const setValue = (input, value) => {
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
              input.dispatchEvent(new Event('input', { bubbles: true }))
            }
            setValue(focusInput, '42')
            setValue(breakInput, '9')
            widget.querySelector('.pomodoro-settings')?.requestSubmit()
            return true
          })()`)
          await new Promise((resolve) => setTimeout(resolve, 180))
          const configuredPomodoro = workspaceState.widgets.find((widget) => widget.id === pomodoro?.id)
          const timerUi = await pomodoroWindow?.webContents.executeJavaScript(`(() => {
            const widget = document.querySelector('.widget-pomodoro')
            const digit = widget?.querySelector('.flip-digit')
            const separator = widget?.querySelector('.timer-separator')
            const digitRect = digit?.getBoundingClientRect()
            const separatorRect = separator?.getBoundingClientRect()
            return {
              value: widget?.querySelector('.desktop-timer-value')?.textContent || '',
              digitCount: widget?.querySelectorAll('.flip-digit').length || 0,
              staticHalfCount: widget?.querySelectorAll('.flip-digit-static-top, .flip-digit-static-bottom').length || 0,
              separatorDotWidth: separator ? getComputedStyle(separator, '::before').width : '',
              separatorCenterDelta: digitRect && separatorRect
                ? Math.abs((digitRect.top + digitRect.height / 2) - (separatorRect.top + separatorRect.height / 2))
                : Number.POSITIVE_INFINITY,
              sessionTextCount: widget?.querySelectorAll('.session-count').length || 0,
              modeFontSize: Number.parseFloat(getComputedStyle(widget?.querySelector('.timer-mode')).fontSize),
            }
          })()`)
          if (
            !settingsOpened
            || configuredPomodoro?.data?.focusMinutes !== 42
            || configuredPomodoro?.data?.breakMinutes !== 9
            || configuredPomodoro?.data?.remainingSeconds !== 42 * 60
            || configuredPomodoro?.data?.running
            || timerUi?.value !== '42:00'
            || timerUi.digitCount !== 4
            || timerUi.staticHalfCount !== 8
            || timerUi.separatorDotWidth !== '4px'
            || timerUi.separatorCenterDelta > 0.5
            || timerUi.sessionTextCount !== 0
            || timerUi.modeFontSize < 12
          ) {
            throw new Error(`pomodoro settings or flip UI mismatch: ${JSON.stringify({ settingsOpened, timerUi })}`)
          }
          await pomodoroWindow?.webContents.executeJavaScript(
            "document.querySelector('.widget-pomodoro .timer-toggle')?.click()",
          )
          await new Promise((resolve) => setTimeout(resolve, 120))
          const startedTimer = await pomodoroWindow?.webContents.executeJavaScript(
            "document.querySelector('.widget-pomodoro .desktop-timer-value')?.textContent || ''",
          )
          if (startedTimer !== '42:00') throw new Error(`pomodoro start time changed unexpectedly: ${startedTimer}`)
          const flipAnimationUi = await pomodoroWindow?.webContents.executeJavaScript(`(async () => {
            const deadline = Date.now() + 1800
            while (Date.now() < deadline) {
              const widget = document.querySelector('.widget-pomodoro')
              const upperLeaf = widget?.querySelector('.flip-digit-leaf-out')
              const lowerLeaf = widget?.querySelector('.flip-digit-leaf-in')
              if (upperLeaf && lowerLeaf) {
                const upperStage = upperLeaf.parentElement
                const lowerStage = lowerLeaf.parentElement
                return {
                  value: widget.querySelector('.desktop-timer-value')?.textContent || '',
                  upperAnimationName: getComputedStyle(upperLeaf).animationName,
                  lowerAnimationName: getComputedStyle(lowerLeaf).animationName,
                  lowerAnimationDelay: getComputedStyle(lowerLeaf).animationDelay,
                  upperBackgroundColor: getComputedStyle(upperLeaf).backgroundColor,
                  lowerBackgroundColor: getComputedStyle(lowerLeaf).backgroundColor,
                  upperFilter: getComputedStyle(upperLeaf).filter,
                  lowerFilter: getComputedStyle(lowerLeaf).filter,
                  upperBackfaceVisibility: getComputedStyle(upperLeaf).backfaceVisibility,
                  lowerBackfaceVisibility: getComputedStyle(lowerLeaf).backfaceVisibility,
                  upperStageOverflow: upperStage ? getComputedStyle(upperStage).overflow : '',
                  lowerStageOverflow: lowerStage ? getComputedStyle(lowerStage).overflow : '',
                }
              }
              await new Promise((resolve) => setTimeout(resolve, 40))
            }
            return null
          })()`)
          if (
            flipAnimationUi?.value !== '41:59'
            || flipAnimationUi.upperAnimationName !== 'split-flap-fold'
            || flipAnimationUi.lowerAnimationName !== 'split-flap-unfold'
            || flipAnimationUi.lowerAnimationDelay !== '0.22s'
            || flipAnimationUi.upperBackgroundColor !== 'rgb(18, 75, 63)'
            || flipAnimationUi.lowerBackgroundColor !== 'rgb(18, 75, 63)'
            || flipAnimationUi.upperFilter !== 'none'
            || flipAnimationUi.lowerFilter !== 'none'
            || flipAnimationUi.upperBackfaceVisibility !== 'hidden'
            || flipAnimationUi.lowerBackfaceVisibility !== 'hidden'
            || !['hidden', 'clip'].includes(flipAnimationUi.upperStageOverflow)
            || !['hidden', 'clip'].includes(flipAnimationUi.lowerStageOverflow)
          ) {
            throw new Error(`pomodoro live split-flap mismatch: ${JSON.stringify(flipAnimationUi)}`)
          }
          await pomodoroWindow?.webContents.executeJavaScript(
            "document.querySelector('.widget-pomodoro [aria-label=\"重置\"]')?.click()",
          )
          const breakModeUi = await pomodoroWindow?.webContents.executeJavaScript(`(async () => {
            const button = document.querySelector('.widget-pomodoro .timer-mode-switch')
            button?.click()
            await new Promise((resolve) => setTimeout(resolve, 120))
            const label = document.querySelector('.widget-pomodoro .timer-mode')
            const currentButton = document.querySelector('.widget-pomodoro .timer-mode-switch')
            return {
              label: label?.textContent || '',
              labelBackground: label ? getComputedStyle(label).backgroundColor : '',
              pressed: currentButton?.getAttribute('aria-pressed') || '',
              buttonBackground: currentButton ? getComputedStyle(currentButton).backgroundColor : '',
            }
          })()`)
          const breakPomodoro = workspaceState.widgets.find((widget) => widget.id === pomodoro?.id)
          if (
            breakPomodoro?.data?.mode !== 'break'
            || breakModeUi?.label !== '休息时间'
            || breakModeUi.pressed !== 'true'
            || !breakModeUi.labelBackground.includes('248, 247, 242')
            || !breakModeUi.buttonBackground.includes('248, 247, 242')
          ) {
            throw new Error(`pomodoro break-mode feedback mismatch: ${JSON.stringify({ breakModeUi, mode: breakPomodoro?.data?.mode })}`)
          }
          console.log(`[desktop-geometry] pomodoro settings, mode feedback, two-stage split-flap, centered colon, and stable-start assertions passed: ${startedTimer}`)
          const leftmostDisplay = [...currentDesktopInfo().displays]
            .sort((a, b) => a.bounds.x - b.bounds.x)[0]
          const leftmostDisplayId = leftmostDisplay?.id
          await fs.promises.rm(desktopHostFileTestRoot, { recursive: true, force: true })
          const testSourceDirectory = path.join(desktopHostFileTestRoot, 'source')
          const testSourcePath = path.join(testSourceDirectory, 'desktop-item.txt')
          await fs.promises.mkdir(testSourceDirectory, { recursive: true })
          await fs.promises.writeFile(testSourcePath, 'desktop organizer move test', 'utf8')
          const importResult = await importOrganizerFiles(organizer.id, [testSourcePath])
          const importedOrganizer = workspaceState.widgets.find((widget) => widget.id === organizer.id)
          const importedFile = importedOrganizer?.data.files?.find((file) => file.name === 'desktop-item.txt')
          if (importResult.imported !== 1 || fs.existsSync(testSourcePath) || !importedFile || !fs.existsSync(importedFile.path)) {
            throw new Error(`organizer import move mismatch: ${JSON.stringify(importResult)}`)
          }
          const releaseResult = await releaseOrganizerFile(organizer.id, importedFile.path)
          if (fs.existsSync(importedFile.path) || !fs.existsSync(releaseResult.releasedPath) || releaseResult.releasedPath !== testSourcePath) {
            throw new Error('organizer release move mismatch')
          }
          const secondImportResult = await importOrganizerFiles(organizer.id, [testSourcePath])
          const secondOrganizer = workspaceState.widgets.find((widget) => widget.id === organizer.id)
          const secondImportedFile = secondOrganizer?.data.files?.find((file) => file.name === 'desktop-item.txt')
          if (secondImportResult.imported !== 1 || !secondImportedFile || fs.existsSync(testSourcePath)) {
            throw new Error('organizer second import mismatch')
          }
          const secondReleaseResult = await releaseOrganizerFile(organizer.id, secondImportedFile.path)
          if (fs.existsSync(secondImportedFile.path) || secondReleaseResult.releasedPath !== testSourcePath || !fs.existsSync(testSourcePath)) {
            throw new Error('organizer repeated release mismatch')
          }
          const thirdImportResult = await importOrganizerFiles(organizer.id, [testSourcePath])
          const thirdOrganizer = workspaceState.widgets.find((widget) => widget.id === organizer.id)
          const thirdImportedFile = thirdOrganizer?.data.files?.find((file) => file.name === 'desktop-item.txt')
          if (thirdImportResult.imported !== 1 || !thirdImportedFile || fs.existsSync(testSourcePath)) {
            throw new Error('organizer third import mismatch')
          }
          const restoreResult = await restoreOrganizerFilesToOriginalLocations()
          const restoredOrganizer = workspaceState.widgets.find((widget) => widget.id === organizer.id)
          if (
            restoreResult.restored !== 1
            || !fs.existsSync(testSourcePath)
            || fs.existsSync(thirdImportedFile.path)
            || restoredOrganizer?.data.files?.some((file) => file.name === 'desktop-item.txt')
          ) {
            throw new Error(`organizer exit restore mismatch: ${JSON.stringify(restoreResult)}`)
          }
          console.log('[desktop-geometry] organizer physical move assertions passed: repeated import + release + exit restore')

          const lifecycleImportResult = await importOrganizerFiles(organizer.id, [testSourcePath])
          const lifecycleImportedFile = workspaceState.widgets
            .find((widget) => widget.id === organizer.id)
            ?.data.files?.find((file) => file.name === 'desktop-item.txt')
          if (lifecycleImportResult.imported !== 1 || !lifecycleImportedFile || fs.existsSync(testSourcePath)) {
            throw new Error('organizer lifecycle import mismatch')
          }
          const temporaryRestoreResult = await restoreOrganizerFilesToOriginalLocations({
            preserveOrganizerMembership: true,
          })
          const temporarilyRestoredFile = workspaceState.widgets
            .find((widget) => widget.id === organizer.id)
            ?.data.files?.find((file) => file.name === 'desktop-item.txt')
          if (
            temporaryRestoreResult.restored !== 1
            || !fs.existsSync(testSourcePath)
            || temporarilyRestoredFile?.path !== testSourcePath
            || temporarilyRestoredFile?.temporarilyRestoredOnExit !== true
          ) {
            throw new Error(`organizer temporary exit restore mismatch: ${JSON.stringify(temporaryRestoreResult)}`)
          }
          await new Promise((resolve) => setTimeout(resolve, 80))
          const pendingRenderedCount = await desktopWindows.get(organizerDisplay?.id)?.webContents.executeJavaScript(`[
            ...document.querySelectorAll('.organizer-file-open strong')
          ].filter((element) => element.textContent === 'desktop-item').length`)
          if (pendingRenderedCount !== 0) {
            throw new Error('temporarily restored desktop file was rendered as already collected')
          }
          await reconcileOrganizerStorage()
          const reimportedAfterRestart = workspaceState.widgets
            .find((widget) => widget.id === organizer.id)
            ?.data.files?.find((file) => file.name === 'desktop-item.txt')
          if (
            fs.existsSync(testSourcePath)
            || !reimportedAfterRestart
            || !fs.existsSync(reimportedAfterRestart.path)
            || reimportedAfterRestart.temporarilyRestoredOnExit === true
            || !pathIsInside(organizerStoragePath(organizer.id), reimportedAfterRestart.path)
          ) {
            throw new Error('organizer startup re-import mismatch')
          }
          await new Promise((resolve) => setTimeout(resolve, 80))
          const reimportedRenderedCount = await desktopWindows.get(organizerDisplay?.id)?.webContents.executeJavaScript(`[
            ...document.querySelectorAll('.organizer-file-open strong')
          ].filter((element) => element.textContent === 'desktop-item').length`)
          if (reimportedRenderedCount !== 1) {
            throw new Error('successfully re-imported desktop file was not rendered exactly once')
          }
          const lifecycleCleanupResult = await restoreOrganizerFilesToOriginalLocations()
          if (lifecycleCleanupResult.restored !== 1 || !fs.existsSync(testSourcePath)) {
            throw new Error('organizer lifecycle cleanup mismatch')
          }
          console.log('[desktop-geometry] organizer quit/restart lifecycle assertion passed: pending hidden + re-imported once on restart')

          const transferTarget = createWidget('organizer')
          transferTarget.title = '跨盒转移目标'
          transferTarget.x = 60
          transferTarget.y = 510
          transferTarget.width = 220
          transferTarget.height = 180
          const stateWithTransferTarget = cloneWorkspace()
          stateWithTransferTarget.widgets.push(transferTarget)
          await updateWorkspace(stateWithTransferTarget)
          const folderSourcePath = path.join(testSourceDirectory, 'windows-folder')
          await fs.promises.mkdir(folderSourcePath, { recursive: true })
          await fs.promises.writeFile(path.join(folderSourcePath, 'inside.txt'), 'folder icon and transfer test', 'utf8')
          const folderImportResult = await importOrganizerFiles(organizer.id, [folderSourcePath])
          const importedFolder = workspaceState.widgets
            .find((widget) => widget.id === organizer.id)
            ?.data.files?.find((file) => file.name === 'windows-folder')
          if (
            folderImportResult.imported !== 1
            || !importedFolder
            || !importedFolder.iconDataUrl?.startsWith('data:image/')
            || fs.existsSync(folderSourcePath)
          ) {
            throw new Error(`organizer folder icon persistence mismatch: ${JSON.stringify(folderImportResult)}`)
          }
          await new Promise((resolve) => setTimeout(resolve, 180))
          const transferWindow = desktopWindows.get(organizerDisplay?.id)
          const folderDragResult = await transferWindow?.webContents.executeJavaScript(`(async () => {
            const widgets = [...document.querySelectorAll('.widget-organizer')]
            const byTitle = (title) => widgets.find((entry) => entry.querySelector('[data-widget-title]')?.value === title)
            const sourceWidget = byTitle('项目资料')
            const targetWidget = byTitle('跨盒转移目标')
            const sourceButton = [...(sourceWidget?.querySelectorAll('.organizer-file-open') || [])]
              .find((entry) => entry.querySelector('strong')?.textContent === 'windows-folder')
            const sourceIcon = sourceButton?.querySelector('.organizer-file-icon img')?.getAttribute('src') || ''
            const targetDropZone = targetWidget?.querySelector('.organizer-drop-zone')
            if (!sourceButton || !targetDropZone) return { error: 'missing cross-organizer drag fixtures', sourceIcon }
            const dataTransfer = new DataTransfer()
            sourceButton.dispatchEvent(new DragEvent('dragstart', {
              bubbles: true,
              cancelable: true,
              dataTransfer,
            }))
            const targetRect = targetDropZone.getBoundingClientRect()
            const eventInit = {
              bubbles: true,
              cancelable: true,
              dataTransfer,
              clientX: targetRect.left + targetRect.width / 2,
              clientY: targetRect.top + targetRect.height / 2,
            }
            targetDropZone.dispatchEvent(new DragEvent('dragenter', eventInit))
            targetDropZone.dispatchEvent(new DragEvent('dragover', eventInit))
            targetDropZone.dispatchEvent(new DragEvent('drop', eventInit))
            sourceButton.dispatchEvent(new DragEvent('dragend', eventInit))
            await new Promise((resolve) => setTimeout(resolve, 300))
            const targetIcon = [...(targetWidget.querySelectorAll('.organizer-file-open') || [])]
              .find((entry) => entry.querySelector('strong')?.textContent === 'windows-folder')
              ?.querySelector('.organizer-file-icon img')?.getAttribute('src') || ''
            return { sourceIcon, targetIcon }
          })()`)
          const sourceAfterTransfer = workspaceState.widgets
            .find((widget) => widget.id === organizer.id)
            ?.data.files?.find((file) => file.name === 'windows-folder')
          const targetAfterTransfer = workspaceState.widgets
            .find((widget) => widget.id === transferTarget.id)
            ?.data.files?.find((file) => file.name === 'windows-folder')
          if (
            folderDragResult?.error
            || !folderDragResult?.sourceIcon?.startsWith('data:image/')
            || folderDragResult.targetIcon !== folderDragResult.sourceIcon
            || sourceAfterTransfer
            || !targetAfterTransfer
            || !fs.existsSync(targetAfterTransfer.path)
            || !pathIsInside(organizerStoragePath(transferTarget.id), targetAfterTransfer.path)
          ) {
            throw new Error(`organizer cross-box folder drag mismatch: ${JSON.stringify({ folderDragResult })}`)
          }
          const transferredFolderRelease = await releaseOrganizerFile(transferTarget.id, targetAfterTransfer.path)
          if (transferredFolderRelease.releasedPath !== folderSourcePath || !fs.existsSync(folderSourcePath)) {
            throw new Error('organizer transferred folder release mismatch')
          }
          const stateWithoutTransferTarget = cloneWorkspace()
          stateWithoutTransferTarget.widgets = stateWithoutTransferTarget.widgets
            .filter((widget) => widget.id !== transferTarget.id)
          await updateWorkspace(stateWithoutTransferTarget)
          console.log('[desktop-geometry] folder icon and cross-organizer drag assertions passed: persisted + rendered + transferred')

          const organizerBeforeCompactTest = workspaceState.widgets.find((widget) => widget.id === organizer.id)
          const originalOrganizerFrame = {
            x: organizerBeforeCompactTest.x,
            y: organizerBeforeCompactTest.y,
            width: organizerBeforeCompactTest.width,
            height: organizerBeforeCompactTest.height,
          }
          const compactDraggedFrame = await transferWindow?.webContents.executeJavaScript(`(async () => {
            const widgetId = ${JSON.stringify(organizer.id)}
            await window.desktopAPI.updateWidget(widgetId, { width: 88, height: 122 })
            window.desktopAPI.previewWidgetFrame(widgetId, {
              x: ${originalOrganizerFrame.x + 24},
              y: ${originalOrganizerFrame.y + 18},
            })
            await window.desktopAPI.updateWidget(widgetId, {
              x: ${originalOrganizerFrame.x + 24},
              y: ${originalOrganizerFrame.y + 18},
            })
            return window.desktopAPI.getWorkspace().then((state) => {
              const widget = state.widgets.find((entry) => entry.id === widgetId)
              return widget ? { x: widget.x, y: widget.y, width: widget.width, height: widget.height } : null
            })
          })()`)
          await new Promise((resolve) => setTimeout(resolve, 120))
          const compactOrganizerRect = await transferWindow?.webContents.executeJavaScript(`(() => {
            const widget = [...document.querySelectorAll('.widget-organizer')]
              .find((entry) => entry.querySelector('[data-widget-title]')?.value === '项目资料')
            const rect = widget?.getBoundingClientRect()
            return rect ? { width: rect.width, height: rect.height } : null
          })()`)
          if (
            !compactDraggedFrame
            || compactDraggedFrame.width !== 88
            || compactDraggedFrame.height !== 122
            || !compactOrganizerRect
            || Math.abs(compactOrganizerRect.width - 88) > 1
            || Math.abs(compactOrganizerRect.height - 122) > 1
          ) {
            throw new Error(`organizer compact drag size mismatch: ${JSON.stringify({ compactDraggedFrame, compactOrganizerRect })}`)
          }
          await transferWindow?.webContents.executeJavaScript(`window.desktopAPI.updateWidget(
            ${JSON.stringify(organizer.id)},
            ${JSON.stringify(originalOrganizerFrame)}
          )`)
          console.log('[desktop-geometry] organizer compact drag-size assertion passed: 88x122 preserved after move')

          const shortcutSourcePath = path.join(testSourceDirectory, 'desktop-shortcut.lnk')
          const escapePowerShellLiteral = (value) => String(value).replace(/'/g, "''")
          const shortcutScript = [
            '$shell = New-Object -ComObject WScript.Shell',
            `$shortcut = $shell.CreateShortcut('${escapePowerShellLiteral(shortcutSourcePath)}')`,
            `$shortcut.TargetPath = '${escapePowerShellLiteral(process.execPath)}'`,
            `$shortcut.IconLocation = '${escapePowerShellLiteral(process.execPath)},0'`,
            `$shortcut.WorkingDirectory = '${escapePowerShellLiteral(path.dirname(process.execPath))}'`,
            '$shortcut.Save()',
          ].join('; ')
          await execFileAsync(windowsPowerShellPath(), [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(shortcutScript, 'utf16le').toString('base64'),
          ], { windowsHide: true, timeout: 5_000 })
          const expectedShortcutVisual = await loadDirectFileVisual(process.execPath)
          const shortcutImportResult = await importOrganizerFiles(organizer.id, [shortcutSourcePath])
          const shortcutOrganizer = workspaceState.widgets.find((widget) => widget.id === organizer.id)
          const importedShortcut = shortcutOrganizer?.data.files?.find((file) => file.name === 'desktop-shortcut.lnk')
          const expectedShortcutIcon = expectedShortcutVisual?.toDataURL() || ''
          const shortcutInfo = await readWindowsShortcut(importedShortcut?.path || shortcutSourcePath)
          const shortcutVisualPath = importedShortcut ? await resolveShortcutVisualPath(importedShortcut.path) : ''
          if (
            shortcutImportResult.imported !== 1
            || !importedShortcut
            || !expectedShortcutIcon
            || importedShortcut.iconDataUrl !== expectedShortcutIcon
          ) {
            const iconFingerprint = (value) => ({
              length: value?.length || 0,
              hash: value ? crypto.createHash('sha256').update(value).digest('hex') : '',
            })
            throw new Error(`organizer shortcut icon persistence mismatch: ${JSON.stringify({
              shortcutImportResult,
              shortcutInfo,
              shortcutVisualPath,
              expected: iconFingerprint(expectedShortcutIcon),
              actual: iconFingerprint(importedShortcut?.iconDataUrl),
            })}`)
          }
          await new Promise((resolve) => setTimeout(resolve, 180))
          const shortcutHostWindow = desktopWindows.get(organizerDisplay?.id)
          const renderedShortcutIcon = await shortcutHostWindow?.webContents.executeJavaScript(`(() => {
            const tile = [...document.querySelectorAll('.organizer-file')]
              .find((entry) => entry.querySelector('.organizer-file-open')?.getAttribute('aria-label')?.startsWith('desktop-shortcut.lnk，'))
            return tile?.querySelector('.organizer-file-icon img')?.getAttribute('src') || ''
          })()`)
          if (renderedShortcutIcon !== expectedShortcutIcon) {
            throw new Error('organizer shortcut icon rendering mismatch')
          }
          const shortcutReleaseResult = await releaseOrganizerFile(organizer.id, importedShortcut.path)
          if (shortcutReleaseResult.releasedPath !== shortcutSourcePath || !fs.existsSync(shortcutSourcePath)) {
            throw new Error('organizer shortcut release mismatch')
          }
          console.log('[desktop-geometry] shortcut icon assertions passed: resolved + persisted + rendered')

          const exitRestorePaths = ['exit-a.txt', 'exit-b.txt', 'exit-c.txt']
            .map((name) => path.join(testSourceDirectory, name))
          await Promise.all(exitRestorePaths.map((filePath, index) => (
            fs.promises.writeFile(filePath, `exit restore ${index}`, 'utf8')
          )))
          const queuedImports = await Promise.all(exitRestorePaths.map((filePath) => (
            enqueueWorkspaceMutation(() => importOrganizerFiles(organizer.id, [filePath]))
          )))
          if (queuedImports.some((result) => result.imported !== 1)) {
            throw new Error(`organizer queued import mismatch: ${JSON.stringify(queuedImports)}`)
          }
          const queuedOrganizer = workspaceState.widgets.find((widget) => widget.id === organizer.id)
          const queuedFiles = queuedOrganizer?.data.files?.filter((file) => file.name.startsWith('exit-')) || []
          if (queuedFiles.length !== exitRestorePaths.length) {
            throw new Error(`organizer concurrent import lost records: ${queuedFiles.length}`)
          }
          const reorderedIds = [queuedFiles[2].id, queuedFiles[0].id, queuedFiles[1].id]
          await reorderOrganizerFiles(organizer.id, reorderedIds)
          const reorderedNames = workspaceState.widgets
            .find((widget) => widget.id === organizer.id)
            ?.data.files?.filter((file) => file.name.startsWith('exit-'))
            .map((file) => file.name)
          if (JSON.stringify(reorderedNames) !== JSON.stringify(['exit-c.txt', 'exit-a.txt', 'exit-b.txt'])) {
            throw new Error(`organizer reorder mismatch: ${JSON.stringify(reorderedNames)}`)
          }
          const multiRestoreResult = await restoreOrganizerFilesToOriginalLocations()
          const remainingExitFiles = workspaceState.widgets
            .find((widget) => widget.id === organizer.id)
            ?.data.files?.filter((file) => file.name.startsWith('exit-')) || []
          if (
            multiRestoreResult.restored !== exitRestorePaths.length
            || exitRestorePaths.some((filePath) => !fs.existsSync(filePath))
            || remainingExitFiles.length
          ) {
            throw new Error(`organizer multi-file exit restore mismatch: ${JSON.stringify(multiRestoreResult)}`)
          }
          console.log('[desktop-geometry] organizer ordering and queued multi-file exit restore assertions passed: 3/3')
          await fs.promises.rm(desktopHostFileTestRoot, { recursive: true, force: true })
          organizer = workspaceState.widgets.find((widget) => widget.kind === 'organizer')
          if (!organizer) throw new Error('organizer disappeared after file move test')
          const sampleFiles = await Promise.all([
            'package.json',
            'tsconfig.json',
            'vite.config.ts',
          ].map((name) => describePath(path.join(process.cwd(), name))))
          if (sampleFiles.some((file) => !file)) throw new Error('organizer sample files could not be described')
          const [sampleFile] = sampleFiles
          organizer.data.files = sampleFiles
          broadcastWorkspace()
          await new Promise((resolve) => setTimeout(resolve, 180))
          const organizerWindow = desktopWindows.get(leftmostDisplayId)
          const renderedFileName = await organizerWindow?.webContents.executeJavaScript(
            "document.querySelector('.organizer-file-open strong')?.textContent || ''",
          )
          if (renderedFileName !== path.parse(sampleFile.name).name) {
            throw new Error(`organizer file rendering mismatch: ${renderedFileName}`)
          }
          console.log(`[desktop-geometry] organizer file assertion passed: ${renderedFileName}`)
          const organizerAcrylicVisual = await organizerWindow?.webContents.executeJavaScript(`(() => {
            const organizer = document.querySelector('.widget-organizer')
            const header = organizer?.querySelector('.desktop-widget-header')
            const grid = organizer?.querySelector('.organizer-files')
            const tile = document.querySelector('.organizer-file')
            const tileRects = [...document.querySelectorAll('.organizer-file')].slice(0, 3).map((item) => {
              const rect = item.getBoundingClientRect()
              return { left: rect.left, right: rect.right, width: rect.width }
            })
            const organizerStyle = organizer ? getComputedStyle(organizer) : null
            const headerStyle = header ? getComputedStyle(header) : null
            const gridStyle = grid ? getComputedStyle(grid) : null
            const tileStyle = tile ? getComputedStyle(tile) : null
            return {
              radius: organizerStyle?.borderRadius || '',
              backgroundImage: organizerStyle?.backgroundImage || '',
              headerHeight: headerStyle?.height || '',
              gridColumnGap: gridStyle?.columnGap || '',
              gridRowGap: gridStyle?.rowGap || '',
              gridAlignContent: gridStyle?.alignContent || '',
              singleRow: grid?.classList.contains('is-single-row') || false,
              tileMinHeight: tileStyle?.minHeight || '',
              tileRects,
              tileBackground: tileStyle?.backgroundColor || '',
              suffixRows: document.querySelectorAll('.organizer-file-open small').length,
            }
          })()`)
          if (
            organizerAcrylicVisual?.radius !== '10px'
            || organizerAcrylicVisual?.backgroundImage === 'none'
            || organizerAcrylicVisual?.headerHeight !== '34px'
            || organizerAcrylicVisual?.gridColumnGap !== '4px'
            || organizerAcrylicVisual?.gridRowGap !== '4px'
            || organizerAcrylicVisual?.gridAlignContent !== 'center'
            || !organizerAcrylicVisual?.singleRow
            || organizerAcrylicVisual?.tileMinHeight !== '64px'
            || organizerAcrylicVisual?.tileRects?.length !== 3
            || organizerAcrylicVisual.tileRects.some((rect) => Math.abs(rect.width - 64) > 0.5)
            || Math.abs(organizerAcrylicVisual.tileRects[1].left - organizerAcrylicVisual.tileRects[0].right - 4) > 0.5
            || organizerAcrylicVisual?.tileBackground !== 'rgba(0, 0, 0, 0)'
            || organizerAcrylicVisual?.suffixRows !== 0
          ) {
            throw new Error(`organizer acrylic visual mismatch: ${JSON.stringify(organizerAcrylicVisual)}`)
          }
          console.log('[desktop-geometry] organizer acrylic assertions passed: 10px + compact 34px header + centered single row + fixed 64px/4px grid + transparent tiles + suffix hidden')

          await organizerWindow?.webContents.executeJavaScript(`window.desktopAPI.updateWidget(
            ${JSON.stringify(organizer.id)},
            { width: 88, height: ${originalOrganizerFrame.height} }
          )`)
          await new Promise((resolve) => setTimeout(resolve, 120))
          const organizerSingleColumnVisual = await organizerWindow?.webContents.executeJavaScript(`(() => {
            const grid = document.querySelector('.organizer-files')
            const tile = grid?.querySelector('.organizer-file')
            const gridRect = grid?.getBoundingClientRect()
            const tileRect = tile?.getBoundingClientRect()
            return {
              singleColumn: grid?.classList.contains('is-single-column') || false,
              justifyContent: grid ? getComputedStyle(grid).justifyContent : '',
              leftGap: gridRect && tileRect ? tileRect.left - gridRect.left : -1,
              rightGap: gridRect && tileRect ? gridRect.right - tileRect.right : -1,
            }
          })()`)
          if (
            !organizerSingleColumnVisual?.singleColumn
            || organizerSingleColumnVisual?.justifyContent !== 'center'
            || Math.abs(organizerSingleColumnVisual.leftGap - organizerSingleColumnVisual.rightGap) > 1
          ) {
            throw new Error(`organizer single-column balance mismatch: ${JSON.stringify(organizerSingleColumnVisual)}`)
          }
          await organizerWindow?.webContents.executeJavaScript(`window.desktopAPI.updateWidget(
            ${JSON.stringify(organizer.id)},
            ${JSON.stringify(originalOrganizerFrame)}
          )`)
          await new Promise((resolve) => setTimeout(resolve, 120))
          console.log('[desktop-geometry] organizer one-dimensional balance assertions passed: single row centered vertically + single column centered horizontally')
          const draggedUiOrder = await organizerWindow?.webContents.executeJavaScript(`(async () => {
            const tiles = () => [...document.querySelectorAll('.organizer-file')]
            const names = () => tiles().map((tile) => tile.querySelector('strong')?.textContent || '')
            const sourceButton = tiles()[0]?.querySelector('.organizer-file-open')
            const targetTile = tiles()[2]
            if (!sourceButton || !targetTile) return { error: 'missing drag fixtures', names: names() }
            const dataTransfer = new DataTransfer()
            sourceButton.dispatchEvent(new DragEvent('dragstart', {
              bubbles: true,
              cancelable: true,
              dataTransfer,
            }))
            await new Promise((resolve) => setTimeout(resolve, 60))
            const targetRect = targetTile.getBoundingClientRect()
            const eventInit = {
              bubbles: true,
              cancelable: true,
              dataTransfer,
              clientX: targetRect.right - 2,
              clientY: targetRect.top + targetRect.height / 2,
            }
            targetTile.dispatchEvent(new DragEvent('dragover', eventInit))
            targetTile.dispatchEvent(new DragEvent('drop', eventInit))
            await new Promise((resolve) => setTimeout(resolve, 120))
            const draggedButton = tiles()
              .find((tile) => tile.querySelector('strong')?.textContent === 'package')
              ?.querySelector('.organizer-file-open')
            const widgetRect = document.querySelector('.widget-organizer')?.getBoundingClientRect()
            draggedButton?.dispatchEvent(new DragEvent('dragend', {
              bubbles: true,
              cancelable: true,
              dataTransfer,
              clientX: (widgetRect?.left || 0) + 20,
              clientY: (widgetRect?.top || 0) + 80,
            }))
            await new Promise((resolve) => setTimeout(resolve, 120))
            return { names: names() }
          })()`)
          const persistedUiOrder = workspaceState.widgets
            .find((widget) => widget.id === organizer.id)
            ?.data.files?.map((file) => file.name)
          const expectedRenderedUiOrder = ['tsconfig', 'vite.config', 'package']
          const expectedPersistedUiOrder = ['tsconfig.json', 'vite.config.ts', 'package.json']
          if (
            JSON.stringify(draggedUiOrder?.names) !== JSON.stringify(expectedRenderedUiOrder)
            || JSON.stringify(persistedUiOrder) !== JSON.stringify(expectedPersistedUiOrder)
          ) {
            throw new Error(`organizer UI drag reorder mismatch: ${JSON.stringify({ draggedUiOrder, persistedUiOrder })}`)
          }
          console.log('[desktop-geometry] organizer UI drag reorder assertion passed: package.json moved to end')
          organizer = workspaceState.widgets.find((widget) => widget.id === organizer.id)
          if (!organizer) throw new Error('organizer disappeared after UI reorder test')
          organizer.x = (leftmostDisplay?.bounds.x || 0) + widgetEdgeGap
          broadcastWorkspace()
          await new Promise((resolve) => setTimeout(resolve, 120))
          const leftEdgeGeometry = await logDesktopGeometry('widget-left-edge')
          const leftWidget = leftEdgeGeometry
            .find((entry) => entry.displayId === leftmostDisplayId)
            ?.renderer.widgets.find((widget) => widget.title === organizer.title)
          if (!leftWidget || Math.abs(leftWidget.rect.x - 8) > 1) {
            throw new Error(`left edge widget mismatch: ${leftWidget?.rect.x}`)
          }
          const canvasBounds = currentDesktopInfo().virtualBounds
          const rightmostDisplayId = [...currentDesktopInfo().displays]
            .sort((a, b) => (b.bounds.x + b.bounds.width) - (a.bounds.x + a.bounds.width))[0]?.id
          organizer.x = canvasBounds.width - organizer.width - 8
          broadcastWorkspace()
          await new Promise((resolve) => setTimeout(resolve, 120))
          const rightEdgeGeometry = await logDesktopGeometry('widget-right-edge')
          const rightScreen = rightEdgeGeometry.find((entry) => entry.displayId === rightmostDisplayId)
          const rightWidget = rightScreen?.renderer.widgets.find((widget) => widget.title === organizer.title)
          const rightGap = rightWidget
            ? rightScreen.renderer.innerWidth - rightWidget.rect.x - rightWidget.rect.width
            : Number.NaN
          if (!Number.isFinite(rightGap) || Math.abs(rightGap - widgetEdgeGap) > 3) {
            throw new Error(`right edge widget mismatch: ${rightGap}`)
          }
          console.log('[desktop-geometry] widget edge assertions passed: left=8 right=8')
          if (!leftmostDisplay) throw new Error('left display was not found for taskbar boundary test')
          organizer.x = leftmostDisplay.bounds.x + 80
          organizer.y = leftmostDisplay.bounds.y - 40
          Object.assign(organizer, constrainWidgetFrame(organizer))
          broadcastWorkspace()
          await new Promise((resolve) => setTimeout(resolve, 120))
          const topEdgeGeometry = await logDesktopGeometry('widget-left-display-top-edge')
          const topWidget = topEdgeGeometry
            .find((entry) => entry.displayId === leftmostDisplay.id)
            ?.renderer.widgets.find((widget) => widget.title === organizer.title)
          if (!topWidget || Math.abs(topWidget.rect.y - widgetTopEdgeGap) > 1) {
            throw new Error(`left display top edge mismatch: ${topWidget?.rect.y}`)
          }
          console.log(`[desktop-geometry] display top edge assertion passed: top=${topWidget.rect.y}`)
          organizer.y = leftmostDisplay.bounds.y + leftmostDisplay.bounds.height - organizer.height + 40
          Object.assign(organizer, constrainWidgetFrame(organizer))
          broadcastWorkspace()
          await new Promise((resolve) => setTimeout(resolve, 120))
          const bottomEdgeGeometry = await logDesktopGeometry('widget-left-display-bottom-edge')
          const bottomWidget = bottomEdgeGeometry
            .find((entry) => entry.displayId === leftmostDisplay.id)
            ?.renderer.widgets.find((widget) => widget.title === organizer.title)
          const bottomGap = bottomWidget
            ? leftmostDisplay.bounds.height - bottomWidget.rect.y - bottomWidget.rect.height
            : Number.NaN
          if (!Number.isFinite(bottomGap) || Math.abs(bottomGap - widgetEdgeGap) > 1) {
            throw new Error(`left display taskbar boundary mismatch: ${bottomGap}`)
          }
          console.log(`[desktop-geometry] left display taskbar boundary assertion passed: bottom=${bottomGap}`)
          await organizerWindow?.webContents.executeJavaScript('window.desktopAPI.setDesktopInteractionLocked(true)')
          await new Promise((resolve) => setTimeout(resolve, 80))
          if (!organizerWindow?.desktopPointerInteractive) {
            throw new Error('always-on widget interaction did not become active')
          }
          await organizerWindow.webContents.executeJavaScript('window.desktopAPI.setDesktopInteractionLocked(false)')
          console.log('[desktop-host] always-on interaction assertion passed')
        } catch (error) {
          console.error(`[desktop-host] transition failed: ${error.message}`)
          process.exitCode = 1
        }
      }, 1800)
      }
      setTimeout(() => app.quit(), desktopDragTest
        ? 120_000
        : (desktopWidgetWindowTest ? 20_000 : (desktopHostRegressionTest ? 15_000 : 6500)))
    }
  } else {
    createDesktopWidgetWindows()
    createControlWindow()
  }

  app.on('activate', () => {
    if (!controlWindow && !capturePath) createControlWindow()
  })
})

app.on('before-quit', (event) => {
  if (squirrelStartup || !hasPrimaryInstance) return
  if (desktopPointerHitTestTimer) clearInterval(desktopPointerHitTestTimer)
  if (desktopOrganizerBandHealthTimer) clearInterval(desktopOrganizerBandHealthTimer)
  if (desktopWidgetGeometryHealthTimer) clearInterval(desktopWidgetGeometryHealthTimer)
  if (organizerStorageReconcileRetryTimer) clearTimeout(organizerStorageReconcileRetryTimer)
  if (capturePath || desktopHostTest || desktopTrayTest || iconTest || workspaceSnapshotTest || quitAfterRestore) {
    stopDesktopIconHelper()
    return
  }

  event.preventDefault()
  if (restoreOnQuitPromise) return
  for (const win of liveAppWindows()) win.hide()
  restoreOnQuitPromise = enqueueWorkspaceMutation(async () => {
    await createAutomaticSafetySnapshot('退出时自动快照')
    return restoreOrganizerFilesToOriginalLocations({
      preserveOrganizerMembership: true,
    })
  })
    .then((result) => {
      if (result.errors.length) console.warn(`[organizer] exit restore warnings: ${result.errors.join(' | ')}`)
      else disarmRestoreGuardian()
    })
    .catch((error) => {
      console.error(`[organizer] exit restore failed: ${error.message}`)
    })
    .finally(() => {
      quitAfterRestore = true
      stopDesktopIconHelper()
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
})
