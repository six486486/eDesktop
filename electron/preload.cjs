const { contextBridge, ipcRenderer, webUtils } = require('electron')

const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Desktop widgets live in independent native windows. Forward every press to
// the main process so a selection in one organizer can be cleared by a click in
// another widget or in the control center.
window.addEventListener('pointerdown', () => {
  ipcRenderer.send('app:pointer-down')
}, true)

contextBridge.exposeInMainWorld('desktopAPI', {
  getDesktopInfo: () => ipcRenderer.invoke('desktop:info'),
  getCursorPosition: () => ipcRenderer.sendSync('desktop:cursor-position'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getFileIcon: (filePath) => ipcRenderer.invoke('files:icon', filePath),
  prepareOrganizerImport: () => ipcRenderer.invoke('organizer:prepare-import'),
  importOrganizerFiles: (widgetId, filePaths) => ipcRenderer.invoke('organizer:import-files', widgetId, filePaths),
  moveOrganizerFile: (sourceWidgetId, targetWidgetId, filePath, targetFileId, edge) => (
    ipcRenderer.invoke('organizer:move-file', sourceWidgetId, targetWidgetId, filePath, targetFileId, edge)
  ),
  claimOrganizerFileDrop: (dragToken) => ipcRenderer.sendSync('organizer:claim-file-drop', dragToken),
  completeOrganizerFileDrop: (dragToken) => ipcRenderer.sendSync('organizer:complete-file-drop', dragToken),
  reorderOrganizerFiles: (widgetId, orderedFileIds) => ipcRenderer.invoke('organizer:reorder-files', widgetId, orderedFileIds),
  releaseOrganizerFile: (widgetId, filePath) => ipcRenderer.invoke('organizer:release-file', widgetId, filePath),
  releaseOrganizerFileToDesktop: (widgetId, filePath) => ipcRenderer.invoke('organizer:release-file-to-desktop', widgetId, filePath),
  showOrganizerFileMenu: (widgetId, filePath) => ipcRenderer.invoke('organizer:show-file-menu', widgetId, filePath),
  selectOrganizerFile: (widgetId, filePath) => ipcRenderer.send('organizer:select-file', widgetId, filePath),
  clearOrganizerFileSelection: (widgetId) => ipcRenderer.send('organizer:clear-file-selection', widgetId),
  onOrganizerFileSelectionCleared: (callback) => subscribe('organizer:file-selection-cleared', callback),
  openFile: (filePath) => ipcRenderer.invoke('files:open', filePath),
  revealFile: (filePath) => ipcRenderer.invoke('files:reveal', filePath),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  addWidget: (kind) => ipcRenderer.invoke('workspace:add-widget', kind),
  updateWidget: (id, patch) => ipcRenderer.invoke('workspace:update-widget', id, patch),
  previewWidgetFrame: (id, patch) => ipcRenderer.send('workspace:preview-widget-frame', id, patch),
  removeWidget: (id) => ipcRenderer.invoke('workspace:remove-widget', id),
  setDesktopEnabled: (enabled) => ipcRenderer.invoke('workspace:set-desktop-enabled', enabled),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('workspace:set-launch-at-login', enabled),
  listWorkspaceSnapshots: () => ipcRenderer.invoke('snapshots:list'),
  createWorkspaceSnapshot: () => ipcRenderer.invoke('snapshots:create'),
  restoreWorkspaceSnapshot: (snapshotId) => ipcRenderer.invoke('snapshots:restore', snapshotId),
  deleteWorkspaceSnapshot: (snapshotId) => ipcRenderer.invoke('snapshots:delete', snapshotId),
  exportWorkspaceSnapshot: (snapshotId) => ipcRenderer.invoke('snapshots:export', snapshotId),
  importWorkspaceSnapshot: () => ipcRenderer.invoke('snapshots:import'),
  setWorkspaceSnapshotSettings: (settings) => ipcRenderer.invoke('snapshots:set-settings', settings),
  getDesktopStatus: () => ipcRenderer.invoke('desktop:status'),
  setDesktopInteractionLocked: (locked) => ipcRenderer.send('desktop:set-interaction-locked', locked),
  showControlCenter: () => ipcRenderer.send('window:show-control'),
  onDesktopInfoChanged: (callback) => subscribe('desktop:info-changed', callback),
  onWorkspaceChanged: (callback) => subscribe('workspace:changed', callback),
  onDesktopStatusChanged: (callback) => subscribe('desktop:status-changed', callback),
  onCloseRequested: (callback) => subscribe('window:close-requested', callback),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  respondToCloseRequest: (action) => ipcRenderer.send('window:close-response', action),
})
