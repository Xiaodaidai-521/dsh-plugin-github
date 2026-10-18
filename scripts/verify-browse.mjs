// Smoke test for the panel's browse/file actions against a real repository.
import { apply } from '../lib/index.js'

const routes = new Map()
const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
const scope = {
  get: (name) => (name === 'connection' ? connection : undefined),
  effect: (fn) => { fn(); return () => {} },
}
apply(
  {
    tools: { register: () => () => {} },
    get: scope.get,
    effect: scope.effect,
    inject: (deps, fn) => { fn(scope); return () => {} },
  },
  {},
)

const action = routes.get('/api/dsh-plugin-github/action')
const repo = process.argv[2] || 'Xiaodaidai-521/ctf'

async function call(payload) {
  const response = await action.fetch(new Request('http://x/api/dsh-plugin-github/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, ...payload }),
  }))
  return response.json()
}

const root = await call({ action: 'browse', path: '' })
if (!root.ok) {
  console.log('browse FAILED:', root.error)
  process.exit(1)
}

const r = root.result
console.log(`repo      = ${r.repository}`)
console.log(`branch    = ${r.branch}`)
console.log(`path      = "${r.path}"`)
console.log(`head      = ${r.head ? `${r.head.sha.slice(0, 7)} ${r.head.message} — ${r.head.author}` : '(none)'}`)
console.log('entries:')
for (const e of r.entries) {
  const kind = e.type === 'dir' ? 'DIR ' : 'FILE'
  const msg = (e.message || '').slice(0, 46)
  console.log(`  ${kind} ${String(e.name).padEnd(24)} ${String(e.date || '').slice(0, 10).padEnd(11)} ${msg}`)
}

// Descend into the first directory, if any.
const dir = r.entries.find((e) => e.type === 'dir')
if (dir) {
  const sub = await call({ action: 'browse', path: dir.path })
  console.log(`\nnested browse ${dir.path} => ok=${sub.ok} entries=${sub.ok ? sub.result.entries.length : '-'}`)
}

// Read a file.
const file = r.entries.find((e) => e.type === 'file')
if (file) {
  const read = await call({ action: 'file', path: file.path })
  console.log(`file ${file.path} => ok=${read.ok} bytes=${read.ok ? read.result.size : '-'}`)
}

// Phase 2: a configured default repository, with no `repo` in the payload at
// all — this is what the panel sends once `config.repository` is set.
const routes2 = new Map()
const connection2 = { fetch: { register: (route) => { routes2.set(route.path, route); return () => {} } } }
const scope2 = {
  get: (name) => (name === 'connection' ? connection2 : undefined),
  effect: (fn) => { fn(); return () => {} },
}
apply(
  {
    tools: { register: () => () => {} },
    get: scope2.get,
    effect: scope2.effect,
    inject: (deps, fn) => { fn(scope2); return () => {} },
  },
  { repository: 'Xiaodaidai-521/ctf' },
)

const action2 = routes2.get('/api/dsh-plugin-github/action')
const state2 = routes2.get('/api/dsh-plugin-github/state')

async function bare(route, payload) {
  const response = await route.fetch(new Request('http://x/api/dsh-plugin-github/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return response.json()
}

const configured = await bare(action2, { action: 'browse', path: '' })
console.log(`\nconfig default browse => ok=${configured.ok} repo=${configured.ok ? configured.result.repository : configured.error}`)
if (configured.ok) {
  console.log(`  entries=${configured.result.entries.length} head=${configured.result.head ? configured.result.head.sha.slice(0, 7) : '-'}`)
}

const configuredState = await bare(state2, {})
console.log(`config default state  => authenticated=${configuredState.authenticated} repo=${configuredState.repo ? configuredState.repo.fullName : '-'} branches=${configuredState.branches.length} pulls=${configuredState.pulls.length}`)
