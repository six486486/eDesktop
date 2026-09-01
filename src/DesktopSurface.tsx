import {
  Archive,
  Check,
  CheckSquare2,
  ChevronDown,
  Coffee,
  GripHorizontal,
  GripVertical,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  StickyNote,
  Timer,
  Trash2,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useWorkspace } from './hooks/useWorkspace'
import { displayFileName, iconForFile } from './lib/files'
import type {
  DesktopFile,
  DesktopInfo,
  DesktopWidget,
  NoteWidgetData,
  OrganizerWidgetData,
  PomodoroWidgetData,
  TodoItem,
  TodoListKind,
  TodoWidgetData,
  WidgetKind,
} from './types'

const kindIcon: Record<WidgetKind, typeof Archive> = {
  organizer: Archive,
  note: StickyNote,
  todo: CheckSquare2,
  pomodoro: Timer,
}

const organizerFileDragType = 'application/x-edesktop-organizer-file'
const organizerMinimumWidth = 88
const organizerMinimumHeight = 122
const organizerGridTileSize = 64
const organizerGridGap = 4
const organizerGridHorizontalChrome = 22

interface OrganizerFileDragPayload {
  dragToken: string
  sourceWidgetId: string
  fileId: string
  filePath: string
}

const isOrganizerFileDrag = (dataTransfer: DataTransfer) => (
  Array.from(dataTransfer.types).includes(organizerFileDragType)
)

const readOrganizerFileDrag = (dataTransfer: DataTransfer): OrganizerFileDragPayload | null => {
  try {
    const payload = JSON.parse(dataTransfer.getData(organizerFileDragType)) as Partial<OrganizerFileDragPayload>
    if (
      typeof payload.dragToken !== 'string'
      || !payload.dragToken
      || typeof payload.sourceWidgetId !== 'string'
      || !payload.sourceWidgetId
      || typeof payload.fileId !== 'string'
      || !payload.fileId
      || typeof payload.filePath !== 'string'
      || !payload.filePath
    ) return null
    return payload as OrganizerFileDragPayload
  } catch {
    return null
  }
}

const defaultPomodoro: PomodoroWidgetData = {
  mode: 'focus',
  focusMinutes: 25,
  breakMinutes: 5,
  remainingSeconds: 25 * 60,
  running: false,
  endsAt: null,
  sessions: 0,
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const widgetEdgeGap = 8
const widgetTopEdgeGap = 0

type DesktopDisplay = DesktopInfo['displays'][number]

const distanceToDisplay = (point: { x: number; y: number }, display: DesktopDisplay) => {
  const { bounds } = display
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width))
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height))
  return dx * dx + dy * dy
}

const displayNearestPoint = (point: { x: number; y: number }, displays: DesktopDisplay[]) => (
  displays.reduce<DesktopDisplay | null>((nearest, display) => {
    if (!nearest) return display
    return distanceToDisplay(point, display) < distanceToDisplay(point, nearest) ? display : nearest
  }, null)
)

const constrainPositionToDisplay = (
  position: { x: number; y: number },
  size: { width: number; height: number },
  display: DesktopDisplay,
) => {
  const { bounds } = display
  const minX = bounds.x + widgetEdgeGap
  const minY = bounds.y + widgetTopEdgeGap
  const maxX = Math.max(minX, bounds.x + bounds.width - size.width - widgetEdgeGap)
  const maxY = Math.max(minY, bounds.y + bounds.height - size.height - widgetEdgeGap)
  return {
    x: clamp(position.x, minX, maxX),
    y: clamp(position.y, minY, maxY),
  }
}

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

function WidgetShell({
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
      className={`desktop-widget tone-${widget.tone} widget-${widget.kind}`}
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
        onPointerDown={windowMargin === undefined || widget.kind === 'organizer' ? beginDrag : undefined}
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

function OrganizerFileIcon({ file }: { file: DesktopFile }) {
  const persistedIconUrl = typeof file.iconDataUrl === 'string' ? file.iconDataUrl : ''
  const [iconUrl, setIconUrl] = useState(persistedIconUrl)
  const FallbackIcon = iconForFile(file)

  useEffect(() => {
    if (persistedIconUrl) {
      setIconUrl(persistedIconUrl)
      return undefined
    }
    let active = true
    window.desktopAPI?.getFileIcon(file.path).then((url) => {
      if (active) setIconUrl(url)
    })
    return () => {
      active = false
    }
  }, [file.path, persistedIconUrl])

  return (
    <span className="organizer-file-icon">
      {iconUrl ? <img src={iconUrl} alt="" draggable={false} /> : <FallbackIcon size={30} strokeWidth={1.5} />}
    </span>
  )
}

function OrganizerWidget({ widget }: { widget: DesktopWidget }) {
  const api = window.desktopAPI
  const data = widget.data as OrganizerWidgetData
  // An entry restored to the desktop during the previous shutdown is only a
  // pending membership record until startup has physically moved it back.
  // Rendering it early makes one real desktop icon look like two files.
  const files = useMemo(() => (
    Array.isArray(data.files)
      ? data.files.filter((file) => file.temporarilyRestoredOnExit !== true)
      : []
  ), [data.files])
  const [orderedFiles, setOrderedFiles] = useState(files)
  const [dropActive, setDropActive] = useState(false)
  const [draggingFilePath, setDraggingFilePath] = useState('')
  const [selectedFilePath, setSelectedFilePath] = useState('')
  const [dropTarget, setDropTarget] = useState<{ path: string; edge: 'before' | 'after' } | null>(null)
  const internalDropHandledRef = useRef(false)
  const prepareImportRef = useRef<Promise<boolean> | null>(null)
  const dragTokenRef = useRef('')
  const pointerReorderCleanupRef = useRef<(() => void) | null>(null)
  const suppressOpenClickRef = useRef(false)
  const gridColumnCapacity = Math.max(1, Math.floor((
    Math.max(organizerGridTileSize, widget.width - organizerGridHorizontalChrome) + organizerGridGap
  ) / (organizerGridTileSize + organizerGridGap)))
  const organizerGridClassName = [
    'organizer-files',
    gridColumnCapacity === 1 ? 'is-single-column' : '',
    orderedFiles.length > 0 && orderedFiles.length <= gridColumnCapacity ? 'is-single-row' : '',
  ].filter(Boolean).join(' ')

  useEffect(() => setOrderedFiles(files), [files])
  useEffect(() => {
    if (selectedFilePath && !files.some((file) => file.path === selectedFilePath)) {
      setSelectedFilePath('')
      api?.clearOrganizerFileSelection(widget.id)
    }
  }, [api, files, selectedFilePath, widget.id])
  useEffect(() => api?.onOrganizerFileSelectionCleared(() => setSelectedFilePath('')), [api])
  useEffect(() => () => pointerReorderCleanupRef.current?.(), [])

  const selectFile = (filePath: string) => {
    setSelectedFilePath(filePath)
    api?.selectOrganizerFile(widget.id, filePath)
  }

  const clearFileSelection = () => {
    setSelectedFilePath('')
    api?.clearOrganizerFileSelection(widget.id)
  }

  const importPaths = (paths: string[]) => {
    if (!api) return
    void api.importOrganizerFiles(widget.id, paths)
  }

  const acceptDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setDropActive(false)
    if (isOrganizerFileDrag(event.dataTransfer)) {
      const payload = readOrganizerFileDrag(event.dataTransfer)
      if (!payload) return
      api?.claimOrganizerFileDrop(payload.dragToken)
      if (payload.sourceWidgetId === widget.id) {
        internalDropHandledRef.current = true
        const sourceIndex = orderedFiles.findIndex((file) => file.path === payload.filePath)
        if (sourceIndex >= 0 && sourceIndex !== orderedFiles.length - 1) {
          const nextFiles = [...orderedFiles]
          const [sourceFile] = nextFiles.splice(sourceIndex, 1)
          nextFiles.push(sourceFile)
          setOrderedFiles(nextFiles)
          void api?.reorderOrganizerFiles(widget.id, nextFiles.map((file) => file.id))
        }
      } else {
        await api?.moveOrganizerFile(payload.sourceWidgetId, widget.id, payload.filePath)
      }
      setDropTarget(null)
      return
    }
    if (!api) return
    await (prepareImportRef.current || api.prepareOrganizerImport()).catch(() => false)
    prepareImportRef.current = null
    const paths = Array.from(event.dataTransfer.files).map((file) => {
      try {
        return api.getPathForFile(file)
      } catch {
        return ''
      }
    }).filter(Boolean)
    importPaths(paths)
  }

  const reorderFileWithinWidget = (sourcePath: string, targetFile: DesktopFile, edge: 'before' | 'after') => {
    internalDropHandledRef.current = true
    if (sourcePath === targetFile.path) return
    const sourceFile = orderedFiles.find((file) => file.path === sourcePath)
    if (!sourceFile) return
    const nextFiles = orderedFiles.filter((file) => file.path !== sourcePath)
    const targetIndex = nextFiles.findIndex((file) => file.path === targetFile.path)
    if (targetIndex < 0) return
    nextFiles.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, sourceFile)
    if (nextFiles.every((file, index) => file.path === orderedFiles[index]?.path)) return
    setOrderedFiles(nextFiles)
    void api?.reorderOrganizerFiles(widget.id, nextFiles.map((file) => file.id))
  }

  const moveFileInOrder = (
    payload: OrganizerFileDragPayload,
    targetFile: DesktopFile,
    edge: 'before' | 'after',
  ) => {
    api?.claimOrganizerFileDrop(payload.dragToken)
    setDropTarget(null)
    if (!api) return
    if (payload.sourceWidgetId !== widget.id) {
      void api.moveOrganizerFile(payload.sourceWidgetId, widget.id, payload.filePath, targetFile.id, edge)
      return
    }
    reorderFileWithinWidget(payload.filePath, targetFile, edge)
  }

  const beginPointerReorder = (file: DesktopFile, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    pointerReorderCleanupRef.current?.()
    const start = { x: event.clientX, y: event.clientY }
    let active = false
    let target: { file: DesktopFile; edge: 'before' | 'after' } | null = null
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      if (pointerReorderCleanupRef.current === cleanup) pointerReorderCleanupRef.current = null
    }
    const move = (pointerEvent: PointerEvent) => {
      if (dragTokenRef.current) return
      if (!active && Math.hypot(pointerEvent.clientX - start.x, pointerEvent.clientY - start.y) >= 6) {
        active = true
        setDraggingFilePath(file.path)
        api?.setDesktopInteractionLocked(true)
      }
      if (!active) return
      const targetTile = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>('.organizer-file')
      const targetPath = targetTile?.dataset.organizerFilePath || ''
      const targetFile = orderedFiles.find((candidate) => candidate.path === targetPath)
      if (!targetTile || !targetFile || targetTile.closest('.desktop-widget')?.getAttribute('data-widget-id') !== widget.id) {
        target = null
        setDropTarget(null)
        return
      }
      const rect = targetTile.getBoundingClientRect()
      const edge = pointerEvent.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
      target = { file: targetFile, edge }
      setDropTarget({ path: targetFile.path, edge })
    }
    const finish = (pointerEvent: PointerEvent, cancelled: boolean) => {
      cleanup()
      if (active && !cancelled && !dragTokenRef.current && target) {
        pointerEvent.preventDefault()
        pointerEvent.stopPropagation()
        suppressOpenClickRef.current = true
        window.setTimeout(() => {
          suppressOpenClickRef.current = false
        }, 0)
        reorderFileWithinWidget(file.path, target.file, target.edge)
      }
      if (!dragTokenRef.current) {
        setDraggingFilePath('')
        setDropTarget(null)
        api?.setDesktopInteractionLocked(false)
      }
    }
    const end = (pointerEvent: PointerEvent) => finish(pointerEvent, false)
    const cancel = (pointerEvent: PointerEvent) => finish(pointerEvent, true)
    pointerReorderCleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', cancel, { once: true })
  }

  const finishFileDrag = async (file: DesktopFile, event: ReactDragEvent<HTMLButtonElement>) => {
    const widgetRect = event.currentTarget.closest('.desktop-widget')?.getBoundingClientRect()
    const droppedOutside = Boolean(widgetRect && (
      event.clientX < widgetRect.left
      || event.clientX >= widgetRect.right
      || event.clientY < widgetRect.top
      || event.clientY >= widgetRect.bottom
    ))
    const dragToken = dragTokenRef.current
    const claimedByOrganizer = Boolean(dragToken && api?.completeOrganizerFileDrop(dragToken))
    const completedInsideOrganizer = internalDropHandledRef.current || claimedByOrganizer
    internalDropHandledRef.current = false
    dragTokenRef.current = ''
    try {
      if (api && droppedOutside && !completedInsideOrganizer) {
        await api.releaseOrganizerFileToDesktop(widget.id, file.path)
      }
    } finally {
      delete document.documentElement.dataset.organizerFileDrag
      setDraggingFilePath('')
      setDropTarget(null)
      setDropActive(false)
      api?.setDesktopInteractionLocked(false)
    }
  }

  return (
    <div
      className={`organizer-drop-zone ${dropActive ? 'is-drop-active' : ''}`}
      aria-label="文件收纳盒"
      onDragEnter={(event) => {
        event.preventDefault()
        if (isOrganizerFileDrag(event.dataTransfer)) {
          setDropActive(false)
          return
        }
        prepareImportRef.current = api?.prepareOrganizerImport() || null
        setDropActive(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (isOrganizerFileDrag(event.dataTransfer)) {
          setDropActive(false)
          return
        }
        setDropActive(true)
      }}
      onDragLeave={(event) => {
        if (isOrganizerFileDrag(event.dataTransfer)) return
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false)
      }}
      onDrop={acceptDrop}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest('.organizer-file-open')) clearFileSelection()
      }}
    >
      {dropActive && <div className="drop-message">松开以加入收纳盒</div>}
      {orderedFiles.length ? (
        <div className={organizerGridClassName}>
          {orderedFiles.map((file) => (
            <div
              className={`organizer-file ${selectedFilePath === file.path ? 'is-selected' : ''} ${dropTarget?.path === file.path ? `is-drop-${dropTarget.edge}` : ''}`}
              key={`${file.id}-${file.path}`}
              data-organizer-file-path={file.path}
              onDragOver={(event) => {
                if (!isOrganizerFileDrag(event.dataTransfer)) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                const rect = event.currentTarget.getBoundingClientRect()
                const edge = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
                setDropTarget({ path: file.path, edge })
              }}
              onDrop={(event) => {
                if (!isOrganizerFileDrag(event.dataTransfer)) return
                event.preventDefault()
                event.stopPropagation()
                const payload = readOrganizerFileDrag(event.dataTransfer)
                if (!payload) return
                const rect = event.currentTarget.getBoundingClientRect()
                const edge = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
                moveFileInOrder(payload, file, edge)
              }}
            >
              <button
                type="button"
                className={`organizer-file-open ${draggingFilePath === file.path ? 'is-dragging' : ''}`}
                draggable
                aria-label={`${file.name}，单击选择，双击打开，右键显示菜单；可拖动排序、移至其他收纳盒或移出`}
                aria-selected={selectedFilePath === file.path}
                onPointerDown={(event) => {
                  if (event.button === 0) selectFile(file.path)
                  beginPointerReorder(file, event)
                }}
                onDragStart={(event) => {
                  pointerReorderCleanupRef.current?.()
                  event.stopPropagation()
                  event.dataTransfer.effectAllowed = 'move'
                  const dragToken = window.crypto.randomUUID()
                  dragTokenRef.current = dragToken
                  event.dataTransfer.setData(organizerFileDragType, JSON.stringify({
                    dragToken,
                    sourceWidgetId: widget.id,
                    fileId: file.id,
                    filePath: file.path,
                  } satisfies OrganizerFileDragPayload))
                  api?.setDesktopInteractionLocked(true)
                  document.documentElement.dataset.organizerFileDrag = 'true'
                  internalDropHandledRef.current = false
                  setDropTarget(null)
                  setDraggingFilePath(file.path)
                }}
                onDragEnd={(event) => void finishFileDrag(file, event)}
                onClick={(event) => {
                  if (suppressOpenClickRef.current) {
                    event.preventDefault()
                    return
                  }
                  selectFile(file.path)
                }}
                onDoubleClick={(event) => {
                  if (suppressOpenClickRef.current) {
                    event.preventDefault()
                    return
                  }
                  event.preventDefault()
                  void api?.openFile(file.path)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  selectFile(file.path)
                  void api?.showOrganizerFileMenu(widget.id, file.path)
                }}
              >
                <OrganizerFileIcon file={file} />
                <strong>{displayFileName(file)}</strong>
              </button>
              <button
                type="button"
                className="organizer-file-remove"
                onClick={(event) => {
                  event.stopPropagation()
                  void api?.releaseOrganizerFile(widget.id, file.path)
                }}
                aria-label={`移出收纳盒 ${file.name}`}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="organizer-empty">
          <Archive size={25} />
          <strong>把文件或文件夹拖进来</strong>
          <span>加入后双击即可打开</span>
        </div>
      )}
    </div>
  )
}

function NoteWidget({ widget }: { widget: DesktopWidget }) {
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

function TodoWidget({ widget }: { widget: DesktopWidget }) {
  const data = widget.data as TodoWidgetData
  const items = Array.isArray(data.items) ? data.items : []
  const api = window.desktopAPI
  const contentRef = useRef<HTMLDivElement>(null)
  const [settingsItemId, setSettingsItemId] = useState<string | null>(null)
  const [textDraft, setTextDraft] = useState('')
  const [startTimeDraft, setStartTimeDraft] = useState('')
  const [endTimeDraft, setEndTimeDraft] = useState('')
  const [isWide, setIsWide] = useState(widget.width >= 540)
  const [activeList, setActiveList] = useState<TodoListKind>(data.activeList === 'my-day' ? 'my-day' : 'temporary')
  const [listMenuOpen, setListMenuOpen] = useState(false)
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ itemId: string; edge: 'before' | 'after' } | null>(null)
  const [dropList, setDropList] = useState<TodoListKind | null>(null)
  const [todayKey, setTodayKey] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  const settingsItem = items.find((item) => item.id === settingsItemId) || null

  const itemList = (item: TodoItem): TodoListKind => item.list === 'my-day' ? 'my-day' : 'temporary'
  const itemCompleted = (item: TodoItem) => (
    itemList(item) === 'my-day'
      ? Boolean(item.completed && item.completedOn === todayKey)
      : Boolean(item.completed)
  )
  const save = (nextItems: TodoItem[], patch: Partial<TodoWidgetData> = {}) => (
    api?.updateWidget(widget.id, { data: { ...data, activeList, ...patch, items: nextItems } })
  )

  useEffect(() => {
    const element = contentRef.current
    if (!element) return undefined
    const updateLayout = () => setIsWide(element.clientWidth >= 520)
    updateLayout()
    const observer = new ResizeObserver(updateLayout)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setActiveList(data.activeList === 'my-day' ? 'my-day' : 'temporary')
  }, [data.activeList])

  useEffect(() => {
    let timer = 0
    const scheduleNextDay = () => {
      const now = new Date()
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      timer = window.setTimeout(() => {
        const current = new Date()
        setTodayKey(`${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`)
        scheduleNextDay()
      }, Math.max(1_000, nextDay.getTime() - now.getTime() + 100))
    }
    scheduleNextDay()
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const hasStaleCompletion = items.some((item) => (
      itemList(item) === 'my-day' && item.completed && item.completedOn !== todayKey
    ))
    if (!hasStaleCompletion) return
    void save(items.map((item) => {
      if (itemList(item) !== 'my-day' || !item.completed || item.completedOn === todayKey) return item
      const nextItem = { ...item, completed: false }
      delete nextItem.completedOn
      return nextItem
    }))
  }, [todayKey, items])

  const groupedItems = (list: TodoListKind) => items.filter((item) => itemList(item) === list)
  const replaceListItems = (list: TodoListKind, nextListItems: TodoItem[]) => {
    const otherList: TodoListKind = list === 'my-day' ? 'temporary' : 'my-day'
    const nextItems = list === 'my-day'
      ? [...nextListItems, ...groupedItems(otherList)]
      : [...groupedItems(otherList), ...nextListItems]
    void save(nextItems)
  }
  const moveItem = (item: TodoItem, direction: -1 | 1) => {
    const list = itemList(item)
    const listItems = groupedItems(list)
    const index = listItems.findIndex((candidate) => candidate.id === item.id)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= listItems.length) return
    const nextItems = [...listItems]
    const [moved] = nextItems.splice(index, 1)
    nextItems.splice(targetIndex, 0, moved)
    replaceListItems(list, nextItems)
  }
  const reorderItem = (sourceId: string, targetId: string, edge: 'before' | 'after') => {
    if (sourceId === targetId) return
    const source = items.find((item) => item.id === sourceId)
    const target = items.find((item) => item.id === targetId)
    if (!source || !target) return
    const targetList = itemList(target)
    const nextMyDay = groupedItems('my-day').filter((item) => item.id !== sourceId)
    const nextTemporary = groupedItems('temporary').filter((item) => item.id !== sourceId)
    const targetItems = targetList === 'my-day' ? nextMyDay : nextTemporary
    const targetIndex = targetItems.findIndex((item) => item.id === targetId)
    if (targetIndex < 0) return
    const movedItem = { ...source, list: targetList, completed: itemCompleted(source) }
    if (targetList === 'my-day' && movedItem.completed) movedItem.completedOn = todayKey
    else delete movedItem.completedOn
    targetItems.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, movedItem)
    void save([...nextMyDay, ...nextTemporary])
  }
  const moveItemToList = (sourceId: string, targetList: TodoListKind, reveal = false) => {
    const source = items.find((item) => item.id === sourceId)
    if (!source) return
    const nextMyDay = groupedItems('my-day').filter((item) => item.id !== sourceId)
    const nextTemporary = groupedItems('temporary').filter((item) => item.id !== sourceId)
    const movedItem = { ...source, list: targetList, completed: itemCompleted(source) }
    if (targetList === 'my-day' && movedItem.completed) movedItem.completedOn = todayKey
    else delete movedItem.completedOn
    if (targetList === 'my-day') nextMyDay.push(movedItem)
    else nextTemporary.push(movedItem)
    if (reveal) setActiveList(targetList)
    void save([...nextMyDay, ...nextTemporary], reveal ? { activeList: targetList } : {})
  }
  const selectList = (list: TodoListKind) => {
    setActiveList(list)
    setListMenuOpen(false)
    setSettingsItemId(null)
    if (data.activeList !== list) void save(items, { activeList: list })
  }
  const addItem = (event: FormEvent<HTMLFormElement>, list: TodoListKind) => {
    event.preventDefault()
    const form = event.currentTarget
    const input = form.elements.namedItem('todo') as HTMLInputElement
    const text = input.value.trim()
    if (!text) return
    save([...items, {
      id: crypto.randomUUID(),
      text,
      completed: false,
      list,
    }])
    form.reset()
  }
  const openSettings = (item: TodoItem) => {
    if (settingsItemId === item.id) {
      setSettingsItemId(null)
      return
    }
    setTextDraft(item.text)
    setStartTimeDraft(item.startTime || '')
    setEndTimeDraft(item.endTime || '')
    setSettingsItemId(item.id)
  }
  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!settingsItem) return
    const form = event.currentTarget
    const textInput = form.elements.namedItem('text') as HTMLInputElement
    const startTimeInput = form.elements.namedItem('startTime') as HTMLInputElement
    const endTimeInput = form.elements.namedItem('endTime') as HTMLInputElement
    const text = textDraft.trim()
    if (!text) {
      textInput.setCustomValidity('待办事项内容不能为空')
      textInput.reportValidity()
      return
    }
    textInput.setCustomValidity('')
    if (Boolean(startTimeDraft) !== Boolean(endTimeDraft)) {
      const missingInput = startTimeDraft ? endTimeInput : startTimeInput
      missingInput.setCustomValidity('请同时填写开始和结束时间')
      missingInput.reportValidity()
      return
    }
    startTimeInput.setCustomValidity('')
    endTimeInput.setCustomValidity('')
    save(items.map((item) => {
      if (item.id !== settingsItem.id) return item
      const nextItem = { ...item, text }
      if (startTimeDraft && endTimeDraft) {
        nextItem.startTime = startTimeDraft
        nextItem.endTime = endTimeDraft
      } else {
        delete nextItem.startTime
        delete nextItem.endTime
      }
      return nextItem
    }))
    setSettingsItemId(null)
  }

  const toggleCompleted = (item: TodoItem) => {
    const completed = !itemCompleted(item)
    void save(items.map((candidate) => {
      if (candidate.id !== item.id) return candidate
      const nextItem = { ...candidate, completed }
      if (itemList(candidate) === 'my-day') {
        if (completed) nextItem.completedOn = todayKey
        else delete nextItem.completedOn
      }
      return nextItem
    }))
  }

  const renderList = (list: TodoListKind) => {
    const listItems = groupedItems(list)
    const completed = listItems.filter(itemCompleted).length
    const label = list === 'my-day' ? '我的一天' : '临时安排'
    return (
      <section className="todo-list-section" data-todo-list={list} key={list}>
        <header className="todo-list-header">
          {isWide ? <strong>{label}</strong> : (
            <button
              type="button"
              className="todo-list-selector"
              onClick={() => setListMenuOpen((current) => !current)}
              aria-expanded={listMenuOpen}
              aria-haspopup="menu"
            >
              <strong>{label}</strong>
              <ChevronDown size={14} className={listMenuOpen ? 'is-open' : ''} />
            </button>
          )}
          <span>{completed} / {listItems.length} 已完成</span>
          {!isWide && listMenuOpen && (
            <div className="todo-list-menu" role="menu">
              {(['my-day', 'temporary'] as TodoListKind[]).map((candidate) => (
                <button
                  type="button"
                  role="menuitem"
                  className={candidate === activeList ? 'is-active' : ''}
                  onClick={() => selectList(candidate)}
                  key={candidate}
                >
                  {candidate === 'my-day' ? '我的一天' : '临时安排'}
                  {candidate === activeList && <Check size={12} />}
                </button>
              ))}
            </div>
          )}
        </header>
        {!isWide && draggedItemId && (
          <div className="todo-compact-group-targets" aria-label="移动到其他待办分组">
            {(['my-day', 'temporary'] as TodoListKind[]).map((candidate) => (
              <span
                data-todo-group-target={candidate}
                className={dropList === candidate ? 'is-active' : ''}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropList(candidate)
                }}
                onDragLeave={() => setDropList((current) => current === candidate ? null : current)}
                onDrop={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  const sourceId = event.dataTransfer.getData('application/x-edesktop-todo-item') || draggedItemId
                  if (sourceId) moveItemToList(sourceId, candidate, true)
                  setDraggedItemId(null)
                  setDropTarget(null)
                  setDropList(null)
                }}
                key={candidate}
              >
                {candidate === 'my-day' ? '移动到我的一天' : '移动到临时安排'}
              </span>
            ))}
          </div>
        )}
        <div
          className={`desktop-todo-list${dropList === list ? ' is-drop-target' : ''}`}
          onDragOver={(event) => {
            const target = event.target as HTMLElement
            if (target !== event.currentTarget && !target.closest('.todo-empty')) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDropList(list)
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropList((current) => current === list ? null : current)
            }
          }}
          onDrop={(event) => {
            const target = event.target as HTMLElement
            if (target !== event.currentTarget && !target.closest('.todo-empty')) return
            event.preventDefault()
            const sourceId = event.dataTransfer.getData('application/x-edesktop-todo-item') || draggedItemId
            if (sourceId) moveItemToList(sourceId, list)
            setDraggedItemId(null)
            setDropTarget(null)
            setDropList(null)
          }}
        >
          {listItems.map((item) => {
            const completedItem = itemCompleted(item)
            return (
              <div
                className={`desktop-todo-row${draggedItemId === item.id ? ' is-dragging' : ''}${dropTarget?.itemId === item.id ? ` drop-${dropTarget.edge}` : ''}`}
                data-todo-item-id={item.id}
                key={item.id}
                onDragOver={(event) => {
                  const sourceId = event.dataTransfer.getData('application/x-edesktop-todo-item') || draggedItemId
                  const source = items.find((candidate) => candidate.id === sourceId)
                  if (!source || source.id === item.id) return
                  event.preventDefault()
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'move'
                  setDropList(null)
                  const rect = event.currentTarget.getBoundingClientRect()
                  setDropTarget({ itemId: item.id, edge: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' })
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  const sourceId = event.dataTransfer.getData('application/x-edesktop-todo-item') || draggedItemId
                  if (sourceId) reorderItem(sourceId, item.id, dropTarget?.itemId === item.id ? dropTarget.edge : 'before')
                  setDraggedItemId(null)
                  setDropTarget(null)
                  setDropList(null)
                }}
              >
                <span
                  className="todo-item-drag-handle"
                  role="button"
                  tabIndex={0}
                  draggable
                  aria-label={`拖动调整“${item.text}”的位置`}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('application/x-edesktop-todo-item', item.id)
                    setDraggedItemId(item.id)
                    setSettingsItemId(null)
                  }}
                  onDragEnd={() => {
                    setDraggedItemId(null)
                    setDropTarget(null)
                    setDropList(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.altKey && event.key === 'ArrowUp') {
                      event.preventDefault()
                      moveItem(item, -1)
                    }
                    if (event.altKey && event.key === 'ArrowDown') {
                      event.preventDefault()
                      moveItem(item, 1)
                    }
                  }}
                >
                  <GripVertical size={14} />
                </span>
                <button
                  type="button"
                  className={completedItem ? 'is-completed' : ''}
                  onClick={() => toggleCompleted(item)}
                  aria-label={completedItem ? `将“${item.text}”标记为未完成` : `完成“${item.text}”`}
                >
                  {completedItem && <Check size={11} />}
                </button>
                <div className={`todo-item-copy ${completedItem ? 'is-completed' : ''}`}>
                  <span>{item.text}</span>
                  {item.startTime && item.endTime && (
                    <time className="todo-time-range">{item.startTime} – {item.endTime}</time>
                  )}
                </div>
                <button
                  type="button"
                  className={`todo-item-menu ${settingsItemId === item.id ? 'is-active' : ''}`}
                  onClick={() => openSettings(item)}
                  aria-label={`设置待办：${item.text}`}
                  aria-expanded={settingsItemId === item.id}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            )
          })}
          {!listItems.length && <p className="todo-empty">{list === 'my-day' ? '今天还没有安排' : '还没有临时安排'}</p>}
        </div>
        <form className="desktop-todo-add" onSubmit={(event) => addItem(event, list)}>
          <input className="todo-text-input" name="todo" placeholder={list === 'my-day' ? '添加到我的一天' : '添加临时安排'} autoComplete="off" />
          <button type="submit" aria-label={`添加到${label}`}><Plus size={16} /></button>
        </form>
      </section>
    )
  }

  return (
    <div ref={contentRef} className={`todo-widget-content ${isWide ? 'is-wide' : 'is-compact'}`}>
      <div className="todo-lists-grid">
        {isWide
          ? (['my-day', 'temporary'] as TodoListKind[]).map(renderList)
          : renderList(activeList)}
      </div>
      {settingsItem && (
        <div
          className="todo-item-settings-layer"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSettingsItemId(null)
          }}
        >
          <form
            key={settingsItem.id}
            className="todo-item-settings"
            aria-label={`设置待办：${settingsItem.text}`}
            onSubmit={saveSettings}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSettingsItemId(null)
            }}
          >
            <div className="todo-item-settings-header">
              <div>
                <strong>事项设置</strong>
                <span>修改事项内容与时间</span>
              </div>
              <button type="button" onClick={() => setSettingsItemId(null)} aria-label="关闭事项设置"><X size={14} /></button>
            </div>
            <label className="todo-item-settings-text">
              <span>事项内容</span>
              <input
                type="text"
                name="text"
                value={textDraft}
                maxLength={200}
                autoFocus
                onChange={(event) => {
                  setTextDraft(event.currentTarget.value)
                  event.currentTarget.setCustomValidity('')
                }}
                aria-label="待办事项内容"
              />
            </label>
            <div className="todo-item-settings-time">
              <label>
                <span>开始</span>
                <input
                  type="time"
                  name="startTime"
                  value={startTimeDraft}
                  onChange={(event) => {
                    setStartTimeDraft(event.currentTarget.value)
                    event.currentTarget.setCustomValidity('')
                  }}
                  aria-label="待办开始时间"
                />
              </label>
              <span>—</span>
              <label>
                <span>结束</span>
                <input
                  type="time"
                  name="endTime"
                  value={endTimeDraft}
                  onChange={(event) => {
                    setEndTimeDraft(event.currentTarget.value)
                    event.currentTarget.setCustomValidity('')
                  }}
                  aria-label="待办结束时间"
                />
              </label>
            </div>
            <div className="todo-item-settings-actions">
              <button
                type="button"
                className="todo-item-delete"
                onClick={() => {
                  save(items.filter((item) => item.id !== settingsItem.id))
                  setSettingsItemId(null)
                }}
              >
                <Trash2 size={12} />
                删除
              </button>
              <span>
                <button
                  type="button"
                  onClick={() => {
                    setStartTimeDraft('')
                    setEndTimeDraft('')
                  }}
                >
                  清除时间
                </button>
                <button type="submit" className="todo-item-settings-save">保存</button>
              </span>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function FlipDigit({ value, position }: { value: string; position: string }) {
  const settledValue = useRef(value)
  const [transition, setTransition] = useState<{
    from: string
    to: string
    key: number
  } | null>(null)

  useEffect(() => {
    const from = settledValue.current
    if (value === from) return undefined
    settledValue.current = value
    const key = Date.now()
    setTransition({ from, to: value, key })
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(() => {
      setTransition((current) => current?.key === key ? null : current)
    }, reducedMotion ? 0 : 480)
    return () => window.clearTimeout(timer)
  }, [value])

  const currentValue = transition?.to ?? settledValue.current
  const lowerValue = transition?.from ?? currentValue
  const glyph = (digit: string) => <span className="flip-digit-glyph" data-value={digit} />

  return (
    <span className={`flip-digit ${transition ? 'is-flipping' : ''}`} data-position={position} aria-hidden="true">
      <span className="flip-digit-half flip-digit-top flip-digit-static-top">{glyph(currentValue)}</span>
      <span className="flip-digit-half flip-digit-bottom flip-digit-static-bottom">{glyph(lowerValue)}</span>
      {transition && (
        <span key={`${position}-${transition.key}`} className="flip-digit-animation">
          <span className="flip-digit-leaf-stage flip-digit-leaf-stage-top">
            <span className="flip-digit-leaf flip-digit-leaf-out">
              {glyph(transition.from)}
            </span>
          </span>
          <span className="flip-digit-leaf-stage flip-digit-leaf-stage-bottom">
            <span className="flip-digit-leaf flip-digit-leaf-in">
              {glyph(transition.to)}
            </span>
          </span>
        </span>
      )}
      <span className="flip-digit-seam" />
    </span>
  )
}

function PomodoroWidget({ widget, settingsOpen, onCloseSettings }: {
  widget: DesktopWidget
  settingsOpen: boolean
  onCloseSettings: () => void
}) {
  const data = { ...defaultPomodoro, ...(widget.data as PomodoroWidgetData) }
  const [now, setNow] = useState(Date.now())
  const [focusDraft, setFocusDraft] = useState(String(data.focusMinutes))
  const [breakDraft, setBreakDraft] = useState(String(data.breakMinutes))
  const completing = useRef(false)
  const activeNow = data.running ? Date.now() : now
  const fallbackDuration = (data.mode === 'focus' ? data.focusMinutes : data.breakMinutes) * 60
  const storedRemaining = Number.isFinite(data.remainingSeconds)
    ? Math.max(0, Math.round(data.remainingSeconds))
    : fallbackDuration
  const remaining = data.running && data.endsAt
    ? Math.max(0, Math.ceil((data.endsAt - activeNow) / 1000))
    : storedRemaining

  useEffect(() => {
    if (!data.running) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [data.endsAt, data.running])

  useEffect(() => {
    if (!settingsOpen) return
    setFocusDraft(String(data.focusMinutes))
    setBreakDraft(String(data.breakMinutes))
  }, [data.breakMinutes, data.focusMinutes, settingsOpen])

  useEffect(() => {
    if (!data.running || remaining > 0 || completing.current) return
    completing.current = true
    const nextMode = data.mode === 'focus' ? 'break' : 'focus'
    const duration = nextMode === 'focus' ? data.focusMinutes : data.breakMinutes
    window.desktopAPI?.updateWidget(widget.id, {
      data: {
        ...data,
        mode: nextMode,
        remainingSeconds: duration * 60,
        running: false,
        endsAt: null,
        sessions: data.sessions + (data.mode === 'focus' ? 1 : 0),
      },
    }).finally(() => {
      completing.current = false
    })
  }, [data, remaining, widget.id])

  const update = (next: Partial<PomodoroWidgetData>) => {
    return window.desktopAPI?.updateWidget(widget.id, { data: { ...data, ...next } })
  }
  const saveDurations = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const focusMinutes = clamp(Math.round(Number(focusDraft) || data.focusMinutes), 1, 240)
    const breakMinutes = clamp(Math.round(Number(breakDraft) || data.breakMinutes), 1, 120)
    const remainingSeconds = (data.mode === 'focus' ? focusMinutes : breakMinutes) * 60
    setFocusDraft(String(focusMinutes))
    setBreakDraft(String(breakMinutes))
    void update({
      focusMinutes,
      breakMinutes,
      remainingSeconds,
      running: false,
      endsAt: null,
    })?.then(onCloseSettings)
  }
  const toggle = () => {
    if (data.running) {
      update({ running: false, endsAt: null, remainingSeconds: remaining })
    } else {
      const startedAt = Date.now()
      const startRemaining = remaining > 0 ? remaining : fallbackDuration
      setNow(startedAt)
      update({ running: true, endsAt: startedAt + startRemaining * 1000, remainingSeconds: startRemaining })
    }
  }
  const reset = () => {
    const minutes = data.mode === 'focus' ? data.focusMinutes : data.breakMinutes
    update({ running: false, endsAt: null, remainingSeconds: minutes * 60 })
  }
  const skip = () => {
    const nextMode = data.mode === 'focus' ? 'break' : 'focus'
    const minutes = nextMode === 'focus' ? data.focusMinutes : data.breakMinutes
    update({ mode: nextMode, running: false, endsAt: null, remainingSeconds: minutes * 60 })
  }
  const minutes = Math.floor(remaining / 60).toString().padStart(2, '0')
  const seconds = (remaining % 60).toString().padStart(2, '0')
  const total = (data.mode === 'focus' ? data.focusMinutes : data.breakMinutes) * 60
  const progress = total > 0 ? Math.max(0, Math.min(100, ((total - remaining) / total) * 100)) : 0

  if (settingsOpen) {
    return (
      <form className="pomodoro-settings" onSubmit={saveDurations}>
        <strong>计时时长</strong>
        <label>
          <span>专注时间</span>
          <span className="pomodoro-duration-input">
            <input
              name="focusMinutes"
              type="number"
              min="1"
              max="240"
              step="1"
              value={focusDraft}
              onChange={(event) => setFocusDraft(event.currentTarget.value)}
            />
            <small>分钟</small>
          </span>
        </label>
        <label>
          <span>休息时间</span>
          <span className="pomodoro-duration-input">
            <input
              name="breakMinutes"
              type="number"
              min="1"
              max="120"
              step="1"
              value={breakDraft}
              onChange={(event) => setBreakDraft(event.currentTarget.value)}
            />
            <small>分钟</small>
          </span>
        </label>
        <button type="submit">保存设置</button>
      </form>
    )
  }

  return (
    <div className="pomodoro-widget-content">
      <span className={`timer-mode mode-${data.mode}`}>{data.mode === 'focus' ? '专注时间' : '休息时间'}</span>
      <div className="desktop-timer-value" aria-label={`${minutes}:${seconds}`}>
        {[...minutes].map((digit, index) => <FlipDigit key={`minute-${index}`} value={digit} position={`minute-${index}`} />)}
        <span className="timer-separator" aria-hidden="true" />
        {[...seconds].map((digit, index) => <FlipDigit key={`second-${index}`} value={digit} position={`second-${index}`} />)}
        <span className="timer-accessible-value">{minutes}:{seconds}</span>
      </div>
      <div className="desktop-timer-progress"><i style={{ width: `${progress}%` }} /></div>
      <div className="desktop-timer-controls">
        <button type="button" onClick={reset} aria-label="重置"><RotateCcw size={15} /></button>
        <button type="button" className="timer-toggle" onClick={toggle} aria-label={data.running ? '暂停' : '开始'}>
          {data.running ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          type="button"
          className={`timer-mode-switch ${data.mode === 'break' ? 'is-break' : ''}`}
          onClick={skip}
          aria-label={data.mode === 'focus' ? '进入休息时间' : '返回专注时间'}
          aria-pressed={data.mode === 'break'}
        >
          <Coffee size={15} />
        </button>
      </div>
    </div>
  )
}

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
              onCloseSettings={() => setSettingsWidgetId(null)}
            />
          )}
        </WidgetShell>
      ))}
    </main>
  )
}
