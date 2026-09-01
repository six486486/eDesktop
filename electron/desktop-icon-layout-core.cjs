const defaultRetryAtMs = [0, 80, 180, 320, 500, 750, 1_050, 1_400, 1_800, 2_300, 2_900, 3_600, 4_500]

const normalizeName = (value) => String(value || '').toLocaleLowerCase()

const findDesktopIconPositionByNames = (positionsByName, names) => {
  if (!positionsByName || typeof positionsByName.get !== 'function') return null
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== 'string' || !name) continue
    const position = positionsByName.get(normalizeName(name))
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) continue
    return { x: Math.round(position.x), y: Math.round(position.y) }
  }
  return null
}

const createDesktopIconLayoutPlan = (entries) => {
  const positionsByName = new Map()
  const groups = []

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry?.position || !Number.isFinite(entry.position.x) || !Number.isFinite(entry.position.y)) continue
    const position = {
      x: Math.round(entry.position.x),
      y: Math.round(entry.position.y),
    }
    const names = [...new Set(
      (Array.isArray(entry.names) ? entry.names : [])
        .filter((name) => typeof name === 'string' && name)
        .map(normalizeName),
    )]
    if (!names.length) continue

    // Later entries are explicit restorations and must override an earlier full-desktop
    // snapshot entry for the same icon (notably hidden shell items retained by Explorer).
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (!groups[index].names.some((name) => names.includes(name))) continue
      const [removed] = groups.splice(index, 1)
      for (const name of removed.names) positionsByName.delete(name)
    }
    groups.push({ names, position, required: entry.required === true })
    for (const name of names) {
      positionsByName.set(name, { name, x: position.x, y: position.y })
    }
  }

  return { groups, positions: [...positionsByName.values()] }
}

const inspectDesktopIconLayout = (groups, items) => {
  const currentByName = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.Name !== 'string' || !Number.isFinite(item.X) || !Number.isFinite(item.Y)) continue
    currentByName.set(normalizeName(item.Name), { x: Math.round(item.X), y: Math.round(item.Y) })
  }

  let matched = 0
  let required = 0
  const missingRequired = []
  for (const group of groups) {
    const isMatched = group.names.some((name) => {
      const current = currentByName.get(name)
      return current?.x === group.position.x && current?.y === group.position.y
    })
    if (isMatched) matched += 1
    if (!group.required) continue
    required += 1
    if (!isMatched) missingRequired.push(group.names)
  }

  return {
    matched,
    required,
    missingRequired,
    allRequiredMatched: missingRequired.length === 0,
  }
}

const restoreDesktopIconLayout = async ({
  entries,
  setPositions,
  listPositions,
  delay,
  retryAtMs = defaultRetryAtMs,
  stableMs = 900,
}) => {
  const plan = createDesktopIconLayoutPlan(entries)
  if (!plan.positions.length) {
    return { matched: 0, required: 0, missingRequired: [], allRequiredMatched: true }
  }

  const startedAt = Date.now()
  let stableSince = null
  let lastStatus = {
    matched: 0,
    required: plan.groups.filter((group) => group.required).length,
    missingRequired: plan.groups.filter((group) => group.required).map((group) => group.names),
    allRequiredMatched: false,
  }

  for (const retryAt of retryAtMs) {
    const waitMs = retryAt - (Date.now() - startedAt)
    if (waitMs > 0) await delay(waitMs)
    await setPositions(plan.positions)
    const currentItems = await listPositions()
    lastStatus = inspectDesktopIconLayout(plan.groups, currentItems)
    if (lastStatus.allRequiredMatched) {
      if (stableSince === null) stableSince = Date.now()
      if (Date.now() - stableSince >= stableMs) break
    } else {
      stableSince = null
    }
  }

  return lastStatus
}

module.exports = {
  createDesktopIconLayoutPlan,
  findDesktopIconPositionByNames,
  inspectDesktopIconLayout,
  restoreDesktopIconLayout,
}
