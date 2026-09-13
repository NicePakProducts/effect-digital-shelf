import * as Atom from "effect/unstable/reactivity/Atom"

export function sessionAtom<A>(store: {
  readonly get: () => A
  readonly subscribe: (listener: (value: A) => void) => () => void
}) {
  return Atom.make((context) => {
    context.addFinalizer(store.subscribe((value) => context.setSelf(value)))

    return store.get()
  })
}
