/** Bound a best-effort probe without leaving a rejected promise unhandled. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(null) },
    )
  })
}
