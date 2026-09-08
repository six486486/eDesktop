import { useState } from 'react'
import { ArrowLeft, BookHeart, ChevronRight } from 'lucide-react'
import type { PetMemory } from './types'

export function MemoryPanel({ memory, onBack }: { memory: PetMemory; onBack: () => void }) {
  const [tab, setTab] = useState<'habits' | 'operations'>('habits')
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const forget = async (id: string) => {
    if (busy || !window.petAPI) return
    setBusy(id); setFeedback('')
    try { await window.petAPI.forgetMemories([id]); setFeedback('好啦，这条已经忘掉了～') }
    catch (e) { setFeedback(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '这次没能忘掉，请再试一次。') }
    finally { setBusy(null) }
  }
  const date = (at?: number) => at ? new Date(at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : ''
  return <section className="reminder-settings memory-panel" aria-label="小栖的记忆">
    <div className="reminder-settings-heading"><button className="icon-button" aria-label="返回设置" onClick={onBack}><ArrowLeft size={16} /></button><strong>小栖记住的事</strong><BookHeart size={19} strokeWidth={1.8} /></div>
    <p className="memory-intro">记住你的习惯，让下次少说一点。</p>
    <div className="memory-tabs" aria-label="记忆分类">{(['habits', 'operations'] as const).map(key => <button key={key} type="button" aria-pressed={tab === key} className={tab === key ? 'is-active' : ''} onClick={() => { setTab(key); setFeedback('') }}>{key === 'habits' ? '习惯' : '最近操作'} · {memory[key].length}</button>)}</div>
    <div className="memory-list">{memory[tab].map(entry => <article className="memory-card" key={entry.id}>
      <div><strong>{entry.label}</strong><small>{tab === 'habits' ? '你告诉小栖的' : '实际执行过'} · {date(entry.updatedAt || entry.at)}</small>
        {entry.source?.text && <details><summary>当时怎么说的</summary><p>“{entry.source.text}”</p></details>}
      </div><button type="button" disabled={busy !== null} aria-label={`忘记：${entry.label}`} onClick={() => void forget(entry.id)}>{busy === entry.id ? '…' : '忘记'}</button>
    </article>)}</div>
    {!memory[tab].length && <div className="memory-empty"><BookHeart size={30} strokeWidth={1.3} /><p>{tab === 'habits' ? '习惯本还是空的呢。' : '还没有可以回顾的操作。'}</p><small>{tab === 'habits' ? '试着说：“以后写代码，计时45分钟。”' : '成功设置提醒或操作番茄钟后，会记在这里。'}</small></div>}
    {feedback && <p className="reminder-feedback" role="status">{feedback}</p>}
    <p className="memory-footnote">{tab === 'habits' ? <>只用于对应活动。“这次20分钟”不会改掉习惯。<br />说“以后……”可以修改，也可以在这里忘记。</> : <>最多保留近30天的40条操作。<br />忘记记录会保留待办和番茄钟的当前状态。</>}</p>
  </section>
}

export function MemoryEntry({ count, onClick }: { count: number; onClick: () => void }) {
  return <button type="button" className="memory-entry" onClick={onClick}><BookHeart size={19} strokeWidth={1.6} /><span><strong>小栖记住的事</strong><small>{count ? `${count} 条习惯，随时可以看看或忘记。` : '你的习惯，随时可以看看或忘记。'}</small></span><ChevronRight size={16} /></button>
}
