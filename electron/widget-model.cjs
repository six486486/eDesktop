const crypto = require('node:crypto')

const widgetDefaults = {
  organizer: { title: '新收纳盒', tone: 'paper', width: 360, height: 260, data: { files: [] } },
  note: {
    title: '新便签',
    tone: 'yellow',
    width: 280,
    height: 220,
    data: { content: '', updatedAt: new Date().toISOString() },
  },
  todo: {
    title: '待办列表',
    tone: 'paper',
    width: 320,
    height: 300,
    data: { items: [], activeList: 'my-day' },
  },
  pomodoro: {
    title: '番茄钟',
    tone: 'emerald',
    width: 280,
    height: 300,
    data: {
      mode: 'focus',
      focusMinutes: 25,
      breakMinutes: 5,
      remainingSeconds: 25 * 60,
      running: false,
      endsAt: null,
      sessions: 0,
    },
  },
}

const createWidget = (kind, { index, primaryOffset }) => {
  const defaults = widgetDefaults[kind] || widgetDefaults.note
  return {
    id: crypto.randomUUID(),
    kind: widgetDefaults[kind] ? kind : 'note',
    title: defaults.title,
    tone: defaults.tone,
    x: primaryOffset.x + 48 + (index % 5) * 34,
    y: primaryOffset.y + 96 + (index % 4) * 32,
    width: defaults.width,
    height: defaults.height,
    hidden: false,
    data: JSON.parse(JSON.stringify(defaults.data)),
  }
}

const safeWidgetPatch = (patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {}
  const safe = {}
  for (const key of ['title', 'tone', 'x', 'y', 'width', 'height', 'hidden', 'data']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) safe[key] = patch[key]
  }
  if (typeof safe.title === 'string') safe.title = safe.title.slice(0, 80)
  if (Number.isFinite(safe.x)) safe.x = Math.round(safe.x)
  if (Number.isFinite(safe.y)) safe.y = Math.round(safe.y)
  if (Number.isFinite(safe.width)) safe.width = Math.max(1, Math.min(900, Math.round(safe.width)))
  if (Number.isFinite(safe.height)) safe.height = Math.max(1, Math.min(760, Math.round(safe.height)))
  return safe
}

module.exports = {
  createWidget,
  safeWidgetPatch,
}
