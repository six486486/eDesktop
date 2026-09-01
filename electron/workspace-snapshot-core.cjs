const snapshotSchemaVersion = 1

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback)
const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum)

const normalizeBounds = (bounds = {}) => ({
  x: finite(bounds.x),
  y: finite(bounds.y),
  width: Math.max(1, finite(bounds.width, 1)),
  height: Math.max(1, finite(bounds.height, 1)),
})

const normalizeDisplay = (display = {}, index = 0) => ({
  id: String(display.id ?? `display-${index}`),
  label: typeof display.label === 'string' ? display.label : '',
  primary: display.primary === true,
  scaleFactor: Math.max(0.1, finite(display.scaleFactor, 1)),
  bounds: normalizeBounds(display.bounds),
})

const workspaceLayoutSignature = (layout) => JSON.stringify(
  (Array.isArray(layout) ? layout : (Array.isArray(layout?.displays) ? layout.displays : []))
    .map(normalizeDisplay)
    .map((display) => ({
      // Electron display ids are session-local on Windows and can change after
      // a reboot or dock cycle. A topology profile describes geometry and DPI,
      // not one boot's transient display handle.
      label: display.label.trim().toLocaleLowerCase(),
      primary: display.primary,
      scaleFactor: display.scaleFactor,
      bounds: display.bounds,
    }))
    .sort((left, right) => (
      left.bounds.x - right.bounds.x
      || left.bounds.y - right.bounds.y
      || left.bounds.width - right.bounds.width
      || left.bounds.height - right.bounds.height
      || left.scaleFactor - right.scaleFactor
      || left.label.localeCompare(right.label)
    )),
)

const captureWorkspaceLayoutProfile = (workspace, desktopLayout) => ({
  signature: workspaceLayoutSignature(desktopLayout),
  desktopLayout: JSON.parse(JSON.stringify(desktopLayout)),
  widgetFrames: (Array.isArray(workspace?.widgets) ? workspace.widgets : []).map((widget) => ({
    id: widget.id,
    x: finite(widget.x),
    y: finite(widget.y),
    width: Math.max(1, finite(widget.width, 1)),
    height: Math.max(1, finite(widget.height, 1)),
  })),
})

const restoreWorkspaceLayoutProfile = (workspace, profile) => {
  const cloned = JSON.parse(JSON.stringify(workspace || {}))
  const frames = new Map((Array.isArray(profile?.widgetFrames) ? profile.widgetFrames : [])
    .filter((frame) => typeof frame?.id === 'string')
    .map((frame) => [frame.id, frame]))
  let restoredWidgets = 0
  cloned.widgets = (Array.isArray(cloned.widgets) ? cloned.widgets : []).map((widget) => {
    const frame = frames.get(widget.id)
    if (!frame) return widget
    restoredWidgets += 1
    return {
      ...widget,
      x: finite(frame.x, finite(widget.x)),
      y: finite(frame.y, finite(widget.y)),
      width: Math.max(1, finite(frame.width, finite(widget.width, 1))),
      height: Math.max(1, finite(frame.height, finite(widget.height, 1))),
    }
  })
  return { workspace: cloned, restoredWidgets }
}

const displayDistance = (source, target) => {
  const sourceAspect = source.bounds.width / source.bounds.height
  const targetAspect = target.bounds.width / target.bounds.height
  const sizeDelta = Math.abs(Math.log(source.bounds.width / target.bounds.width))
    + Math.abs(Math.log(source.bounds.height / target.bounds.height))
  return Math.abs(sourceAspect - targetAspect) * 4 + sizeDelta
}

const buildDisplayMapping = (sourceDisplays, targetDisplays) => {
  const sources = (Array.isArray(sourceDisplays) ? sourceDisplays : []).map(normalizeDisplay)
  const targets = (Array.isArray(targetDisplays) ? targetDisplays : []).map(normalizeDisplay)
  const targetPrimary = targets.find((display) => display.primary) || targets[0] || null
  const mapping = new Map()
  const unusedTargets = new Set(targets.map((display) => display.id))

  const assign = (source, target) => {
    if (!source || !target || mapping.has(source.id)) return false
    mapping.set(source.id, target)
    unusedTargets.delete(target.id)
    return true
  }

  // A layout created on the primary display follows the primary role when the
  // user changes which physical monitor is primary. Mapping exact ids first
  // left the whole workspace on the former primary after a dock/undock cycle.
  const sourcePrimary = sources.find((display) => display.primary)
  if (sourcePrimary && targetPrimary) assign(sourcePrimary, targetPrimary)

  for (const source of sources) {
    const exact = targets.find((target) => unusedTargets.has(target.id) && target.id === source.id)
    if (exact) assign(source, exact)
  }
  for (const source of sources.filter((display) => !mapping.has(display.id) && display.label)) {
    const labelMatch = targets.find((target) => (
      unusedTargets.has(target.id)
      && target.label
      && target.label.toLocaleLowerCase() === source.label.toLocaleLowerCase()
    ))
    if (labelMatch) assign(source, labelMatch)
  }
  for (const source of sources.filter((display) => !mapping.has(display.id))) {
    const candidates = targets.filter((target) => unusedTargets.has(target.id))
    const best = candidates.sort((left, right) => displayDistance(source, left) - displayDistance(source, right))[0]
    assign(source, best || targetPrimary)
  }
  return { sources, targets, targetPrimary, mapping }
}

const distanceToBounds = (point, bounds) => {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width))
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height))
  return dx * dx + dy * dy
}

const nearestDisplay = (point, displays) => displays.reduce((nearest, display) => {
  if (!nearest) return display
  return distanceToBounds(point, display.bounds) < distanceToBounds(point, nearest.bounds) ? display : nearest
}, null)

const minimumWidgetSize = (kind) => (
  kind === 'organizer' ? { width: 88, height: 122 } : { width: 240, height: 190 }
)

const layoutClusterGap = 40

const widgetFrame = (widget) => ({
  x: finite(widget.x),
  y: finite(widget.y),
  width: Math.max(1, finite(widget.width, 1)),
  height: Math.max(1, finite(widget.height, 1)),
})

const unionFrames = (frames) => {
  const left = Math.min(...frames.map((frame) => frame.x))
  const top = Math.min(...frames.map((frame) => frame.y))
  const right = Math.max(...frames.map((frame) => frame.x + frame.width))
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

const frameDistance = (left, right) => {
  const dx = Math.max(left.x - (right.x + right.width), right.x - (left.x + left.width), 0)
  const dy = Math.max(left.y - (right.y + right.height), right.y - (left.y + left.height), 0)
  return Math.sqrt(dx * dx + dy * dy)
}

const clusterWidgets = (entries) => {
  const remaining = new Set(entries.map((_, index) => index))
  const groups = []
  while (remaining.size) {
    const first = remaining.values().next().value
    remaining.delete(first)
    const memberIndexes = [first]
    for (let cursor = 0; cursor < memberIndexes.length; cursor += 1) {
      const frame = widgetFrame(entries[memberIndexes[cursor]].widget)
      for (const candidate of [...remaining]) {
        if (frameDistance(frame, widgetFrame(entries[candidate].widget)) > layoutClusterGap) continue
        remaining.delete(candidate)
        memberIndexes.push(candidate)
      }
    }
    groups.push(memberIndexes.map((index) => entries[index]))
  }
  return groups
}

const translatedGroupFrames = (group, x, y) => {
  const bounds = group.bounds
  return group.entries.map((entry) => ({
    entry,
    frame: {
      ...widgetFrame(entry.widget),
      x: x + finite(entry.widget.x) - bounds.x,
      y: y + finite(entry.widget.y) - bounds.y,
    },
  }))
}

const frameOverlapArea = (left, right) => {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  return width > 0 && height > 0 ? width * height : 0
}

const placeRigidGroups = (groups, target) => {
  const edgeGap = 8
  const topGap = 0
  const targetBounds = target.bounds
  const inner = {
    x: targetBounds.x + edgeGap,
    y: targetBounds.y + topGap,
    width: Math.max(1, targetBounds.width - edgeGap * 2),
    height: Math.max(1, targetBounds.height - topGap - edgeGap),
  }
  const placedFrames = []
  const placements = new Map()
  const ordered = [...groups].sort((left, right) => {
    const leftResident = left.source.id === target.id ? 1 : 0
    const rightResident = right.source.id === target.id ? 1 : 0
    if (leftResident !== rightResident) return rightResident - leftResident
    return right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height
  })

  for (const group of ordered) {
    if (group.bounds.width > inner.width || group.bounds.height > inner.height) {
      for (const entry of group.entries) placements.set(entry.index, fitFrameToDisplay(entry.widget, target))
      continue
    }

    const sourceBounds = group.source.bounds
    const unchangedDisplay = group.source.id === target.id
      && sourceBounds.x === targetBounds.x
      && sourceBounds.y === targetBounds.y
      && sourceBounds.width === targetBounds.width
      && sourceBounds.height === targetBounds.height
    const relativeCenterX = clamp(
      (group.bounds.x + group.bounds.width / 2 - sourceBounds.x) / sourceBounds.width,
      0,
      1,
    )
    const relativeCenterY = clamp(
      (group.bounds.y + group.bounds.height / 2 - sourceBounds.y) / sourceBounds.height,
      0,
      1,
    )
    const minX = inner.x
    const minY = inner.y
    const maxX = inner.x + inner.width - group.bounds.width
    const maxY = inner.y + inner.height - group.bounds.height
    const desiredX = clamp(unchangedDisplay
      ? group.bounds.x
      : inner.x + relativeCenterX * inner.width - group.bounds.width / 2, minX, maxX)
    const desiredY = clamp(unchangedDisplay
      ? group.bounds.y
      : inner.y + relativeCenterY * inner.height - group.bounds.height / 2, minY, maxY)
    const xCandidates = new Set([Math.round(desiredX), Math.round(minX), Math.round(maxX)])
    const yCandidates = new Set([Math.round(desiredY), Math.round(minY), Math.round(maxY)])
    for (const placed of placedFrames) {
      for (const entry of group.entries) {
        const frame = widgetFrame(entry.widget)
        const offsetX = frame.x - group.bounds.x
        const offsetY = frame.y - group.bounds.y
        xCandidates.add(Math.round(placed.x + placed.width - offsetX))
        xCandidates.add(Math.round(placed.x - frame.width - offsetX))
        yCandidates.add(Math.round(placed.y + placed.height - offsetY))
        yCandidates.add(Math.round(placed.y - frame.height - offsetY))
      }
    }

    let best = null
    for (const rawX of xCandidates) {
      const x = clamp(rawX, minX, maxX)
      for (const rawY of yCandidates) {
        const y = clamp(rawY, minY, maxY)
        const frames = translatedGroupFrames(group, x, y)
        const overlap = frames.reduce((total, candidate) => (
          total + placedFrames.reduce((sum, placed) => sum + frameOverlapArea(candidate.frame, placed), 0)
        ), 0)
        const distance = (x - desiredX) ** 2 + (y - desiredY) ** 2
        if (!best || overlap < best.overlap || (overlap === best.overlap && distance < best.distance)) {
          best = { x, y, frames, overlap, distance }
        }
      }
    }

    for (const candidate of best.frames) {
      const mapped = {
        ...candidate.entry.widget,
        x: Math.round(candidate.frame.x),
        y: Math.round(candidate.frame.y),
      }
      placements.set(candidate.entry.index, mapped)
      if (!candidate.entry.widget.hidden) placedFrames.push(candidate.frame)
    }
  }
  return placements
}

const fitFrameToDisplay = (widget, display) => {
  const edgeGap = 8
  const topGap = 0
  const bounds = display.bounds
  const minimum = minimumWidgetSize(widget.kind)
  const requestedWidth = clamp(finite(widget.width, minimum.width), minimum.width, 900)
  const requestedHeight = clamp(finite(widget.height, minimum.height), minimum.height, 760)
  const width = Math.min(requestedWidth, Math.max(1, bounds.width - edgeGap * 2))
  const height = Math.min(requestedHeight, Math.max(1, bounds.height - topGap - edgeGap))
  const minX = bounds.x + edgeGap
  const minY = bounds.y + topGap
  const maxX = Math.max(minX, bounds.x + bounds.width - width - edgeGap)
  const maxY = Math.max(minY, bounds.y + bounds.height - height - edgeGap)
  return {
    ...widget,
    x: Math.round(clamp(finite(widget.x, minX), minX, maxX)),
    y: Math.round(clamp(finite(widget.y, minY), minY, maxY)),
    width: Math.round(width),
    height: Math.round(height),
  }
}

const remapWorkspaceLayout = (workspace, sourceDisplays, targetDisplays) => {
  const cloned = JSON.parse(JSON.stringify(workspace || {}))
  const { sources, targets, targetPrimary, mapping } = buildDisplayMapping(sourceDisplays, targetDisplays)
  let remappedWidgets = 0
  if (!targets.length) return { workspace: cloned, remappedWidgets, displayMapping: {} }

  const entries = (Array.isArray(cloned.widgets) ? cloned.widgets : []).map((widget, index) => {
    const center = {
      x: finite(widget.x) + finite(widget.width, 1) / 2,
      y: finite(widget.y) + finite(widget.height, 1) / 2,
    }
    const source = nearestDisplay(center, sources)
    const target = (source && mapping.get(source.id)) || targetPrimary || targets[0]
    return { index, widget, source, target }
  })

  const groupsBySource = new Map()
  for (const entry of entries) {
    if (!entry.source || !entry.target) continue
    const key = entry.source.id
    if (!groupsBySource.has(key)) groupsBySource.set(key, [])
    groupsBySource.get(key).push(entry)
  }
  const groupsByTarget = new Map()
  for (const sourceEntries of groupsBySource.values()) {
    for (const groupEntries of clusterWidgets(sourceEntries)) {
      const source = groupEntries[0].source
      const target = groupEntries[0].target
      const group = {
        entries: groupEntries,
        source,
        target,
        bounds: unionFrames(groupEntries.map((entry) => widgetFrame(entry.widget))),
      }
      if (!groupsByTarget.has(target.id)) groupsByTarget.set(target.id, [])
      groupsByTarget.get(target.id).push(group)
    }
  }

  const mappedByIndex = new Map()
  for (const [targetId, groups] of groupsByTarget) {
    const target = targets.find((candidate) => candidate.id === targetId)
    if (!target) continue
    for (const [index, mapped] of placeRigidGroups(groups, target)) mappedByIndex.set(index, mapped)
  }

  cloned.widgets = entries.map((entry) => {
    if (!entry.source || !entry.target) return fitFrameToDisplay(entry.widget, targets[0])
    const mapped = mappedByIndex.get(entry.index) || fitFrameToDisplay(entry.widget, entry.target)
    if (
      entry.source.id !== entry.target.id
      || entry.source.bounds.x !== entry.target.bounds.x
      || entry.source.bounds.y !== entry.target.bounds.y
      || entry.source.bounds.width !== entry.target.bounds.width
      || entry.source.bounds.height !== entry.target.bounds.height
    ) remappedWidgets += 1
    return mapped
  })

  return {
    workspace: cloned,
    remappedWidgets,
    displayMapping: Object.fromEntries([...mapping.entries()].map(([sourceId, target]) => [sourceId, target.id])),
  }
}

const validateSnapshotDocument = (value) => {
  if (!value || typeof value !== 'object') throw new Error('快照文件格式无效')
  if (value.schemaVersion !== snapshotSchemaVersion) throw new Error('不支持的快照版本')
  if (value.fileDataIncluded !== false) throw new Error('该文件不是纯配置快照')
  if (!value.workspace || !Array.isArray(value.workspace.widgets) || !value.workspace.settings) {
    throw new Error('快照缺少工作区配置')
  }
  if (!value.desktop || !Array.isArray(value.desktop.displays)) throw new Error('快照缺少显示器布局')
  return value
}

module.exports = {
  snapshotSchemaVersion,
  buildDisplayMapping,
  captureWorkspaceLayoutProfile,
  remapWorkspaceLayout,
  restoreWorkspaceLayoutProfile,
  validateSnapshotDocument,
  workspaceLayoutSignature,
}
