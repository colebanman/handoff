// A disposable site for real API + browser execution, without touching user accounts.
import { createServer } from 'node:http'
const records = [{ id: 'record-1', title: 'Read chapter four', href: '/announcement/record-1' }]
createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.url === '/records') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(records)); return
  }
  res.setHeader('Content-Type', 'text/html')
  res.end(`<!doctype html><title>REPL extension test</title><main><h1>${req.url?.startsWith('/announcement/') ? 'Read chapter four' : 'Course announcements'}</h1><a id="latest-announcement" href="/announcement/record-1">Read chapter four</a></main>`)
}).listen(8766, '127.0.0.1', () => console.log('REPL test site: http://127.0.0.1:8766'))
