import { createServer } from 'net'

// Parses and validates a CLI-supplied port string (Commander passes the raw
// value). Returns an integer in the valid TCP range, or throws a user-facing
// error the command boundary converts to exit code 1.
export function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value "${raw}" — expected an integer between 1 and 65535`)
  }
  return port
}

// Probes a port by briefly binding to it. Returns true if available.
function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port)
  })
}

// Returns the first available port starting from `start`, skipping occupied ones.
// Throws if no free port is found within `maxTries` attempts.
export async function findAvailablePort(start: number, maxTries = 10): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const port = start + i
    if (await isPortFree(port)) return port
  }
  throw new Error(`No available port found in range ${start}–${start + maxTries - 1}`)
}
