import {
  Check,
  ChevronDown,
  GripVertical,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  DesktopWidget,
  TodoItem,
  TodoListKind,
  TodoWidgetData,
} from '../types'

export function TodoWidget({ widget }: { widget: DesktopWidget }) {
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

