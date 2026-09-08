const path = require('node:path')
const sherpa = require('sherpa-onnx-node')
// One isolated process per utterance: cancellation also releases native model memory.
process.parentPort.once('message', ({ data }) => {
  try {
    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { senseVoice: { model: path.join(data.directory, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
        tokens: path.join(data.directory, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
    })
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(data.samples) })
    recognizer.decode(stream)
    process.parentPort.postMessage({ text: recognizer.getResult(stream).text })
  } catch { process.parentPort.postMessage({ error: '小栖这次没听清，重新说一次吧～' }) }
})
