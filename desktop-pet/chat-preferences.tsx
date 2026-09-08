import { useState } from 'react'
import { ArrowLeft, ChevronRight, MessageCircle } from 'lucide-react'
import type { ChatPreferences } from './types'

const defaults: ChatPreferences = { preferredName: null, replyLength: 'normal', followUp: 'natural' }

export function ChatPreferencePanel({ preferences = defaults, onBack }: { preferences?: ChatPreferences; onBack: () => void }) {
  const [changes, setChanges] = useState<Partial<ChatPreferences>>({})
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  // Untouched fields follow live changes from conversation; only edited fields are saved.
  const values = { ...preferences, ...changes }
  const change = <K extends keyof ChatPreferences>(key: K, value: ChatPreferences[K]) => {
    setChanges(current => ({ ...current, [key]: value }))
    setFeedback('')
  }
  const save = async () => {
    if (!window.petAPI || busy || !Object.keys(changes).length) return
    setBusy(true); setFeedback('')
    try {
      await window.petAPI.saveChatPreferences(changes)
      setChanges({}); setFeedback('保存好啦，下次回复就按这些偏好来。')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '偏好没有保存，请再试一次。')
    } finally { setBusy(false) }
  }
  return <section className="reminder-settings chat-preferences" aria-label="聊天偏好设置">
    <div className="reminder-settings-heading"><button className="icon-button" aria-label="返回设置" onClick={onBack}><ArrowLeft size={16} /></button><strong>聊天偏好</strong><MessageCircle size={19} strokeWidth={1.8} /></div>
    <p className="memory-intro">保存后，下次回复就按你的习惯来。</p>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset disabled={busy}>
        <label className="reminder-field">用户称呼<input aria-label="用户称呼" aria-describedby="pet-name-hint" value={values.preferredName ?? ''} maxLength={24} placeholder="小栖怎么称呼你" autoComplete="off" onChange={event => change('preferredName', event.target.value)} /></label>
        <small id="pet-name-hint" className="preference-field-hint">最多 24 个字符，留空表示不特意称呼。</small>
        <label className="reminder-field">回复长短<select aria-label="回复长短" value={values.replyLength} onChange={event => change('replyLength', event.target.value as ChatPreferences['replyLength'])}><option value="short">简短 · 直接说重点</option><option value="normal">正常 · 自然聊几句</option><option value="detailed">详细 · 多讲一点</option></select></label>
        <label className="reminder-field">追问方式<select aria-label="追问方式" value={values.followUp} onChange={event => change('followUp', event.target.value as ChatPreferences['followUp'])}><option value="natural">自然交流 · 可以适当追问</option><option value="avoid">尽量不追问 · 用陈述句接话</option></select></label>
        <p className="reminder-hint">也能通过聊天修改，以最后一次修改为准。<br />“这次详细一点”只影响当次回复。</p>
        <div className="reminder-setting-actions"><button type="button" onClick={() => { setChanges(defaults); setFeedback('已填入默认选项，保存后生效。') }}>恢复默认</button><button type="submit" className="reminder-save" disabled={!Object.keys(changes).length}>{busy ? '保存中…' : '保存偏好'}</button></div>
      </fieldset>
      {feedback && <p className="reminder-feedback" role="status">{feedback}</p>}
    </form>
  </section>
}

export function ChatPreferenceEntry({ onClick }: { onClick: () => void }) {
  return <button type="button" className="memory-entry" onClick={onClick}><MessageCircle size={19} strokeWidth={1.6} /><span><strong>聊天偏好</strong><small>称呼、回复长短和追问方式。</small></span><ChevronRight size={16} /></button>
}
