const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const surfaceSource = fs.readFileSync(path.join(root, 'src', 'desktop-widgets', 'PomodoroWidget.tsx'), 'utf8')
const stylesSource = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')

assert.match(
  surfaceSource,
  /flip-digit-leaf-stage flip-digit-leaf-stage-top flip-digit-static-stage[\s\S]*?flip-digit-leaf flip-digit-face-top flip-digit-static-top/,
)
assert.match(
  surfaceSource,
  /flip-digit-leaf-stage flip-digit-leaf-stage-bottom flip-digit-static-stage[\s\S]*?flip-digit-leaf flip-digit-face-bottom flip-digit-static-bottom/,
)
assert.match(surfaceSource, /flip-digit-leaf flip-digit-face-top flip-digit-leaf-out/)
assert.match(surfaceSource, /flip-digit-leaf flip-digit-face-bottom flip-digit-leaf-in/)
assert.doesNotMatch(surfaceSource, /flip-digit-half/)

assert.match(stylesSource, /--flap-top-face:[\s\S]*?#124b3f;/)
assert.match(stylesSource, /--flap-bottom-face:[\s\S]*?#124b3f;/)
assert.match(stylesSource, /\.flip-digit-static-stage\s*{\s*z-index:\s*1;/)
assert.match(stylesSource, /\.flip-digit-face-top\s*{[\s\S]*?transform:\s*rotateX\(0deg\);[\s\S]*?background:\s*var\(--flap-top-face\);/)
assert.match(stylesSource, /\.flip-digit-face-bottom\s*{[\s\S]*?transform:\s*rotateX\(0deg\);[\s\S]*?background:\s*var\(--flap-bottom-face\);/)
assert.match(stylesSource, /\.flip-digit-leaf-out\s*{\s*animation:\s*split-flap-fold 220ms/)
assert.match(stylesSource, /\.flip-digit-leaf-in\s*{[\s\S]*?animation:\s*split-flap-unfold 240ms 220ms/)

const foldFrames = stylesSource.match(/@keyframes split-flap-fold\s*{([\s\S]*?)\n}/)?.[1] || ''
const unfoldFrames = stylesSource.match(/@keyframes split-flap-unfold\s*{([\s\S]*?)\n}/)?.[1] || ''
assert.doesNotMatch(foldFrames, /opacity:/)
assert.doesNotMatch(unfoldFrames, /opacity:/)

console.log('[pomodoro-flip] shared stage/face geometry and transform-only handoff assertions passed')
