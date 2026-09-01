const assert = require('node:assert/strict')
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

console.log('[desktop-shell-visibility] dual registry state + legacy migration assertions passed')
