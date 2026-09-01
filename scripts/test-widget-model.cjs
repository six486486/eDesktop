const assert = require('node:assert/strict')
const { createWidget, safeWidgetPatch } = require('../electron/widget-model.cjs')

const primaryOffset = { x: -1920, y: 40 }
const firstTodo = createWidget('todo', { index: 0, primaryOffset })
const wrappedTodo = createWidget('todo', { index: 5, primaryOffset })

assert.equal(firstTodo.kind, 'todo')
assert.equal(firstTodo.x, -1872)
assert.equal(firstTodo.y, 136)
assert.equal(wrappedTodo.x, -1872)
assert.equal(wrappedTodo.y, 168)

const firstOrganizer = createWidget('organizer', { index: 1, primaryOffset })
const secondOrganizer = createWidget('organizer', { index: 1, primaryOffset })
firstOrganizer.data.files.push({ id: 'isolated' })
assert.deepEqual(secondOrganizer.data.files, [])

const fallback = createWidget('unknown', { index: 2, primaryOffset })
assert.equal(fallback.kind, 'note')
assert.equal(fallback.title, '新便签')

assert.deepEqual(safeWidgetPatch(null), {})
assert.deepEqual(safeWidgetPatch([]), {})
assert.deepEqual(safeWidgetPatch({ unexpected: true }), {})
assert.deepEqual(safeWidgetPatch({
  title: 'x'.repeat(100),
  x: 1.6,
  y: -1.6,
  width: 1_000,
  height: 0,
  hidden: true,
  unexpected: true,
}), {
  title: 'x'.repeat(80),
  x: 2,
  y: -2,
  width: 900,
  height: 1,
  hidden: true,
})

console.log('[widget-model] defaults, placement, data isolation, fallback, and safe patch assertions passed')
