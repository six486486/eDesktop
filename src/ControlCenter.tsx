import {
  Archive,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  Download,
  History,
  Info,
  MonitorUp,
  Plus,
  Power,
  Search,
  Settings2,
  ShieldCheck,
  StickyNote,
  Timer,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import appIconUrl from '../assets/app-icon.png'
import {
  CloseRequestDialog,
  WidgetRow,
  WindowControls,
} from './control-center/ControlCenterComponents'
import { useWorkspace } from './hooks/useWorkspace'
import type {
  CloseRequestAction,
  DesktopWidget,
  WidgetKind,
  WorkspaceSnapshotSummary,
} from './types'

type ControlPage = 'basic' | 'add' | 'widgets' | 'snapshots'

const widgetOptions: Array<{
  kind: WidgetKind
  title: string
  description: string
  icon: typeof Archive
}> = [
  { kind: 'organizer', title: '收纳盒', description: '整理应用、文件和文件夹', icon: Archive },
  { kind: 'note', title: '便签', description: '记录临时想法和重要信息', icon: StickyNote },
  { kind: 'todo', title: '待办列表', description: '安排“我的一天”和临时任务', icon: CheckSquare2 },
  { kind: 'pomodoro', title: '番茄钟', description: '使用专注与休息计时保持节奏', icon: Timer },
]

const pageCopy: Record<ControlPage, { title: string; description: string }> = {
  basic: { title: '基础设置', description: '设置组件显示状态和应用启动方式。' },
  add: { title: '添加组件', description: '选择一种组件添加到桌面。' },
  widgets: { title: '已有组件', description: '按类型管理已创建的桌面组件。' },
  snapshots: { title: '快照与恢复', description: '保存组件配置，并在多屏环境变化后安全恢复。' },
}

const pageSearchTerms: Record<ControlPage, string> = {
  basic: '基础设置 显示 桌面 组件 开机 自动运行 启动 数据 安全 文件 文档',
  add: '添加组件 新建 收纳盒 便签 待办列表 番茄钟',
  widgets: '已有组件 管理 收纳盒 便签 待办列表 番茄钟 改名 显示 隐藏 删除',
  snapshots: '快照 恢复 自动 历史 配置 导入 导出 多屏幕 显示器',
}

const formatSnapshotDate = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false })
}

const formatSnapshotSize = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`

const groupSummary = (widgets: DesktopWidget[]) => {
  if (widgets.length === 0) return '当前无活跃组件'
  const visibleCount = widgets.filter((widget) => !widget.hidden).length
  if (visibleCount === widgets.length) return `${widgets.length} 个组件 · 全部可见`
  if (visibleCount === 0) return `${widgets.length} 个组件 · 均已隐藏`
  return `${visibleCount} 个显示 · ${widgets.length - visibleCount} 个隐藏`
}

export function ControlCenter() {
  const { workspace, status } = useWorkspace()
  const isCapture = new URLSearchParams(window.location.search).get('capture') === '1'
  const [activePage, setActivePage] = useState<ControlPage>('basic')
  const [searchValue, setSearchValue] = useState('')
  const [adding, setAdding] = useState<WidgetKind | null>(null)
  const [closeRequestOpen, setCloseRequestOpen] = useState(false)
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshotSummary[]>([])
  const [snapshotBusy, setSnapshotBusy] = useState('')
  const [snapshotNotice, setSnapshotNotice] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Record<WidgetKind, boolean>>({
    organizer: true,
    note: false,
    todo: false,
    pomodoro: false,
  })
  const api = window.desktopAPI

  useEffect(() => {
    const unsubscribe = window.desktopAPI?.onCloseRequested(() => {
      setCloseRequestOpen(true)
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    if (activePage !== 'snapshots') return
    void api?.listWorkspaceSnapshots().then(setSnapshots)
  }, [activePage, api])

  const counts = useMemo(() => {
    return workspace.widgets.reduce<Record<WidgetKind, number>>(
      (result, widget) => {
        result[widget.kind] += 1
        return result
      },
      { organizer: 0, note: 0, todo: 0, pomodoro: 0 },
    )
  }, [workspace.widgets])

  const addWidget = async (kind: WidgetKind) => {
    if (!api || adding) return
    setAdding(kind)
    try {
      await api.addWidget(kind)
    } finally {
      setAdding(null)
    }
  }

  const toggleDesktop = async () => {
    await api?.setDesktopEnabled(!workspace.settings.desktopEnabled)
  }

  const resolveCloseRequest = (action: CloseRequestAction) => {
    setCloseRequestOpen(false)
    api?.respondToCloseRequest(action)
  }

  const updateSearch = (value: string) => {
    setSearchValue(value)
    const query = value.trim().toLocaleLowerCase()
    if (!query) return
    const match = (Object.keys(pageSearchTerms) as ControlPage[])
      .find((page) => pageSearchTerms[page].toLocaleLowerCase().includes(query))
    if (match) setActivePage(match)
  }

  const selectPage = (page: ControlPage) => {
    setActivePage(page)
    setSearchValue('')
  }

  const refreshSnapshots = async () => {
    const nextSnapshots = await api?.listWorkspaceSnapshots()
    if (nextSnapshots) setSnapshots(nextSnapshots)
  }

  const createSnapshot = async () => {
    if (!api || snapshotBusy) return
    setSnapshotBusy('create')
    setSnapshotNotice('')
    try {
      await api.createWorkspaceSnapshot()
      await refreshSnapshots()
      setSnapshotNotice('已创建配置快照，不包含任何真实文件内容。')
    } catch (error) {
      setSnapshotNotice(`创建失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSnapshotBusy('')
    }
  }

  const restoreSnapshot = async (snapshot: WorkspaceSnapshotSummary) => {
    if (!api || snapshotBusy) return
    if (!window.confirm(`确定恢复 ${formatSnapshotDate(snapshot.createdAt)} 的配置吗？恢复前会自动保存当前状态。`)) return
    setSnapshotBusy(snapshot.id)
    setSnapshotNotice('')
    try {
      const result = await api.restoreWorkspaceSnapshot(snapshot.id)
      const notes = ['快照恢复完成']
      if (result.remappedWidgets) notes.push(`${result.remappedWidgets} 个组件已适配当前显示器`)
      if (result.preservedFiles) notes.push(`${result.preservedFiles} 个较新文件引用已保留`)
      if (result.missingFiles.length) notes.push(`${result.missingFiles.length} 个缺失文件已跳过`)
      if (result.movementErrors.length) notes.push(`${result.movementErrors.length} 个收纳项目未能调整分组`)
      setSnapshotNotice(`${notes.join('；')}。`)
      await refreshSnapshots()
    } catch (error) {
      setSnapshotNotice(`恢复失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSnapshotBusy('')
    }
  }

  const deleteSnapshot = async (snapshot: WorkspaceSnapshotSummary) => {
    if (!api || snapshotBusy) return
    if (!window.confirm(`确定删除 ${formatSnapshotDate(snapshot.createdAt)} 的快照吗？`)) return
    setSnapshotBusy(snapshot.id)
    try {
      setSnapshots(await api.deleteWorkspaceSnapshot(snapshot.id))
      setSnapshotNotice('快照已删除；不会影响任何用户文件。')
    } catch (error) {
      setSnapshotNotice(`删除失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSnapshotBusy('')
    }
  }

  const exportSnapshot = async (snapshot: WorkspaceSnapshotSummary) => {
    if (!api || snapshotBusy) return
    setSnapshotBusy(snapshot.id)
    try {
      const result = await api.exportWorkspaceSnapshot(snapshot.id)
      if (!result.canceled) setSnapshotNotice(`配置快照已导出到：${result.filePath}`)
    } catch (error) {
      setSnapshotNotice(`导出失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSnapshotBusy('')
    }
  }

  const importSnapshot = async () => {
    if (!api || snapshotBusy) return
    setSnapshotBusy('import')
    try {
      const result = await api.importWorkspaceSnapshot()
      if (!result.canceled) {
        await refreshSnapshots()
        setSnapshotNotice('配置快照已导入，可在历史快照中检查后恢复。')
      }
    } catch (error) {
      setSnapshotNotice(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSnapshotBusy('')
    }
  }

  return (
    <main className="control-center">
      <header className="control-titlebar">
        <div className="control-brand">
          <img src={appIconUrl} alt="" />
          <strong>eDesktop 控制中心</strong>
        </div>
        <WindowControls onClose={() => api?.close()} />
      </header>

      <div className="control-shell">
        <aside className="control-sidebar">
          <div className="control-identity">
            <img src={appIconUrl} alt="" />
            <div>
              <strong>eDesktop</strong>
              <span>桌面组件管理</span>
            </div>
          </div>

          <label className="control-search">
            <input
              type="search"
              value={searchValue}
              onChange={(event) => updateSearch(event.currentTarget.value)}
              placeholder="查找设置"
              aria-label="查找设置"
            />
            <Search size={15} />
          </label>

          <nav className="control-navigation" aria-label="控制中心页面">
            <button
              type="button"
              className={activePage === 'basic' ? 'is-active' : ''}
              aria-current={activePage === 'basic' ? 'page' : undefined}
              onClick={() => selectPage('basic')}
            >
              <Settings2 size={18} />
              <span>基础设置</span>
            </button>
            <button
              type="button"
              className={activePage === 'add' ? 'is-active' : ''}
              aria-current={activePage === 'add' ? 'page' : undefined}
              onClick={() => selectPage('add')}
            >
              <Plus size={18} />
              <span>添加组件</span>
            </button>
            <button
              type="button"
              className={activePage === 'widgets' ? 'is-active' : ''}
              aria-current={activePage === 'widgets' ? 'page' : undefined}
              onClick={() => selectPage('widgets')}
            >
              <Archive size={18} />
              <span>已有组件</span>
            </button>
            <button
              type="button"
              className={activePage === 'snapshots' ? 'is-active' : ''}
              aria-current={activePage === 'snapshots' ? 'page' : undefined}
              onClick={() => selectPage('snapshots')}
            >
              <History size={18} />
              <span>快照与恢复</span>
            </button>
          </nav>

          <p className="control-sidebar-note">桌面组件运行在壁纸层</p>
        </aside>

        <section className="control-page-area">
          <header className="control-page-heading">
            <div>
              <h1>{pageCopy[activePage].title}</h1>
              <p>{pageCopy[activePage].description}</p>
            </div>
            <div className={`control-status state-${status.hostState}`}>
              <span />
              <strong>{isCapture ? '桌面组件运行正常' : status.message}</strong>
            </div>
          </header>

          <div className="control-page-scroll">
            {activePage === 'basic' && (
              <div className="control-page control-basic-page">
                <section>
                  <h2>基础设置</h2>
                  <div className="control-settings-card">
                    <label className="control-setting-row">
                      <span className="control-row-icon is-blue"><Power size={18} /></span>
                      <span className="control-row-copy">
                        <strong>显示桌面组件</strong>
                        <small>控制所有桌面组件是否显示</small>
                      </span>
                      <input type="checkbox" checked={workspace.settings.desktopEnabled} onChange={toggleDesktop} />
                      <i className="fluent-switch" />
                    </label>

                    <label className="control-setting-row">
                      <span className="control-row-icon"><MonitorUp size={18} /></span>
                      <span className="control-row-copy">
                        <strong>开机自动运行</strong>
                        <small>登录 Windows 后自动启动 eDesktop 并恢复组件</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={workspace.settings.launchAtLogin}
                        onChange={(event) => api?.setLaunchAtLogin(event.currentTarget.checked)}
                      />
                      <i className="fluent-switch" />
                    </label>
                  </div>
                </section>

                <aside className="safety-card">
                  <Info size={18} />
                  <div>
                    <strong>数据与安全</strong>
                    <p>文件默认保存在“文档/eDesktop”；移除组件不会删除任何文件。</p>
                  </div>
                </aside>
              </div>
            )}

            {activePage === 'add' && (
              <div className="control-page control-add-page">
                <section>
                  <h2>选择组件</h2>
                  <p className="control-section-caption">添加后直接显示在桌面，可随时拖动和调整大小。</p>
                  <div className="control-settings-card add-widget-list">
                    {widgetOptions.map(({ kind, title, description, icon: Icon }) => (
                      <button
                        type="button"
                        key={kind}
                        className="add-widget-row"
                        onClick={() => addWidget(kind)}
                        disabled={adding !== null}
                      >
                        <span className={`control-row-icon kind-${kind}`}><Icon size={18} /></span>
                        <span className="control-row-copy">
                          <strong>{adding === kind ? '正在添加…' : title}</strong>
                          <small>{description}</small>
                        </span>
                        <em>{counts[kind]}</em>
                        <span className="fluent-add-button"><Plus size={14} />添加</span>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {activePage === 'widgets' && (
              <div className="control-page control-widgets-page">
                <section>
                  <div className="control-section-title-row">
                    <div>
                      <h2>组件分组</h2>
                      <p className="control-section-caption">点击名称可改名，也可以隐藏或移除组件。</p>
                    </div>
                    <span>{workspace.widgets.length} 个组件</span>
                  </div>

                  <div className="control-widget-groups">
                    {widgetOptions.map(({ kind, title, icon: Icon }) => {
                      const widgets = workspace.widgets.filter((widget) => widget.kind === kind)
                      const expanded = expandedGroups[kind]
                      const panelId = `widget-group-${kind}`

                      return (
                        <article
                          className={`widget-group${widgets.length > 0 ? ' has-widgets' : ''}${expanded ? ' is-expanded' : ''}`}
                          key={kind}
                        >
                          <button
                            type="button"
                            className="widget-group-header"
                            aria-expanded={expanded}
                            aria-controls={panelId}
                            onClick={() => setExpandedGroups((current) => ({ ...current, [kind]: !current[kind] }))}
                          >
                            <span className={`widget-kind-mark kind-${kind}`}><Icon size={18} /></span>
                            <span className="widget-group-copy">
                              <strong>{title}</strong>
                              <small>{groupSummary(widgets)}</small>
                            </span>
                            <span className="widget-group-meta">
                              <em>{widgets.length}</em>
                              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            </span>
                          </button>

                          {expanded && (
                            <div className="widget-group-body" id={panelId}>
                              {widgets.length > 0 ? (
                                widgets.map((widget) => <WidgetRow key={widget.id} widget={widget} />)
                              ) : (
                                <button type="button" className="widget-group-empty" onClick={() => addWidget(kind)}>
                                  <Plus size={15} />
                                  <span>暂无{title}组件，点击添加</span>
                                </button>
                              )}
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                </section>
              </div>
            )}

            {activePage === 'snapshots' && (
              <div className="control-page snapshot-page">
                <section>
                  <h2>自动保护</h2>
                  <div className="control-settings-card snapshot-settings-card">
                    <label className="control-setting-row">
                      <span className="control-row-icon is-blue"><ShieldCheck size={18} /></span>
                      <span className="control-row-copy">
                        <strong>自动创建配置快照</strong>
                        <small>定期保存，并在移除组件或移出收纳项目之前额外保护</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={workspace.settings.snapshotAutoEnabled}
                        onChange={(event) => api?.setWorkspaceSnapshotSettings({ autoEnabled: event.currentTarget.checked })}
                      />
                      <i className="fluent-switch" />
                    </label>
                    <label className="snapshot-retention-row">
                      <span>
                        <strong>保留快照数量</strong>
                        <small>超过数量后自动清理最旧的快照</small>
                      </span>
                      <select
                        value={workspace.settings.snapshotRetention}
                        onChange={(event) => api?.setWorkspaceSnapshotSettings({ retention: Number(event.currentTarget.value) })}
                        aria-label="保留快照数量"
                      >
                        {[10, 20, 30, 50, 100].map((count) => <option key={count} value={count}>{count} 份</option>)}
                      </select>
                    </label>
                  </div>
                </section>

                <section className="snapshot-history-section">
                  <div className="control-section-title-row snapshot-title-row">
                    <div>
                      <h2>历史快照</h2>
                      <p className="control-section-caption">只保存组件配置和文件引用，不复制真实文件。</p>
                    </div>
                    <div className="snapshot-toolbar">
                      <button type="button" onClick={importSnapshot} disabled={Boolean(snapshotBusy)}>
                        <Upload size={14} />导入
                      </button>
                      <button type="button" className="is-primary" onClick={createSnapshot} disabled={Boolean(snapshotBusy)}>
                        <History size={14} />{snapshotBusy === 'create' ? '创建中…' : '立即创建'}
                      </button>
                    </div>
                  </div>

                  {snapshotNotice && <div className="snapshot-notice" role="status"><Info size={14} />{snapshotNotice}</div>}

                  <div className="snapshot-list">
                    {snapshots.length > 0 ? snapshots.map((snapshot) => (
                      <article className="snapshot-row" key={snapshot.id}>
                        <span className="snapshot-row-icon"><History size={17} /></span>
                        <div className="snapshot-row-copy">
                          <strong>{snapshot.reason}</strong>
                          <span>{formatSnapshotDate(snapshot.createdAt)}</span>
                          <small>
                            {snapshot.widgetCount} 个组件 · {snapshot.displayCount} 个显示器 · {formatSnapshotSize(snapshot.sizeBytes)}
                          </small>
                        </div>
                        <div className="snapshot-row-actions">
                          <button type="button" onClick={() => restoreSnapshot(snapshot)} disabled={Boolean(snapshotBusy)}>
                            <History size={14} />恢复
                          </button>
                          <button type="button" onClick={() => exportSnapshot(snapshot)} disabled={Boolean(snapshotBusy)} aria-label="导出快照">
                            <Download size={14} />
                          </button>
                          <button type="button" className="is-danger" onClick={() => deleteSnapshot(snapshot)} disabled={Boolean(snapshotBusy)} aria-label="删除快照">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </article>
                    )) : (
                      <div className="snapshot-empty">
                        <History size={25} />
                        <strong>还没有配置快照</strong>
                        <span>点击“立即创建”保存当前组件状态。</span>
                      </div>
                    )}
                  </div>
                </section>

                <aside className="safety-card snapshot-safety-card">
                  <Info size={18} />
                  <div>
                    <strong>多屏幕恢复</strong>
                    <p>恢复时优先匹配原显示器；显示器缺失、位置或分辨率变化时，会将组件按相对位置映射并限制在当前屏幕范围内。</p>
                  </div>
                </aside>
              </div>
            )}
          </div>
        </section>
      </div>

      {closeRequestOpen && (
        <CloseRequestDialog
          onCancel={() => resolveCloseRequest('cancel')}
          onConfirm={resolveCloseRequest}
        />
      )}
    </main>
  )
}
