// Verify the production ASAR layout can load the Windows native recognizer in a utility process.
const { app, utilityProcess } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const asar = require('@electron/asar')
const { packagerConfig } = require('../../forge.config.cjs')
const directory = path.resolve('.artifacts/voice-native', `run-${Date.now()}`), source = path.join(directory, 'source')
fs.mkdirSync(path.join(source, 'desktop-pet'), {recursive:true})
fs.mkdirSync(path.join(source, 'electron'), {recursive:true})
fs.copyFileSync(path.resolve('desktop-pet/voice-worker.cjs'), path.join(source, 'desktop-pet/voice-worker.cjs'))
fs.writeFileSync(path.join(source, 'electron/probe.cjs'), 'module.exports = true')
for (const name of ['sherpa-onnx-node', 'sherpa-onnx-win-x64']) {
  assert.equal(packagerConfig.ignore.some(pattern => pattern.test(`/node_modules/${name}/package.json`)), false)
  fs.cpSync(path.resolve('node_modules', name), path.join(source, 'node_modules', name), {recursive:true})
}
assert.ok(packagerConfig.ignore.some(pattern => pattern.test('/node_modules/react/index.js')))
let child
app.whenReady().then(async () => {
  const archive = path.join(directory, 'app.asar')
  await asar.createPackageWithOptions(source, archive, packagerConfig.asar)
  for (const file of ['electron/probe.cjs', 'node_modules/sherpa-onnx-win-x64/sherpa-onnx.node', 'node_modules/sherpa-onnx-win-x64/onnxruntime.dll']) {
    assert.equal(asar.statFile(archive, path.normalize(file)).unpacked, true, `${file} must be unpacked`)
    assert.ok(fs.existsSync(path.join(`${archive}.unpacked`, file)))
  }
  const wave = require('sherpa-onnx-node').readWave(path.resolve('.artifacts/voice-fixture/reminder.wav'), false)
  const samples = new Float32Array(Math.floor(wave.samples.length * 16000 / wave.sampleRate))
  for (let i = 0; i < samples.length; i++) { const at=i*wave.sampleRate/16000, left=Math.floor(at); samples[i]=wave.samples[left]+((wave.samples[left+1]??wave.samples[left])-wave.samples[left])*(at-left) }
  child = utilityProcess.fork(path.join(archive, 'desktop-pet/voice-worker.cjs'), [], {stdio:'ignore'})
  const result = await new Promise((resolve, reject) => {
    const timer=setTimeout(()=>reject(Error('packaged recognizer timed out')),60000)
    child.once('message', data=>{clearTimeout(timer);resolve(data)})
    child.once('exit', code=>{clearTimeout(timer);reject(Error(`packaged recognizer exited: ${code}`))})
    child.postMessage({directory:path.resolve('.artifacts/voice-model/sensevoice'),samples})
  })
  assert.equal(result.error, undefined); assert.match(result.text, /(?:10|十)分钟后提醒我取快递/)
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({passed:true,text:result.text},null,2))
  console.log('PASS ASAR native dependency layout and isolated offline recognition: '+directory)
}).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{child?.kill();app.exit(process.exitCode||0)})
