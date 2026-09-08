// Real capture and offline ASR using synthesized fixture audio, never the user's microphone.
const { app, BrowserWindow, globalShortcut } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createDesktopPet } = require('../main.cjs')
const { createFocusPreview } = require('../focus-preview.cjs')
const { VoiceModel } = require('../voice-model.cjs')
const directory = path.resolve('.artifacts/voice-electron', `run-${Date.now()}`), dataDirectory = path.join(directory, 'data')
const sample = path.resolve('.artifacts/voice-fixture/reminder.wav')
fs.mkdirSync(path.dirname(sample), { recursive: true })
require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $voiceFixture = New-Object System.Speech.Synthesis.SpeechSynthesizer; $voiceFixture.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo('zh-CN')); $voiceFixture.SetOutputToWaveFile('${sample.replace(/'/g,"''")}'); $voiceFixture.SpeakSsml('<speak version="1.0" xml:lang="zh-CN"><break time="800ms"/>十分钟后提醒我取快递。<break time="300ms"/></speak>'); $voiceFixture.Dispose()`], { windowsHide: true })
fs.mkdirSync(dataDirectory, { recursive: true }); app.setPath('userData', path.join(directory, 'electron'))
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', sample)
app.on('window-all-closed', () => {})
fs.writeFileSync(path.join(dataDirectory, 'state.json'), JSON.stringify({ model: 'fixture', messages: [] }))
const model = new VoiceModel({ directory: path.resolve('.artifacts/voice-model/sensevoice') })
assert.ok(model.ready(), 'prepare offline speech model before this test')
let pet, requests = 0, offline = false, delayReply = false, releaseReply
const callbacks = new Map(), register = globalShortcut.register.bind(globalShortcut)
globalShortcut.register = (key, callback) => { callbacks.set(key, callback); return register(key, callback) }
const shortcut = () => callbacks.get('Control+Alt+V')()
global.fetch = async (url, options) => {
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'fixture' }] }))
  if (url.endsWith('/api/generate')) return new Response(JSON.stringify({ done: true }))
  const body = JSON.parse(options.body)
  if (!body.format?.properties?.decision) return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify(Object.fromEntries(Object.entries(body.format.properties).map(([key, value]) => [key, value.type === 'array' ? [] : '无长期偏好']))) } }))
  requests++
  if (offline) throw new TypeError('fetch failed')
  if (delayReply) await new Promise(resolve => { releaseReply = resolve })
  const source = body.messages.filter(m => m.role === 'user').at(-1).content
  const when = source.match(/(?:\d+|十)分钟后/)?.[0]
  assert.ok(when)
  return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ assessment: '用户请求稍后提醒取快递', decision: { action: 'reminder.create', params: { text: '取快递', when, timeOfDay: 'auto' } }, response: { text: '好。', visual: 'none' } }) } }) + '\n')
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(50) } throw Error('voice UI timeout') }
const evaluate = (win, js) => win.webContents.executeJavaScript(js, true)
const state = win => evaluate(win, 'window.petAPI.getState()')
const petWin = () => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('surface=pet'))
const bubbleWin = () => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('surface=voice'))
async function capture(win, name) { await delay(150); fs.writeFileSync(path.join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
async function trackMicrophone(win) {
  await evaluate(win, `(() => { window.testVoiceTracks=[];const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>{const stream=await get(options);window.testVoiceTracks.push(...stream.getTracks());return stream} })()`)
}
async function recordCommand() {
  shortcut(); await until(async () => (await state(petWin())).voice.phase === 'recording')
  await delay(4200); shortcut()
}
app.whenReady().then(async () => {
  const host = createFocusPreview(dataDirectory); host.preview = false
  pet = createDesktopPet({ dataDirectory, focusHost: host, voiceModel: model })
  pet.openChat(); const chat = BrowserWindow.getAllWindows().find(win => win.getTitle().includes('聊一会儿'))
  await until(() => evaluate(chat, 'Boolean(document.querySelector("[aria-label=语音输入]") && document.querySelector(".model-dot.connected"))'))
  await trackMicrophone(chat); await trackMicrophone(petWin())
  await evaluate(chat, `(() => { const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'保留我的文字草稿');t.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await evaluate(chat, 'window.petAPI.closeChat()')
  let chatShows = 0; chat.on('show', () => chatShows++)
  shortcut(); await until(async () => (await state(petWin())).voice.phase === 'recording')
  await until(() => bubbleWin() && evaluate(bubbleWin(), 'Boolean(document.querySelector(".voice-bubble-recording"))'))
  assert.equal(chat.isVisible(), false); assert.equal(bubbleWin().isFocusable(), false)
  assert.equal((await state(petWin())).voice.surface, 'pet')
  await until(() => evaluate(petWin(), 'Boolean(document.querySelector(".mascot-listening"))'))
  await until(async () => (await state(petWin())).voice.level > .05)
  await capture(petWin(), 'listening-cat'); await capture(bubbleWin(), 'recording')
  const listeningCat = await evaluate(petWin(), 'document.querySelector("svg").outerHTML')
  const listeningBubble = await evaluate(bubbleWin(), 'document.querySelector(".voice-bubble").outerHTML')
  // Explicitly switching to chat exits the desktop recording.
  pet.openChat(); await until(() => chat.isVisible())
  // Opening chat is an explicit switch; it cancels the pet microphone.
  await until(async () => (await state(chat)).voice.phase === 'idle')
  assert.equal(await evaluate(petWin(), 'window.testVoiceTracks.every(track=>track.readyState === "ended")'), true)
  await evaluate(chat, 'window.petAPI.closeChat()'); chatShows = 0
  await recordCommand()
  await until(async () => (await state(petWin())).voiceBubble?.phase === 'reply', 60000)
  const final = await state(petWin()), transcript = final.messages.find(m => m.role === 'user').content
  assert.match(transcript, /(?:10|十)分钟后提醒我取快递/); assert.equal(requests, 1)
  assert.match(final.voiceBubble.text, /已加入临时安排/)
  assert.equal(host.read().widgets.find(w => w.kind === 'todo').data.items[0].text, '取快递')
  const remaining = host.read().widgets.find(w => w.kind === 'todo').data.items[0].reminderAt - Date.now()
  assert.ok(remaining > 590000 && remaining <= 600000)
  assert.equal(chatShows, 0); assert.equal(chat.isVisible(), false)
  assert.equal(await evaluate(chat, 'document.querySelector("textarea").value'), '保留我的文字草稿')
  assert.equal(await evaluate(petWin(), 'window.testVoiceTracks.every(track=>track.readyState === "ended")'), true)
  await until(() => evaluate(bubbleWin(), 'Boolean(document.querySelector(".voice-bubble-reply"))'))
  await capture(bubbleWin(), 'reply'); await capture(petWin(), 'reply-cat')
  const replyBubble = await evaluate(bubbleWin(), 'document.querySelector(".voice-bubble").outerHTML')
  const replyCat = await evaluate(petWin(), 'document.querySelector("svg").outerHTML')
  // Meow follows real audio playback events; capture the mouth mid-clip.
  pet.openChat(); await until(() => chat.isVisible())
  await evaluate(chat, 'document.querySelector("[aria-label=小栖设置]").click()')
  await until(() => evaluate(chat, 'Boolean(document.querySelector("[aria-label=试听喵声]"))'))
  chat.webContents.setAudioMuted(true)
  await evaluate(chat, 'document.querySelector("[aria-label=试听喵声]").click()')
  await until(() => evaluate(petWin(), 'Boolean(document.querySelector(".mascot-meowing"))'))
  await delay(160); await capture(petWin(), 'meowing-cat')
  const meowingCat = await evaluate(petWin(), 'document.querySelector("svg").outerHTML')
  assert.ok(await evaluate(petWin(), 'Number(getComputedStyle(document.querySelector(".pet-mouth-open")).opacity) > .9'))
  await until(() => evaluate(petWin(), '!document.querySelector(".mascot-meowing")'))
  await evaluate(chat, 'document.querySelector("[aria-label=返回聊天]").click()')
  // Chat microphone still works, and Escape releases its tracks without sending.
  await evaluate(chat, 'document.querySelector("[aria-label=语音输入]").click()')
  await until(async () => (await state(chat)).voice.phase === 'recording')
  assert.equal((await state(chat)).voice.surface, 'chat')
  chat.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  await until(async () => (await state(chat)).voice.phase === 'idle')
  assert.equal(await evaluate(chat, 'window.testVoiceTracks.every(track=>track.readyState === "ended")'), true)
  await evaluate(chat, 'window.petAPI.closeChat()')
  shortcut(); await until(async () => (await state(petWin())).voice.phase === 'recording')
  assert.equal(globalShortcut.isRegistered('Escape'), true)
  callbacks.get('Escape')(); await until(async () => (await state(petWin())).voice.phase === 'idle')
  assert.equal(globalShortcut.isRegistered('Escape'), false); assert.equal(requests, 1)
  assert.equal(await evaluate(petWin(), 'window.testVoiceTracks.every(track=>track.readyState === "ended")'), true)
  // Offline LLM is an honest bubble; it does not open chat or create another todo.
  offline = true; await recordCommand()
  await until(async () => (await state(petWin())).voiceBubble?.phase === 'error', 60000)
  assert.match((await state(petWin())).voiceBubble.text, /Ollama|连接/)
  assert.equal(host.read().widgets[0].data.items.length, 1); assert.equal(chat.isVisible(), false)
  offline = false; delayReply = true; await recordCommand()
  await until(() => Boolean(releaseReply), 60000)
  await evaluate(bubbleWin(), 'document.querySelector("[aria-label=停止本次回复]").click()')
  releaseReply(); await delay(350)
  assert.equal(host.read().widgets[0].data.items.length, 1, 'cancelled late model response must not create a task')
  assert.equal((await state(petWin())).voiceBubble, null)
  const css = fs.readFileSync('desktop-pet/pet.css', 'utf8')
  const cards = [ ['竖起耳朵，听你说', listeningBubble, listeningCat], ['听清之后，轻轻回应', replyBubble, replyCat], ['喵～提醒你一下', '<div class="focus-notice"><div class="notice-copy"><p>专注时间到啦，伸个懒腰喵～</p></div></div>', meowingCat] ]
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小栖 · 说给我听</title><style>${css}\n#voice-board{height:100%;display:flex;gap:30px;align-items:center;justify-content:center;background:#edece4;padding:28px}.voice-example{width:300px;flex-shrink:0}.voice-example>h2{font:14px 'Microsoft YaHei UI',sans-serif;color:#718573;margin:0 0 24px}.voice-scene{height:390px;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch}.voice-cat{width:132px;height:140px;align-self:flex-end;margin-right:22px;margin-top:14px}.voice-cat>.mascot{width:132px;height:140px}</style></head><body><div id="voice-board" class="w-full h-full">${cards.map(([title,bubble,cat])=>`<section class="voice-example"><h2>${title}</h2><div class="voice-scene">${bubble}<div class="voice-cat">${cat}</div></div></section>`).join('')}</div></body></html>`
  fs.writeFileSync(path.join(directory, 'preview.html'), html.replace('</style>', '.voice-example .voice-bubble{animation:none;opacity:1}</style>'))
  const preview = new BrowserWindow({ width: 1080, height: 530, frame: false, show: false, webPreferences: { sandbox: true } })
  await preview.loadFile(path.join(directory, 'preview.html')); await delay(600); await capture(preview, 'preview'); preview.destroy()
  await pet.dispose(); pet = null
  assert.equal(globalShortcut.isRegistered('Control+Alt+V'), false)
  // Cold shortcut: no chat window is even created, including before pet load finishes.
  pet = createDesktopPet({ dataDirectory, focusHost: host, voiceModel: model }); shortcut()
  await until(async () => petWin() && (await state(petWin())).voice.phase === 'recording')
  assert.equal(BrowserWindow.getAllWindows().some(win => win.getTitle().includes('聊一会儿')), false)
  pet.setVisible(false)
  assert.equal((await state(petWin())).voice.phase, 'idle')
  assert.equal(bubbleWin().isVisible(), false)
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, directory, transcript, requests }, null, 2))
  console.log('PASS pet shortcut -> actual audio meter -> offline ASR -> tool -> bubble, meow mouth, chat draft, Escape, cancellation, offline failure, cold shortcut and shutdown: ' + directory)
}).catch(async error => {
  console.error(error)
  if (petWin()) { console.error(JSON.stringify(await state(petWin()))); await capture(petWin(), 'failed-pet') }
  if (bubbleWin()) await capture(bubbleWin(), 'failed-bubble')
  process.exitCode = 1
}).finally(async () => { releaseReply?.(); await pet?.dispose(); app.exit(process.exitCode || 0) })
