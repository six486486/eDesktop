const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const MODEL = {
  revision: '73eca47697f980daa3d16112404174b6b950b514',
  base: 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/73eca47697f980daa3d16112404174b6b950b514/',
  files: [
    { name: 'model.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
    { name: 'tokens.txt', bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
    { name: 'LICENSE', bytes: 71, sha256: '221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17' },
  ],
}
class VoiceModel {
  constructor({ directory, fetchImpl = fetch }) { this.directory = path.resolve(directory); this.fetch = fetchImpl }
  ready() {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(this.directory, 'ready.json'), 'utf8'))
      return marker.revision === MODEL.revision && MODEL.files.every(file => fs.statSync(path.join(this.directory, file.name)).size === file.bytes)
    } catch { return false }
  }
  async prepare(signal, progress = () => {}) {
    if (this.ready()) return this.directory
    fs.mkdirSync(this.directory, { recursive: true })
    const total = MODEL.files.reduce((sum, file) => sum + file.bytes, 0); let downloaded = 0, last = 0
    for (const file of MODEL.files) {
      const temporary = path.join(this.directory, `download-${randomUUID()}.part`)
      let handle
      try {
        const response = await this.fetch(MODEL.base + file.name, { signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]) })
        if (!response.ok || !response.body) throw Error('语音模型暂时下载不了，请检查网络后再试。')
        handle = await fs.promises.open(temporary, 'wx')
        const hash = createHash('sha256'); let bytes = 0
        for await (const chunk of response.body) {
          signal.throwIfAborted(); bytes += chunk.length
          if (bytes > file.bytes) throw Error('语音模型校验没有通过，请重新下载。')
          hash.update(chunk)
          let offset = 0
          while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten
          if (Date.now() - last > 150) { progress(Math.floor((downloaded + bytes) / total * 100)); last = Date.now() }
        }
        await handle.close(); handle = null
        if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw Error('语音模型校验没有通过，请重新下载。')
        signal.throwIfAborted()
        await fs.promises.rename(temporary, path.join(this.directory, file.name)); downloaded += bytes
      } finally { await handle?.close(); await fs.promises.rm(temporary, { force: true }) }
    }
    fs.writeFileSync(path.join(this.directory, 'ready.json'), JSON.stringify({ revision: MODEL.revision }))
    progress(100); return this.directory
  }
}
module.exports = { VoiceModel, MODEL }
