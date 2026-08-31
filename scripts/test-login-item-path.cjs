const assert = require('node:assert/strict')
const path = require('node:path')
const { resolveWindowsLoginLauncherPath } = require('../electron/login-item-path.cjs')

const installedExecutable = path.resolve('C:\\Users\\tester\\AppData\\Local\\eDesktop\\app-0.1.0\\eDesktop.exe')
const installedStub = path.resolve('C:\\Users\\tester\\AppData\\Local\\eDesktop\\eDesktop.exe')
const portableExecutable = path.resolve('D:\\Apps\\eDesktop-win32-x64\\eDesktop.exe')

assert.equal(
  resolveWindowsLoginLauncherPath({
    platform: 'win32',
    isPackaged: true,
    execPath: installedExecutable,
    pathExists: (candidate) => candidate === installedStub,
  }),
  installedStub,
  'Squirrel installs should use the stable stub launcher',
)

assert.equal(
  resolveWindowsLoginLauncherPath({
    platform: 'win32',
    isPackaged: true,
    execPath: portableExecutable,
    pathExists: () => false,
  }),
  portableExecutable,
  'portable builds should use their existing executable',
)

assert.equal(
  resolveWindowsLoginLauncherPath({
    platform: 'linux',
    isPackaged: true,
    execPath: '/opt/edesktop/edesktop',
    pathExists: () => true,
  }),
  '/opt/edesktop/edesktop',
  'non-Windows builds should keep the current executable',
)

assert.equal(
  resolveWindowsLoginLauncherPath({
    platform: 'win32',
    isPackaged: false,
    execPath: 'C:\\Electron\\electron.exe',
    pathExists: () => true,
  }),
  'C:\\Electron\\electron.exe',
  'development builds should keep the current executable',
)

console.log('[login-item] path selection assertions passed: 4/4')
