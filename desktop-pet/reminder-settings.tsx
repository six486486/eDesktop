import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, BellRing, Search, Volume2 } from 'lucide-react'
import type { ChatPreferences, PetMemory, PetReminders, WeatherCity } from './types'
import { createMeowPlayer } from './reminder-sound'
import { MemoryEntry, MemoryPanel } from './memory-panel'
import { ChatPreferenceEntry, ChatPreferencePanel } from './chat-preferences'

export function ReminderSettings({ settings, soundEnabled, memory, chatPreferences, onClose }: { settings: PetReminders; soundEnabled: boolean; memory?: PetMemory | null; chatPreferences?: ChatPreferences; onClose: () => void }) {
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [soundBusy, setSoundBusy] = useState(false)
  const player = useRef<ReturnType<typeof createMeowPlayer> | null>(null)
  useEffect(() => () => { player.current?.stop(); player.current = null }, [])
  const [base, setBase] = useState(settings)
  const [enabled, setEnabled] = useState(settings.weather.enabled)
  const [city, setCity] = useState(settings.weather.city)
  const [changingCity, setChangingCity] = useState(!settings.weather.city)
  const [query, setQuery] = useState('')
  const [cities, setCities] = useState<WeatherCity[]>([])
  const [time, setTime] = useState(settings.weather.time)
  const [repeat, setRepeat] = useState(settings.weather.repeat)
  const [todoEnabled, setTodoEnabled] = useState(settings.todo.enabled)
  const [leadMinutes, setLeadMinutes] = useState(settings.todo.leadMinutes)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const searching = useRef(0)
  const api = window.petAPI
  const changeSound = async (enabled: boolean) => {
    if (!api || soundBusy) return
    setSoundBusy(true)
    try { await api.setReminderSound(enabled) }
    catch (error) { setMessage(errorText(error)) }
    finally { setSoundBusy(false) }
  }
  const previewSound = async () => {
    player.current ||= createMeowPlayer()
    if (!await player.current.play()) setMessage('这声喵暂时没播出来，检查一下声音输出后再试吧。')
  }
  const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '这次没有完成，请再试一次。'
  const search = async () => {
    if (!api || busy) return
    const request = ++searching.current
    setBusy(true); setMessage('')
    try { const result = await api.searchWeatherCities(query); if (request === searching.current) { setCities(result); if (!result.length) setMessage('没有找到城市，试试完整名称或拼音。') } }
    catch (error) { setMessage(errorText(error)) }
    finally { setBusy(false) }
  }
  const save = async () => {
    if (!api || busy) return
    setBusy(true); setMessage('')
    try {
      const next = await api.saveReminderSettings({ context: JSON.stringify(base), weather: { enabled, cityId: city?.id || '', time, repeat }, todo: { enabled: todoEnabled, leadMinutes } })
      setBase(next); setMessage('好啦，提醒设置记好啦～')
    } catch (error) { setMessage(errorText(error)) }
    finally { setBusy(false) }
  }
  if (memoryOpen && memory) return <MemoryPanel memory={memory} onBack={() => setMemoryOpen(false)} />
  if (preferencesOpen) return <ChatPreferencePanel preferences={chatPreferences} onBack={() => setPreferencesOpen(false)} />
  return <section className="reminder-settings" aria-label="小栖设置">
    <div className="reminder-settings-heading"><button className="icon-button" aria-label="返回聊天" onClick={onClose}><ArrowLeft size={16} /></button><strong>小栖设置</strong><BellRing size={19} strokeWidth={1.8} /></div>
    <ChatPreferenceEntry onClick={() => setPreferencesOpen(true)} />
    {memory && <MemoryEntry count={memory.habits.length} onClick={() => setMemoryOpen(true)} />}
    <div className="reminder-sound-setting">
      <div><strong>提醒声音</strong><small>到时间，轻轻喵一声。</small></div>
      <button type="button" className="reminder-sound-preview" aria-label="试听喵声" onClick={() => void previewSound()}><Volume2 size={14} /><span>试听</span></button>
      <input type="checkbox" role="switch" aria-label="提醒喵声" title="立即保存，天气、待办和番茄钟提醒共用" checked={soundEnabled} disabled={soundBusy} onChange={event => void changeSound(event.target.checked)} />
    </div>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="reminder-setting-title"><div><strong>天气预报</strong><small>到时间，让小栖告诉你天气。</small></div><input type="checkbox" role="switch" aria-label="天气定时播报" checked={enabled} onChange={e => setEnabled(e.target.checked)} /></div>
      <div className="reminder-field reminder-city-row">城市{city && <><span className="reminder-city">{city.label}</span><button type="button" onClick={() => setChangingCity(v => !v)}>{changingCity ? '收起' : '更换'}</button></>}</div>
      {changingCity && <div className="reminder-city-search"><input aria-label="搜索天气城市" placeholder="输入城市名称" value={query} maxLength={60} onChange={e => { setQuery(e.target.value); setCities([]) }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void search() } }} /><button type="button" aria-label="搜索城市" disabled={busy || query.trim().length < 2} onClick={() => void search()}><Search size={15} /></button></div>}
      {changingCity && cities.length > 0 && <div className="reminder-city-results" aria-label="城市搜索结果">{cities.map(c => <button type="button" key={c.id} onClick={() => { setCity(c); setChangingCity(false); setCities([]); setQuery('') }}>{c.label}</button>)}</div>}
      <div className="reminder-setting-row"><label className="reminder-field">播报时间<input type="time" aria-label="天气播报时间" required value={time} onChange={e => setTime(e.target.value)} /></label><label className="reminder-field">重复<select aria-label="天气播报周期" value={repeat} onChange={e => setRepeat(e.target.value as typeof repeat)}><option value="daily">每天</option><option value="weekdays">周一至周五</option></select></label></div>
      <div className="reminder-setting-title reminder-todo-title"><div><strong>我的一天</strong><small>按待办的开始时间提醒。</small></div><input type="checkbox" role="switch" aria-label="我的一天提醒" checked={todoEnabled} onChange={e => setTodoEnabled(e.target.checked)} /></div>
      <label className="reminder-field reminder-lead">提醒时间<select aria-label="待办提前提醒" disabled={!todoEnabled} value={leadMinutes} onChange={e => setLeadMinutes(Number(e.target.value))}>{[0, 5, 10, 15].map(n => <option key={n} value={n}>{n ? `提前 ${n} 分钟` : '开始时'}</option>)}</select></label>
      <p className="reminder-hint">临时提醒直接对我说，会记在待办的「临时安排」里。</p>
      <div className="reminder-setting-actions"><button type="button" disabled={busy || !base.weather.city} onClick={() => { setBusy(true); setMessage(''); void api?.previewWeather().then(setMessage).catch(e => setMessage(errorText(e))).finally(() => setBusy(false)) }}>查看已保存城市的天气</button><button type="submit" className="reminder-save" disabled={busy}>{busy ? '处理中…' : '保存设置'}</button></div>
      {message && <p className="reminder-feedback" role="status">{message}</p>}
      <p className="reminder-source">天气数据：<a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a></p>
    </form>
  </section>
}
