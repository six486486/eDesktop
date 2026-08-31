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

  cloned.widgets = (Array.isArray(cloned.widgets) ? cloned.widgets : []).map((widget) => {
    const center = {
      x: finite(widget.x) + finite(widget.width, 1) / 2,
      y: finite(widget.y) + finite(widget.height, 1) / 2,
    }
    const source = nearestDisplay(center, sources)
    const target = (source && mapping.get(source.id)) || targetPrimary || targets[0]
    if (!source || !target) return fitFrameToDisplay(widget, targets[0])

    const sourceWidth = Math.max(1, source.bounds.width - finite(widget.width) - 16)
    const sourceHeight = Math.max(1, source.bounds.height - finite(widget.height) - 8)
    const relativeX = clamp((finite(widget.x) - source.bounds.x - 8) / sourceWidth, 0, 1)
    const relativeY = clamp((finite(widget.y) - source.bounds.y) / sourceHeight, 0, 1)
    const targetWidth = Math.max(0, target.bounds.width - finite(widget.width) - 16)
    const targetHeight = Math.max(0, target.bounds.height - finite(widget.height) - 8)
    const mapped = fitFrameToDisplay({
      ...widget,
      x: target.bounds.x + 8 + relativeX * targetWidth,
      y: target.bounds.y + relativeY * targetHeight,
    }, target)
    if (
      source.id !== target.id
      || source.bounds.x !== target.bounds.x
      || source.bounds.y !== target.bounds.y
      || source.bounds.width !== target.bounds.width
      || source.bounds.height !== target.bounds.height
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
  remapWorkspaceLayout,
  validateSnapshotDocument,
}
