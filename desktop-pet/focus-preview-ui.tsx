import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { PomodoroWidget } from '../src/desktop-widgets/PomodoroWidget'
import { TodoWidget } from '../src/desktop-widgets/TodoWidget'
import type { DesktopWidget } from '../src/types'
import '../src/styles.css'

function Preview() {
  const [widget, setWidget] = useState<DesktopWidget | null>(null)
  const [todo, setTodo] = useState<DesktopWidget | null>(null)
  useEffect(() => {
    const refresh = () => { void window.petAPI?.getFocusWidget().then(setWidget); void window.petAPI?.getPreviewTodo().then(setTodo) }
    refresh()
    return window.petAPI?.onState(refresh)
  }, [])
  return <main style={{ padding: 20, height: '100%', background: '#edf2e8', overflowY: 'auto' }}>
    <div style={{ fontSize: 12, marginBottom: 14, color: '#53684c' }}>待办与番茄钟 · 独立预览</div>
    {todo && <div style={{ position: 'relative', height: 300, marginBottom: 15 }}><TodoWidget widget={todo} onUpdate={data => window.petAPI!.updatePreviewTodo(data)} /></div>}
    {widget && <PomodoroWidget widget={widget} settingsOpen={false} onCloseSettings={() => {}} completionManaged
      onUpdate={data => window.petAPI!.updateFocusWidget(data)} />}
  </main>
}
export function mount() { createRoot(document.getElementById('root')!).render(<Preview />) }
