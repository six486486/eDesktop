const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { VoiceModel } = require('./voice-model.cjs')
const MAX_SAMPLES = 16000 * 60
const SHORTCUT = 'Control+Alt+V'
class VoiceService {
  constructor({ directory, fork, model = new VoiceModel({ directory }), onChange = () => {} }) {
    Object.assign(this, { directory, fork, model, onChange })
    this.state = { phase: 'idle', surface: null, level: 0, startedAt: 0, ready: model.ready(), progress: 0, error: '', trigger: 0, cancelRevision: 0, shortcut: 'Ctrl+Alt+V', shortcutAvailable: false }
    this.job = null; this.disposed = false; this.running = Promise.resolve()
  }
  snapshot() { return { ...this.state } }
  update(patch) { Object.assign(this.state, patch); if (!this.disposed) this.onChange() }
  requestToggle(surface = 'chat') { this.update({ surface: this.job ? this.state.surface : surface, trigger: this.state.trigger + 1 }) }
  async begin(surface = 'chat') {
    if (this.disposed || this.job) return null
    const job = { id: randomUUID(), controller: new AbortController() }; this.job = job
    this.state.surface = surface; this.state.level = 0
    if (!this.state.ready) {
      this.update({ phase: 'downloading', progress: 0, error: '' })
      this.running = this.model.prepare(job.controller.signal, progress => { if (this.job === job) this.update({ progress }) })
      try {
        await this.running
        if (this.job === job) { this.job = null; this.update({ phase: 'idle', ready: true, error: '准备好啦，再按麦克风或快捷键就能说话～' }) }
      } catch (error) { if (this.job === job) { this.job = null; this.update({ phase: 'idle', error: /[\u4e00-\u9fff]/.test(error.message || '') ? error.message : '语音模型还没下载好，检查网络后再试吧。' }) } }
      return null
    }
    this.update({ phase: 'requesting', error: '' })
    job.timer = setTimeout(() => this.cancel('麦克风没有准备好，请检查权限后再试。'), 15000)
    job.timer.unref?.(); return job.id
  }
  recording(id) {
    if (!this.job || this.job.id !== id || this.state.phase !== 'requesting') return false
    clearTimeout(this.job.timer)
    this.job.timer = setTimeout(() => this.cancel('这次录音已结束，请再按麦克风重试。'), 65000)
    this.job.timer.unref?.(); this.update({ phase: 'recording', startedAt: Date.now() }); return true
  }
  audioLevel(id, level) {
    if (this.job?.id !== id || this.state.phase !== 'recording' || !Number.isFinite(level)) return
    const now = Date.now()
    if (now - (this.lastLevelAt || 0) < 80) return
    this.lastLevelAt = now; this.update({ level: Math.max(0, Math.min(1, level)) })
  }
  async transcribe(id, input) {
    const job = this.job
    if (!job || id !== job.id || this.state.phase !== 'recording') return null
    clearTimeout(job.timer)
    try {
      const samples = input instanceof Float32Array ? input : null
      if (!samples || samples.length < 1600 || samples.length > MAX_SAMPLES) throw Error('这段录音太短或太长啦，请在一分钟内说完。')
      let energy = 0
      for (const value of samples) { if (!Number.isFinite(value) || Math.abs(value) > 1.01) throw Error('录音数据不完整，请再试一次。'); energy += value * value }
      if (Math.sqrt(energy / samples.length) < 0.001) throw Error('小栖没有听到声音，检查一下麦克风再说吧～')
      this.update({ phase: 'transcribing', level: 0, error: '' })
      const child = this.fork(path.join(__dirname, 'voice-worker.cjs'), [], { stdio: 'ignore', serviceName: '小栖离线语音识别' }); job.child = child
      const result = await new Promise((resolve, reject) => {
        job.reject = reject
        job.timer = setTimeout(() => reject(Error('这次识别有点久，重新说一次吧～')), 60000)
        job.timer.unref?.()
        child.once('message', resolve)
        child.once('exit', () => reject(Error('语音识别意外停下了，请再试一次。')))
        child.postMessage({ directory: this.directory, samples })
      })
      if (this.job !== job || this.disposed) return null
      if (result.error) throw Error(result.error)
      const text = typeof result.text === 'string' ? result.text.replace(/<\|[^|]*\|>/g, '').trim() : ''
      if (!text) throw Error('小栖这次没听清，重新说一次吧～')
      if (text.length > 2000) throw Error('这段话太长啦，分成两次告诉小栖吧～')
      this.job = null; this.update({ phase: 'idle', error: '' }); return { id, text }
    } catch (error) {
      if (this.job === job && !this.disposed) { this.job = null; this.update({ phase: 'idle', error: error.message }) }
      return null
    } finally { clearTimeout(job.timer); job.child?.kill() }
  }
  cancel(error = '') {
    const job = this.job; this.job = null
    clearTimeout(job?.timer); job?.controller.abort(); job?.reject?.(Error('cancelled')); job?.child?.kill()
    this.update({ phase: 'idle', level: 0, error, cancelRevision: this.state.cancelRevision + 1 })
  }
  async dispose() { this.disposed = true; this.cancel(); await this.running.catch(() => {}) }
}
module.exports = { VoiceService, SHORTCUT, MAX_SAMPLES }
