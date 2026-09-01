const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  desktopShellVisibilityEquals,
  hiddenDesktopShellVisibility,
  normalizeDesktopShellVisibility,
  storedDesktopShellVisibility,
} = require('../electron/desktop-shell-visibility-core.cjs')

assert.deepEqual(hiddenDesktopShellVisibility(), {
  newStartPanel: { exists: true, value: 1 },
  classicStartMenu: { exists: true, value: 1 },
})
assert.deepEqual(normalizeDesktopShellVisibility({
  locations: {
    newStartPanel: { exists: true, value: 0 },
    classicStartMenu: { exists: true, value: 1 },
  },
}), {
  newStartPanel: { exists: true, value: 0 },
  classicStartMenu: { exists: true, value: 1 },
})
assert.deepEqual(storedDesktopShellVisibility({
  shellVisibilityValueExists: true,
  shellVisibilityValue: 0,
}), {
  newStartPanel: { exists: true, value: 0 },
  classicStartMenu: { exists: false, value: 0 },
})
assert.equal(desktopShellVisibilityEquals(
  hiddenDesktopShellVisibility(),
  hiddenDesktopShellVisibility(),
), true)
assert.equal(desktopShellVisibilityEquals(
  hiddenDesktopShellVisibility(),
  { newStartPanel: { exists: true, value: 1 }, classicStartMenu: { exists: false, value: 0 } },
), false)

const electronRoot = path.join(__dirname, '..', 'electron')
const mainSource = fs.readFileSync(path.join(electronRoot, 'main.cjs'), 'utf8')
const guardianSource = fs.readFileSync(path.join(electronRoot, 'restore-guardian.cjs'), 'utf8')
const helperSource = fs.readFileSync(path.join(electronRoot, 'windows-desktop-icons.ps1'), 'utf8')
const organizerWidgetSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'desktop-widgets', 'OrganizerWidget.tsx'),
  'utf8',
)
assert.equal(mainSource.includes('desktop-shell-restart'), false)
assert.equal(guardianSource.includes('desktop-shell-restart'), false)
assert.equal(helperSource.includes('RestartDesktopShell'), false)
assert.match(helperSource, /SetWinEventHook/)
assert.match(helperSource, /guard-items/)
assert.match(helperSource, /private const uint WM_SETREDRAW = 0x000B/)
const hideItemsStart = helperSource.indexOf('public static DesktopIconInfo[] HideItems(string[] names)')
const hideItemsEnd = helperSource.indexOf('public static bool HasDesktopView()', hideItemsStart)
const hideItemsSource = helperSource.slice(hideItemsStart, hideItemsEnd)
const suspendRedrawIndex = hideItemsSource.indexOf('SendDesktopMessage(listView, WM_SETREDRAW, IntPtr.Zero, IntPtr.Zero)')
const deleteItemIndex = hideItemsSource.indexOf('SendDesktopMessage(listView, LVM_DELETEITEM')
const resumeRedrawIndex = hideItemsSource.indexOf('SendDesktopMessage(listView, WM_SETREDRAW, new IntPtr(1), IntPtr.Zero)')
const singleRedrawIndex = hideItemsSource.indexOf('RedrawWindow(listView')
assert.ok(suspendRedrawIndex >= 0 && suspendRedrawIndex < deleteItemIndex)
assert.ok(resumeRedrawIndex > deleteItemIndex && singleRedrawIndex > resumeRedrawIndex)
assert.match(mainSource, /configureDesktopShellItemGuard/)
assert.match(mainSource, /if \(ipcHandlersRegistered && !desktopTopologyTransitionRevision\) syncDesktopWidgetWindows\(\)/)
assert.match(mainSource, /confirmedTopologyChange\) await rebuildDesktopWidgetWindowsForTopology\(revision\)/)
assert.match(mainSource, /const oldWindows = liveDesktopWidgetWindows\(\)/)
assert.match(mainSource, /if \(desktopTopologyTransitionRevision\) return\s+if \(process\.platform !== 'darwin'\) app\.quit\(\)/)
assert.match(mainSource, /createDesktopWidgetWindows\(\)\s+createControlWindow\(\)\s+scheduleOrganizerStorageReconcileRetry\(\)/)
assert.match(mainSource, /scheduleOrganizerStorageReconcileRetry = \(attempt = 0, surfacePoll = 0\)/)
assert.match(mainSource, /const surfacePollInterval = 100/)
assert.match(mainSource, /scheduleOrganizerStorageReconcileRetry\(attempt, surfacePoll \+ 1\)/)
assert.match(mainSource, /surfacePoll > 0 \? surfacePollInterval : delays\[attempt\]/)
assert.equal(mainSource.includes('startupRevealDeferred'), false)
assert.equal(mainSource.includes('if (!win.isVisible()) win.showInactive()'), false)
assert.match(mainSource, /persistOrganizerReconcileFileProgress/)
assert.match(mainSource, /if \(widgetProgressChanged\) broadcastWorkspace\(\)/)
assert.match(mainSource, /desktopIconPositionSnapshot\(\{ refresh: false \}\)/)
assert.match(mainSource, /const organizerStartupDesktopHidePlan = \(state\) =>/)
assert.match(mainSource, /configureDesktopShellItemGuard\(\[\.\.\.persistentGuardNames, \.\.\.plan\.desktopFileNames\]\)/)
assert.match(mainSource, /const hasUncollectedDesktopFile = activePlan\.desktopFilePaths\.some/)
assert.match(mainSource, /primary workspace unavailable; recovered latest safety snapshot/)
assert.match(mainSource, /ipcHandlersRegistered = true/)
const reconcileStart = mainSource.indexOf('const reconcileOrganizerStorage = async () => {')
const reconcileEnd = mainSource.indexOf('const hasPendingOrganizerStorageReconcile = () =>', reconcileStart)
const reconcileSource = mainSource.slice(reconcileStart, reconcileEnd)
const batchHideIndex = reconcileSource.indexOf('await beginOrganizerStartupDesktopHide(')
const physicalMoveIndex = reconcileSource.indexOf('await movePathWithTransientRetry(')
const batchNotifyIndex = reconcileSource.indexOf('await notifyShellMoves(shellMoves, { flush: true })')
const temporaryGuardCleanupIndex = reconcileSource.indexOf('await finishOrganizerStartupDesktopHide(startupDesktopHide)')
assert.ok(batchHideIndex >= 0 && batchHideIndex < physicalMoveIndex)
assert.ok(batchNotifyIndex > physicalMoveIndex && temporaryGuardCleanupIndex > batchNotifyIndex)
const attachStart = mainSource.indexOf('const attachDesktopWindow = async (win) => {')
const attachEnd = mainSource.indexOf('const attachDesktopWindows = async () => {', attachStart)
const attachSource = mainSource.slice(attachStart, attachEnd)
const organizerAttachedIndex = attachSource.indexOf("win.desktopOrganizerChildAttached = hostResult.includes('placement=desktop-child')")
const earlyRevealIndex = attachSource.indexOf('await revealDesktopWidgetFirstFrame(win)', organizerAttachedIndex)
const stabilizationIndex = attachSource.indexOf('await stabilizeAttachedDesktopOrganizerGeometry(win, widget)', organizerAttachedIndex)
assert.ok(organizerAttachedIndex >= 0 && earlyRevealIndex > organizerAttachedIndex)
assert.ok(stabilizationIndex > earlyRevealIndex)
assert.match(organizerWidgetSource, /pendingStartupFileCount > 0[\s\S]*?正在整理桌面文件/)

console.log('[desktop-shell-visibility] atomic no-redraw batch hide + temporary guard + progressive population assertions passed')
