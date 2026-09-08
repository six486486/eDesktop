const { app, BrowserWindow, ipcMain, Menu, screen, shell, globalShortcut, utilityProcess, session } = require('electron')
const path = require('node:path')
const { PetHarness } = require('./harness.cjs')
const { FocusService } = require('./focus-service.cjs')
const { ReminderService } = require('./reminder-service.cjs')
const { randomUUID } = require('node:crypto')
const { VoiceService, SHORTCUT } = require('./voice-service.cjs')

function createDesktopPet({ dataDirectory = path.join(app.getPath('userData'), 'desktop-pet'), initialVisible = null,
  onVisibilityChanged = () => {}, onRequestDisable = null, focusHost = null, voiceModel = undefined } = {}) {
  let petWindow = null
  let chatWindow = null
  let noticeWindow = null
  let voiceWindow = null, voiceBubble = null, voiceBubbleTimer = null, meowing = false, escapeRegistered = false
  let noticeTimer = null
  let shownNotice = null
  let previewWindow = null
  let dragStart = null
  let disposed = false
  let voice, shortcutRegistered = false
  const chatSession = session.fromPartition('pet-chat')
  const withVoice = state => ({ ...state, voice: voice?.snapshot(), voiceBubble, meowing })
  const noticeSize = { width: 310, height: 216 }
  const focus = focusHost ? new FocusService({ host: focusHost,
    onChange: state => harness.updateFocus(state), onComplete: event => harness.notifyFocus(event),
  }) : null
  const reminders = focusHost ? new ReminderService({ host: focusHost, directory: dataDirectory,
    onChange: () => harness.emit(), onNotice: event => harness.notifyReminder(event) }) : null
  const harness = new PetHarness({ directory: dataDirectory, focusTools: focus, reminderTools: reminders, onChange: (state) => {
    if (voiceBubble?.runId && harness.activeRun?.id === voiceBubble.runId) voiceBubble.text = state.reply
    for (const win of [petWindow, chatWindow, noticeWindow, previewWindow, voiceWindow]) if (win && !win.isDestroyed()) win.webContents.send('pet:changed', withVoice(state))
    if (state.focusNotice && state.focusNotice.id !== shownNotice) showNotice(state.focusNotice)
    if (focusHost?.preview && focusHost.read().widgets.length) showFocusPreview()
  } })
  voice = new VoiceService({ directory: voiceModel?.directory || path.join(dataDirectory, 'speech', 'sensevoice'), model: voiceModel,
    fork: (...args) => utilityProcess.fork(...args), onChange: () => {
      if (voice.state.surface === 'pet') {
        if (voice.state.phase !== 'idle') setVoiceBubble({ id: voice.job?.id || String(voice.state.trigger), phase: voice.state.phase })
        else if (voice.state.error) setVoiceBubble({ id: randomUUID(), phase: 'error', text: voice.state.error })
        else if (voiceBubble && !['thinking', 'reply', 'error'].includes(voiceBubble.phase)) setVoiceBubble(null)
      }
      syncEscape(); harness.emit()
    } })
  const microphoneAllowed = contents => {
    const owner = voice.state.surface === 'pet' ? petWindow : chatWindow
    return !disposed && harness.enabled && contents === owner?.webContents && owner.isVisible()
      && ['requesting', 'recording'].includes(voice.state.phase)
  }
  chatSession.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'media' && details.mediaType === 'audio' && microphoneAllowed(contents))
  chatSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === 'media'
    && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio' && microphoneAllowed(contents)))
  if (typeof initialVisible === 'boolean') harness.enabled = initialVisible
  const handlers = []
  const listeners = []
  const trusted = (event) => [petWindow, chatWindow, noticeWindow, previewWindow, voiceWindow].some((win) => win && !win.isDestroyed()
    && win.webContents === event.sender && event.senderFrame === win.webContents.mainFrame)
  const handle = (name, fn) => {
    ipcMain.handle(name, (event, ...args) => {
      if (disposed) return
      if (!trusted(event)) throw new Error('无效的桌宠窗口。')
      return fn(...args)
    })
    handlers.push(name)
  }
  const listen = (name, fn) => {
    const listener = (event, ...args) => { if (trusted(event)) fn(...args) }
    ipcMain.on(name, listener)
    listeners.push([name, listener])
  }
  const constrain = (bounds) => {
    const area = screen.getDisplayMatching(bounds).workArea
    return { ...bounds, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width))),
      y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height))) }
  }
  const load = (win, surface) => {
    if (process.env.VITE_DEV_SERVER_URL) {
      const url = new URL('desktop-pet/index.html', `${process.env.VITE_DEV_SERVER_URL}/`)
      url.searchParams.set('surface', surface)
      void win.loadURL(url.toString())
    } else void win.loadFile(path.join(__dirname, '..', 'dist', 'desktop-pet', 'index.html'), { query: { surface } })
    win.webContents.setWindowOpenHandler(({ url }) => { if (url === 'https://open-meteo.com/') void shell.openExternal(url); return { action: 'deny' } })
    win.webContents.on('will-navigate', (event) => event.preventDefault())
  }
  const webPreferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  const positionChat = () => {
    if (!chatWindow || chatWindow.isDestroyed() || !petWindow || petWindow.isDestroyed()) return
    const pet = petWindow.getBounds()
    const area = screen.getDisplayMatching(pet).workArea
    const width = Math.min(370, area.width)
    const height = Math.min(490, area.height)
    chatWindow.setBounds(constrain({ x: pet.x + pet.width - width, y: pet.y - height + 12, width, height }))
  }
  const hideChat = () => { if (voice.state.surface === 'chat') voice.cancel(); chatWindow?.hide() }
  const resetChat = () => {
    dismissVoice()
    try { harness.resetConversation(); return harness.snapshot() } catch {
      harness.error = '聊天未能重新开始，原对话已保留。请检查桌宠数据目录。'
      harness.emit()
      throw new Error(harness.error)
    }
  }
  const showFocusPreview = () => {
    if (previewWindow || disposed) return
    const pet = petWindow?.getBounds() || { x: 500, y: 500 }
    previewWindow = new BrowserWindow({ ...constrain({ x: pet.x - 680, y: pet.y - 450, width: 360, height: 430 }),
      title: '待办与番茄钟 · 桌宠独立预览', frame: true, resizable: false, show: false, webPreferences })
    previewWindow.once('ready-to-show', () => previewWindow?.showInactive())
    previewWindow.on('close', event => { if (!disposed) { event.preventDefault(); previewWindow.hide() } })
    load(previewWindow, 'focus-preview')
  }
  const positionNotice = () => {
    if (!noticeWindow || noticeWindow.isDestroyed() || !petWindow || petWindow.isDestroyed()) return
    const pet = petWindow.getBounds()
    noticeWindow.setBounds(constrain({ x: pet.x + pet.width - noticeSize.width, y: pet.y - noticeSize.height, ...noticeSize }))
  }
  const positionVoice = () => {
    if (!voiceWindow || voiceWindow.isDestroyed() || !petWindow || petWindow.isDestroyed()) return
    const pet = petWindow.getBounds(), width = 320, height = 270
    const area = screen.getDisplayMatching(pet).workArea
    const below = pet.y - height < area.y
    voiceWindow.setBounds(constrain({ x: pet.x + pet.width - width, y: below ? pet.y + pet.height - 6 : pet.y - height + 5, width, height }))
  }
  const setVoiceBubble = bubble => {
    clearTimeout(voiceBubbleTimer)
    voiceBubble = bubble
    if (disposed) return
    if (!bubble || !harness.enabled) {
      voiceWindow?.hide()
      if (harness.enabled && harness.focusNotice?.expiresAt > Date.now()) { positionNotice(); noticeWindow?.showInactive() }
      return
    }
    noticeWindow?.hide()
    if (!voiceWindow || voiceWindow.isDestroyed()) {
      voiceWindow = new BrowserWindow({ width: 320, height: 270, frame: false, transparent: true, resizable: false,
        show: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, webPreferences })
      voiceWindow.once('ready-to-show', () => { if (voiceBubble && harness.enabled && !disposed) { positionVoice(); voiceWindow.showInactive() } })
      load(voiceWindow, 'voice')
    } else { positionVoice(); voiceWindow.showInactive() }
    if (['reply', 'error'].includes(bubble.phase)) {
      voiceBubbleTimer = setTimeout(() => { setVoiceBubble(null); harness.emit() }, Math.max(16000, Math.min(45000, (bubble.text?.length || 0) * 180)))
    }
  }
  const dismissVoice = () => {
    const runId = voiceBubble?.runId
    setVoiceBubble(null); voice.cancel()
    if (runId && harness.activeRun?.id === runId) harness.stop('voice-dismiss')
    harness.emit()
  }
  const syncEscape = () => {
    const needed = !disposed && voice.state.surface === 'pet' && (voice.state.phase !== 'idle' || voiceBubble?.phase === 'thinking')
    if (needed && !escapeRegistered) escapeRegistered = globalShortcut.register('Escape', dismissVoice)
    if (!needed && escapeRegistered) { globalShortcut.unregister('Escape'); escapeRegistered = false }
    voice.state.cancelShortcutAvailable = escapeRegistered
  }
  const submitPetVoice = async result => {
    setVoiceBubble({ id: result.id, phase: 'thinking', transcript: result.text, text: '' }); harness.emit()
    try {
      if (!harness.model) {
        const models = await harness.listModels()
        if (voiceBubble?.id !== result.id) return
        if (!models.length) throw new Error('听到啦。先在聊天框选好 Ollama 模型，我就能帮你做啦。')
        harness.setPreferences({ model: models[0] })
      }
      if (voiceBubble?.id !== result.id) return
      harness.start(result.text)
      const runId = harness.activeRun.id
      voiceBubble.runId = runId; syncEscape(); harness.emit()
      await harness.running
      if (voiceBubble?.id !== result.id) return
      const reply = harness.messages.find(message => message.id === runId && message.role === 'assistant')
      setVoiceBubble({ id: result.id, phase: harness.error ? 'error' : 'reply', transcript: result.text,
        text: harness.error || reply?.content || '这次回复停下了，再说一句我还在听～' })
    } catch (error) {
      if (voiceBubble?.id === result.id) setVoiceBubble({ id: result.id, phase: 'error', transcript: result.text, text: error.message })
    } finally { syncEscape(); harness.emit() }
  }
  const showNotice = notice => {
    shownNotice = notice.id
    if (!harness.enabled || disposed || notice.expiresAt <= Date.now()) return
    if (!noticeWindow || noticeWindow.isDestroyed()) {
      noticeWindow = new BrowserWindow({ ...noticeSize, frame: false, transparent: true, resizable: false,
        show: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false,
        webPreferences: { ...webPreferences, autoplayPolicy: 'no-user-gesture-required' } })
      noticeWindow.setIgnoreMouseEvents(true)
      noticeWindow.once('ready-to-show', () => {
        if (!disposed && harness.enabled && !voiceBubble && notice.expiresAt > Date.now()) { positionNotice(); noticeWindow.showInactive() }
      })
      load(noticeWindow, 'notice')
    } else if (!voiceBubble) { positionNotice(); noticeWindow.showInactive() }
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => noticeWindow?.hide(), Math.max(0, notice.expiresAt - Date.now()))
  }
  const openChat = () => {
    if (disposed) return
    if (voice.state.surface === 'pet') dismissVoice()
    harness.wake()
    void harness.warmModel()
    if (!chatWindow || chatWindow.isDestroyed()) {
      chatWindow = new BrowserWindow({ width: 370, height: 490, frame: false, resizable: false, show: false,
        skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#f8f7f2', title: '小栖 · 聊一会儿', webPreferences: { ...webPreferences, session: chatSession } })
      chatWindow.once('ready-to-show', () => { positionChat(); chatWindow.show(); chatWindow.focus() })
      chatWindow.on('close', (event) => { if (!disposed) { event.preventDefault(); hideChat() } })
      chatWindow.webContents.on('render-process-gone', () => { if (voice.state.surface === 'chat') voice.cancel() })
      load(chatWindow, 'chat')
    } else {
      positionChat()
      chatWindow.show()
      chatWindow.focus()
      chatWindow.webContents.send('pet:chat-opened')
    }
  }
  const showPet = () => {
    if (disposed) return
    if (petWindow && !petWindow.isDestroyed()) { petWindow.showInactive(); return }
    const area = screen.getPrimaryDisplay().workArea
    const position = harness.position || { x: area.x + area.width - 164, y: area.y + area.height - 156 }
    petWindow = new BrowserWindow({ ...constrain({ ...position, width: 132, height: 140 }),
      frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, show: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, title: 'eDesktop · 小栖',
      webPreferences: { ...webPreferences, session: chatSession, autoplayPolicy: 'no-user-gesture-required' } })
    petWindow.once('ready-to-show', () => { if (harness.enabled) petWindow.showInactive() })
    petWindow.on('close', (event) => { if (!disposed) { event.preventDefault(); setVisible(false) } })
    petWindow.webContents.on('render-process-gone', () => { if (voice.state.surface === 'pet') dismissVoice() })
    load(petWindow, 'pet')
  }
  const setVisible = (enabled) => {
    harness.setPreferences({ enabled })
    if (enabled) showPet()
    else { dismissVoice(); hideChat(); petWindow?.hide(); noticeWindow?.hide(); voiceWindow?.hide() }
    updateVoiceShortcut()
    onVisibilityChanged()
  }
  const adjustDisplays = () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.setBounds(constrain(petWindow.getBounds()))
    positionChat()
    positionNotice()
    positionVoice()
  }
  const updateVoiceShortcut = () => {
    if (shortcutRegistered) { globalShortcut.unregister(SHORTCUT); shortcutRegistered = false }
    if (harness.enabled && !disposed) shortcutRegistered = globalShortcut.register(SHORTCUT, () => {
      if (!voice.job) { dismissVoice(); harness.stop('voice-start'); chatWindow?.hide(); showPet() }
      voice.requestToggle('pet')
    })
    voice.update({ shortcutAvailable: shortcutRegistered })
  }
  const handleVoice = (name, fn) => {
    ipcMain.handle(name, (event, ...args) => {
      const source = event.sender === petWindow?.webContents ? 'pet' : event.sender === chatWindow?.webContents ? 'chat' : null
      const owner = source === 'pet' ? petWindow : chatWindow
      if (!trusted(event) || !source || !harness.enabled || !owner?.isVisible()) return null
      if (voice.job && voice.state.surface !== source) return null
      return fn(source, ...args)
    }); handlers.push(name)
  }
  handleVoice('pet:voice-begin', source => voice.begin(source))
  handleVoice('pet:voice-recording', (_source, id) => voice.recording(id))
  handleVoice('pet:voice-transcribe', async (source, id, samples) => {
    const result = await voice.transcribe(id, samples)
    if (result && source === 'pet') void submitPetVoice(result)
    return result
  })
  handleVoice('pet:voice-cancel', source => { if (voice.state.surface === source) voice.cancel() })
  listen('pet:voice-level', (id, level) => voice.audioLevel(id, level))
  listen('pet:voice-error', message => { if (voice.state.surface === 'pet' && typeof message === 'string' && message) { setVoiceBubble({ id: randomUUID(), phase: 'error', text: message.slice(0, 500) }); harness.emit() } })
  listen('pet:voice-toggle', () => voice.requestToggle(voice.job ? voice.state.surface : 'pet'))
  listen('pet:voice-dismiss', dismissVoice)
  listen('pet:meowing', playing => { if (typeof playing === 'boolean' && meowing !== playing) { meowing = playing; harness.emit() } })
  handle('pet:state', () => withVoice(harness.snapshot()))
  handle('pet:models', () => harness.listModels())
  handle('pet:model', (model) => { dismissVoice(); harness.setPreferences({ model }); void harness.warmModel() })
  handle('pet:reminder-sound', enabled => harness.setPreferences({ reminderSoundEnabled: enabled }))
  handle('pet:chat-preferences', patch => harness.setChatPreferences(patch))
  handle('pet:send', (text) => { dismissVoice(); return harness.start(text) })
  handle('pet:reset', () => resetChat())
  handle('pet:memory-forget', async ids => {
    if (!harness.taskMemory) throw new Error('记忆暂时不可用。')
    dismissVoice(); harness.stop('memory-forget')
    const result = await harness.taskMemory.forget(ids, () => !disposed)
    if (result.status !== 'saved') throw new Error(result.text || '这次没有忘掉，请再试一次。')
    harness.emit(); return harness.taskMemory.snapshot()
  })
  handle('pet:focus-widget', () => focusHost?.preview ? focusHost.read().widgets.find(widget => widget.kind === 'pomodoro') || null : null)
  handle('pet:preview-todo', () => focusHost?.preview ? focusHost.read().widgets.find(widget => widget.kind === 'todo') || null : null)
  handle('pet:preview-todo-update', data => {
    if (!focusHost?.preview || !Array.isArray(data?.items) || data.items.some(i => typeof i.text !== 'string' || typeof i.id !== 'string')) throw new Error('仅供独立待办预览使用。')
    return focusHost.transact(workspace => {
      const widget = workspace.widgets.find(w => w.kind === 'todo')
      if (!widget) return { value: null }
      widget.data = { ...widget.data, items: data.items, activeList: data.activeList }
      return { changed: true, value: null }
    })
  })
  handle('pet:weather-cities', query => {
    if (!reminders) throw new Error('提醒服务未连接。')
    return reminders.weather.search(query, reminders.controller.signal)
  })
  handle('pet:reminder-settings', async input => {
    if (!reminders || !input || typeof input.context !== 'string') throw new Error('提醒服务未连接。')
    harness.stop('reminder-settings')
    const result = await reminders.execute({ name: 'settings.update', weather: input.weather, todo: input.todo },
      { runId: randomUUID(), expectedContext: input.context, fromUI: true })
    if (result.status !== 'saved') throw new Error(result.status === 'stale' ? '安排刚刚有变化，请重新打开设置后保存。' : result.text || '保存未完成。')
    return reminders.snapshot()
  })
  handle('pet:weather-preview', async () => {
    if (!reminders) throw new Error('提醒服务未连接。')
    const result = await reminders.execute({ name: 'weather.get' }, { expectedContext: JSON.stringify(reminders.snapshot()) })
    if (result.status !== 'read') throw new Error(result.text || '天气查询未完成。')
    return result.text
  })
  handle('pet:focus-widget-update', data => {
    if (!focusHost?.preview) throw new Error('仅供独立预览使用。')
    if (!data || !['focus', 'break'].includes(data.mode) || typeof data.running !== 'boolean'
      || !Number.isFinite(data.remainingSeconds) || data.remainingSeconds < 0
      || (data.endsAt !== null && !Number.isFinite(data.endsAt))) throw new Error('计时状态无效。')
    return focusHost.transact(workspace => {
      const widget = workspace.widgets.find(item => item.kind === 'pomodoro')
      if (!widget) return { value: null }
      widget.data = { ...widget.data, mode: data.mode, running: data.running,
        remainingSeconds: data.remainingSeconds, endsAt: data.endsAt,
        petFocus: data.petFocus === null ? null : widget.data.petFocus }
      return { changed: true, value: null }
    })
  })
  listen('pet:stop', () => harness.stop())
  listen('pet:open-chat', openChat)
  listen('pet:close-chat', hideChat)
  listen('pet:menu', () => Menu.buildFromTemplate([
    { label: '聊一会儿', click: openChat },
    { label: '重新聊', click: () => {
      try { resetChat() } catch {}
      openChat()
    } },
    { label: '关闭桌宠', click: () => onRequestDisable ? onRequestDisable() : setVisible(false) },
  ]).popup({ window: petWindow }))
  listen('pet:drag', (phase, delta) => {
    if (!petWindow || petWindow.isDestroyed()) return
    if (phase === 'start') dragStart = petWindow.getBounds()
    if (phase === 'move' && dragStart && Number.isFinite(delta?.x) && Number.isFinite(delta?.y)) {
      petWindow.setBounds(constrain({ ...dragStart, x: dragStart.x + delta.x, y: dragStart.y + delta.y }))
      positionChat()
      positionNotice()
      positionVoice()
    }
    if (phase === 'end' && dragStart) {
      dragStart = null
      const { x, y } = petWindow.getBounds()
      try { harness.setPreferences({ position: { x, y } }) } catch (error) { harness.error = error.message; harness.emit() }
    }
  })
  screen.on('display-removed', adjustDisplays)
  screen.on('display-metrics-changed', adjustDisplays)
  if (harness.enabled) showPet()
  updateVoiceShortcut()
  focus?.start()
  reminders?.start()
  void harness.warmModel()
  return {
    get visible() { return harness.enabled },
    setVisible, openChat,
    async dispose() {
      if (disposed) return
      disposed = true
      if (shortcutRegistered) globalShortcut.unregister(SHORTCUT)
      if (escapeRegistered) globalShortcut.unregister('Escape')
      voice.cancel()
      chatSession.setPermissionCheckHandler(null); chatSession.setPermissionRequestHandler(null)
      harness.stop('shutdown')
      harness.clearNotices()
      clearTimeout(noticeTimer)
      clearTimeout(voiceBubbleTimer)
      petWindow?.destroy()
      chatWindow?.destroy()
      noticeWindow?.destroy()
      voiceWindow?.destroy()
      previewWindow?.destroy()
      await Promise.allSettled([reminders?.dispose(), focus?.dispose(), voice.dispose(), harness.releaseModel()])
      screen.removeListener('display-removed', adjustDisplays)
      screen.removeListener('display-metrics-changed', adjustDisplays)
      await harness.running
      await harness.memoryRunning
      // Let already queued messages from the closing renderers drain first.
      await new Promise((resolve) => setImmediate(resolve))
      for (const name of handlers) ipcMain.removeHandler(name)
      for (const [name, listener] of listeners) ipcMain.removeListener(name, listener)
    },
  }
}

module.exports = { createDesktopPet }
