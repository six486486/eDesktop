const { app, BrowserWindow, globalShortcut } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createDesktopPet } = require('../main.cjs')
const { createFocusPreview } = require('../focus-preview.cjs')
const directory = path.resolve('.artifacts/pet-chat-preferences-electron', `run-${Date.now()}`)
const dataDirectory = path.join(directory, 'data')
fs.mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', path.join(directory, 'electron')); app.on('window-all-closed', () => {})
globalShortcut.register = () => false; globalShortcut.unregister = () => {}; globalShortcut.isRegistered = () => false
fs.writeFileSync(path.join(dataDirectory, 'state.json'), JSON.stringify({ model: 'fixture', messages: [] }))
const requests = []
let offline = true
global.fetch = async (url, options) => {
  if (url.endsWith('/api/tags')) {
    if (offline) throw new TypeError('offline')
    return new Response(JSON.stringify({ models: [{ name: 'fixture' }] }))
  }
  if (url.endsWith('/api/chat')) {
    requests.push(JSON.parse(options.body))
    const content = JSON.stringify({ assessment: '回应用户的聊天偏好', decision: { action: 'none', params: {} }, response: { text: '好呀，我记住啦。', visual: 'none' } })
    return new Response(JSON.stringify({ done: true, message: { content } }) + '\n')
  }
  return new Response(JSON.stringify({ done: true }))
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = (win, js) => win.webContents.executeJavaScript(js)
async function until(check) { for (let i = 0; i < 160; i++) { if (await check()) return; await delay(50) } throw new Error('chat preferences UI timeout') }
async function click(win, label) {
  const find = `Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.textContent.trim() === ${JSON.stringify(label)} || b.querySelector('strong')?.textContent.trim() === ${JSON.stringify(label)})`
  await until(() => evaluate(win, `Boolean(${find})`)); await evaluate(win, `${find}.click()`)
}
const value = (win, label) => evaluate(win, `document.querySelector('[aria-label="${label}"]').value`)
const input = (win, label, value) => evaluate(win, `(() => {
  const element = document.querySelector('[aria-label="${label}"]');
  const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
})()`)
const state = win => evaluate(win, 'window.petAPI.getState()')
let pet, chat
app.whenReady().then(async () => {
  const open = async () => {
    pet = createDesktopPet({ dataDirectory, focusHost: createFocusPreview(dataDirectory) }); pet.openChat()
    chat = BrowserWindow.getAllWindows().find(w => w.getTitle().includes('聊一会儿'))
    await until(() => evaluate(chat, 'Boolean(document.querySelector("textarea"))'))
    await click(chat, '小栖设置'); await click(chat, '聊天偏好')
    await until(() => evaluate(chat, 'Boolean(document.querySelector(".chat-preferences"))'))
  }
  await open()
  await input(chat, '用户称呼', '小李'); await input(chat, '回复长短', 'short'); await input(chat, '追问方式', 'avoid')
  await click(chat, '保存偏好')
  await until(async () => (await state(chat)).chatPreferences.preferredName === '小李')
  assert.deepEqual((await state(chat)).chatPreferences, { preferredName: '小李', replyLength: 'short', followUp: 'avoid' })
  assert.equal(requests.length, 0, 'manual settings work while Ollama is offline')
  assert.equal((await state(chat)).messages.length, 0)
  await delay(150)
  fs.writeFileSync(path.join(directory, 'chat-preferences.png'), (await chat.webContents.capturePage()).toPNG())
  assert.equal(await evaluate(chat, 'document.querySelector(".chat-preferences").scrollWidth > document.querySelector(".chat-preferences").clientWidth'), false)
  assert.equal(await evaluate(chat, 'document.querySelector(".chat-preferences .reminder-save").getBoundingClientRect().bottom <= innerHeight'), true)
  await input(chat, '用户称呼', '小禾')
  offline = false
  await evaluate(chat, 'window.petAPI.send("以后叫我小林，回答详细一点，可以追问我")')
  await until(async () => !(await state(chat)).busy)
  await until(async () => await value(chat, '回复长短') === 'detailed')
  assert.equal(await value(chat, '用户称呼'), '小禾', 'an unsaved edited field stays visible')
  assert.equal(await value(chat, '追问方式'), 'natural', 'untouched fields follow natural-language changes')
  await click(chat, '保存偏好')
  await until(async () => (await state(chat)).chatPreferences.preferredName === '小禾')
  assert.equal((await state(chat)).chatPreferences.replyLength, 'detailed', 'saving one field cannot overwrite another field with stale values')
  await evaluate(chat, 'window.petAPI.send("这次回答短一点")')
  await until(async () => !(await state(chat)).busy)
  assert.equal(await value(chat, '回复长短'), 'detailed')
  assert.match(requests.at(-1).messages[0].content, /一到两句/)
  await input(chat, '用户称呼', '重试名称')
  const temporary = path.join(dataDirectory, 'state.json.tmp')
  fs.mkdirSync(temporary)
  await click(chat, '保存偏好')
  await until(() => evaluate(chat, 'document.querySelector(".reminder-feedback")?.textContent.includes("未能保存")'))
  assert.equal((await state(chat)).chatPreferences.preferredName, '小禾')
  assert.equal(await value(chat, '用户称呼'), '重试名称')
  fs.rmdirSync(temporary)
  await click(chat, '返回设置'); await click(chat, '聊天偏好')
  assert.equal(await value(chat, '用户称呼'), '小禾')
  await pet.dispose(); pet = null
  await open()
  assert.deepEqual((await state(chat)).chatPreferences, { preferredName: '小禾', replyLength: 'detailed', followUp: 'natural' })
  await click(chat, '恢复默认'); await click(chat, '保存偏好')
  await until(async () => (await state(chat)).chatPreferences.preferredName === null)
  assert.deepEqual((await state(chat)).chatPreferences, { preferredName: null, replyLength: 'normal', followUp: 'natural' })
  await pet.dispose(); pet = null
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks: ['offline settings', 'no synthetic conversation', 'natural-language sync', 'partial save', 'temporary override', 'save failure recovery', 'restart', 'restore defaults', 'visible controls'] }, null, 2))
  console.log(directory); app.quit()
}).catch(async error => { console.error(error); await pet?.dispose(); app.exit(1) })
