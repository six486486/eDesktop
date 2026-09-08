import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceState } from './types'

type Recording = { id: string; recorder?: MediaRecorder; stream?: MediaStream; timer?: ReturnType<typeof setTimeout>; meter?: ReturnType<typeof setInterval>; audio?: AudioContext; cancelled: boolean }
export function useVoiceInput(state: VoiceState | undefined, onText: (text: string) => Promise<void>, onError: (text: string) => void, surface: 'chat' | 'pet' = 'chat') {
  const [localPhase, setLocalPhase] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle')
  const [seconds, setSeconds] = useState(0)
  const recording = useRef<Recording | null>(null)
  const handler = useRef({ onText, onError }); handler.current = { onText, onError }
  const latestState = useRef(state); latestState.current = state
  const release = useCallback((job: Recording) => {
    clearTimeout(job.timer); clearInterval(job.meter); job.stream?.getTracks().forEach(track => track.stop())
    if (job.audio && job.audio.state !== 'closed') void job.audio.close().catch(() => {})
  }, [])
  const cancelLocal = useCallback(() => {
    const job = recording.current; recording.current = null
    if (job) { job.cancelled = true; release(job); if (job.recorder?.state === 'recording') job.recorder.stop() }
    setLocalPhase('idle')
  }, [release])
  const cancel = useCallback(() => { cancelLocal(); void window.petAPI?.cancelVoice() }, [cancelLocal])
  useEffect(() => { cancelLocal() }, [state?.cancelRevision, cancelLocal])
  useEffect(() => () => { const job = recording.current; if (job) { job.cancelled = true; release(job); if (job.recorder?.state === 'recording') job.recorder.stop(); void window.petAPI?.cancelVoice() } }, [release])
  useEffect(() => {
    if (localPhase !== 'recording') return
    const started = Date.now(); setSeconds(0)
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250)
    return () => clearInterval(timer)
  }, [localPhase])
  const toggle = useCallback(async () => {
    const api = window.petAPI
    if (!api) return
    const current = recording.current
    if (current?.recorder?.state === 'recording') { current.recorder.stop(); release(current); return }
    if (current || latestState.current?.phase !== 'idle') return
    const job: Recording = { id: '', cancelled: false }; recording.current = job
    setLocalPhase('requesting'); handler.current.onError('')
    try {
      const id = await api.beginVoice()
      if (job.cancelled || recording.current !== job) return
      if (!id) { recording.current = null; setLocalPhase('idle'); return }
      job.id = id
      job.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
      if (job.cancelled || recording.current !== job) { release(job); return }
      // Observe microphone energy only; never route the microphone to speakers.
      job.audio = new AudioContext()
      await job.audio.resume()
      if (job.cancelled || recording.current !== job) { release(job); return }
      const source = job.audio.createMediaStreamSource(job.stream), analyser = job.audio.createAnalyser()
      analyser.fftSize = 512; source.connect(analyser)
      const waveform = new Float32Array(analyser.fftSize)
      job.meter = setInterval(() => {
        analyser.getFloatTimeDomainData(waveform)
        const rms = Math.sqrt(waveform.reduce((sum, value) => sum + value * value, 0) / waveform.length)
        api.voiceLevel(job.id, Math.min(1, rms * 9))
      }, 100)
      const chunks: BlobPart[] = []
      const recorder = new MediaRecorder(job.stream); job.recorder = recorder
      recorder.ondataavailable = event => { if (!job.cancelled && event.data.size) chunks.push(event.data) }
      recorder.onerror = () => { cancel(); handler.current.onError('录音中断啦，检查一下麦克风再试。') }
      recorder.onstop = async () => {
        release(job)
        if (job.cancelled || recording.current !== job) return
        setLocalPhase('transcribing')
        let audio: AudioContext | undefined
        try {
          audio = new AudioContext()
          const decoded = await audio.decodeAudioData(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer())
          const frames = Math.min(16000 * 60, Math.ceil(decoded.duration * 16000))
          if (frames < 1600) throw Error('这次太短啦，再按一次快捷键或麦克风，慢慢说～')
          const offline = new OfflineAudioContext(1, frames, 16000), source = offline.createBufferSource()
          source.buffer = decoded; source.connect(offline.destination); source.start()
          const buffer = await offline.startRendering()
          if (job.cancelled || recording.current !== job) return
          const result = await api.transcribeVoice(job.id, buffer.getChannelData(0))
          if (!result || job.cancelled || recording.current !== job) return
          recording.current = null; setLocalPhase('idle')
          await handler.current.onText(result.text)
        } catch (error) {
          if (!job.cancelled && recording.current === job) { cancel(); handler.current.onError(error instanceof Error ? error.message : '小栖这次没听清，再说一次吧～') }
        } finally {
          chunks.length = 0; await audio?.close()
          if (recording.current === job) { recording.current = null; setLocalPhase('idle') }
        }
      }
      if (!await api.voiceRecording(job.id) || job.cancelled || recording.current !== job) {
        release(job)
        if (recording.current === job) { recording.current = null; setLocalPhase('idle') }
        return
      }
      recorder.start(250); setLocalPhase('recording')
      job.timer = setTimeout(() => { if (recorder.state === 'recording') { recorder.stop(); release(job) } }, 60000)
    } catch (error) {
      if (job.cancelled || recording.current !== job) return
      cancel()
      const name = error instanceof DOMException ? error.name : ''
      handler.current.onError(name === 'NotAllowedError' ? '麦克风还没获准使用，在 Windows 设置里允许桌面应用访问麦克风后再试吧。'
        : ['NotFoundError', 'NotReadableError'].includes(name) ? '小栖没连上麦克风，检查连接或占用后再试吧。'
        : error instanceof Error ? error.message : '录音没有开始，请再试一次。')
    }
  }, [cancel, release])
  const toggleRef = useRef(toggle); toggleRef.current = toggle
  const handledTrigger = useRef(0)
  useEffect(() => {
    if (!state?.trigger || state.trigger === handledTrigger.current) return
    handledTrigger.current = state.trigger
    if (state.surface === surface) void toggleRef.current()
  }, [state?.trigger, state?.surface, surface])
  return { toggle, cancel, seconds, active: localPhase !== 'idle' || Boolean(state && state.phase !== 'idle'),
    phase: localPhase === 'transcribing' ? 'transcribing' : state && state.phase !== 'idle' ? state.phase : localPhase }
}
