const assert = require('node:assert/strict')
const {
  buildDisplayMapping,
  remapWorkspaceLayout,
  validateSnapshotDocument,
} = require('../electron/workspace-snapshot-core.cjs')

const sourceDisplays = [
  { id: 'left-old', label: 'DISPLAY-B', primary: false, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1280, height: 1024 } },
  { id: 'main-old', label: 'DISPLAY-A', primary: true, scaleFactor: 1.25, bounds: { x: 1280, y: 0, width: 1920, height: 1040 } },
]
const targetDisplays = [
  { id: 'main-new', label: 'DISPLAY-A', primary: true, scaleFactor: 1.5, bounds: { x: 0, y: 0, width: 2560, height: 1400 } },
  { id: 'right-new', label: 'DISPLAY-B', primary: false, scaleFactor: 1, bounds: { x: 2560, y: 120, width: 1920, height: 1080 } },
]
const workspace = {
  version: 1,
  settings: { desktopEnabled: true, launchAtLogin: false, snapshotAutoEnabled: true, snapshotRetention: 30 },
  widgets: [
    { id: 'left-widget', kind: 'organizer', x: 40, y: 60, width: 360, height: 260, data: { files: [] } },
    { id: 'main-widget', kind: 'todo', x: 2700, y: 700, width: 320, height: 300, data: { items: [] } },
  ],
}

const mapping = buildDisplayMapping(sourceDisplays, targetDisplays)
assert.equal(mapping.mapping.get('left-old').id, 'right-new', 'display labels should survive topology changes')
assert.equal(mapping.mapping.get('main-old').id, 'main-new', 'primary display label should map to the new primary')

const remapped = remapWorkspaceLayout(workspace, sourceDisplays, targetDisplays)
const leftWidget = remapped.workspace.widgets.find((widget) => widget.id === 'left-widget')
const mainWidget = remapped.workspace.widgets.find((widget) => widget.id === 'main-widget')
assert.ok(leftWidget.x >= 2568 && leftWidget.x + leftWidget.width <= 4472, 'left display widget should move onto matching right display')
assert.ok(mainWidget.x >= 8 && mainWidget.x + mainWidget.width <= 2552, 'primary widget should remain inside the new primary display')
assert.equal(remapped.remappedWidgets, 2)

const singleDisplay = [{ id: 'only', label: 'DISPLAY-A', primary: true, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1366, height: 728 } }]
const collapsed = remapWorkspaceLayout(workspace, sourceDisplays, singleDisplay)
for (const widget of collapsed.workspace.widgets) {
  assert.ok(widget.x >= 8 && widget.y >= 0, 'collapsed topology should keep widgets on screen')
  assert.ok(widget.x + widget.width <= 1358 && widget.y + widget.height <= 720, 'collapsed topology should constrain widget edges')
}

assert.throws(() => validateSnapshotDocument({ schemaVersion: 1, fileDataIncluded: true }), /纯配置快照/)
validateSnapshotDocument({
  schemaVersion: 1,
  fileDataIncluded: false,
  workspace,
  desktop: { displays: sourceDisplays },
})

console.log('[snapshots] multi-display label mapping + missing-display fallback + config-only validation passed')
