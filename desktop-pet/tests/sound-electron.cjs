// Real due reminder and Chromium audio playback, with isolated data and muted
// output so the automated checks do not repeatedly meow at the user's desk.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createDesktopPet } = require('../main.cjs')
const { createFocusPreview } = require('../focus-preview.cjs')
const { createWidget } = require('../../electron/widget-model.cjs')
const directory = path.resolve('.artifacts/desktop-pet-sound', `run-${Date.now()}`)
const dataDirectory = path.join(directory, 'data')
fs.mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', path.join(directory, 'electron'))
app.on('window-all-closed', () => {})
const playback = []
app.on('web-contents-created', (_event, contents) => {
  contents.setAudioMuted(true)
  contents.on('media-started-playing', () => playback.push(new URL(contents.getURL()).searchParams.get('surface')))
})
global.fetch = async () => new Response(JSON.stringify({ models: [] }))
let pet
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, message = 'sound integration timeout') {
  for (let i = 0; i < 160; i++) { if (await check()) return; await delay(50) }
  throw new Error(message)
}
const evaluate = (win, js) => win.webContents.executeJavaScript(js, true)
const read = win => evaluate(win, 'window.petAPI.getState()')
const count = surface => playback.filter(value => value === surface).length
async function openChat() {
  pet.openChat()
  const chat = BrowserWindow.getAllWindows().find(win => win.getTitle().includes('聊一会儿'))
  await until(() => evaluate(chat, 'Boolean(window.petAPI && document.querySelector("textarea"))'))
  return chat
}
app.whenReady().then(async () => {
  const host = createFocusPreview(dataDirectory)
  host.preview = false
  pet = createDesktopPet({ dataDirectory, focusHost: host })
  let chat = await openChat()
  assert.equal((await read(chat)).reminderSoundEnabled, true)
  await evaluate(chat, 'document.querySelector("[aria-label=小栖设置]").click()')
  await until(() => evaluate(chat, 'Boolean(document.querySelector("[aria-label=提醒喵声]"))'))
  await evaluate(chat, 'document.querySelector("[aria-label=提醒喵声]").click()')
  await until(async () => (await read(chat)).reminderSoundEnabled === false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDirectory, 'state.json'))).reminderSoundEnabled, false)
  await evaluate(chat, 'document.querySelector("[aria-label=试听喵声]").click()')
  await until(() => count('chat') === 1, 'preview did not play')
  assert.equal((await read(chat)).reminderSoundEnabled, false, 'preview does not change mute preference')
  await evaluate(chat, 'document.querySelector("[aria-label=提醒喵声]").click()')
  await until(async () => (await read(chat)).reminderSoundEnabled === true)
  await delay(800)
  fs.writeFileSync(path.join(directory, 'sound-settings.png'), (await chat.webContents.capturePage()).toPNG())
  const html = await evaluate(chat, `(() => {
    const source = document.querySelector('main.chat-panel'), clone = source.cloneNode(true)
    source.querySelectorAll('input').forEach((field, i) => { const copy = clone.querySelectorAll('input')[i]; copy.setAttribute('value', field.value); if (field.checked) copy.setAttribute('checked', ''); else copy.removeAttribute('checked') })
    source.querySelectorAll('select').forEach((field, i) => { clone.querySelectorAll('select')[i].querySelectorAll('option').forEach(option => { if (option.value === field.value) option.setAttribute('selected', ''); else option.removeAttribute('selected') }) })
    return clone.outerHTML
  })()`)
  const css = fs.readFileSync(path.resolve('desktop-pet/pet.css'), 'utf8')
  fs.writeFileSync(path.join(directory, 'sound-settings.html'), `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小栖 · 天气与提醒</title><style>${css}</style></head><body><div id="root" class="w-full h-full">${html.replace('href="https://open-meteo.com/"', 'id="weather-provider-attribution" href="https://open-meteo.com/"')}</div></body></html>`)
  await evaluate(chat, 'window.petAPI.closeChat()')
  await until(() => !chat.isVisible())
  await host.transact(workspace => {
    const widget = createWidget('todo', { index: 0, primaryOffset: { x: 0, y: 0 } })
    widget.data.items = [{ id: 'sound-due', text: '取快递', completed: false, list: 'temporary', reminderAt: Date.now() + 200 }]
    workspace.widgets.push(widget)
    return { changed: true }
  })
  await until(() => count('notice') === 1, 'due reminder did not play automatically')
  const notice = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('surface=notice'))
  assert.equal(chat.isVisible(), false)
  assert.equal(notice.isFocusable(), false)
  await until(() => evaluate(notice, 'document.querySelector(".notice-copy p")?.textContent.includes("取快递")'))
  const state = await read(chat)
  let revision = state.revision
  const frame = (id, patch = {}) => ({ ...state, focusNotice: { id, text: '测试提醒', expiresAt: Date.now() + 60000 }, ...patch })
  const publish = async next => {
    notice.webContents.send('pet:changed', { ...next, revision: ++revision })
    await until(() => evaluate(notice, `document.querySelector('.notice-copy p')?.textContent === ${JSON.stringify(next.focusNotice.text)}`))
    await delay(850)
  }
  await publish(state)
  await publish({ ...state, revision: state.revision + 1 })
  assert.equal(count('notice'), 1, 'state refresh must not repeat the sound')
  await publish(frame('muted', { reminderSoundEnabled: false }))
  await publish(frame('muted'))
  assert.equal(count('notice'), 1, 'unmuting must not replay a skipped reminder')
  await publish(frame('disabled', { enabled: false }))
  await publish(frame('disabled'))
  assert.equal(count('notice'), 1, 'enabling the pet must not replay a skipped reminder')
  for (const phase of ['requesting', 'recording']) {
    await publish(frame(phase, { voice: { ...state.voice, phase } }))
    await publish(frame(phase, { voice: { ...state.voice, phase: 'idle' } }))
  }
  assert.equal(count('notice'), 1, 'voice input suppresses sound without delayed playback')
  await publish(frame('expired', { focusNotice: { id: 'expired', text: '旧提醒', expiresAt: Date.now() - 1000 } }))
  assert.equal(count('notice'), 1, 'expired reminders stay silent')
  await publish(frame('next'))
  assert.equal(count('notice'), 2, 'a new reminder can play after the previous one')
  await evaluate(chat, 'window.petAPI.setReminderSound(false)')
  await pet.dispose()
  const restoredHost = createFocusPreview(dataDirectory)
  restoredHost.preview = false
  pet = createDesktopPet({ dataDirectory, focusHost: restoredHost })
  chat = await openChat()
  assert.equal((await read(chat)).reminderSoundEnabled, false)
  assert.equal((await read(chat)).focusNotice, null)
  assert.equal(count('notice'), 2, 'restart does not replay reminders')
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, playback, directory }, null, 2))
  console.log(`PASS real reminder audio, preview, persisted switch, dedupe, mute, disabled, voice suppression, expiry and restart: ${directory}`)
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await pet?.dispose(); app.exit(process.exitCode || 0) })
