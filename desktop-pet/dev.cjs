// Isolated pet preview: never starts eDesktop's organizer or reads its workspace.
const { app, Menu, Tray } = require('electron')
const path = require('node:path')
const { createDesktopPet } = require('./main.cjs')
const { createFocusPreview } = require('./focus-preview.cjs')

app.setPath('userData', path.join(__dirname, '..', '.artifacts', 'desktop-pet-preview'))
let pet
let tray
let quitting = false
app.whenReady().then(() => {
  pet = createDesktopPet({ focusHost: createFocusPreview(path.join(app.getPath('userData'), 'desktop-pet')) })
  pet.setVisible(true)
  pet.openChat()
  tray = new Tray(path.join(__dirname, '..', 'assets', 'app-icon-16.png'))
  tray.setToolTip('小栖 · 独立预览')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示桌宠', click: () => pet.setVisible(true) },
    { label: '退出桌宠预览', click: () => app.quit() },
  ]))
})
app.on('before-quit', (event) => {
  if (quitting || !pet) return
  event.preventDefault()
  quitting = true
  void pet.dispose().finally(() => app.quit())
})
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => tray?.destroy())
