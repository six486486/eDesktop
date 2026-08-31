const assert = require('node:assert/strict')
const {
  createDesktopIconLayoutPlan,
  findDesktopIconPositionByNames,
  inspectDesktopIconLayout,
  restoreDesktopIconLayout,
} = require('../electron/desktop-icon-layout-core.cjs')

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const main = async () => {
  const entries = [
    { names: ['report.txt', 'report'], position: { x: 120, y: 240 }, required: true },
    { names: ['回收站', 'Recycle Bin'], position: { x: 24, y: 548 }, required: true },
  ]
  const plan = createDesktopIconLayoutPlan(entries)
  assert.equal(plan.groups.length, 2)
  assert.equal(plan.positions.length, 4)

  const shellOverridePlan = createDesktopIconLayoutPlan([
    { names: ['回收站'], position: { x: 500, y: 500 }, required: true },
    { names: ['回收站', 'Recycle Bin'], position: { x: 24, y: 548 }, required: true },
  ])
  assert.equal(shellOverridePlan.groups.length, 1)
  assert.equal(shellOverridePlan.positions.length, 2)
  assert.deepEqual(shellOverridePlan.groups[0].position, { x: 24, y: 548 })

  const currentPositions = new Map([
    ['回收站', { x: 24, y: 184 }],
    ['vdi', { x: 24, y: 548 }],
  ])
  assert.deepEqual(
    findDesktopIconPositionByNames(currentPositions, ['Recycle Bin', '回收站']),
    { x: 24, y: 184 },
  )
  assert.equal(findDesktopIconPositionByNames(currentPositions, ['此电脑', 'This PC']), null)

  const localizedStatus = inspectDesktopIconLayout(plan.groups, [
    { Name: 'report', X: 120, Y: 240 },
    { Name: 'Recycle Bin', X: 24, Y: 548 },
  ])
  assert.equal(localizedStatus.allRequiredMatched, true)

  let current = []
  let setCalls = 0
  let listCalls = 0
  const restored = await restoreDesktopIconLayout({
    entries,
    retryAtMs: [0, 5, 12, 24, 42],
    stableMs: 16,
    delay,
    setPositions: async () => {
      setCalls += 1
      current = [
        { Name: 'report.txt', X: 120, Y: 240 },
        { Name: '回收站', X: 24, Y: 548 },
      ]
    },
    listPositions: async () => {
      listCalls += 1
      // Simulate Explorer rebuilding its desktop list after the first successful write.
      if (listCalls === 2) return [
        { Name: 'report.txt', X: 500, Y: 500 },
        { Name: '回收站', X: 600, Y: 600 },
      ]
      return current
    },
  })
  assert.equal(restored.allRequiredMatched, true)
  assert.ok(setCalls >= 4, `expected repeated layout replay, got ${setCalls}`)

  const missing = inspectDesktopIconLayout(plan.groups, [{ Name: 'report.txt', X: 120, Y: 240 }])
  assert.equal(missing.allRequiredMatched, false)
  assert.equal(missing.missingRequired.length, 1)
  console.log('[desktop-icon-layout] delayed Explorer rebuild + localized system icon assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
