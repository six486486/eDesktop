import { useEffect, useState } from 'react'
import type { DesktopStatus, WorkspaceState } from '../types'

const emptyWorkspace: WorkspaceState = {
  version: 1,
  widgets: [],
  settings: {
    desktopEnabled: true,
    launchAtLogin: false,
    snapshotAutoEnabled: true,
    snapshotRetention: 30,
  },
}

const emptyStatus: DesktopStatus = {
  hostState: 'disabled',
  message: '正在连接桌面层…',
}

export function useWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(emptyWorkspace)
  const [status, setStatus] = useState<DesktopStatus>(emptyStatus)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const api = window.desktopAPI
    if (!api) {
      setReady(true)
      return
    }

    let active = true
    Promise.all([api.getWorkspace(), api.getDesktopStatus()]).then(([nextWorkspace, nextStatus]) => {
      if (!active) return
      setWorkspace(nextWorkspace)
      setStatus(nextStatus)
      setReady(true)
    })

    const unsubscribeWorkspace = api.onWorkspaceChanged(setWorkspace)
    const unsubscribeStatus = api.onDesktopStatusChanged(setStatus)
    return () => {
      active = false
      unsubscribeWorkspace()
      unsubscribeStatus()
    }
  }, [])

  return { workspace, status, ready }
}
