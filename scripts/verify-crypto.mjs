// Encrypted token file: round-trip, tamper resistance, legacy migration.
import { apply } from '../lib/index.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = join(tmpdir(), 'dsh-plugin-github-crypt-' + Date.now())
process.env.DSH_HOME = home
const dataDir = join(home, 'storages', 'dsh-plugin-github')
const tokenPath = join(dataDir, 'token.json')

function mount() {
  const routes = new Map()
  const connection = { fetch: { register: (r) => { routes.set(r.path, r); return () => {} } } }
  const scope = {
    get: (n) => (n === 'connection' ? connection : undefined),
    effect: (f) => { f(); return () => {} },
  }
  apply({ tools: { register: () => () => {} }, get: scope.get, effect: scope.effect,
    inject: (d, f) => { f(scope); return () => {} } }, {})
  return routes
}

async function post(route, payload) {
  const res = await route.fetch(new Request('http://x/api/dsh-plugin-github/x', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
  return res.json()
}

let real = ''
try { real = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() } catch {}
if (!real) { console.log('SKIP: no token on this host'); process.exit(0) }

mkdirSync(dataDir, { recursive: true })

// 1. legacy plaintext still works
writeFileSync(tokenPath, JSON.stringify({ token: real }))
let state = await post(mount().get('/api/dsh-plugin-github/state'), {})
console.log(`legacy plaintext read => authenticated=${state.authenticated} source=${state.source}`)
if (!state.authenticated) { console.log('FAIL: legacy file ignored'); process.exit(1) }

// 2. sign-in rewrites it encrypted (credentials unavailable in this mount)
const action = mount().get('/api/dsh-plugin-github/action')
const logged = await post(action, { action: 'login', token: real })
console.log(`login => ok=${logged.ok} stored=${logged.result && logged.result.stored}`)
if (!logged.ok) process.exit(1)

const raw = readFileSync(tokenPath, 'utf8')
const record = JSON.parse(raw)
console.log(`file => v=${record.v} alg=${record.alg} hasCiphertext=${typeof record.data === 'string'}`)
if (record.v !== 2 || record.alg !== 'aes-256-gcm') { console.log('FAIL: not encrypted'); process.exit(1) }
if (raw.includes(real.slice(0, 12))) { console.log('FAIL: plaintext token still in file'); process.exit(1) }
console.log('plaintext absent from file => true')

// 3. encrypted file still authenticates
state = await post(mount().get('/api/dsh-plugin-github/state'), {})
console.log(`encrypted read => authenticated=${state.authenticated} source=${state.source}`)
if (!state.authenticated) { console.log('FAIL: encrypted file unreadable'); process.exit(1) }

// 4. tampering is rejected (GCM tag) — checked in a FRESH process, because the
// current one still holds the token in memory and would mask the failure.
const bytes = Buffer.from(record.data, 'base64')
bytes[0] ^= 0xff
writeFileSync(tokenPath, JSON.stringify({ ...record, data: bytes.toString('base64') }))

const probe = `
process.env.DSH_HOME = ${JSON.stringify(home)}
const { apply } = await import('./lib/index.js')
const routes = new Map()
const conn = { fetch: { register: (r) => { routes.set(r.path, r); return () => {} } } }
const scope = { get: (n) => (n === 'connection' ? conn : undefined), effect: (f) => { f() } }
apply({ tools: { register: () => () => {} }, get: scope.get, effect: scope.effect,
  inject: (d, f) => { f(scope); return () => {} } }, {})
const res = await routes.get('/api/dsh-plugin-github/state').fetch(
  new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
const body = await res.json()
console.log(JSON.stringify({ source: body.source }))
`
const out = execFileSync('node', ['--input-type=module', '-e', probe], {
  encoding: 'utf8',
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home },
})
const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()
const child = JSON.parse(line)
console.log(`tampered file (fresh process) => source=${child.source}`)
if (child.source === 'panel-login:saved') { console.log('FAIL: tampered ciphertext accepted'); process.exit(1) }
console.log('tamper rejected => true')

rmSync(home, { recursive: true, force: true })
console.log('\nTOKEN ENCRYPTION OK')
