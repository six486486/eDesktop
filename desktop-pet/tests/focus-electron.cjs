// Isolated integration of IPC, the real timer component, and main-process expiry.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createDesktopPet } = require('../main.cjs')
const { createFocusPreview } = require('../focus-preview.cjs')
const directory = path.resolve('.artifacts/desktop-pet-focus-electron', `run-${Date.now()}`)
const dataDirectory = path.join(directory, 'data')
fs.mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', path.join(directory, 'electron'))
app.on('window-all-closed', () => {})
fs.writeFileSync(path.join(dataDirectory, 'state.json'), JSON.stringify({ model: 'fixture', messages: [] }))
let requests = 0, pet
global.fetch = async url => {
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'fixture' }] }))
  if (url.endsWith('/api/generate')) return new Response(JSON.stringify({ done: true }))
  requests++
  return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({
    decision: { action: 'focus.start', params: { minutes: 1 } }, response: { text: '好。', visual: 'none' },
  }) } }) + '\n')
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 260; i++) { if (await check()) return; await delay(50) }
  throw new Error('focus integration timeout')
}
const read = chat => chat.webContents.executeJavaScript('window.petAPI.getState()')
app.whenReady().then(async () => {
  let host = createFocusPreview(dataDirectory)
  pet = createDesktopPet({ dataDirectory, focusHost: host })
  pet.openChat()
  const chat = BrowserWindow.getAllWindows().find(win => win.getTitle().includes('聊一会儿'))
  await until(() => chat.webContents.executeJavaScript('Boolean(window.petAPI && document.querySelector("textarea"))'))
  await chat.webContents.executeJavaScript('window.petAPI.send("陪我专注一分钟")')
  await until(async () => !(await read(chat)).busy && host.read().widgets[0]?.data.running)
  assert.match((await read(chat)).messages.at(-1).content, /1 分钟开始/)
  let timer
  await until(() => (timer = BrowserWindow.getAllWindows().find(win => win !== chat && win.webContents.getURL().includes('focus-preview'))))
  assert.ok(timer)
  await until(() => timer.webContents.executeJavaScript('Boolean(document.querySelector(".desktop-timer-value"))'))
  const before = host.read().widgets[0].data
  assert.equal(await timer.webContents.executeJavaScript('document.querySelector(".desktop-timer-value").textContent'), '01:00')
  assert.equal(await timer.webContents.executeJavaScript('document.querySelector(".desktop-timer-progress i").style.width'), '0%')
  fs.writeFileSync(path.join(directory, 'timer.png'), (await timer.webContents.capturePage()).toPNG())
  await chat.webContents.executeJavaScript('window.petAPI.closeChat()')
  await until(() => !chat.isVisible())
  assert.equal(host.read().widgets[0].data.running, true)
  // Reschedule only this isolated fixture; production's minute range is unchanged.
  await host.transact(workspace => {
    workspace.widgets[0].data.endsAt = Date.now() + 250
    return { changed: true, value: null }
  })
  timer.hide()
  await until(async () => (await read(chat)).focusNotice)
  assert.equal(requests, 1, 'completion did not call the model')
  assert.equal(host.read().widgets[0].data.sessions, before.sessions + 1)
  assert.equal(host.read().widgets[0].data.running, false)
  let notice
  await until(() => (notice = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('surface=notice'))))
  await until(() => notice?.webContents.executeJavaScript('document.querySelector(".focus-notice")?.textContent.includes("1 分钟到啦")'))
  assert.equal(chat.isVisible(), false, 'reminder does not open chat')
  assert.equal(notice.isFocusable(), false)
  fs.writeFileSync(path.join(directory, 'notice.png'), (await notice.webContents.capturePage()).toPNG())
  await pet.dispose()
  host = createFocusPreview(dataDirectory)
  pet = createDesktopPet({ dataDirectory, focusHost: host })
  pet.openChat()
  const reopened = BrowserWindow.getAllWindows().find(win => win.getTitle().includes('聊一会儿'))
  await until(() => reopened.webContents.executeJavaScript('Boolean(window.petAPI && document.querySelector("textarea"))'))
  assert.equal((await read(reopened)).focusNotice, null)
  assert.equal((await read(reopened)).messages.filter(message => message.content.includes('分钟到啦')).length, 1)
  await reopened.webContents.executeJavaScript('window.petAPI.reset(); window.petAPI.closeChat()')
  await until(() => !reopened.isVisible())
  await until(() => (timer = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('focus-preview'))))
  await until(() => timer.webContents.executeJavaScript('Boolean(document.querySelector(".timer-toggle"))'))
  // Use the actual widget buttons for both manual phases, with no chat command.
  for (const mode of ['focus', 'break']) {
    if (host.read().widgets[0].data.mode !== mode) {
      await timer.webContents.executeJavaScript('document.querySelector(".timer-mode-switch").click()')
      await until(() => host.read().widgets[0].data.mode === mode)
    }
    await until(() => timer.webContents.executeJavaScript(`document.querySelector('.timer-mode')?.textContent === '${mode === 'focus' ? '专注时间' : '休息时间'}' && document.querySelector('.timer-toggle')?.getAttribute('aria-label') === '开始'`))
    const sessions = host.read().widgets[0].data.sessions
    await timer.webContents.executeJavaScript('document.querySelector(".timer-toggle").click()')
    await until(() => host.read().widgets[0].data.running && host.read().widgets[0].data.mode === mode)
    assert.notEqual(host.read().widgets[0].data.petFocus?.status, 'active')
    const previousId = (await read(reopened)).focusNotice?.id
    await host.transact(workspace => { workspace.widgets[0].data.endsAt = Date.now() + 200; return { changed: true, value: null } })
    await until(() => !host.read().widgets[0].data.running)
    assert.equal(host.read().widgets[0].data.mode, mode === 'focus' ? 'break' : 'focus')
    assert.equal(host.read().widgets[0].data.sessions, sessions + (mode === 'focus' ? 1 : 0))
    const prefix = mode === 'focus' ? '专注' : '休息'
    await until(async () => { const n = (await read(reopened)).focusNotice; return n && n.id !== previousId && n.text.startsWith(prefix) })
    await until(() => (notice = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('surface=notice'))))
    await until(() => notice.webContents.executeJavaScript(`document.querySelector('.notice-copy p')?.textContent.startsWith('${prefix}')`))
    assert.equal(reopened.isVisible(), false)
    assert.equal(notice.isFocusable(), false)
    fs.writeFileSync(path.join(directory, `manual-${mode}-notice.png`), (await notice.webContents.capturePage()).toPNG())
  }
  assert.equal((await read(reopened)).messages.filter(message => message.notice).length, 2)
  await pet.dispose()
  pet = createDesktopPet({ dataDirectory, focusHost: createFocusPreview(dataDirectory) })
  pet.openChat()
  const finalChat = BrowserWindow.getAllWindows().find(win => win.getTitle().includes('聊一会儿'))
  await until(() => finalChat.webContents.executeJavaScript('Boolean(window.petAPI && document.querySelector("textarea"))'))
  assert.equal((await read(finalChat)).focusNotice, null)
  assert.equal((await read(finalChat)).messages.filter(message => message.notice).length, 2)
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, requests, directory }, null, 2))
  console.log(`PASS: pet start, manual focus + break buttons, closed-chat notices, phase counts, restart dedupe; ${directory}`)
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  await pet?.dispose()
  app.exit(process.exitCode || 0)
})
