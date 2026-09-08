import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUp, BellRing, Mic, PawPrint, RefreshCw, RotateCcw, Square, X } from 'lucide-react'
import type { PetState } from './types'
import { ReminderSettings } from './reminder-settings'
import { useVoiceInput } from './use-voice-input'
import { useReminderSound } from './reminder-sound'
import './pet.css'

const initialState: PetState = { revision: -1, model: '', messages: [], busy: false, reply: '', error: '', reaction: null }
const api = window.petAPI

function usePetState() {
  const [state, setState] = useState(initialState)
  useEffect(() => {
    let active = true
    const accept = (next: PetState) => { if (active) setState((previous) => next.revision >= previous.revision ? next : previous) }
    const unsubscribe = api?.onState(accept)
    void api?.getState().then(accept).catch(() => {
      if (active) setState((previous) => ({ ...previous, error: '桌宠连接中断，请重新打开 eDesktop。' }))
    })
    return () => { active = false; unsubscribe?.() }
  }, [])
  return state
}

function useReaction(state: PetState) {
  const [, redraw] = useState(0)
  const endsAt = state.reaction?.endsAt
  useEffect(() => {
    if (!endsAt) return
    const timer = setTimeout(() => redraw((value) => value + 1), Math.max(0, endsAt - Date.now()))
    return () => clearTimeout(timer)
  }, [endsAt])
  return state.reaction && (!endsAt || endsAt > Date.now()) ? state.reaction : null
}

type Mood = 'idle' | 'sleep' | 'thinking' | 'awake' | 'happy' | 'focus' | 'rest' | 'listening'

function Mascot({ mood = 'idle', meowing = false, level = 0 }: { mood?: Mood; meowing?: boolean; level?: number }) {
  const lift = mood === 'listening' ? 1 + Math.max(0, Math.min(1, level)) * .12 : 0
  const ear = (rest: number, raised: number) => +(rest + (raised - rest) * lift).toFixed(3)
  // One closed silhouette keeps the ear roots attached throughout interpolation.
  // The resting path is the original cat outline; only the ear tips deform.
  const head = `M28 51L${ear(26, 30)} ${ear(23, 18)}C${ear(26, 30)} ${ear(17, 12)} ${ear(31, 35)} ${ear(15, 10)} ${ear(36, 39)} ${ear(19, 15)}L53 32C61 30 73 30 80 32L${ear(98, 94)} ${ear(19, 14)}C${ear(103, 99)} ${ear(15, 9)} ${ear(108, 104)} ${ear(18, 11)} ${ear(107, 104)} ${ear(24, 18)}L104 52C111 63 112 79 104 88C91 102 41 102 28 88C19 77 20 64 28 51Z`
  const leftInner = `M${ear(33, 36)} ${ear(29, 22)}L34 ${ear(45, 43)}L${ear(44, 47)} ${ear(36, 34)}Z`
  const rightInner = `M${ear(99, 98)} ${ear(29, 21)}L${ear(96, 97)} ${ear(45, 43)}L${ear(88, 86)} ${ear(36, 35)}Z`
  return (
    <svg className={`mascot mascot-${mood}${meowing ? ' mascot-meowing' : ''}`} style={{ '--pet-head-shape': `path("${head}")`, '--pet-left-inner': `path("${leftInner}")`, '--pet-right-inner': `path("${rightInner}")` } as React.CSSProperties} viewBox="0 0 132 140" fill="none" aria-hidden="true">
      <ellipse className="pet-shadow" cx="66" cy="125" rx="33" ry="6" fill="#273e34" opacity=".13" />
      <g className="pet-motion"><g className="pet-body">
        <path className="pet-tail" d="M100 105C124 104 124 80 111 84" stroke="#d9cbb5" strokeWidth="12" strokeLinecap="round" />
        <path className="pet-torso" d="M38 86C28 93 27 108 31 116C35 123 97 123 101 116C105 107 102 94 94 86Z" fill="#e9ddc8" stroke="#80745f" strokeWidth="2" />
        {/* The collar stays attached to the head, with the torso overlapping behind it. */}
        <g className="pet-upper">
        <g className="pet-head">
        <path className="pet-head-outline" d={head} fill="#f6ecd9" stroke="#80745f" strokeWidth="2.2" strokeLinejoin="round" />
        <path className="pet-ear-inner pet-ear-inner-left" d={leftInner} fill="#dab0a0" />
        <path className="pet-ear-inner pet-ear-inner-right" d={rightInner} fill="#dab0a0" />
        <path d="M60 33L63 43M70 33L69 42" stroke="#dccbb0" strokeWidth="3.5" strokeLinecap="round" />
        <g className="pet-face">
          <g className="pet-eyes" fill="#4d5148">
            <ellipse cx="47" cy="65" rx="3" ry="4.5" /><ellipse cx="85" cy="65" rx="3" ry="4.5" />
          </g>
          <g className="pet-sleep-eyes" stroke="#4d5148" strokeWidth="2.4" strokeLinecap="round">
            <path d="M42 66Q47 69 52 65M80 65Q85 69 90 66" />
          </g>
          <g className="pet-happy-eyes" stroke="#4d5148" strokeWidth="2.4" strokeLinecap="round">
            <path d="M42 66Q47 58 52 66M80 66Q85 58 90 66" />
          </g>
          <ellipse cx="35" cy="75" rx="7" ry="4" fill="#e7b4a0" opacity=".65" />
          <ellipse cx="97" cy="75" rx="7" ry="4" fill="#e7b4a0" opacity=".65" />
          <path d="M63 73Q66 69 69 73L66 76Z" fill="#ab8a77" />
          <g className="pet-mouth-open"><path d="M61 79C63 80 66 79 66 76C66 79 69 80 71 79C70 83 68.5 85 66 85C63.5 85 62 83 61 79Z" fill="#946c63" stroke="#80745f" strokeWidth="1.2" strokeLinejoin="round" /><path d="M63.4 83Q66 81 68.6 83Q66 85 63.4 83Z" fill="#e5ada4" /></g>
          <path className="pet-mouth-line" d="M66 76C66 81 60 81 59 77M66 76C66 81 72 81 73 77" stroke="#80745f" strokeWidth="1.6" strokeLinecap="round" />
        </g>
        </g>
        <path d="M36 93Q65 105 97 92L95 102Q65 114 36 102Z" fill="#548477" />
        <path className="pet-scarf-end" d="M79 102L90 101L88 118L76 115Z" fill="#548477" />
        <path d="M39 98Q60 107 78 102" stroke="#6c9a8d" strokeWidth="2" strokeLinecap="round" />
        </g>
        <g fill="#f6ecd9" stroke="#80745f" strokeWidth="1.8" strokeLinejoin="round">
          <path className="pet-paw-left" d="M38 111C34 111 33 117 35 120C38 123 49 123 52 120C54 117 51 111 48 111Z" />
          <path className="pet-paw-right" d="M84 111C80 111 79 117 81 120C84 123 95 123 98 120C100 117 97 111 94 111Z" />
        </g>
        <path className="pet-toes" d="M40 119L40 122M46 119L46 122M86 119L86 122M92 119L92 122" stroke="#b0a08a" strokeWidth="1.2" strokeLinecap="round" />
      </g></g>
      {mood === 'thinking' && <g className="pet-thinking" fill="#548477"><circle cx="56" cy="10" r="2.2" /><circle cx="66" cy="7" r="2.2" /><circle cx="76" cy="10" r="2.2" /></g>}
    </svg>
  )
}

function Pet() {
  const state = usePetState()
  const voiceInput = useVoiceInput(state.voice, async () => {}, message => { if (message) api?.voiceError(message) }, 'pet')
  const listening = ['requesting', 'recording'].includes(state.voice?.phase || '')
  const reaction = useReaction(state)
  const [sleeping, setSleeping] = useState(false)
  const [hovered, setHovered] = useState(false)
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const wake = useCallback(() => {
    setSleeping(false)
    clearTimeout(sleepTimer.current)
    sleepTimer.current = setTimeout(() => setSleeping(true), 90000)
  }, [])
  useEffect(() => { wake(); return () => clearTimeout(sleepTimer.current) }, [wake, state.busy])
  return (
    <button className="pet-button" aria-label="小栖，点击聊天，拖动移动" title="点击聊天 · 拖动移动 · 右键菜单"
      onPointerEnter={() => { setHovered(true); wake() }} onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.screenX, y: event.screenY, moved: false }
        api?.drag('start')
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        if (Math.hypot(event.screenX - drag.current.x, event.screenY - drag.current.y) > 5) drag.current.moved = true
        if (drag.current.moved) api?.drag('move', { x: event.screenX - drag.current.x, y: event.screenY - drag.current.y })
      }}
      onPointerUp={(event) => {
        if (!drag.current) return
        const moved = drag.current.moved
        drag.current = null
        api?.drag('end')
        event.currentTarget.releasePointerCapture(event.pointerId)
        if (!moved) { if (state.voice?.phase === 'recording') api?.toggleVoice(); else if (voiceInput.active) api?.dismissVoice(); else api?.openChat() }
      }}
      onPointerCancel={() => { drag.current = null; api?.drag('end') }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); wake(); api?.openChat() } }}
      onContextMenu={(event) => { event.preventDefault(); api?.menu() }}>
      <Mascot mood={listening ? 'listening' : state.voice?.phase === 'transcribing' || state.busy ? 'thinking' : state.meowing ? 'awake' : reaction?.kind ?? (hovered ? 'awake' : state.focus?.running ? 'rest' : sleeping ? 'sleep' : 'idle')} meowing={state.meowing} level={state.voice?.level} />
    </button>
  )
}

function Chat() {
  const state = usePetState()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const reaction = useReaction(state)
  const [text, setText] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const modelLoad = useRef<Promise<void> | null>(null)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [notice, setNotice] = useState('')
  const [waitingSeconds, setWaitingSeconds] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const voiceInput = useVoiceInput(state.voice, async transcript => {
    const keepTranscript = () => setText(current => current ? `${current}\n${transcript}` : transcript)
    if (!api || !state.model || ollamaConnected !== true) { keepTranscript(); setNotice('已经转成文字啦，连上 Ollama 后就能发送。'); return }
    try { await api.send(transcript) }
    catch (error) { keepTranscript(); setNotice(errorText(error)) }
  }, setNotice)
  const loadModels = useCallback(() => {
    if (modelLoad.current) return modelLoad.current
    const operation = (async () => {
      if (!api) { setNotice('请从 eDesktop 中打开桌宠。'); return }
      setLoading(true)
      setNotice('')
      try {
        const names = await api.listModels()
        setOllamaConnected(true)
        setModels(names)
        const current = await api.getState()
        if (!current.model && names.length) await api.setModel(names[0])
        if (!names.length) setNotice('已连接 Ollama，但还没有聊天模型。请先安装一个模型，然后点刷新。')
        else if (current.model && !names.includes(current.model)) setNotice('上次使用的模型已不在本机，请重新选择。')
      } catch (error) { setOllamaConnected(false); setModels([]); setNotice(errorText(error)) }
      finally { setLoading(false) }
    })()
    modelLoad.current = operation
    void operation.finally(() => { if (modelLoad.current === operation) modelLoad.current = null })
    return operation
  }, [])
  useEffect(() => { void loadModels() }, [loadModels])
  useEffect(() => api?.onChatOpened(() => { input.current?.focus(); void loadModels() }), [loadModels])
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }) }, [state.messages, state.reply])
  useEffect(() => {
    setWaitingSeconds(0)
    if (!state.busy || state.reply) return
    const started = Date.now()
    const timer = setInterval(() => setWaitingSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [state.busy, state.reply])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (voiceInput.active) voiceInput.cancel(); else api?.closeChat() } }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [voiceInput.active, voiceInput.cancel])
  const send = async () => {
    if (!api || !text.trim() || sendingRef.current || voiceInput.active || !state.model || ollamaConnected !== true) return
    const submitted = text
    sendingRef.current = true
    setSending(true)
    setNotice('')
    try { await api.send(submitted); setText((current) => current === submitted ? '' : current) }
    catch (error) { setNotice(errorText(error)) }
    finally { sendingRef.current = false; setSending(false); input.current?.focus() }
  }
  const error = notice || state.error
  const waitingText = waitingSeconds >= 8 ? '模型还在准备，小栖等它一下…' : '让小栖想一想…'
  const reset = async () => {
    if (!api) return
    setNotice('')
    try { await api.reset(); setWaitingSeconds(0); input.current?.focus() }
    catch (error) { setNotice(errorText(error)) }
  }
  return (
    <main className="chat-panel">
      <header className="chat-header">
        <div className="chat-avatar"><Mascot mood={['requesting', 'recording'].includes(state.voice?.phase || '') ? 'listening' : reaction?.kind ?? (state.busy ? 'thinking' : 'idle')} meowing={state.meowing} level={state.voice?.level} /></div>
        <div className="chat-heading"><h1>小栖</h1><p>{state.busy ? waitingText : state.focus?.running ? '陪你专注中。' : '在这儿，慢慢聊。'}</p></div>
        {state.reminders && <button className={`icon-button reminder-entry${settingsOpen ? ' is-active' : ''}`} aria-label="天气与提醒" title="天气与提醒" aria-expanded={settingsOpen} onClick={() => { voiceInput.cancel(); setSettingsOpen(value => !value) }}><BellRing size={17} strokeWidth={1.8} /></button>}
        <button className="icon-button" aria-label="重新聊" title="清空当前对话" onClick={() => void reset()}><RotateCcw size={15} /></button>
        <button className="icon-button" aria-label="收起聊天" title="收起聊天（Esc）" onClick={() => api?.closeChat()}><X size={17} /></button>
      </header>
      {settingsOpen && state.reminders ? <ReminderSettings settings={state.reminders} memory={state.memory} soundEnabled={state.reminderSoundEnabled !== false} onClose={() => setSettingsOpen(false)} /> : <>
      <div className="chat-history" ref={scroll} role="log" aria-label="聊天记录">
        {state.messages.length === 0 && !state.busy && <div className="chat-empty"><Mascot /><p>小栖在呢，想聊什么呀？</p></div>}
        {state.messages.map((message) => <div key={message.id} className={`chat-message message-${message.role}`}>
          <span className="sr-only">{message.role === 'user' ? '你：' : '小栖：'}</span>
          {message.role === 'assistant' ? <ReplyText text={message.content} /> : <p>{message.content}</p>}
          {message.interrupted && <small>回复已中断</small>}
        </div>)}
        {state.busy && <div className="chat-message message-assistant current-reply">
          {state.reply ? <ReplyText text={state.reply} streaming /> : <div className="waiting-reply"><span className="thinking-dots" aria-label={waitingText}><i /><i /><i /></span><small>{waitingText}</small></div>}
        </div>}
      </div>
      <footer className="chat-footer">
        {error && <p className="chat-notice" role="alert">{error}</p>}
        {state.voice && <div className={`voice-status${voiceInput.active ? ' voice-active' : ''}`} role="status">
          <span>{voiceInput.phase === 'downloading' ? `准备离线语音 · ${state.voice.progress}%`
            : voiceInput.phase === 'requesting' ? '正在连接麦克风…'
            : voiceInput.phase === 'recording' ? `小栖在听 · ${voiceInput.seconds} 秒 · 再按结束并发送`
            : voiceInput.phase === 'transcribing' ? '小栖在把声音变成文字…'
            : state.voice.error || (!state.voice.ready ? '首次使用需下载语音模型 · 229 MB'
              : !state.voice.shortcutAvailable ? '快捷键被占用啦，可以点麦克风说话' : 'Ctrl+Alt+V 说话 · 结束后自动发送')}</span>
          {voiceInput.active && <button type="button" onClick={voiceInput.cancel} aria-label="取消语音输入" title="取消语音（Esc）"><X size={12} /></button>}
        </div>}
        <form className="chat-compose" onSubmit={(event) => { event.preventDefault(); void send() }}>
          <textarea ref={input} value={text} maxLength={2000} rows={2} autoFocus aria-label="发给小栖的消息"
            placeholder={state.busy ? '可以继续补充…' : ollamaConnected === false ? '请先启动 Ollama…' : '和小栖说句话…'} onChange={(event) => setText(event.target.value)}
            onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
                event.preventDefault(); void send()
              }
            }} />
          <div className="compose-actions">
          {state.voice && <button type="button" className={`voice-button${voiceInput.phase === 'recording' ? ' is-recording' : ''}`} aria-label={voiceInput.phase === 'recording' ? '结束录音并发送' : state.voice.ready ? '语音输入' : '下载离线语音模型'} title="语音输入（Ctrl+Alt+V），Esc 取消" disabled={voiceInput.active && voiceInput.phase !== 'recording'} onClick={() => void voiceInput.toggle()}>{voiceInput.phase === 'recording' ? <Square size={13} fill="currentColor" /> : <Mic size={17} />}</button>}
          {state.busy && !text.trim() ? <button type="button" className="send-button stop-button" aria-label="停止回复" title="停止回复" onClick={() => api?.stop()}><Square size={14} fill="currentColor" /></button>
            : <button type="submit" className="send-button" aria-label={state.busy ? '发送补充消息' : '发送消息'} title={state.busy ? '发送并接着聊（Enter）' : '发送（Enter）'} disabled={!text.trim() || !state.model || ollamaConnected !== true || sending || voiceInput.active}><ArrowUp size={19} /></button>}
          </div>
        </form>
        <div className="chat-model-row">
          <span className={`model-dot ${ollamaConnected ? 'connected' : ''}`} />
          <label htmlFor="pet-model">Ollama</label>
          <select id="pet-model" aria-label="Ollama 模型" value={state.model} disabled={state.busy || loading}
            onChange={(event) => { setNotice(''); void api?.setModel(event.target.value).catch((error) => setNotice(errorText(error))) }}>
            {ollamaConnected === false
              ? <option value={state.model}>未连接 Ollama</option>
              : <>
                {!state.model && <option value="">{loading ? '正在连接…' : '选择模型'}</option>}
                {state.model && !models.includes(state.model) && <option value={state.model}>{state.model}</option>}
                {models.map((model) => <option key={model} value={model}>{model}</option>)}
              </>}
          </select>
          <button className="icon-button refresh-button" type="button" title="刷新本地模型" aria-label="刷新本地模型" disabled={loading || state.busy} onClick={() => void loadModels()}><RefreshCw size={12} className={loading ? 'spinning' : ''} /></button>
        </div>
      </footer>
      </>}
    </main>
  )
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作没有完成，请再试一次。'
}

function ReplyText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const hasSource = text.endsWith('（Open-Meteo）')
  const body = hasSource ? text.slice(0, -'（Open-Meteo）'.length) : text
  const content = hasSource ? body.split(/(-?\d+–-?\d+℃)/).map((part, index) => index % 2 ? <span className="speech-temperature" key={index}>{part}</span> : part) : body
  return <><p>{content}{streaming && <span className="typing-cursor" />}</p>{hasSource && <small className="weather-attribution">天气数据 · Open-Meteo</small>}</>
}

function FocusNotice() {
  const state = usePetState()
  useReminderSound(state)
  return <div className="focus-notice" role="status">
    <div className="notice-heading"><PawPrint size={15} strokeWidth={1.7} aria-hidden="true" /><span>小栖的小提醒</span></div>
    <div className="notice-copy"><ReplyText text={state.focusNotice?.text || ''} /></div>
    <div className="notice-footnote">聊天里也留了一份喵</div>
  </div>
}

function VoiceBubble() {
  const state = usePetState(), bubble = state.voiceBubble, voice = state.voice
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (bubble?.phase !== 'recording') return
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [bubble?.phase])
  if (!bubble) return null
  const phase = bubble.phase
  const active = ['requesting', 'recording', 'downloading', 'transcribing', 'thinking'].includes(phase)
  const title = phase === 'recording' ? '小栖在听呢' : phase === 'requesting' ? '耳朵竖好啦' : phase === 'transcribing' ? '让我听清楚一点…'
    : phase === 'downloading' ? '准备小栖的耳朵' : phase === 'thinking' ? '让我想一想…' : phase === 'error' ? '小栖有句话' : '小栖说'
  return <div className={`focus-notice voice-bubble voice-bubble-${phase}`} role="status">
    <div className="notice-heading"><PawPrint size={15} /><span>{title}</span>
      <button className="voice-bubble-close" aria-label={phase === 'thinking' ? '停止本次回复' : active ? '取消语音输入' : '收起语音气泡'} onClick={() => api?.dismissVoice()}><X size={14} /></button>
    </div>
    {phase === 'recording' ? <>
      <div className="voice-listening"><div className="voice-wave" aria-label="麦克风声音强度">{[.4, .7, 1, .65, .9, .55, .35].map((weight, index) => <i key={index} style={{ height: `${4 + 28 * (voice?.level || 0) * weight}px` }} />)}</div><span>{Math.max(0, Math.floor((now - (voice?.startedAt || now)) / 1000))} 秒</span></div>
      <p className="voice-bubble-hint">慢慢说，再按 Ctrl+Alt+V 就发给我～</p>
      <button className="voice-finish" onClick={() => api?.toggleVoice()}><Square size={11} fill="currentColor" />说好啦，发送</button>
    </> : phase === 'downloading' ? <><p className="voice-bubble-hint">首次准备离线语音 · {voice?.progress || 0}%</p><progress max={100} value={voice?.progress || 0} /></>
      : phase === 'requesting' || phase === 'transcribing' ? <div className="voice-working"><span className="thinking-dots"><i /><i /><i /></span><span>{phase === 'requesting' ? '正在连接麦克风' : '说的话正在变成文字'}</span></div>
      : <>{bubble.transcript && <p className="voice-heard" title={bubble.transcript}>听到你说：{bubble.transcript}</p>}<div className="notice-copy voice-reply-copy">{bubble.text ? <ReplyText text={bubble.text} streaming={phase === 'thinking'} /> : <span className="thinking-dots"><i /><i /><i /></span>}</div></>}
    <div className="voice-bubble-footer">{active ? <span>{phase === 'thinking' ? voice?.cancelShortcutAvailable ? 'Esc 停止回复' : '点右上角 × 停止回复' : voice?.cancelShortcutAvailable ? 'Esc 取消 · 不会发送' : '点右上角 × 可以取消'}</span> : <><span>还想说话？再按快捷键就好</span><button onClick={() => api?.openChat()}>聊天记录</button></>}</div>
  </div>
}

const surface = new URLSearchParams(location.search).get('surface')
const isChat = surface === 'chat'
document.title = isChat ? '小栖 · 聊一会儿' : surface === 'voice' ? '小栖 · 语音气泡' : surface === 'notice' ? '小栖 · 提醒气泡' : 'eDesktop · 小栖'
document.body.className = isChat ? 'chat-surface' : surface === 'notice' || surface === 'voice' ? 'notice-surface' : 'pet-surface'
if (surface === 'focus-preview') void import('./focus-preview-ui').then(module => module.mount())
else createRoot(document.getElementById('root')!).render(<React.StrictMode>{isChat ? <Chat /> : surface === 'notice' ? <FocusNotice /> : surface === 'voice' ? <VoiceBubble /> : <Pet />}</React.StrictMode>)
