import { execa, type Options } from 'execa'
import { oneLine } from '../lib/vendor-error-summary.js'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// OpenCode can emit a terminal API error on stdout and exit zero. Only inspect
// top-level CLI events, never agent text or tool output copied from the checkout.
export function openCodeStreamError(raw: string): string | undefined {
  for (const line of raw.split('\n')) {
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    if (!record(event) || event.type !== 'error') continue
    const error = event.error
    if (typeof error === 'string' && error.trim()) return oneLine(error)
    if (!record(error)) return 'OpenCode reported an error without details'
    const data = record(error.data) ? error.data : undefined
    const message = data?.message ?? error.message
    return typeof message === 'string' && message.trim()
      ? oneLine(message)
      : 'OpenCode reported an error without details'
  }
  return undefined
}

// V1 retries provider 429s internally without emitting a terminal JSON event.
// Its structured error log reveals exhausted free usage while that retry loop
// is still running. Require the runtime's stream-error record, not arbitrary
// stderr text (which can include tool output).
export function openCodeProviderLimit(raw: string): string | undefined {
  for (const line of raw.split('\n')) {
    if (!/^timestamp=\S+ level=ERROR run=\S+ message="stream error" /.test(line)) continue
    const encoded = line.match(/ error\.error=("(?:[^"\\]|\\.)*")/)
    if (!encoded) continue
    let message: unknown
    try { message = JSON.parse(encoded[1]) } catch { continue }
    if (typeof message !== 'string' || !/free usage limit reached|out of credits|insufficient (?:credits|quota)|quota (?:exceeded|exhausted)/i.test(message)) continue
    return oneLine(message.replace(/^AI_\w+Error: /, ''))
  }
  return undefined
}

/** Stop a failed stream promptly, including CLIs that stay alive after an error. */
export async function runOpenCode(args: string[], options: Options): Promise<{ stdout: string; stderr: string }> {
  const child = execa('opencode', ['--print-logs', ...args], options)
  let pending = ''
  let pendingStderr = ''
  let failure: string | undefined
  const inspect = (chunk: Buffer | string): void => {
    pending += chunk.toString()
    const end = pending.lastIndexOf('\n')
    if (end < 0) return
    failure ??= openCodeStreamError(pending.slice(0, end))
    pending = pending.slice(end + 1)
    if (failure) child.kill('SIGTERM')
  }
  const inspectStderr = (chunk: Buffer | string): void => {
    pendingStderr += chunk.toString()
    const end = pendingStderr.lastIndexOf('\n')
    if (end < 0) return
    failure ??= openCodeProviderLimit(pendingStderr.slice(0, end))
    pendingStderr = pendingStderr.slice(end + 1)
    if (failure) child.kill('SIGTERM')
  }
  child.stdout?.on('data', inspect)
  child.stderr?.on('data', inspectStderr)
  try {
    const result = await child
    failure ??= openCodeStreamError(String(result.stdout ?? '')) ?? openCodeProviderLimit(String(result.stderr ?? ''))
    if (failure) throw Object.assign(new Error(failure), { stderr: failure })
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  } catch (err: unknown) {
    const stdout = (err as { stdout?: unknown } | null)?.stdout
    const stderr = (err as { stderr?: unknown } | null)?.stderr
    failure ??= (typeof stdout === 'string' ? openCodeStreamError(stdout) : undefined)
      ?? (typeof stderr === 'string' ? openCodeProviderLimit(stderr) : undefined)
    if (failure) {
      // A provider error is not a timeout, even if the process failed to exit.
      throw Object.assign(new Error(failure), { stderr: failure, exitCode: 1 })
    }
    throw err
  } finally {
    child.stdout?.off('data', inspect)
    child.stderr?.off('data', inspectStderr)
  }
}

// V1 exposes --variant; only V2 accepts the #variant model suffix.
export function openCodeModelArgs(model: string | undefined, effort: string, v2: boolean): string[] {
  if (!model) return []
  return v2 ? ['--model', `${model}#${effort}`] : ['--model', model, '--variant', effort]
}
