// Focused window/menu integration; isolated data and deterministic Ollama responses.
// Run: node_modules/.bin/electron desktop-pet/tests/reset-electron.cjs
const { app, BrowserWindow, Menu } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createDesktopPet } = require('../main.cjs')
const directory = path.resolve(__dirname, '../../.artifacts/desktop-pet-reset', `run-${Date.now()}`)
const dataDirectory = path.join(directory, 'data')
fs.mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', path.join(directory, 'electron'))
app.on('window-all-closed', () => {})
const preference = { value: '小李', evidence: '以后叫我小李', sourceMessageId: 'old-user', sourceSequence: 5,
  method: 'explicit', updatedAt: new Date().toISOString() }
fs.writeFileSync(path.join(dataDirectory, 'state.json'), JSON.stringify({
  model: 'local-test', userSequence: 5, memoryCursor: 5,
  chatPreferences: { preferredName: preference },
  messages: [{ id: 'old-user', role: 'user', sequence: 5, content: '以前一直聊递归，叫我小李' },
    { id: 'old-assistant', role: 'assistant', content: '我们刚才在聊套娃。' }],
}))
const requests = []
let releaseHiddenReply
global.fetch = async (url, options) => {
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'local-test' }] }))
  if (url.endsWith('/api/generate')) return new Response(JSON.stringify({ done: true }))
  const request = JSON.parse(options.body)
  requests.push(request)
  assert.equal(request.stream, true, 'only explicit user messages may request a reply in this test')
  if (request.messages.at(-1)?.content.includes('收起窗口也继续回复')) {
    return new Promise(resolve => { releaseHiddenReply = () => resolve(new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ reply: '收起来也会继续回复。', action: 'none' }) } }) + '\n')) })
  }
  return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ reply: '小李，我在。', action: 'none' }) } }) + '\n')
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await check()) return; await delay(50) }
  throw new Error('Timed out waiting for the reset UI')
}
let pet, menu, menuWindow
const originalBuild = Menu.buildFromTemplate
Menu.buildFromTemplate = template => {
  const built = originalBuild.call(Menu, template)
  // Capture the real menu and its click handlers without taking desktop focus.
  built.popup = options => { menu = built; menuWindow = options.window }
  return built
}
const state = chat => chat.webContents.executeJavaScript('window.petAPI.getState()')
const setText = (chat, text) => chat.webContents.executeJavaScript(`(() => {
  const input = document.querySelector('textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
async function open() {
  pet = createDesktopPet({ dataDirectory })
  pet.openChat()
  const chat = BrowserWindow.getAllWindows().find(win => win.getTitle().includes('聊一会儿'))
  const character = BrowserWindow.getAllWindows().find(win => win !== chat)
  await until(() => chat.webContents.executeJavaScript('Boolean(document.querySelector("textarea") && window.petAPI)'))
  await until(() => character.webContents.executeJavaScript('Boolean(document.querySelector(".pet-button"))'))
  return { chat, character }
}
async function restartFromMenu(character) {
  menu = null
  await character.webContents.executeJavaScript('document.querySelector(".pet-button").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))')
  await until(() => menu)
  assert.equal(menuWindow, character)
  assert.deepEqual(menu.items.map(item => item.label), ['聊一会儿', '重新聊', '关闭桌宠'])
  menu.items.find(item => item.label === '重新聊').click()
}

app.whenReady().then(async () => {
  let { chat, character } = await open()
  await until(async () => (await state(chat)).messages.length === 2)
  await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '想聊个新话题')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    window.petAPI.closeChat()
  })()`)
  await until(() => !chat.isVisible())
  await restartFromMenu(character)
  await until(async () => chat.isVisible() && (await state(chat)).messages.length === 0)
  await until(() => chat.webContents.executeJavaScript('Boolean(document.querySelector(".chat-empty"))'))
  assert.equal(await chat.webContents.executeJavaScript('document.querySelector("textarea").value'), '想聊个新话题')
  assert.equal(requests.length, 0, 'resetting does not generate a greeting or re-extract the old memory')
  assert.equal((await state(chat)).reaction, null)
  const saved = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'state.json'), 'utf8'))
  assert.deepEqual(saved.messages, [])
  assert.deepEqual(saved.chatPreferences.preferredName, preference)
  fs.writeFileSync(path.join(directory, 'reset-chat.png'), (await chat.webContents.capturePage()).toPNG())
  await chat.webContents.executeJavaScript('document.querySelector("form").requestSubmit()')
  await until(async () => (await state(chat)).messages.length === 2 && !(await state(chat)).busy)
  assert.equal((await state(chat)).error, '')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].messages.length, 2)
  assert.match(requests[0].messages[0].content, /小李/)
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /递归|套娃/)
  await chat.webContents.executeJavaScript('document.querySelector("button[aria-label=重新聊]").click()')
  await until(async () => (await state(chat)).messages.length === 0)
  await setText(chat, '收起窗口也继续回复')
  await chat.webContents.executeJavaScript('document.querySelector("form").requestSubmit()')
  await until(async () => (await state(chat)).busy && releaseHiddenReply)
  await delay(8200)
  await until(() => chat.webContents.executeJavaScript('document.querySelector(".waiting-reply small")?.textContent.includes("正在加载本地模型")'))
  fs.writeFileSync(path.join(directory, 'loading-chat.png'), (await chat.webContents.capturePage()).toPNG())
  await chat.webContents.executeJavaScript('window.petAPI.closeChat()')
  await until(() => !chat.isVisible())
  assert.equal((await state(chat)).busy, true)
  releaseHiddenReply()
  await until(async () => !(await state(chat)).busy && (await state(chat)).messages.length === 2)
  assert.equal((await state(chat)).messages.at(-1).content, '收起来也会继续回复。')
  await chat.webContents.executeJavaScript('window.petAPI.reset()')
  await until(async () => (await state(chat)).messages.length === 0)
  await pet.dispose()
  ;({ chat, character } = await open())
  assert.deepEqual((await state(chat)).messages, [])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDirectory, 'state.json'), 'utf8')).chatPreferences.preferredName, preference)
  console.log('[pet reset] PASS: menu/button reset, hidden-chat completion, retained draft/preferences, fresh context, durable reset')
  console.log(`[pet reset] Isolated result: ${directory}`)
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  await pet?.dispose()
  Menu.buildFromTemplate = originalBuild
  app.exit(process.exitCode || 0)
})
