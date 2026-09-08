const fs = require('node:fs')
const path = require('node:path')
const { createWidget } = require('../electron/widget-model.cjs')
const { createFocusHost } = require('./focus-host.cjs')

// Same service and widget model as production, with a separate preview workspace.
function createFocusPreview(directory) {
  const file = path.join(directory, 'focus-workspace.json')
  let workspace = { widgets: [], settings: { desktopEnabled: true } }, tail = Promise.resolve()
  try { workspace = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const host = createFocusHost({
    read: () => workspace,
    enqueue: operation => { const work = tail.then(operation, operation); tail = work.catch(() => {}); return work },
    createWidget: (next, kind = 'pomodoro') => createWidget(kind, { index: next.widgets.length, primaryOffset: { x: 0, y: 0 } }),
    persist: async next => {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2))
      fs.renameSync(`${file}.tmp`, file)
    },
    publish: next => { workspace = next; host.changed() },
  })
  host.preview = true
  return host
}
module.exports = { createFocusPreview }
