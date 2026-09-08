// Render the real production UI with synthetic data, without starting the app host.
// Run: npm run build && npx electron scripts/capture-readme.cjs
const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const scratch = path.join(root, '.artifacts/readme-capture')
const output = path.join(root, 'docs/screenshots')
fs.mkdirSync(scratch, { recursive: true })
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(scratch, 'electron'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.on('window-all-closed', () => {})
const fixture = new Map(), captures = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = Date.now(), day = new Date().toLocaleDateString('en-CA')
const date = hour => new Date(new Date().setHours(hour, 0, 0, 0)).toISOString()
const city = { id: 'beijing-demo', name: '北京', label: '北京 · 中国' }
const petBase = {
  revision: 1, model: 'qwen3:4b-instruct', enabled: true, reminderSoundEnabled: false,
  messages: [
    { id: 'm1', role: 'user', content: '以后写代码45分钟，看书25分钟。' },
    { id: 'm2', role: 'assistant', content: '记住啦～写代码时专注45分钟，看书时25分钟。只对这些活动生效哦。' },
    { id: 'm3', role: 'user', content: '二十分钟后提醒我取快递。' },
    { id: 'm4', role: 'assistant', content: '记好啦～「取快递」已加入临时安排，到时间我来提醒你。' },
  ],
  busy: false, reply: '', error: '', reaction: null,
  reminders: { revision: 1, weather: { enabled: true, city, time: '08:30', repeat: 'weekdays' }, todo: { enabled: true, leadMinutes: 5 }, reminders: [] },
  memory: { revision: 1, habits: [
    { id: 'h1', label: '写代码时，专注 45 分钟', updatedAt: now, source: { text: '以后写代码45分钟，看书25分钟。', at: now } },
    { id: 'h2', label: '看书时，专注 25 分钟', updatedAt: now, source: { text: '以后写代码45分钟，看书25分钟。', at: now } },
    { id: 'h3', label: '睡觉时，11:00 指晚上', updatedAt: now, source: { text: '以后我说11点睡觉，就是晚上11点。', at: now } },
  ], operations: [
    { id: 'o1', label: '专注 45 分钟 · 写代码', at: now, source: { text: '陪我写会儿代码。', at: now } },
    { id: 'o2', label: '提醒 · 取快递', at: now, source: { text: '二十分钟后提醒我取快递。', at: now } },
  ] },
  voice: { phase: 'idle', ready: true, level: 0, progress: 100, error: '', trigger: 0, cancelRevision: 0, shortcut: 'Ctrl+Alt+V', shortcutAvailable: true, cancelShortcutAvailable: true },
  voiceBubble: null,
}
let workspace
function createWindow(width, height, pet = petBase) {
  const win = new BrowserWindow({ width, height, useContentSize: true, show: false, frame: false, transparent: true,
    webPreferences: { preload: path.join(__dirname, 'readme-capture-preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } })
  win.webContents.setFrameRate(30)
  const bounds = { x: 0, y: 0, width, height }
  fixture.set(win.webContents.id, { workspace, pet, desktop: { desktopPath: '', virtualBounds: bounds, primaryBounds: bounds, displays: [{ id: 'demo', primary: true, scaleFactor: 1, bounds }] },
    snapshots: [
      { id: 'demo-1', createdAt: date(9), reason: '手动创建快照', appVersion: '1.1.0', widgetCount: 4, displayCount: 1, sizeBytes: 8192, fileDataIncluded: false },
      { id: 'demo-2', createdAt: date(8), reason: '启动自动快照', appVersion: '1.1.0', widgetCount: 4, displayCount: 1, sizeBytes: 7680, fileDataIncluded: false },
    ] })
  win.webContents.setAudioMuted(true)
  return win
}
async function ready(win, selector) {
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
      await win.webContents.executeJavaScript('document.fonts.ready')
      await delay(350)
      return
    }
    await delay(40)
  }
  throw Error(`Missing screenshot UI: ${selector}`)
}
async function capture(win, name, published = true) {
  await win.webContents.executeJavaScript('document.activeElement?.blur()')
  await win.webContents.insertCSS('* { caret-color: transparent !important; }')
  await win.webContents.executeJavaScript(`document.getAnimations().forEach(a => { const timing = a.effect.getComputedTiming(); if (Number.isFinite(timing.endTime)) a.finish(); else { a.currentTime = 1000; a.pause() } })`)
  await win.webContents.capturePage()
  await delay(160)
  const image = await win.webContents.capturePage()
  const file = path.join(published ? output : scratch, name + '.png')
  fs.writeFileSync(file, image.toPNG())
  const size = image.getSize()
  if (published) captures.push({ file: path.basename(file), ...size, bytes: fs.statSync(file).size })
  return { file, ...size }
}
async function click(win, label) {
  const found = await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true })()`)
  assert.ok(found, `Button not found: ${label}`)
  await delay(160)
}
async function petView(surface, state = petBase, width = 420, height = 660) {
  const win = createWindow(width, height, state)
  await win.loadFile(path.join(root, 'dist/desktop-pet/index.html'), { query: { surface } })
  await ready(win, surface === 'chat' ? '.chat-panel' : surface === 'pet' ? '.mascot' : '.focus-notice')
  return win
}
const wallpaper = 'radial-gradient(ellipse at 10% 12%, #f6eedd 0%, transparent 47%), radial-gradient(ellipse at 94% 86%, #b8dacf 0%, transparent 52%), linear-gradient(132deg, #eaf1f5, #c9dce9 58%, #dfeadf)'
async function board(name, width, height, panels, extra = '') {
  const win = createWindow(width, height)
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:${wallpaper};font-family:'Segoe UI','Microsoft YaHei UI',sans-serif;color:#2e4941}img{position:absolute;display:block;object-fit:contain}.caption{position:absolute;font-size:19px;font-weight:600;letter-spacing:.5px}.caption small{display:block;font-size:13px;font-weight:400;color:#627c75;margin-top:7px}</style><body>${panels.map(p => `<img alt="演示界面" src="data:image/png;base64,${fs.readFileSync(p.file).toString('base64')}" style="left:${p.x}px;top:${p.y}px;width:${p.width}px;height:${p.height}px;${p.framed ? 'border-radius:16px;box-shadow:0 18px 45px #28475024;' : ''}">`).join('')}${extra}</body></html>`
  const file = path.join(scratch, name + '.html')
  fs.writeFileSync(file, html)
  await win.loadFile(file)
  await win.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.decode()))')
  await capture(win, name)
  win.destroy()
}
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false))
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
  ipcMain.handle('readme:read', (event, key) => fixture.get(event.sender.id)?.[key])
  const sampleDir = path.join(scratch, 'sample-files')
  fs.mkdirSync(sampleDir, { recursive: true })
  const files = []
  for (const [index, name] of ['项目资料', '设计参考', '阅读清单', '待整理', '本周计划.md', '使用说明.pdf', '产品草图.png', '灵感摘记.txt'].entries()) {
    const sample = path.join(sampleDir, name), isDirectory = !path.extname(name)
    if (isDirectory) fs.mkdirSync(sample, { recursive: true })
    else fs.writeFileSync(sample, 'eDesktop screenshot fixture')
    const icon = isDirectory ? null : await app.getFileIcon(sample, { size: 'large' })
    files.push({ id: `file-${index}`, path: sample, name, extension: path.extname(name).slice(1), size: 2048, isDirectory, modifiedAt: date(9), iconDataUrl: icon?.toDataURL() || '' })
  }
  workspace = { version: 1, settings: { desktopEnabled: true, desktopPetEnabled: true, launchAtLogin: false, snapshotAutoEnabled: true, snapshotRetention: 30 }, widgets: [
    { id: 'organizer', kind: 'organizer', title: '工作台', tone: 'graphite', x: 58, y: 74, width: 382, height: 302, hidden: false, data: { files } },
    { id: 'note', kind: 'note', title: '随手记', tone: 'yellow', x: 58, y: 408, width: 382, height: 250, hidden: false, data: { content: '今天的小目标\n\n把手头这件事做好。\n忙完以后，出去走走。', updatedAt: date(9) } },
    { id: 'todo', kind: 'todo', title: '今天要做的事', tone: 'paper', x: 472, y: 74, width: 586, height: 584, hidden: false, data: { activeList: 'my-day', items: [
      { id: 't1', text: '整理项目资料', list: 'my-day', completed: true, completedOn: day, startTime: '09:00', endTime: '09:30' },
      { id: 't2', text: '完成首页草图', list: 'my-day', completed: false, startTime: '10:00', endTime: '11:30' },
      { id: 't3', text: '读一章书', list: 'my-day', completed: false, startTime: '16:00', endTime: '16:30' },
      { id: 't4', text: '取快递', list: 'temporary', completed: false, reminderAt: new Date().setHours(17, 30, 0, 0) },
      { id: 't5', text: '给绿植浇水', list: 'temporary', completed: false },
    ] } },
    { id: 'pomodoro', kind: 'pomodoro', title: '专注一会儿', tone: 'emerald', x: 1090, y: 74, width: 292, height: 336, hidden: false, data: { mode: 'focus', focusMinutes: 25, breakMinutes: 5, remainingSeconds: 1500, running: false, endsAt: null, sessions: 2 } },
  ] }
  const desktop = createWindow(1440, 744)
  await desktop.loadFile(path.join(root, 'dist/index.html'), { query: { surface: 'desktop', displayId: 'demo', nativeCursor: '0' } })
  await ready(desktop, '.desktop-widget.widget-todo')
  await desktop.webContents.executeJavaScript(`document.querySelector('.desktop-surface').style.background = ${JSON.stringify(wallpaper)}`)
  const pet = await petView('pet', petBase, 160, 170)
  const cat = await capture(pet, 'mascot', false)
  const noticeState = { ...petBase, focusNotice: { id: 'demo', text: '专注了一会儿，起来伸个懒腰吧～小栖在这里等你。', expiresAt: now + 3600000 } }
  const notice = await petView('notice', noticeState, 306, 158)
  const bubble = await capture(notice, 'notice', false)
  await desktop.webContents.executeJavaScript(`(() => { for (const item of ${JSON.stringify([{ ...cat, x: 1160, y: 570 }, { ...bubble, x: 1084, y: 420 }].map(p => ({ x: p.x, y: p.y, width: p.width, height: p.height, uri: 'data:image/png;base64,' + fs.readFileSync(p.file).toString('base64') })))}) { const image = document.createElement('img'); image.src = item.uri; image.style.cssText = 'position:absolute;pointer-events:none;left:'+item.x+'px;top:'+item.y+'px;width:'+item.width+'px;height:'+item.height+'px'; document.body.append(image) } })()`)
  await capture(desktop, 'desktop-components')
  desktop.destroy(); notice.destroy(); pet.destroy()
  const control = createWindow(1080, 620)
  await control.loadFile(path.join(root, 'dist/index.html'), { query: { surface: 'control', capture: '1' } })
  await ready(control, '.control-center')
  await capture(control, 'control-center')
  for (const [label, name] of [['添加组件', 'control-center-add'], ['已有组件', 'control-center-widgets'], ['快照与恢复', 'control-center-snapshots']]) {
    await click(control, label); await capture(control, name)
  }
  control.destroy()
  const chat = await petView('chat')
  const chatImage = await capture(chat, 'chat', false)
  await click(chat, '天气与提醒')
  const settingsImage = await capture(chat, 'settings', false)
  await chat.webContents.executeJavaScript('document.querySelector(".memory-entry").click()')
  await ready(chat, '.memory-card')
  await chat.webContents.executeJavaScript('document.querySelector(".memory-card details").open = true')
  const memoryImage = await capture(chat, 'memory', false)
  await click(chat, '最近操作')
  const operationImage = await capture(chat, 'operations', false)
  chat.destroy()
  await board('pet-chat', 960, 752, [{ ...chatImage, x: 40, y: 46, framed: true }, { ...settingsImage, x: 500, y: 46, framed: true }])
  await board('pet-memory', 960, 752, [{ ...memoryImage, x: 40, y: 46, framed: true }, { ...operationImage, x: 500, y: 46, framed: true }])
  const listenState = { ...petBase, voice: { ...petBase.voice, phase: 'recording', surface: 'pet', level: .8, startedAt: Date.now() - 4000 }, voiceBubble: { id: 'voice-demo', phase: 'recording' } }
  const replyState = { ...petBase, voiceBubble: { id: 'voice-demo', phase: 'reply', transcript: '陪我专注一刻钟。', text: '开始啦～这次专注15分钟，小栖陪你一起。' }, reaction: { kind: 'focus', startedAt: now, endsAt: null } }
  const listenBubble = await petView('voice', listenState, 360, 238)
  const listenCat = await petView('pet', listenState, 168, 178)
  const replyBubble = await petView('voice', replyState, 360, 238)
  const replyCat = await petView('pet', replyState, 168, 178)
  const voicePanels = []
  for (const [win, name, x, y] of [[listenBubble, 'listen-bubble', 72, 100], [listenCat, 'listen-cat', 168, 328], [replyBubble, 'reply-bubble', 512, 100], [replyCat, 'reply-cat', 608, 328]]) {
    voicePanels.push({ ...await capture(win, name, false), x, y }); win.destroy()
  }
  await board('pet-voice', 944, 552, voicePanels, '<div class="caption" style="left:82px;top:43px">按一下，说给小栖听<small>Ctrl + Alt + V · 开始 / 结束</small></div><div class="caption" style="left:522px;top:43px">回复就在桌面上<small>聊天框保持收起</small></div>')
  fs.writeFileSync(path.join(scratch, 'manifest.json'), JSON.stringify({ source: 'production dist renderers with synthetic IPC data; no network or microphone', captures }, null, 2))
  console.log(JSON.stringify(captures, null, 2))
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
