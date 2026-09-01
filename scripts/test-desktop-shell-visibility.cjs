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
assert.equal(mainSource.includes('desktop-shell-restart'), false)
assert.equal(guardianSource.includes('desktop-shell-restart'), false)
assert.equal(helperSource.includes('RestartDesktopShell'), false)
assert.match(helperSource, /SetWinEventHook/)
assert.match(helperSource, /guard-items/)
assert.match(mainSource, /configureDesktopShellItemGuard/)
assert.match(mainSource, /if \(ipcHandlersRegistered && !desktopTopologyTransitionRevision\) syncDesktopWidgetWindows\(\)/)
assert.match(mainSource, /confirmedTopologyChange\) await rebuildDesktopWidgetWindowsForTopology\(revision\)/)
assert.match(mainSource, /const oldWindows = liveDesktopWidgetWindows\(\)/)
assert.match(mainSource, /if \(desktopTopologyTransitionRevision\) return\s+if \(process\.platform !== 'darwin'\) app\.quit\(\)/)
assert.match(mainSource, /ipcHandlersRegistered = true/)

console.log('[desktop-shell-visibility] state migration + event guard + startup sequencing + no Explorer restart assertions passed')
