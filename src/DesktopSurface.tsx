import {
  useEffect,
  useState,
  type CSSProperties,
} from 'react'
import { NoteWidget } from './desktop-widgets/NoteWidget'
import { OrganizerWidget } from './desktop-widgets/OrganizerWidget'
import { PomodoroWidget } from './desktop-widgets/PomodoroWidget'
import { TodoWidget } from './desktop-widgets/TodoWidget'
import { WidgetShell } from './desktop-widgets/WidgetShell'
import { useWorkspace } from './hooks/useWorkspace'
import type { DesktopInfo } from './types'

export function DesktopSurface({ capture = false }: { capture?: boolean }) {
  const { workspace } = useWorkspace()
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null)
  const [settingsWidgetId, setSettingsWidgetId] = useState<string | null>(null)
  const params = new URLSearchParams(window.location.search)
  const displayId = params.get('displayId')
  const widgetId = params.get('widgetId')
  const isWidgetWindow = params.get('widgetWindow') === '1' && Boolean(widgetId)
  const parsedWidgetWindowMargin = Number(params.get('widgetMargin'))
  const widgetWindowMargin = isWidgetWindow && Number.isFinite(parsedWidgetWindowMargin)
    ? Math.max(0, parsedWidgetWindowMargin)
    : undefined
  const organizerRadiusParam = params.get('organizerRadius')
  const parsedOrganizerRadius = organizerRadiusParam === null ? Number.NaN : Number(organizerRadiusParam)
  const organizerRadius = Number.isFinite(parsedOrganizerRadius)
    ? Math.max(0, parsedOrganizerRadius)
    : 10

  useEffect(() => {
    const api = window.desktopAPI
    if (!api) return
    let unlockTimer = 0
    const lockInteraction = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.desktop-widget')) {
        if (unlockTimer) window.clearTimeout(unlockTimer)
        unlockTimer = 0
        api.setDesktopInteractionLocked(true)
      }
    }
    const unlockInteraction = () => {
      if (document.documentElement.dataset.organizerFileDrag === 'true') return
      if (unlockTimer) window.clearTimeout(unlockTimer)
      // The capture listener runs before WidgetShell's pointer-up handler.
      // Defer the native unlock until React has submitted the final frame; an
      // immediate unlock can destroy the old-display organizer while its
      // pointer-up handler is still committing the cross-display position.
      unlockTimer = window.setTimeout(() => {
        unlockTimer = 0
        api.setDesktopInteractionLocked(false)
      }, 0)
    }
    window.addEventListener('pointerdown', lockInteraction, true)
    window.addEventListener('pointerup', unlockInteraction, true)
    window.addEventListener('pointercancel', unlockInteraction, true)
    window.addEventListener('blur', unlockInteraction)
    return () => {
      if (unlockTimer) window.clearTimeout(unlockTimer)
      api.setDesktopInteractionLocked(false)
      window.removeEventListener('pointerdown', lockInteraction, true)
      window.removeEventListener('pointerup', unlockInteraction, true)
      window.removeEventListener('pointercancel', unlockInteraction, true)
      window.removeEventListener('blur', unlockInteraction)
    }
  }, [])

  useEffect(() => {
    const api = window.desktopAPI
    if (!api) return
    let active = true
    api.getDesktopInfo().then((info) => {
      if (active) setDesktopInfo(info)
    })
    const unsubscribe = api.onDesktopInfoChanged((info) => {
      if (active) setDesktopInfo(info)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const display = desktopInfo?.displays.find((candidate) => candidate.id === displayId)
  const widgetWindowBounds = isWidgetWindow && desktopInfo
    ? {
      x: window.screenX - desktopInfo.virtualBounds.x,
      y: window.screenY - desktopInfo.virtualBounds.y,
      width: window.innerWidth,
      height: window.innerHeight,
    }
    : null
  const displayBounds = widgetWindowBounds || display?.bounds
  const visibleWidgets = isWidgetWindow
    ? workspace.widgets.filter((widget) => !widget.hidden && widget.id === widgetId)
    : displayBounds ? workspace.widgets.filter((widget) => (
      !widget.hidden
      && widget.x < displayBounds.x + displayBounds.width
      && widget.x + widget.width > displayBounds.x
      && widget.y < displayBounds.y + displayBounds.height
      && widget.y + widget.height > displayBounds.y
    )) : []
  return (
    <main
      className={`desktop-surface ${capture ? 'is-capture' : ''} ${isWidgetWindow ? 'is-widget-window' : ''}`}
      style={{ '--organizer-radius': `${organizerRadius}px` } as CSSProperties}
    >
      {displayBounds && desktopInfo && visibleWidgets.map((widget) => (
        <WidgetShell
          key={widget.id}
          widget={widget}
          displayBounds={displayBounds}
          displays={desktopInfo.displays}
          virtualBounds={desktopInfo.virtualBounds}
          windowMargin={widgetWindowMargin}
          pomodoroSettingsOpen={settingsWidgetId === widget.id}
          onTogglePomodoroSettings={() => setSettingsWidgetId((current) => current === widget.id ? null : widget.id)}
        >
          {widget.kind === 'organizer' && <OrganizerWidget widget={widget} />}
          {widget.kind === 'note' && <NoteWidget widget={widget} />}
          {widget.kind === 'todo' && <TodoWidget widget={widget} />}
          {widget.kind === 'pomodoro' && (
            <PomodoroWidget
              widget={widget}
              settingsOpen={settingsWidgetId === widget.id}
              completionManaged={workspace.settings.desktopPetEnabled !== false}
              onCloseSettings={() => setSettingsWidgetId(null)}
            />
          )}
        </WidgetShell>
      ))}
    </main>
  )
}
