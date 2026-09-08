const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  getState: () => ipcRenderer.invoke('pet:state'),
  listModels: () => ipcRenderer.invoke('pet:models'),
  setModel: (model) => ipcRenderer.invoke('pet:model', model),
  setReminderSound: enabled => ipcRenderer.invoke('pet:reminder-sound', enabled),
  send: (text) => ipcRenderer.invoke('pet:send', text),
  reset: () => ipcRenderer.invoke('pet:reset'),
  forgetMemories: ids => ipcRenderer.invoke('pet:memory-forget', ids),
  beginVoice: () => ipcRenderer.invoke('pet:voice-begin'),
  voiceRecording: id => ipcRenderer.invoke('pet:voice-recording', id),
  transcribeVoice: (id, samples) => ipcRenderer.invoke('pet:voice-transcribe', id, samples),
  cancelVoice: () => ipcRenderer.invoke('pet:voice-cancel'),
  voiceLevel: (id, level) => ipcRenderer.send('pet:voice-level', id, level),
  voiceError: message => ipcRenderer.send('pet:voice-error', message),
  toggleVoice: () => ipcRenderer.send('pet:voice-toggle'),
  dismissVoice: () => ipcRenderer.send('pet:voice-dismiss'),
  setMeowing: playing => ipcRenderer.send('pet:meowing', playing),
  searchWeatherCities: query => ipcRenderer.invoke('pet:weather-cities', query),
  saveReminderSettings: input => ipcRenderer.invoke('pet:reminder-settings', input),
  previewWeather: () => ipcRenderer.invoke('pet:weather-preview'),
  getFocusWidget: () => ipcRenderer.invoke('pet:focus-widget'),
  getPreviewTodo: () => ipcRenderer.invoke('pet:preview-todo'),
  updatePreviewTodo: data => ipcRenderer.invoke('pet:preview-todo-update', data),
  updateFocusWidget: (data) => ipcRenderer.invoke('pet:focus-widget-update', data),
  stop: () => ipcRenderer.send('pet:stop'),
  openChat: () => ipcRenderer.send('pet:open-chat'),
  closeChat: () => ipcRenderer.send('pet:close-chat'),
  drag: (phase, delta) => ipcRenderer.send('pet:drag', phase, delta),
  menu: () => ipcRenderer.send('pet:menu'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('pet:changed', listener)
    return () => ipcRenderer.removeListener('pet:changed', listener)
  },
  onChatOpened: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('pet:chat-opened', listener)
    return () => ipcRenderer.removeListener('pet:chat-opened', listener)
  },
})
