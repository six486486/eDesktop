const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const MARKER = '.portable-data.json'
const JOURNAL = '.legacy-migration.json'
const LOCK_FILES = new Set(['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'])
function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}
function hashFile(file) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(file, 'r')
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); return hash.digest('hex') }
  finally { fs.closeSync(fd) }
}
function assertSeparate(source, destination) {
  if (source === path.parse(source).root || destination === path.parse(destination).root || source === destination || inside(source, destination) || inside(destination, source)) throw Error('数据迁移目录重叠，请检查软件位置。')
}
function initialized(directory) {
  return [MARKER, 'desktop-workspace.json', 'desktop-pet/state.json'].some(file => fs.existsSync(path.join(directory, file)))
}
function listFiles(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    if (!relative && LOCK_FILES.has(entry.name)) return []
    const file = path.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw Error(`数据目录中存在链接，已保留原数据：${file}`)
    return entry.isDirectory() ? listFiles(directory, file) : [file]
  })
}
function prepareDataDirectory({ source, destination, copyFile = fs.copyFileSync }) {
  source = path.resolve(source); destination = path.resolve(destination); assertSeparate(source, destination)
  if (initialized(destination)) return { migrated: false }
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw Error(`目标数据目录已有文件，已保留两处数据：${destination}`)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (!fs.existsSync(source)) {
    fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, MARKER), JSON.stringify({ version: 1 }))
    return { migrated: false }
  }
  if (fs.lstatSync(source).isSymbolicLink()) throw Error('旧数据目录是链接，请先将数据移入软件旁的 data 文件夹。')
  const staging = path.join(path.dirname(destination), `.data-migration-${randomUUID()}`)
  fs.mkdirSync(staging)
  try {
    const manifest = []
    for (const relative of listFiles(source)) {
      const from = path.join(source, relative), to = path.join(staging, relative)
      fs.mkdirSync(path.dirname(to), { recursive: true }); copyFile(from, to)
      const hash = hashFile(from)
      if (hashFile(to) !== hash) throw Error(`数据校验未通过，原文件已保留：${relative}`)
      manifest.push({ relative, hash })
    }
    fs.writeFileSync(path.join(staging, MARKER), JSON.stringify({ version: 1, migratedAt: new Date().toISOString() }))
    fs.writeFileSync(path.join(staging, JOURNAL), JSON.stringify({ source, files: manifest }))
    if (fs.existsSync(destination)) fs.rmdirSync(destination) // Only an empty destination may be replaced.
    fs.renameSync(staging, destination)
    return { migrated: true, files: manifest.length }
  } finally {
    if (inside(path.dirname(destination), staging) && path.basename(staging).startsWith('.data-migration-')) fs.rmSync(staging, { recursive: true, force: true })
  }
}
// Delete only unchanged source files recorded by a successfully committed copy.
// Interrupted cleanup is retried next launch; changed or newly added files are retained.
function cleanupLegacyData({ source, destination }) {
  source = path.resolve(source); destination = path.resolve(destination); assertSeparate(source, destination)
  const journalPath = path.join(destination, JOURNAL)
  if (!fs.existsSync(journalPath)) return true
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  if (path.resolve(journal.source) !== source) throw Error('迁移记录与旧数据目录不一致，原数据已保留。')
  if (fs.existsSync(source) && fs.lstatSync(source).isSymbolicLink()) throw Error('旧数据目录已变成链接，原数据已保留。')
  for (const file of journal.files) {
    const from = path.resolve(source, file.relative), to = path.resolve(destination, file.relative)
    if (!inside(source, from) || !inside(destination, to)) throw Error('迁移记录包含无效路径，原数据已保留。')
    if (!fs.existsSync(from)) continue
    try {
      if (fs.lstatSync(from).isFile() && fs.existsSync(to) && inside(source, fs.realpathSync(from)) && inside(destination, fs.realpathSync(to)) && hashFile(from) === file.hash) fs.unlinkSync(from)
    } catch { /* A locked source is kept for the next launch. */ }
  }
  if (fs.existsSync(source)) {
    for (const name of LOCK_FILES) { try { fs.unlinkSync(path.join(source, name)) } catch {} }
    const pruneEmpty = directory => {
      if (directory !== source && !inside(source, directory)) throw Error('无效的旧数据路径。')
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) pruneEmpty(path.join(directory, entry.name))
      if (!fs.readdirSync(directory).length) { try { fs.rmdirSync(directory) } catch {} }
    }
    pruneEmpty(source)
  }
  if (!fs.existsSync(source)) { fs.unlinkSync(journalPath); return true }
  return false
}
function dataDirectoryFor({ isPackaged, exePath, projectRoot, override }) {
  return override ? path.resolve(override) : path.join(isPackaged ? path.dirname(exePath) : projectRoot, 'data')
}
function configureDataPaths(app, directory) {
  fs.mkdirSync(directory, { recursive: true })
  const probe = path.join(directory, `.write-check-${randomUUID()}`)
  try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe) }
  catch { throw Error(`软件目录无法写入，请把完整软件文件夹移到可写的位置后再运行：\n${directory}`) }
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
  for (const name of ['logs', 'crashDumps']) {
    const target = path.join(directory, name); fs.mkdirSync(target, { recursive: true }); app.setPath(name, target)
  }
  app.setAppLogsPath(path.join(directory, 'logs'))
}
function initializePortableData(app, { override, projectRoot, enforceSingleInstance = true } = {}) {
  const destination = dataDirectoryFor({ isPackaged: app.isPackaged, exePath: app.getPath('exe'), projectRoot, override })
  const source = path.join(app.getPath('appData'), 'eDesktop')
  const needsLegacy = !override && fs.existsSync(source) && (!initialized(destination) || fs.existsSync(path.join(destination, JOURNAL)))
  // Older releases use the legacy profile for their single-instance lock too.
  // Acquire it before reading/moving their data, so a running old release wins.
  if (needsLegacy) {
    app.setPath('userData', source)
    if (!app.requestSingleInstanceLock()) return false
    try { prepareDataDirectory({ source, destination }) }
    finally { app.releaseSingleInstanceLock() }
  } else if (!override) prepareDataDirectory({ source, destination })
  configureDataPaths(app, destination)
  const primary = !enforceSingleInstance || app.requestSingleInstanceLock()
  if (primary && needsLegacy) {
    try { cleanupLegacyData({ source, destination }) } catch (error) { console.warn(`[data] ${error.message}`) }
  }
  return primary
}
module.exports = { dataDirectoryFor, initializePortableData, prepareDataDirectory, cleanupLegacyData, configureDataPaths }
