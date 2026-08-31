const fs = require('node:fs')
const path = require('node:path')

const resolveWindowsLoginLauncherPath = ({
  platform = process.platform,
  isPackaged = false,
  execPath = process.execPath,
  pathExists = fs.existsSync,
} = {}) => {
  if (platform !== 'win32' || !isPackaged) return execPath

  const squirrelStubPath = path.resolve(
    path.dirname(execPath),
    '..',
    path.basename(execPath),
  )

  // Squirrel installations create a stable launcher one directory above the
  // versioned application folder. Portable builds do not, so they must launch
  // the executable that is actually present in the extracted application.
  return pathExists(squirrelStubPath) ? squirrelStubPath : execPath
}

module.exports = { resolveWindowsLoginLauncherPath }
