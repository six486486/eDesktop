import type { DesktopInfo } from '../types'

type DesktopDisplay = DesktopInfo['displays'][number]
type Point = { x: number; y: number }
type Size = { width: number; height: number }

export const widgetEdgeGap = 8
const widgetTopEdgeGap = 0

export const clamp = (value: number, min: number, max: number) => (
  Math.min(Math.max(value, min), max)
)

const distanceToDisplay = (point: Point, display: DesktopDisplay) => {
  const { bounds } = display
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width))
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height))
  return dx * dx + dy * dy
}

export const displayNearestPoint = (point: Point, displays: DesktopDisplay[]) => (
  displays.reduce<DesktopDisplay | null>((nearest, display) => {
    if (!nearest) return display
    return distanceToDisplay(point, display) < distanceToDisplay(point, nearest) ? display : nearest
  }, null)
)

export const constrainPositionToDisplay = (
  position: Point,
  size: Size,
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
