import { useEffect, useState } from 'react'
import type { DesktopWidget, NoteWidgetData } from '../types'

export function NoteWidget({ widget }: { widget: DesktopWidget }) {
  const data = widget.data as NoteWidgetData
  const [content, setContent] = useState(data.content || '')

  useEffect(() => setContent(data.content || ''), [data.content])

  const save = () => {
    if (content === data.content) return
    window.desktopAPI?.updateWidget(widget.id, {
      data: { content, updatedAt: new Date().toISOString() },
    })
  }

  return (
    <div className="note-widget-content">
      <textarea
        value={content}
        placeholder="写下一条便签…"
        onChange={(event) => setContent(event.currentTarget.value)}
        onBlur={save}
      />
      <span>{data.updatedAt ? `更新于 ${new Date(data.updatedAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未编辑'}</span>
    </div>
  )
}

