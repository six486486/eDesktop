const test = require('node:test'), assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { VoiceService, MAX_SAMPLES } = require('../voice-service.cjs')
function fixture(t, model = { ready: () => true }) {
  const children = [], service = new VoiceService({ directory: '/fixture', model, fork: () => {
    const child = new EventEmitter(); child.postMessage = data => { child.input = data }; child.kill = () => { child.killed = true }; children.push(child); return child
  } }); t.after(() => service.dispose()); return { service, children }
}
const samples = () => new Float32Array(16000).fill(0.1)
test('shortcut retains the current recording owner and microphone levels belong to its live job', async t => {
  const { service } = fixture(t)
  service.requestToggle('pet')
  assert.equal(service.state.surface, 'pet')
  const id = await service.begin('pet'); service.recording(id)
  service.requestToggle('chat')
  assert.equal(service.state.surface, 'pet')
  service.audioLevel('old-id', 1); assert.equal(service.state.level, 0)
  service.audioLevel(id, 0.75); assert.equal(service.state.level, 0.75)
  service.audioLevel(id, NaN); assert.equal(service.state.level, 0.75)
  service.cancel(); service.audioLevel(id, 1); assert.equal(service.state.level, 0)
  service.requestToggle('chat'); assert.equal(service.state.surface, 'chat')
})
test('voice accepts one utterance once and produces text only after recognition', async t => {
  const { service, children } = fixture(t), id = await service.begin()
  assert.equal(await service.begin(), null); assert.equal(service.recording(id), true)
  const pending = service.transcribe(id, samples())
  assert.equal(service.state.phase, 'transcribing'); assert.equal(await service.transcribe(id, samples()), null)
  children[0].emit('message', { text: '<|zh|>十分钟后提醒我取快递。' })
  assert.deepEqual(await pending, { id, text: '十分钟后提醒我取快递。' }); assert.equal(children[0].killed, true)
  assert.equal(await service.transcribe(id, samples()), null)
})
test('cancel kills old recognition and late data cannot affect a new session', async t => {
  const { service, children } = fixture(t), old = await service.begin(); service.recording(old)
  const pending = service.transcribe(old, samples()); service.cancel()
  const next = await service.begin(); assert.notEqual(next, old)
  children[0].emit('message', { text: '过时命令' }); assert.equal(await pending, null)
  assert.equal(service.state.phase, 'requesting'); assert.equal(service.job.id, next); assert.equal(children[0].killed, true)
  assert.equal(service.recording(old), false)
})
test('silence, oversized and malformed audio never start a recognizer', async t => {
  const { service, children } = fixture(t)
  for (const input of [new Float32Array(16000), new Float32Array(MAX_SAMPLES + 1), new Float32Array([NaN]), samples().fill(Infinity), [0.1]]) {
    const id = await service.begin(); service.recording(id); assert.equal(await service.transcribe(id, input), null)
    assert.equal(service.state.phase, 'idle'); assert.ok(service.state.error)
  }
  assert.equal(children.length, 0)
})
test('first download does not open the microphone and cancelled download cannot start recording', async t => {
  let done; const { service } = fixture(t, { ready: () => false, prepare: () => new Promise(r => { done = r }) })
  const first = service.begin(); assert.equal(service.state.phase, 'downloading')
  done(); assert.equal(await first, null); assert.equal(service.state.ready, true); assert.equal(service.state.phase, 'idle')
  assert.ok(await service.begin()); service.cancel()
  service.state.ready = false; const next = service.begin(); service.cancel(); done(); assert.equal(await next, null)
  assert.equal(service.state.phase, 'idle'); assert.equal(service.state.ready, false)
})

test('download failure stays idle and retry can prepare the model', async t => {
  let attempts = 0
  const { service, children } = fixture(t, {ready:()=>false,prepare:async()=>{if(++attempts===1)throw Error('fetch failed')}})
  assert.equal(await service.begin(),null); assert.equal(service.state.phase,'idle'); assert.equal(service.state.ready,false)
  assert.match(service.state.error,/检查网络/); assert.equal(await service.begin(),null); assert.equal(service.state.ready,true)
  assert.equal(children.length,0)
})

test('model download validates incomplete bytes and removes temporary files on failure or cancellation', async t => {
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
  const { VoiceModel }=require('../voice-model.cjs')
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pet-voice-model-test-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const controller=new AbortController()
  const incomplete=new VoiceModel({directory,fetchImpl:async()=>new Response(new Uint8Array([1,2,3]))})
  await assert.rejects(incomplete.prepare(controller.signal),/校验/)
  assert.equal(incomplete.ready(),false); assert.deepEqual(fs.readdirSync(directory),[])
  const cancelled=new VoiceModel({directory,fetchImpl:async()=>{controller.abort();return new Response(new Uint8Array([1,2,3]))}})
  await assert.rejects(cancelled.prepare(controller.signal),{name:'AbortError'})
  assert.equal(cancelled.ready(),false); assert.deepEqual(fs.readdirSync(directory),[])
})
