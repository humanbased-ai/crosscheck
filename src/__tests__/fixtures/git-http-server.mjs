/* global process, URL, Buffer, console */
// A real smart-HTTP git remote: `git http-backend` behind a server that answers 401
// until it sees the expected credential, the way GitHub does for a private repository.
// Prints its port when ready.
//
// A process of its own, because the runner pushes with execFileSync: a server on the
// test's event loop could never answer the push that is blocking it.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const server = createServer((req, res) => {
  if (req.headers.authorization !== process.env.EXPECTED_AUTHORIZATION) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' })
    res.end()
    return
  }
  const url = new URL(req.url, 'http://127.0.0.1')
  const backend = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      REMOTE_USER: 'x-access-token',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  req.pipe(backend.stdin)

  // CGI output: headers, a blank line, then the body.
  let head = Buffer.alloc(0)
  let headersSent = false
  backend.stdout.on('data', chunk => {
    if (headersSent) {
      res.write(chunk)
      return
    }
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) return
    const headers = head.subarray(0, end).toString().split('\r\n').map(line => line.split(': '))
    const status = headers.find(([name]) => name.toLowerCase() === 'status')?.[1] ?? '200'
    res.writeHead(parseInt(status, 10), Object.fromEntries(headers.filter(([name]) => name.toLowerCase() !== 'status')))
    res.write(head.subarray(end + 4))
    headersSent = true
  })
  backend.stdout.on('end', () => res.end())
})

server.listen(0, '127.0.0.1', () => console.log(server.address().port))
