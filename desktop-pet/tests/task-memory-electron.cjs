const { app, BrowserWindow, globalShortcut } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createDesktopPet } = require('../main.cjs')
const { createFocusPreview } = require('../focus-preview.cjs')
const directory = path.resolve('.artifacts/pet-task-memory-electron', `run-${Date.now()}`), dataDirectory = path.join(directory, 'data')
fs.mkdirSync(dataDirectory, { recursive: true }); app.setPath('userData', path.join(directory, 'electron')); app.on('window-all-closed', () => {})
// This fixture must not take over the user's global voice shortcut.
globalShortcut.register = () => false; globalShortcut.unregister = () => {}; globalShortcut.isRegistered = () => false
fs.writeFileSync(path.join(dataDirectory, 'state.json'), JSON.stringify({ model: 'fixture', messages: [] }))
global.fetch = async url => new Response(JSON.stringify(url.endsWith('/api/tags') ? { models: [{ name: 'fixture' }] } : { done: true }))
const delay = ms => new Promise(r => setTimeout(r, ms))
const evaluate = (win, js) => win.webContents.executeJavaScript(js)
async function until(check) { for (let i = 0; i < 160; i++) { if (await check()) return; await delay(50) } throw new Error('memory UI timeout') }
const click = async (win, label) => {
  const find = `Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.startsWith(${JSON.stringify(label)}) || b.textContent.trim().startsWith(${JSON.stringify(label)}))`
  await until(() => evaluate(win, `Boolean(${find})`)); return evaluate(win, `${find}.click()`)
}
let pet
app.whenReady().then(async () => {
  const host = createFocusPreview(dataDirectory), now = Date.now()
  await host.transact(w => { w.petMemory = { version: 1, revision: 1, habits: [
    { id: 'code', kind: 'focus', activity: '写代码', minutes: 45, version: 1, updatedAt: now, source: { text: '以后写代码45分钟', at: now } },
    { id: 'read', kind: 'focus', activity: '看书', minutes: 25, version: 1, updatedAt: now, source: { text: '看书25分钟', at: now } },
  ], operations: [{ id: 'op', name: 'reminder.create', text: '取快递', at: now, reminderAt: now + 600000, expiresAt: now + 86400000, source: { text: '十分钟后提醒我取快递', at: now } }] }; return { changed: true } })
  pet = createDesktopPet({ dataDirectory, focusHost: host }); pet.openChat()
  const chat = BrowserWindow.getAllWindows().find(w => w.getTitle().includes('聊一会儿'))
  await until(() => evaluate(chat, 'Boolean(document.querySelector("textarea"))'))
  await click(chat, '小栖设置'); await click(chat, '小栖记住的事')
  await until(() => evaluate(chat, 'document.querySelectorAll(".memory-card").length === 2'))
  await delay(250); fs.writeFileSync(path.join(directory, 'habits.png'), (await chat.webContents.capturePage()).toPNG())
  await evaluate(chat, 'document.querySelector(".memory-card summary").click()')
  assert.equal(await evaluate(chat, 'document.querySelector(".memory-card details").open'), true)
  assert.match(await evaluate(chat, 'document.querySelector(".memory-card details p").textContent'), /以后写代码45分钟/)
  const overflow = await evaluate(chat, 'Array.from(document.querySelectorAll(".memory-card")).some(e => e.scrollWidth > e.clientWidth)')
  assert.equal(overflow, false)
  await click(chat, '忘记：写代码时，专注 45 分钟')
  await until(() => evaluate(chat, 'document.querySelectorAll(".memory-card").length === 1'))
  assert.deepEqual(host.read().petMemory.habits.map(h => h.id), ['read'])
  await click(chat, '最近操作')
  await until(() => evaluate(chat, 'document.querySelector(".memory-card strong")?.textContent.includes("取快递")'))
  await delay(250)
  fs.writeFileSync(path.join(directory, 'operations.png'), (await chat.webContents.capturePage()).toPNG())
  await click(chat, '忘记：')
  await until(() => evaluate(chat, 'Boolean(document.querySelector(".memory-empty"))'))
  assert.equal(host.read().petMemory.operations.length, 0)
  await click(chat, '返回设置'); await until(() => evaluate(chat, 'Boolean(document.querySelector(".reminder-sound-setting"))'))
  await pet.dispose(); pet = null
  assert.deepEqual(createFocusPreview(dataDirectory).read().petMemory.habits.map(h => h.id), ['read'])
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks: ['view habits', 'source disclosure', 'no overflow', 'delete one habit', 'view recent operations', 'delete operation', 'return to settings', 'durable restart'] }, null, 2))
  console.log(directory); app.quit()
}).catch(async error => { console.error(error); await pet?.dispose(); app.exit(1) })
