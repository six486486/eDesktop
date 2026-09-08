export interface DesktopFile {
  id: string
  path: string
  name: string
  extension: string
  size: number
  isDirectory: boolean
  modifiedAt: string
  iconDataUrl?: string
  originalPath?: string
  originalDesktopPosition?: { x: number; y: number } | null
  shellClsid?: string
  shellVisibilityValueExists?: boolean
  shellVisibilityValue?: number
  temporarilyRestoredOnExit?: boolean
}

export interface TodoItem {
  id: string
  text: string
  completed: boolean
  list?: TodoListKind
  completedOn?: string
  startTime?: string
  endTime?: string
  reminderAt?: number
}

export type TodoListKind = 'my-day' | 'temporary'

export type WidgetKind = 'organizer' | 'note' | 'todo' | 'pomodoro'
export type WidgetTone = 'paper' | 'yellow' | 'emerald' | 'graphite'

export interface OrganizerWidgetData {
  files: DesktopFile[]
}

export interface NoteWidgetData {
  content: string
  updatedAt: string
}

export interface TodoWidgetData {
  items: TodoItem[]
  activeList?: TodoListKind
}

export interface PomodoroWidgetData {
  mode: 'focus' | 'break'
  focusMinutes: number
  breakMinutes: number
  remainingSeconds: number
  running: boolean
  endsAt: number | null
  sessions: number
  petFocus?: { id: string; minutes: number; status: 'active' | 'completed' } | null
}

export type DesktopWidgetData =
  | OrganizerWidgetData
  | NoteWidgetData
  | TodoWidgetData
  | PomodoroWidgetData

export interface DesktopWidget {
  id: string
  kind: WidgetKind
  title: string
  tone: WidgetTone
  x: number
  y: number
  width: number
  height: number
  hidden: boolean
  data: DesktopWidgetData
}

export interface WorkspaceSettings {
  desktopEnabled: boolean
  desktopPetEnabled: boolean
  launchAtLogin: boolean
  snapshotAutoEnabled: boolean
  snapshotRetention: number
}

export interface WorkspaceState {
  version: 1
  widgets: DesktopWidget[]
  desktopLayout?: {
    virtualBounds: { x: number; y: number; width: number; height: number }
    displays: DesktopInfo['displays']
  } | null
  desktopLayoutProfiles?: Array<{
    signature: string
    desktopLayout: {
      virtualBounds: { x: number; y: number; width: number; height: number }
      displays: DesktopInfo['displays']
    }
    widgetFrames: Array<Pick<DesktopWidget, 'id' | 'x' | 'y' | 'width' | 'height'>>
    updatedAt?: string
  }>
  desktopIconLayoutProfiles?: Array<{
    signature: string
    desktopLayout: {
      virtualBounds: { x: number; y: number; width: number; height: number }
      displays: DesktopInfo['displays']
    }
    positions: Array<{
      widgetId: string
      fileId: string
      x: number
      y: number
    }>
    updatedAt?: string
  }>
  settings: WorkspaceSettings
}

export type DesktopHostState = 'attached' | 'fallback' | 'disabled'
export type CloseRequestAction = 'tray' | 'quit' | 'cancel'

export interface DesktopStatus {
  hostState: DesktopHostState
  message: string
}

export interface WorkspaceSnapshotSummary {
  id: string
  createdAt: string
  reason: string
  appVersion: string
  widgetCount: number
  displayCount: number
  sizeBytes: number
  fileDataIncluded: false
}

export interface WorkspaceSnapshotRestoreResult {
  workspace: WorkspaceState
  missingFiles: string[]
  preservedFiles: number
  remappedWidgets: number
  movementErrors: string[]
}

export interface DesktopInfo {
  desktopPath: string
  virtualBounds: { x: number; y: number; width: number; height: number }
  primaryBounds: { x: number; y: number; width: number; height: number }
  displays: Array<{
    id: string
    primary: boolean
    scaleFactor: number
    bounds: { x: number; y: number; width: number; height: number }
  }>
}

export interface DesktopAPI {
  getDesktopInfo: () => Promise<DesktopInfo>
  getCursorPosition: () => { x: number; y: number }
  getPathForFile: (file: File) => string
  getFileIcon: (filePath: string) => Promise<string>
  prepareOrganizerImport: () => Promise<boolean>
  importOrganizerFiles: (widgetId: string, filePaths: string[]) => Promise<{ imported: number; errors: string[] }>
  moveOrganizerFile: (
    sourceWidgetId: string,
    targetWidgetId: string,
    filePath: string,
    targetFileId?: string,
    edge?: 'before' | 'after',
  ) => Promise<{ moved: boolean; error: string }>
  claimOrganizerFileDrop: (dragToken: string) => boolean
  completeOrganizerFileDrop: (dragToken: string) => boolean
  reorderOrganizerFiles: (widgetId: string, orderedFileIds: string[]) => Promise<WorkspaceState>
  releaseOrganizerFile: (widgetId: string, filePath: string) => Promise<{ releasedPath: string; error: string }>
  releaseOrganizerFileToDesktop: (widgetId: string, filePath: string) => Promise<{ releasedPath: string; error: string }>
  showOrganizerFileMenu: (widgetId: string, filePath: string) => Promise<string[]>
  selectOrganizerFile: (widgetId: string, filePath: string) => void
  clearOrganizerFileSelection: (widgetId: string) => void
  onOrganizerFileSelectionCleared: (callback: () => void) => () => void
  openFile: (filePath: string) => Promise<string>
  getWorkspace: () => Promise<WorkspaceState>
  addWidget: (kind: WidgetKind) => Promise<DesktopWidget>
  updateWidget: (id: string, patch: Partial<DesktopWidget>) => Promise<WorkspaceState>
  previewWidgetFrame: (id: string, patch: Pick<Partial<DesktopWidget>, 'x' | 'y' | 'width' | 'height'>) => void
  removeWidget: (id: string) => Promise<WorkspaceState>
  setDesktopEnabled: (enabled: boolean) => Promise<WorkspaceState>
  setDesktopPetEnabled: (enabled: boolean) => Promise<WorkspaceState>
  setLaunchAtLogin: (enabled: boolean) => Promise<WorkspaceState>
  listWorkspaceSnapshots: () => Promise<WorkspaceSnapshotSummary[]>
  createWorkspaceSnapshot: () => Promise<WorkspaceSnapshotSummary | null>
  restoreWorkspaceSnapshot: (snapshotId: string) => Promise<WorkspaceSnapshotRestoreResult>
  deleteWorkspaceSnapshot: (snapshotId: string) => Promise<WorkspaceSnapshotSummary[]>
  exportWorkspaceSnapshot: (snapshotId: string) => Promise<{ canceled: boolean; filePath: string }>
  importWorkspaceSnapshot: () => Promise<{ canceled: boolean; snapshot: WorkspaceSnapshotSummary | null }>
  setWorkspaceSnapshotSettings: (settings: { autoEnabled?: boolean; retention?: number }) => Promise<WorkspaceState>
  getDesktopStatus: () => Promise<DesktopStatus>
  setDesktopInteractionLocked: (locked: boolean) => void
  onDesktopInfoChanged: (callback: (info: DesktopInfo) => void) => () => void
  onWorkspaceChanged: (callback: (state: WorkspaceState) => void) => () => void
  onDesktopStatusChanged: (callback: (status: DesktopStatus) => void) => () => void
  onCloseRequested: (callback: () => void) => () => void
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  respondToCloseRequest: (action: CloseRequestAction) => void
}
