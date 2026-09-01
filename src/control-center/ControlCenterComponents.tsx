import {
  AlertCircle,
  Eye,
  EyeOff,
  Info,
  Minus,
  MonitorPlay,
  Power,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CloseRequestAction, DesktopWidget } from '../types'

export function WindowControls({ onClose }: { onClose: () => void }) {
  return (
    <div className="window-controls">
      <button type="button" onClick={() => window.desktopAPI?.minimize()} aria-label="最小化">
        <Minus size={15} />
      </button>
      <button type="button" onClick={() => window.desktopAPI?.toggleMaximize()} aria-label="最大化">
        <Square size={12} />
      </button>
      <button type="button" className="window-close" onClick={onClose} aria-label="关闭">
        <X size={15} />
      </button>
    </div>
  )
}

type CloseChoice = Exclude<CloseRequestAction, 'cancel'>

export function CloseRequestDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: (choice: CloseChoice) => void
}) {
  const [choice, setChoice] = useState<CloseChoice>('tray')
  const dialogRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .filter((button) => !button.disabled)
      if (!focusable.length) return
      const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement)
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1)
      event.preventDefault()
      focusable[nextIndex]?.focus()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return (
    <div className="close-dialog-overlay">
      <div
        ref={dialogRef}
        className="close-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-dialog-title"
        aria-describedby="close-dialog-description"
      >
        <header className="close-dialog-header">
          <strong id="close-dialog-title">关闭控制中心</strong>
          <button type="button" onClick={onCancel} aria-label="取消关闭">
            <X size={16} />
          </button>
        </header>

        <div className="close-dialog-body">
          <div className="close-dialog-lead">
            <span><Info size={20} /></span>
            <div>
              <h2 id="close-dialog-description">请选择关闭后的运行方式</h2>
              <p>此设置只影响控制中心窗口，不会改变现有组件数据。</p>
            </div>
          </div>

          <div className="close-choice-group" role="radiogroup" aria-label="关闭后的运行方式">
            <button
              type="button"
              className={`close-choice-card${choice === 'tray' ? ' is-selected' : ''}`}
              role="radio"
              aria-checked={choice === 'tray'}
              onClick={() => setChoice('tray')}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') setChoice('quit')
              }}
            >
              <i className="close-choice-radio" />
              <MonitorPlay size={21} />
              <span>
                <strong>最小化到托盘</strong>
                <small>桌面组件继续运行，可从系统托盘再次打开控制中心。</small>
              </span>
            </button>

            <button
              type="button"
              className={`close-choice-card close-choice-quit${choice === 'quit' ? ' is-selected' : ''}`}
              role="radio"
              aria-checked={choice === 'quit'}
              onClick={() => setChoice('quit')}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') setChoice('tray')
              }}
            >
              <i className="close-choice-radio" />
              <Power size={21} />
              <span>
                <strong>彻底退出程序</strong>
                <small>恢复已收纳的所有图标，并关闭全部桌面组件。</small>
              </span>
            </button>
          </div>

          <div className="close-dialog-note">
            <AlertCircle size={14} />
            <span>彻底退出时会先恢复已收纳的桌面图标。</span>
          </div>
        </div>

        <footer className="close-dialog-actions">
          <button type="button" className="close-dialog-cancel" onClick={onCancel}>取消</button>
          <button ref={confirmRef} type="button" className="close-dialog-confirm" onClick={() => onConfirm(choice)}>
            确认执行
          </button>
        </footer>
      </div>
    </div>
  )
}

export function WidgetRow({ widget }: { widget: DesktopWidget }) {
  const [renaming, setRenaming] = useState(false)
  const api = window.desktopAPI

  const removeWidget = () => {
    if (window.confirm(`确定移除“${widget.title}”吗？这不会删除任何文件。`)) {
      api?.removeWidget(widget.id)
    }
  }

  return (
    <div className={`control-widget-row${widget.hidden ? ' is-hidden' : ''}`}>
      <div className="widget-row-copy">
        {renaming ? (
          <input
            autoFocus
            defaultValue={widget.title}
            onBlur={(event) => {
              const title = event.currentTarget.value.trim()
              if (title) api?.updateWidget(widget.id, { title })
              setRenaming(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <button type="button" className="widget-name-button" onClick={() => setRenaming(true)}>
            <strong>{widget.title}</strong>
          </button>
        )}
        <span>
          {Math.round(widget.width)} × {Math.round(widget.height)}
          {' · '}
          {widget.hidden ? '已隐藏' : '正在显示'}
        </span>
      </div>
      <div className="widget-row-actions">
        <button
          type="button"
          className="icon-button"
          onClick={() => api?.updateWidget(widget.id, { hidden: !widget.hidden })}
          aria-label={widget.hidden ? '显示组件' : '隐藏组件'}
        >
          {widget.hidden ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        <button type="button" className="icon-button danger-button" onClick={removeWidget} aria-label="移除组件">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  )
}
