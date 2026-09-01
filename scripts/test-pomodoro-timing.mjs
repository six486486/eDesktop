import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getPomodoroNextTickDelay,
  getPomodoroRemainingSeconds,
} from '../src/pomodoroTiming.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pomodoroWidgetSource = fs.readFileSync(
  path.join(root, 'src', 'desktop-widgets', 'PomodoroWidget.tsx'),
  'utf8',
)

assert.match(pomodoroWidgetSource, /getPomodoroRemainingSeconds\(activeEndsAt, now\)/)
assert.match(pomodoroWidgetSource, /getPomodoroNextTickDelay\(endsAt, tickedAt\)/)
assert.doesNotMatch(pomodoroWidgetSource, /setInterval/)

const startedAt = 10_000
const endsAt = startedAt + 60_000

assert.equal(getPomodoroRemainingSeconds(endsAt, startedAt), 60)
assert.equal(getPomodoroRemainingSeconds(endsAt, startedAt + 999), 60)
assert.equal(getPomodoroRemainingSeconds(endsAt, startedAt + 1_000), 59)
assert.equal(getPomodoroRemainingSeconds(endsAt, endsAt), 0)
assert.equal(getPomodoroRemainingSeconds(endsAt, endsAt + 500), 0)

assert.equal(getPomodoroNextTickDelay(endsAt, startedAt), 1_000)
assert.equal(getPomodoroNextTickDelay(endsAt, startedAt + 250), 750)
assert.equal(getPomodoroNextTickDelay(endsAt, startedAt + 1_250), 750)
assert.equal(getPomodoroNextTickDelay(endsAt, startedAt + 2_500), 500)
assert.equal(getPomodoroNextTickDelay(endsAt, endsAt), null)

const callbackLateness = [17, 143, 6, 221, 39, 88]
let scheduledAt = startedAt
let previousBoundary = startedAt
for (const lateness of callbackLateness) {
  const delay = getPomodoroNextTickDelay(endsAt, scheduledAt)
  assert.notEqual(delay, null)
  const intendedBoundary = scheduledAt + delay
  assert.equal(intendedBoundary % 1_000, 0)
  assert.equal(intendedBoundary - previousBoundary, 1_000)

  scheduledAt = intendedBoundary + lateness
  previousBoundary = intendedBoundary
  assert.equal(
    getPomodoroRemainingSeconds(endsAt, scheduledAt),
    Math.max(0, Math.ceil((endsAt - scheduledAt) / 1_000)),
  )
}

console.log('[pomodoro-timing] absolute deadline and second-boundary scheduling assertions passed')
