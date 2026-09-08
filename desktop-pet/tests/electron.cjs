// Run with: node_modules/.bin/electron desktop-pet/tests/electron.cjs
// Uses an isolated state directory and the user's installed Ollama model.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createDesktopPet } = require('../main.cjs')
const artifacts = path.resolve(__dirname, '../../.artifacts/desktop-pet-test')
const directory = path.join(artifacts, `run-${Date.now()}`)
fs.mkdirSync(directory, { recursive: true })
app.setPath('userData', path.join(directory, 'electron'))
app.on('window-all-closed', () => {})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await delay(100) }
  throw new Error('Timed out waiting for pet UI')
}
let pet
const errors = []
async function open() {
  pet = createDesktopPet({ dataDirectory: path.join(directory, 'data') })
  pet.openChat()
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) win.webContents.on('console-message', (_event, details) => {
    if (details?.level === 'error') errors.push(details.message)
  })
  const chat = windows.find((win) => win.getTitle().includes('聊一会儿'))
  const character = windows.find((win) => win !== chat)
  await until(() => chat.webContents.executeJavaScript('Boolean(window.petAPI && document.querySelector("textarea"))'))
  await until(() => chat.webContents.executeJavaScript('window.petAPI.getState().then(state => Boolean(state.model))'))
  return { chat, character }
}
const state = (chat) => chat.webContents.executeJavaScript('window.petAPI.getState()')
const setText = (chat, text) => chat.webContents.executeJavaScript(`(() => {
  const input = document.querySelector('textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)

app.whenReady().then(async () => {
  let { chat, character } = await open()
  await delay(300)
  fs.writeFileSync(path.join(artifacts, 'pet.png'), (await character.webContents.capturePage()).toPNG())
  fs.writeFileSync(path.join(artifacts, 'chat-empty.png'), (await chat.webContents.capturePage()).toPNG())
  assert.equal((await state(chat)).messages.length, 0)
  const beforeDrag = character.getBounds()
  await character.webContents.executeJavaScript("window.petAPI.drag('start'); window.petAPI.drag('move', { x: -32, y: -24 }); window.petAPI.drag('end')")
  await until(() => character.getBounds().x === beforeDrag.x - 32 && character.getBounds().y === beforeDrag.y - 24)
  const dragged = character.getBounds()
  await setText(chat, '我喜欢雨天，简单回应就好。')
  await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('textarea')
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
  })()`)
  await delay(150)
  assert.equal((await state(chat)).messages.length, 0, 'IME confirmation must not send a message')
  await chat.webContents.executeJavaScript(`document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`)
  await chat.webContents.executeJavaScript('document.querySelector("form").requestSubmit()')
  await until(async () => (await state(chat)).busy)
  assert.equal(await chat.webContents.executeJavaScript('Boolean(document.querySelector(".stop-button"))'), true)
  assert.equal(await chat.webContents.executeJavaScript('document.querySelector("select").disabled'), true)
  await until(async () => !(await state(chat)).busy, 125000)
  let saved = await state(chat)
  assert.equal(saved.error, '')
  assert.equal(saved.messages.length, 2)
  console.log('[pet] live Ollama first reply:', saved.messages[1].content)
  await pet.dispose()
  ;({ chat, character } = await open())
  assert.equal((await state(chat)).messages.length, 2, 'history must survive a new harness and windows')
  assert.equal(character.getBounds().x, dragged.x, 'dragged x position must survive restart')
  assert.equal(character.getBounds().y, dragged.y, 'dragged y position must survive restart')
  await setText(chat, '我刚才说喜欢什么天气？')
  await delay(100)
  await chat.webContents.executeJavaScript('document.querySelector("form").requestSubmit()')
  await until(async () => (await state(chat)).messages.length >= 4, 125000)
  saved = await state(chat)
  assert.equal(saved.error, '')
  assert.match(saved.messages.at(-1).content, /雨/)
  console.log('[pet] live Ollama recalled context:', saved.messages.at(-1).content)
  await delay(200)
  fs.writeFileSync(path.join(artifacts, 'chat-conversation.png'), (await chat.webContents.capturePage()).toPNG())
  assert.equal(await chat.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight'), true)

  for (const [message, kind] of [
    ['小栖，你真可爱，我很喜欢你！', 'happy'],
    ['我们认真讨论一下：递归是什么？用两句话解释就好。', 'focus'],
    ['我先去忙了，回头聊。', 'rest'],
  ]) {
    const count = (await state(chat)).messages.length
    await setText(chat, message)
    await delay(60)
    await chat.webContents.executeJavaScript('document.querySelector("form").requestSubmit()')
    await until(async () => !(await state(chat)).busy && (await state(chat)).messages.length > count + 1, 125000)
    const current = await state(chat)
    assert.equal(current.error, '')
    assert.equal(current.reaction?.kind, kind, `live reaction for ${message}: ${JSON.stringify(current)}`)
    for (const win of [character, chat]) await until(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.mascot-${kind}'))`))
    await delay(kind === 'rest' ? 1200 : 200)
    fs.writeFileSync(path.join(artifacts, `pet-${kind}.png`), (await character.webContents.capturePage()).toPNG())
    console.log(`[pet] ${kind}: ${current.messages.at(-1).content}`)
    if (kind === 'happy') {
      await until(() => character.webContents.executeJavaScript("!document.querySelector('.mascot-happy')"), 8000)
      await until(() => chat.webContents.executeJavaScript("!document.querySelector('.mascot-happy')"), 1000)
    }
  }
  pet.openChat()
  await until(async () => (await state(chat)).reaction === null)
  await until(() => character.webContents.executeJavaScript("!document.querySelector('.mascot-rest')"))

  const beforeInterruption = (await state(chat)).messages.length
  await setText(chat, '请详细解释一下递归，给我五个具体的生活例子，每个例子展开说说，总共大约五百字。')
  await delay(60)
  await chat.webContents.executeJavaScript('document.querySelector("form").requestSubmit()')
  await until(async () => { const current = await state(chat); return current.busy && current.reply.trim() }, 125000)
  await setText(chat, '等等，先别解释递归了。我只是想吐槽今天工作好累，陪我聊两句。')
  await until(() => chat.webContents.executeJavaScript('Boolean(document.querySelector("button[aria-label=发送补充消息]:not(:disabled)"))'))
  await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('textarea')
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true }))
  })()`)
  assert.equal((await state(chat)).messages.filter(message => message.role === 'user').length, (beforeInterruption / 2) + 1, 'IME and Shift+Enter must not interrupt')
  fs.writeFileSync(path.join(artifacts, 'chat-supplement.png'), (await chat.webContents.capturePage()).toPNG())
  await chat.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('textarea')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await until(async () => { const current = await state(chat); return !current.busy && current.messages.length === beforeInterruption + 4 }, 125000)
  const afterInterruption = await state(chat)
  assert.equal(afterInterruption.error, '')
  assert.equal(afterInterruption.messages[beforeInterruption + 1].interrupted, true)
  assert.equal(afterInterruption.messages.at(-1).interrupted, false)
  assert.equal(afterInterruption.reaction, null, 'the old focus gesture must not return')
  await until(() => chat.webContents.executeJavaScript('Boolean(document.querySelector(".chat-message small")) && document.querySelector("textarea").value === ""'))
  fs.writeFileSync(path.join(artifacts, 'chat-interrupted.png'), (await chat.webContents.capturePage()).toPNG())
  const runLog = fs.readFileSync(path.join(directory, 'data', 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(runLog.slice(-2).map(({ status, reason }) => [status, reason]), [['cancelled', 'superseded'], ['completed', null]])
  console.log(`[pet] live ${afterInterruption.model} after interruption: ${afterInterruption.messages.at(-1).content}`)

  await chat.webContents.executeJavaScript('window.petAPI.closeChat()')
  await until(() => !chat.isVisible())
  pet.openChat()
  await until(() => chat.isVisible())
  pet.setVisible(false)
  assert.equal(character.isVisible(), false)
  pet.setVisible(true)
  assert.equal(character.isVisible(), true)
  assert.deepEqual(errors, [])
  console.log('[pet] PASS: windows, IPC, IME, streaming, memory, gestures, interruption, duplicate Enter, run logs, hide/show, layout')
}).catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  await pet?.dispose()
  app.exit(process.exitCode || 0)
})
