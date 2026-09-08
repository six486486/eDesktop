// The host supplies its existing workspace queue and persistence. No workspace
// or filesystem authority is exposed to the model or the pet renderer.
function createFocusHost({ read, enqueue, persist, publish, createWidget }) {
  const listeners = new Set()
  return {
    read, createWidget,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    changed() { for (const listener of listeners) listener() },
    transact(edit, isCurrent = () => true) {
      return enqueue(async () => {
        if (!isCurrent()) return { status: 'cancelled' }
        const next = structuredClone(read())
        const result = edit(next)
        if (!result.changed) return result.value
        if (!isCurrent()) return { status: 'cancelled' }
        // Starting the durable write is the commit boundary. Cancellation after
        // this point stops the reply, not the already accepted clock operation.
        await persist(next)
        publish(next)
        return result.value
      })
    },
  }
}
module.exports = { createFocusHost }
