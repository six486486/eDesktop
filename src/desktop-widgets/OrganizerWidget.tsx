import { Archive, X } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { displayFileName, iconForFile } from '../lib/files'
import type { DesktopFile, DesktopWidget, OrganizerWidgetData } from '../types'

const organizerFileDragType = 'application/x-edesktop-organizer-file'
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

export function OrganizerWidget({ widget }: { widget: DesktopWidget }) {
  const api = window.desktopAPI
  const data = widget.data as OrganizerWidgetData
  // An entry restored to the desktop during the previous shutdown is only a
  // pending membership record until startup has physically moved it back.
  // Rendering it early makes one real desktop icon look like two files.
  const { files, pendingStartupFileCount } = useMemo(() => {
    const sourceFiles = Array.isArray(data.files) ? data.files : []
    return {
      files: sourceFiles.filter((file) => file.temporarilyRestoredOnExit !== true),
      pendingStartupFileCount: sourceFiles.filter((file) => file.temporarilyRestoredOnExit === true).length,
    }
  }, [data.files])
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
      ) : pendingStartupFileCount > 0 ? (
        <div className="organizer-empty organizer-startup-loading" aria-live="polite">
          <Archive size={25} />
          <strong>正在整理桌面文件…</strong>
          <span>{pendingStartupFileCount} 个项目将在后台载入</span>
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

