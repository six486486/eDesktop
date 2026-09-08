const { app, BrowserWindow, globalShortcut } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createDesktopPet } = require('../main.cjs')
const { createFocusPreview } = require('../focus-preview.cjs')
const directory = path.resolve('.artifacts/desktop-pet-reminder-electron', `run-${Date.now()}`)
const dataDirectory = path.join(directory, 'data')
fs.mkdirSync(dataDirectory, { recursive: true }); app.setPath('userData', path.join(directory, 'electron')); app.on('window-all-closed', () => {})
fs.writeFileSync(path.join(dataDirectory, 'state.json'), JSON.stringify({ model: 'fixture', messages: [] }))
global.fetch = async url => {
  if (url.includes('geocoding-api')) return new Response(JSON.stringify({ results: [{ id: 1808926, name: '杭州', admin1: '浙江', country: '中国', latitude: 30.27, longitude: 120.15 }] }))
  if (url.includes('api.open-meteo.com')) return new Response(JSON.stringify({ daily: { time: ['2026-09-06'], weather_code: [61], temperature_2m_min: [22], temperature_2m_max: [30], precipitation_probability_max: [80] } }))
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'fixture' }] }))
  if (url.endsWith('/api/generate')) return new Response(JSON.stringify({ done: true }))
  return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ assessment: '用户请求稍后提醒取快递', decision: { action: 'reminder.create', params: { text: '取快递', when: '四十分钟后', timeOfDay: 'auto' } }, response: { text: '好。', visual: 'none' } }) } }) + '\n')
}
let pet
globalShortcut.register = () => false; globalShortcut.unregister = () => {}; globalShortcut.isRegistered = () => false
const delay = ms => new Promise(r => setTimeout(r, ms))
async function until(check) { for (let i = 0; i < 160; i++) { if (await check()) return; await delay(50) } throw new Error('reminder UI timeout') }
const evaluate = (win, js) => win.webContents.executeJavaScript(js)
const read = win => evaluate(win, 'window.petAPI.getState()')
const click = (win, label) => evaluate(win, `Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.textContent.trim() === ${JSON.stringify(label)}).click()`)
const fill = (win, label, value) => evaluate(win, `(() => {const field = document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`)
async function opened() {
  pet.openChat(); const chat = BrowserWindow.getAllWindows().find(w => w.getTitle().includes('聊一会儿'))
  await until(() => evaluate(chat, 'Boolean(window.petAPI && document.querySelector("textarea"))')); return chat
}
async function screenshot(win, name) { await delay(550); fs.writeFileSync(path.join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG()) }
app.whenReady().then(async () => {
  const host = createFocusPreview(dataDirectory); pet = createDesktopPet({ dataDirectory, focusHost: host }); let chat = await opened()
  await click(chat, '天气与提醒'); await until(() => evaluate(chat, 'Boolean(document.querySelector(".reminder-settings"))'))
  await fill(chat, '搜索天气城市', '杭州'); await delay(30); await click(chat, '搜索城市')
  await until(() => evaluate(chat, 'Boolean(document.querySelector(".reminder-city-results button"))'))
  await click(chat, '杭州 · 浙江 · 中国'); await evaluate(chat, 'document.querySelector("[aria-label=天气定时播报]").click()')
  await fill(chat, '天气播报时间', '09:00'); await delay(30); await click(chat, '保存设置')
  await until(async () => (await read(chat)).reminders.weather.time === '09:00'); assert.equal((await read(chat)).reminders.weather.enabled, true)
  await screenshot(chat, 'weather-settings')
  const html = await evaluate(chat, `(() => {
    const source = document.querySelector('main.chat-panel'), clone = source.cloneNode(true)
    source.querySelectorAll('input').forEach((field, i) => { const copy = clone.querySelectorAll('input')[i]; copy.setAttribute('value', field.value); if (field.checked) copy.setAttribute('checked', ''); else copy.removeAttribute('checked') })
    source.querySelectorAll('select').forEach((field, i) => { clone.querySelectorAll('select')[i].querySelectorAll('option').forEach(option => { if (option.value === field.value) option.setAttribute('selected', ''); else option.removeAttribute('selected') }) })
    return clone.outerHTML
  })()`), css = fs.readFileSync(path.resolve('desktop-pet/pet.css'), 'utf8')
  fs.writeFileSync(path.join(directory, 'weather-settings.html'), `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小栖 · 天气与提醒</title><style>${css}</style></head><body><div id="root" class="w-full h-full">${html.replace('href="https://open-meteo.com/"', 'id="weather-provider-attribution" href="https://open-meteo.com/"')}</div></body></html>`)
  await click(chat, '查看已保存城市的天气'); await until(() => evaluate(chat, 'document.querySelector(".reminder-feedback")?.textContent.includes("22–30℃")'))
  await click(chat, '返回聊天'); await evaluate(chat, 'window.petAPI.send("四十分钟后提醒我取快递")')
  await until(async () => !(await read(chat)).busy && (await read(chat)).reminders.reminders.length === 1)
  assert.equal(host.read().widgets.find(w => w.kind === 'todo').data.items[0].list, 'temporary')
  let preview
  await until(() => (preview = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('focus-preview'))))
  preview.show(); preview.focus()
  await until(() => evaluate(preview, 'document.querySelector(".todo-item-copy")?.textContent.includes("取快递")'))
  await screenshot(preview, 'temporary-todo')
  await click(preview, '设置待办：取快递'); await until(() => evaluate(preview, 'Boolean(document.querySelector("[aria-label=临时提醒时间]"))'))
  await screenshot(preview, 'temporary-reminder-edit')
  await fill(preview, '临时提醒时间', '2026-09-08T16:00'); await delay(30); await click(preview, '保存')
  await until(() => host.read().widgets[0].data.items[0].reminderAt === new Date(2026, 8, 8, 16).getTime())
  await click(preview, '设置待办：取快递'); await until(() => evaluate(preview, 'Boolean(document.querySelector("[aria-label=临时提醒时间]"))'))
  await click(preview, '清除时间'); await delay(30); await click(preview, '保存')
  await until(() => host.read().widgets[0].data.items[0].reminderAt === undefined)
  await evaluate(chat, 'window.petAPI.reset(); window.petAPI.closeChat()'); await until(() => !chat.isVisible())
  // Only this isolated fixture's deadline is brought forward for a real timer wakeup.
  await host.transact(w => { w.widgets[0].data.items[0].reminderAt = Date.now() + 200; return { changed: true } })
  await until(async () => (await read(chat)).messages.some(m => m.notice && m.content.includes('取快递')))
  assert.equal(chat.isVisible(), false); assert.equal(host.read().widgets[0].data.items[0].completed, false)
  let notice
  await until(() => (notice = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('surface=notice'))))
  await until(() => evaluate(notice, 'document.querySelector(".notice-copy p")?.textContent.includes("取快递")')); assert.equal(notice.isFocusable(), false)
  await screenshot(notice, 'temporary-notice')
  await pet.dispose(); pet = createDesktopPet({ dataDirectory, focusHost: createFocusPreview(dataDirectory) }); chat = await opened()
  assert.equal((await read(chat)).focusNotice, null); assert.equal((await read(chat)).reminders.weather.time, '09:00')
  assert.equal((await read(chat)).messages.filter(m => m.notice && m.content.includes('取快递')).length, 1)
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, directory }, null, 2)); console.log(`PASS reminder settings, real todo editor, delivery, closed-chat, restart: ${directory}`)
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await pet?.dispose(); app.exit(process.exitCode || 0) })
