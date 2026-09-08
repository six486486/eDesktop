const fs = require('node:fs')
const path = require('node:path')

const rootPath = __dirname
const iconPath = path.join(rootPath, 'assets', 'app-icon')
const installerIconPath = `${iconPath}.ico`
const trayIconPaths = [16, 20, 24, 32].map((size) => path.join(rootPath, 'assets', `app-icon-${size}.png`))
const packagedLocales = new Set(['en-US.pak', 'zh-CN.pak'])

const pruneElectronLocales = (buildPath, _electronVersion, platform, _arch, done) => {
  try {
    if (platform === 'win32') {
      const localesPath = path.join(buildPath, 'locales')
      if (fs.existsSync(localesPath)) {
        for (const localeFile of fs.readdirSync(localesPath)) {
          if (!packagedLocales.has(localeFile)) {
            fs.rmSync(path.join(localesPath, localeFile), { force: true })
          }
        }
      }
    }
    done()
  } catch (error) {
    done(error)
  }
}

module.exports = {
  packagerConfig: {
    name: 'eDesktop',
    executableName: 'eDesktop',
    icon: iconPath,
    extraResource: [installerIconPath, ...trayIconPaths],
    electronZipDir: path.join(rootPath, '.electron-dist-cache'),
    afterExtract: [pruneElectronLocales],
    asar: {
      unpackDir: '{electron,node_modules/sherpa-onnx-win-x64}',
    },
    ignore: [
      /^\/(?:data|\.data-migration-[^/]*)(?:\/|$)/,
      /^\/desktop-pet\/(?:tests(?:\/|$)|dev\.cjs$|.*\.(?:md|tsx?|css|html)$)/,
      /^\/(?:\.agents|\.artifacts|\.electron-dist-cache|\.git|\.superdesign|assets|docs|out|scripts|src|UI风格参考)(?:\/|$)/,
      /^\/\.env(?:\.|$)/,
      /\.(?:log|jsonl)$/,
      /^\/(?:\.gitignore|README\.md|forge\.config\.cjs|index\.html|package-lock\.json|tsconfig(?:\.[^.]+)?\.(?:json|tsbuildinfo)|vite\.config\.(?:js|ts|d\.ts))$/,
      /^\/node_modules\/(?!sherpa-onnx-node(?:\/|$)|sherpa-onnx-win-x64(?:\/|$))/,
    ],
    win32metadata: {
      CompanyName: 'eDesktop',
      FileDescription: 'Windows 桌面文件收纳与效率组件',
      InternalName: 'eDesktop',
      OriginalFilename: 'eDesktop.exe',
      ProductName: 'eDesktop',
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'edesktop',
        authors: 'eDesktop',
        title: 'eDesktop',
        description: 'eDesktop',
        exe: 'eDesktop.exe',
        setupExe: 'eDesktop Setup.exe',
        setupIcon: installerIconPath,
        iconUrl: installerIconPath,
        noMsi: true,
      },
    },
  ],
}
