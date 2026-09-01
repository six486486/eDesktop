const desktopShellVisibilityLocations = ['newStartPanel', 'classicStartMenu']

const normalizeVisibilityEntry = (entry, fallback = null) => {
  const source = entry && typeof entry === 'object' ? entry : fallback
  return {
    exists: Boolean(source?.exists),
    value: Number.isFinite(source?.value) ? Math.trunc(source.value) : 0,
  }
}

const normalizeDesktopShellVisibility = (visibility, legacy = null) => {
  const locations = visibility?.locations && typeof visibility.locations === 'object'
    ? visibility.locations
    : visibility && (visibility.newStartPanel || visibility.classicStartMenu)
      ? visibility
      : null
  const legacyEntry = legacy || (
    visibility && ('exists' in visibility || 'value' in visibility)
      ? visibility
      : null
  )
  return {
    newStartPanel: normalizeVisibilityEntry(locations?.newStartPanel, legacyEntry),
    classicStartMenu: normalizeVisibilityEntry(locations?.classicStartMenu),
  }
}

const hiddenDesktopShellVisibility = () => ({
  newStartPanel: { exists: true, value: 1 },
  classicStartMenu: { exists: true, value: 1 },
})

const storedDesktopShellVisibility = (file) => normalizeDesktopShellVisibility(
  file?.shellVisibilityStates,
  {
    exists: Boolean(file?.shellVisibilityValueExists),
    value: Number.isFinite(file?.shellVisibilityValue) ? Math.trunc(file.shellVisibilityValue) : 0,
  },
)

const desktopShellVisibilityEquals = (left, right) => {
  const normalizedLeft = normalizeDesktopShellVisibility(left)
  const normalizedRight = normalizeDesktopShellVisibility(right)
  return desktopShellVisibilityLocations.every((location) => (
    normalizedLeft[location].exists === normalizedRight[location].exists
    && (
      !normalizedRight[location].exists
      || normalizedLeft[location].value === normalizedRight[location].value
    )
  ))
}

module.exports = {
  desktopShellVisibilityLocations,
  desktopShellVisibilityEquals,
  hiddenDesktopShellVisibility,
  normalizeDesktopShellVisibility,
  storedDesktopShellVisibility,
}
