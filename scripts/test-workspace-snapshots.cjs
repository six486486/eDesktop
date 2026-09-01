const assert = require('node:assert/strict')
const {
  buildDisplayMapping,
  captureWorkspaceLayoutProfile,
  remapWorkspaceLayout,
  restoreWorkspaceLayoutProfile,
  validateSnapshotDocument,
  workspaceLayoutSignature,
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

const swappedMapping = buildDisplayMapping(
  [
    { id: 'laptop', label: 'Laptop', primary: true, bounds: { x: 0, y: 0, width: 1463, height: 867 } },
    { id: 'external', label: 'External', primary: false, bounds: { x: 1463, y: 0, width: 2048, height: 1104 } },
  ],
  [
    { id: 'laptop', label: 'Laptop', primary: false, bounds: { x: 0, y: 0, width: 1463, height: 867 } },
    { id: 'external', label: 'External', primary: true, bounds: { x: 1463, y: 0, width: 2048, height: 1104 } },
  ],
)
assert.equal(swappedMapping.mapping.get('laptop').id, 'external', 'the former primary layout should follow the new primary display')
assert.equal(swappedMapping.mapping.get('external').id, 'laptop', 'the remaining display should keep a one-to-one mapping')

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

const unchanged = remapWorkspaceLayout(workspace, sourceDisplays, sourceDisplays)
assert.deepEqual(
  unchanged.workspace.widgets.map(({ x, y, width, height }) => ({ x, y, width, height })),
  workspace.widgets.map(({ x, y, width, height }) => ({ x, y, width, height })),
  'an unchanged topology must not nudge an already arranged workspace',
)

assert.equal(
  workspaceLayoutSignature(sourceDisplays),
  workspaceLayoutSignature(sourceDisplays.map((display, index) => ({
    ...display,
    id: `new-session-id-${index}`,
  }))),
  'Windows display id churn after a reboot must not invalidate a saved topology profile',
)

const denseDisplay = { id: 'wide', label: 'Wide', primary: true, scaleFactor: 1.25, bounds: { x: 1463, y: 0, width: 2048, height: 1104 } }
const compactDisplay = { id: 'compact', label: 'Compact', primary: true, scaleFactor: 1.75, bounds: { x: 0, y: 0, width: 1463, height: 867 } }
const denseWorkspace = {
  version: 1,
  settings: workspace.settings,
  widgets: [
    { id: 'box-top', kind: 'organizer', x: 1471, y: 0, width: 699, height: 122 },
    { id: 'box-row-two', kind: 'organizer', x: 1471, y: 122, width: 699, height: 122 },
    { id: 'box-row-three', kind: 'organizer', x: 1471, y: 244, width: 160, height: 193 },
    { id: 'box-bottom', kind: 'organizer', x: 1471, y: 439, width: 224, height: 189 },
    { id: 'note-top', kind: 'note', x: 2796, y: 0, width: 265, height: 190 },
    { id: 'note-mid', kind: 'note', x: 2876, y: 215, width: 323, height: 190 },
    { id: 'todo-bottom', kind: 'todo', x: 2686, y: 424, width: 561, height: 378 },
    { id: 'timer-top', kind: 'pomodoro', x: 3223, y: 0, width: 240, height: 226 },
  ],
}
const denseCollapsed = remapWorkspaceLayout(denseWorkspace, [denseDisplay], [compactDisplay]).workspace
const denseById = new Map(denseCollapsed.widgets.map((widget) => [widget.id, widget]))
assert.equal(denseById.get('box-row-two').y - denseById.get('box-top').y, 122)
assert.equal(denseById.get('box-row-three').y - denseById.get('box-top').y, 244)
assert.equal(denseById.get('box-bottom').y - denseById.get('box-top').y, 439)
assert.equal(denseById.get('todo-bottom').y - denseById.get('note-top').y, 424)
assert.deepEqual(
  denseCollapsed.widgets.map(({ width, height }) => ({ width, height })),
  denseWorkspace.widgets.map(({ width, height }) => ({ width, height })),
  'a layout group that fits on the remaining display should retain every component size',
)
for (const widget of denseCollapsed.widgets) {
  assert.ok(widget.x >= 8 && widget.y >= 0)
  assert.ok(widget.x + widget.width <= 1455 && widget.y + widget.height <= 859)
}

const originalLayout = { virtualBounds: { x: -1463, y: 0, width: 3511, height: 1104 }, displays: [compactDisplay, denseDisplay] }
const profile = captureWorkspaceLayoutProfile(denseWorkspace, originalLayout)
assert.equal(profile.signature, workspaceLayoutSignature(originalLayout))
const restoredProfile = restoreWorkspaceLayoutProfile(denseCollapsed, profile)
assert.equal(restoredProfile.restoredWidgets, denseWorkspace.widgets.length)
assert.deepEqual(
  restoredProfile.workspace.widgets.map(({ x, y, width, height }) => ({ x, y, width, height })),
  denseWorkspace.widgets.map(({ x, y, width, height }) => ({ x, y, width, height })),
  'reconnecting a known topology should restore its exact saved arrangement',
)

const mergingWorkspace = {
  version: 1,
  settings: workspace.settings,
  widgets: [
    { id: 'resident', kind: 'note', x: 100, y: 100, width: 300, height: 200 },
    { id: 'incoming', kind: 'note', x: 1100, y: 100, width: 300, height: 200 },
  ],
}
const mergingSources = [
  { id: 'remaining', primary: false, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
  { id: 'removed', primary: true, bounds: { x: 1000, y: 0, width: 1000, height: 800 } },
]
const mergingTarget = [{ id: 'remaining', primary: true, bounds: { x: 0, y: 0, width: 1000, height: 800 } }]
const merged = remapWorkspaceLayout(mergingWorkspace, mergingSources, mergingTarget).workspace.widgets
const mergedResident = merged.find((widget) => widget.id === 'resident')
const mergedIncoming = merged.find((widget) => widget.id === 'incoming')
const mergedOverlapWidth = Math.min(mergedResident.x + mergedResident.width, mergedIncoming.x + mergedIncoming.width)
  - Math.max(mergedResident.x, mergedIncoming.x)
const mergedOverlapHeight = Math.min(mergedResident.y + mergedResident.height, mergedIncoming.y + mergedIncoming.height)
  - Math.max(mergedResident.y, mergedIncoming.y)
assert.ok(mergedOverlapWidth <= 0 || mergedOverlapHeight <= 0, 'layouts from two displays must not be stacked onto each other when one display remains')

assert.throws(() => validateSnapshotDocument({ schemaVersion: 1, fileDataIncluded: true }), /纯配置快照/)
validateSnapshotDocument({
  schemaVersion: 1,
  fileDataIncluded: false,
  workspace,
  desktop: { displays: sourceDisplays },
})

console.log('[snapshots] rigid topology remap + layout profile restore + config-only validation passed')
