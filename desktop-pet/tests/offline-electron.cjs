// Isolated UI check: an unavailable local Ollama service must be understandable
// without exposing addresses or port configuration to the user.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createDesktopPet } = require('../main.cjs')
const directory = path.resolve('.artifacts/desktop-pet-offline', `run-${Date.now()}`)
const dataDirectory = path.join(directory, 'data')
fs.mkdirSync(dataDirectory, { recursive: true })
fs.writeFileSync(path.join(dataDirectory, 'state.json'), JSON.stringify({ model: 'local-model', messages: [] }))
app.setPath('userData', path.join(directory, 'electron'))
app.on('window-all-closed', () => {})
global.fetch = async () => { throw new TypeError('offline') }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(50) }
  throw new Error('offline state did not appear')
}
let pet
app.whenReady().then(async () => {
  pet = createDesktopPet({ dataDirectory })
  pet.openChat()
  const chat = BrowserWindow.getAllWindows().find(win => win.getTitle().includes('聊一会儿'))
  await delay(250)
  await until(() => chat?.webContents.executeJavaScript(`
    document.querySelector('.chat-notice')?.textContent.includes('未连接 Ollama')
      && document.querySelector('#pet-model')?.selectedOptions[0]?.textContent === '未连接 Ollama'
      && !document.querySelector('.refresh-button')?.disabled
  `))
  const state = await chat.webContents.executeJavaScript(`({
    notice: document.querySelector('.chat-notice')?.textContent,
    model: document.querySelector('#pet-model')?.selectedOptions[0]?.textContent,
    placeholder: document.querySelector('textarea')?.placeholder,
    sendDisabled: document.querySelector('.send-button')?.disabled,
  })`)
  assert.match(state.notice, /未连接 Ollama/)
  assert.equal(state.model, '未连接 Ollama')
  assert.equal(state.placeholder, '请先启动 Ollama…')
  assert.equal(state.sendDisabled, true)
  await chat.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  fs.writeFileSync(path.join(directory, 'offline.png'), (await chat.webContents.capturePage()).toPNG())
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, state }, null, 2))
  console.log(`[desktop-pet] offline UI assertion passed; ${directory}`)
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  await pet?.dispose()
  app.exit(process.exitCode || 0)
})
