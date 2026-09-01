import {
  Archive,
  CheckSquare2,
  GripHorizontal,
  Settings2,
  StickyNote,
  Timer,
  X,
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  clamp,
  constrainPositionToDisplay,
  displayNearestPoint,
  widgetEdgeGap,
} from '../lib/desktopGeometry'
import type { DesktopInfo, DesktopWidget, WidgetKind } from '../types'

const kindIcon: Record<WidgetKind, typeof Archive> = {
  organizer: Archive,
  note: StickyNote,
  todo: CheckSquare2,
  pomodoro: Timer,
}

const organizerMinimumWidth = 88
const organizerMinimumHeight = 122

interface WidgetShellProps {
  widget: DesktopWidget
  displayBounds: DesktopInfo['primaryBounds']
  displays: DesktopInfo['displays']
  virtualBounds: DesktopInfo['virtualBounds']
  windowMargin?: number
  pomodoroSettingsOpen?: boolean
  onTogglePomodoroSettings?: () => void
  children: ReactNode
}

export function WidgetShell({
  widget,
  displayBounds,
  displays,
  virtualBounds,
  windowMargin,
  pomodoroSettingsOpen = false,
  onTogglePomodoroSettings,
  children,
}: WidgetShellProps) {
  const api = window.desktopAPI
  const useNativeCursor = new URLSearchParams(window.location.search).get('nativeCursor') !== '0'
  const useNativeWindowDrag = widget.kind === 'organizer'
    && windowMargin !== undefined
    && new URLSearchParams(window.location.search).get('nativeWindowDrag') !== '0'
  const [frame, setFrame] = useState({ x: widget.x, y: widget.y, width: widget.width, height: widget.height })
  const [titleDraft, setTitleDraft] = useState(widget.title)
  const frameRef = useRef(frame)

  useEffect(() => {
    const next = { x: widget.x, y: widget.y, width: widget.width, height: widget.height }
    frameRef.current = next
    setFrame(next)
  }, [widget.x, widget.y, widget.width, widget.height])

  useEffect(() => {
    setTitleDraft(widget.title)
  }, [widget.title])

  const setLiveFrame = (next: typeof frame) => {
    frameRef.current = next
    setFrame(next)
  }

  const desktopPointFromEvent = (pointerEvent: Pick<PointerEvent, 'screenX' | 'screenY' | 'clientX' | 'clientY'>) => {
    if (widget.kind === 'organizer' && windowMargin !== undefined && api && useNativeCursor) {
      // Chromium virtualizes PointerEvent.screenX when a child HWND crosses
      // monitors with different scale factors. Windows' cursor position is
      // already expressed in Electron's unified desktop DIPs and therefore
      // stays aligned with the physical mouse throughout the gesture.
      const cursor = api.getCursorPosition()
      return cursor
    }
    if (Number.isFinite(pointerEvent.screenX) && Number.isFinite(pointerEvent.screenY)) {
      return {
        x: pointerEvent.screenX - virtualBounds.x,
        y: pointerEvent.screenY - virtualBounds.y,
      }
    }
    return api?.getCursorPosition() || {
      x: displayBounds.x + pointerEvent.clientX,
      y: displayBounds.y + pointerEvent.clientY,
    }
  }

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input, textarea')) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Injected test input may not own a browser pointer-capture record; the
      // window-level listeners below still complete the gesture.
    }
    const initialCursor = desktopPointFromEvent(event.nativeEvent)
    const start = { cursorX: initialCursor.x, cursorY: initialCursor.y, ...frameRef.current }
    let latestCursor = initialCursor
    let moveAnimationFrame = 0

    const applyMove = () => {
      moveAnimationFrame = 0
      const cursor = latestCursor
      const targetDisplay = displayNearestPoint(cursor, displays)
      if (!targetDisplay) return
      const { x, y } = constrainPositionToDisplay({
        x: start.x + cursor.x - start.cursorX,
        y: start.y + cursor.y - start.cursorY,
      }, start, targetDisplay)
      const nextFrame = { ...frameRef.current, x, y }
      if (windowMargin === undefined) setLiveFrame(nextFrame)
      else frameRef.current = nextFrame
      api?.previewWidgetFrame(widget.id, { x, y })
    }
    const move = (pointerEvent: PointerEvent) => {
      latestCursor = desktopPointFromEvent(pointerEvent)
      if (!moveAnimationFrame) moveAnimationFrame = window.requestAnimationFrame(applyMove)
    }
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (pointerEvent.type !== 'pointercancel') latestCursor = desktopPointFromEvent(pointerEvent)
      if (moveAnimationFrame) window.cancelAnimationFrame(moveAnimationFrame)
      applyMove()
      void api?.updateWidget(widget.id, { x: frameRef.current.x, y: frameRef.current.y })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // See beginDrag: window-level listeners still complete injected input.
    }
    const initialCursor = desktopPointFromEvent(event.nativeEvent)
    const start = { cursorX: initialCursor.x, cursorY: initialCursor.y, ...frameRef.current }
    const resizeDisplay = displayNearestPoint({
      x: start.x + start.width / 2,
      y: start.y + start.height / 2,
    }, displays)
    const minimumWidth = widget.kind === 'organizer' ? organizerMinimumWidth : 240
    const minimumHeight = widget.kind === 'organizer' ? organizerMinimumHeight : 190
    let latestCursor = initialCursor
    let resizeAnimationFrame = 0

    const applyResize = () => {
      resizeAnimationFrame = 0
      const cursor = latestCursor
      if (!resizeDisplay) return
      const maximumWidth = Math.max(minimumWidth, resizeDisplay.bounds.x + resizeDisplay.bounds.width - start.x - widgetEdgeGap)
      const maximumHeight = Math.max(minimumHeight, resizeDisplay.bounds.y + resizeDisplay.bounds.height - start.y - widgetEdgeGap)
      const width = clamp(start.width + cursor.x - start.cursorX, minimumWidth, maximumWidth)
      const height = clamp(start.height + cursor.y - start.cursorY, minimumHeight, maximumHeight)
      setLiveFrame({ ...frameRef.current, width, height })
      api?.previewWidgetFrame(widget.id, { width, height })
    }
    const move = (pointerEvent: PointerEvent) => {
      latestCursor = desktopPointFromEvent(pointerEvent)
      if (!resizeAnimationFrame) resizeAnimationFrame = window.requestAnimationFrame(applyResize)
    }
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (pointerEvent.type !== 'pointercancel') latestCursor = desktopPointFromEvent(pointerEvent)
      if (resizeAnimationFrame) window.cancelAnimationFrame(resizeAnimationFrame)
      applyResize()
      void api?.updateWidget(widget.id, { width: frameRef.current.width, height: frameRef.current.height })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  const Icon = kindIcon[widget.kind]

  return (
    <section
      className={`desktop-widget tone-${widget.tone} widget-${widget.kind} ${useNativeWindowDrag ? 'uses-native-window-drag' : ''}`}
      data-widget-id={widget.id}
      style={{
        left: windowMargin ?? frame.x - displayBounds.x,
        top: windowMargin ?? frame.y - displayBounds.y,
        width: frame.width,
        height: frame.height,
      }}
    >
      <div
        className={`desktop-widget-header widget-drag-handle ${widget.kind === 'pomodoro' ? 'is-compact' : ''}`}
        onPointerDown={windowMargin === undefined || (widget.kind === 'organizer' && !useNativeWindowDrag) ? beginDrag : undefined}
      >
        {widget.kind === 'pomodoro' && (
          <button
            type="button"
            className={`pomodoro-settings-button ${pomodoroSettingsOpen ? 'is-active' : ''}`}
            onClick={onTogglePomodoroSettings}
            aria-label={pomodoroSettingsOpen ? '返回番茄钟' : '设置专注与休息时间'}
            aria-pressed={pomodoroSettingsOpen}
          >
            {pomodoroSettingsOpen ? <X size={14} /> : <Settings2 size={14} />}
          </button>
        )}
        {widget.kind !== 'pomodoro' && widget.kind !== 'organizer' && <span className="desktop-widget-icon"><Icon size={15} /></span>}
        {widget.kind === 'organizer' ? (
          <input
            className="widget-title-input"
            data-widget-title
            value={titleDraft}
            aria-label="收纳盒名称（请在控制台中重命名）"
            readOnly
            tabIndex={-1}
          />
        ) : widget.kind === 'todo' ? (
          <span className="widget-title-static" data-widget-title>{widget.title}</span>
        ) : widget.kind !== 'pomodoro' ? <h2 data-widget-title>{widget.title}</h2> : null}
        <span className="drag-affordance"><GripHorizontal size={16} /></span>
      </div>
      <div className="desktop-widget-body">{children}</div>
      <button type="button" className="widget-resize-grip" onPointerDown={beginResize} aria-label="调整组件大小" />
    </section>
  )
}

