const closedOutputCodes = new Set(['EPIPE', 'ERR_STREAM_DESTROYED'])

const isClosedOutputError = (error) => Boolean(
  error
  && typeof error === 'object'
  && closedOutputCodes.has(error.code),
)

const installSafeConsole = ({
  targetConsole = console,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  let outputClosed = false
  const originals = new Map()

  for (const method of ['log', 'info', 'warn', 'error']) {
    if (typeof targetConsole[method] !== 'function') continue
    const original = targetConsole[method].bind(targetConsole)
    originals.set(method, original)
    targetConsole[method] = (...args) => {
      if (outputClosed) return undefined
      try {
        return original(...args)
      } catch (error) {
        if (!isClosedOutputError(error)) throw error
        outputClosed = true
        return undefined
      }
    }
  }

  const handleStreamError = (error) => {
    if (isClosedOutputError(error)) {
      outputClosed = true
      return
    }
    setImmediate(() => { throw error })
  }
  stdout?.on?.('error', handleStreamError)
  if (stderr !== stdout) stderr?.on?.('error', handleStreamError)

  return {
    isOutputClosed: () => outputClosed,
    restore: () => {
      for (const [method, original] of originals) targetConsole[method] = original
      stdout?.off?.('error', handleStreamError)
      if (stderr !== stdout) stderr?.off?.('error', handleStreamError)
    },
  }
}

module.exports = { installSafeConsole, isClosedOutputError }
