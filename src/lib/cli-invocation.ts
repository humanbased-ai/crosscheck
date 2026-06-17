import { existsSync } from 'fs'
import { fileURLToPath } from 'url'

// Resolves how to re-invoke the crosscheck CLI as a child process. Used by any
// command that fans work out across multiple PRs by spawning `crosscheck run`
// (or `review`) subprocesses — kickass and the ad-hoc multi-PR dispatchers.

export interface CliInvocation {
  command: string
  args: string[]
}

interface ResolveCliInvocationOptions {
  argvEntry?: string
  execPath?: string
  exists?: (path: string) => boolean
  urlToPath?: (url: URL) => string
}

export function resolveCliInvocation(options: ResolveCliInvocationOptions = {}): CliInvocation {
  const exists = options.exists ?? existsSync
  const urlToPath = options.urlToPath ?? fileURLToPath
  const execPath = options.execPath ?? process.execPath
  const argvEntry = options.argvEntry ?? process.argv[1]
  const localTsx = urlToPath(new URL('../../node_modules/.bin/tsx', import.meta.url))

  if (argvEntry && exists(argvEntry)) {
    return invocationForEntry(argvEntry, execPath, localTsx, exists)
  }

  const builtCli = urlToPath(new URL('../cli.js', import.meta.url))
  if (exists(builtCli)) return { command: execPath, args: [builtCli] }

  const sourceCli = urlToPath(new URL('../cli.ts', import.meta.url))
  if (exists(sourceCli)) return invocationForEntry(sourceCli, execPath, localTsx, exists)

  throw new Error('Cannot resolve crosscheck CLI entrypoint. Run npm run build before this command, or run from a source checkout with dev dependencies installed.')
}

function invocationForEntry(
  entry: string,
  execPath: string,
  localTsx: string,
  exists: (path: string) => boolean,
): CliInvocation {
  if (!entry.endsWith('.ts')) return { command: execPath, args: [entry] }
  if (exists(localTsx)) return { command: localTsx, args: [entry] }
  throw new Error('Cannot run crosscheck actions from a TypeScript entrypoint without the local tsx dev dependency. Run npm run build first.')
}
