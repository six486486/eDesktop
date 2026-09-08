// Only used by capture-readme.cjs. No real workspace, filesystem or microphone access.
const { contextBridge, ipcRenderer } = require('electron')
const read = key => ipcRenderer.invoke('readme:read', key)
const noop = () => {}
const subscribe = () => noop
contextBridge.exposeInMainWorld('desktopAPI', {
  getWorkspace: () => read('workspace'),
  getDesktopStatus: () => Promise.resolve({ hostState: 'attached', message: '桌面组件运行正常' }),
  getDesktopInfo: () => read('desktop'),
  getFileIcon: () => Promise.resolve(''),
  getCursorPosition: () => ({ x: 0, y: 0 }),
  listWorkspaceSnapshots: () => read('snapshots'),
  onWorkspaceChanged: subscribe, onDesktopStatusChanged: subscribe,
  onDesktopInfoChanged: subscribe, onCloseRequested: subscribe,
  onOrganizerFileSelectionCleared: subscribe,
  setDesktopInteractionLocked: noop, clearOrganizerFileSelection: noop,
  selectOrganizerFile: noop, minimize: noop, toggleMaximize: noop, close: noop,
})
contextBridge.exposeInMainWorld('petAPI', {
  getState: () => read('pet'), listModels: () => Promise.resolve(['qwen3:4b-instruct']),
  onState: subscribe, onChatOpened: subscribe,
  setModel: noop, cancelVoice: noop, voiceError: noop, setMeowing: noop,
  openChat: noop, closeChat: noop, drag: noop, menu: noop,
})
