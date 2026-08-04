import { once } from 'events'
import { createConnection } from 'net'

const sessionKey = process.env.CROSSCHECK_SKILL_SESSION_KEY

function parseSocketPath(argv: string[]): string {
  const index = argv.indexOf('--socket')
  if (index === -1 || !argv[index + 1]) throw new Error('--socket <path> is required')
  return argv[index + 1]
}

export async function runSkillBrokerProxy(socketPath: string): Promise<void> {
  if (!sessionKey) throw new Error('CROSSCHECK_SKILL_SESSION_KEY is required')
  const socket = createConnection(socketPath)
  await once(socket, 'connect')
  socket.write(`${sessionKey}\n`)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  await once(socket, 'close')
}

await runSkillBrokerProxy(parseSocketPath(process.argv.slice(2)))
