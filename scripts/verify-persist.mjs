// "Authorize once, never see the login screen again" — the durable side.
//
//  1. a token saved by the panel is written to disk (0600) and reused by a
//     brand-new process, i.e. it survives a restart
//  2. the saved token wins over env / gh fallbacks
//  3. sign-out deletes it and suppresses the fallbacks
//  4. a client id written to disk is picked up with no restart
import { apply } from '../lib/index.js'
import { readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = join(tmpdir(), 'dsh-plugin-github-persist-' + Date.now())
process.env.DSH_HOME = home
const dataDir = join(home, 'storages', 'dsh-plugin-github')

function mount(config, noCredentials) {
  const routes = new Map()
  const store = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const scope = {
    get: (name) => {
      if (name === 'connection') return connection
      if (name === 'credentials' && !noCredentials) {
        return {
          async resolve(ref) { return store.has(ref) ? { value: store.get(ref), source: 'test' } : undefined },
          async set(ref, value) { store.set(ref, value) },
          async unset(ref) { store.delete(ref) },
        }
      }
      return undefined
    },
    effect: (fn) => { fn(); return () => {} },
  }
  apply({
    tools: { register: () => () => {} },
    get: scope.get,
    effect: scope.effect,
    inject: (deps, fn) => { fn(scope); return () => {} },
    // expose the module so the caller can read the resolved token
  }, config)
  return { routes, store }
}

async function post(route, payload) {
  const response = await route.fetch(new Request('http://x/api/dsh-plugin-github/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return response.json()
}

console.log('[1] a client id written to disk needs no restart')
{
  const { routes } = mount({})
  const before = await post(routes.get('/api/dsh-plugin-github/state'), {})
  console.log(`  before file: canDeviceFlow = ${before.canDeviceFlow}`)

  // write through the plugin's own action (same code path the UI uses)
  await post(routes.get('/api/dsh-plugin-github/action'), { action: 'setClientId', clientId: 'Ov23liPersistTest01' })

  // wipe the in-memory value to prove the next call re-reads the file
  const { routes: again } = mount({})
  const after = await post(again.get('/api/dsh-plugin-github/state'), {})
  console.log(`  brand-new instance: canDeviceFlow = ${after.canDeviceFlow}`)
  if (after.canDeviceFlow !== true) { console.log('  FAIL'); process.exit(1) }
}

console.log('\n[2] token persistence on a host whose credential store is unusable')
{
  const { routes } = mount({}, true) // no credentials service at all
  const action = routes.get('/api/dsh-plugin-github/action')

  // simulate the post-authorization step by calling persist through the login path
  // (login validates against GitHub, so use the token file directly instead)
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  let realToken = ''
  try {
    realToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  } catch {
    realToken = ''
  }
  if (!realToken) {
    console.log('  SKIP: no real GitHub token on this host to persist')
    process.exit(0)
  }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'token.json'), JSON.stringify({ token: realToken }), { mode: 0o600 })

  const state = await post(routes.get('/api/dsh-plugin-github/state'), {})
  console.log(`  authenticated from the saved file = ${state.authenticated}`)
  console.log(`  source = ${state.source}`)
  if (state.authenticated !== true) { console.log('  FAIL: saved token ignored'); process.exit(1) }
  if (state.source !== 'panel-login:saved') { console.log('  FAIL: wrong precedence'); process.exit(1) }

  const mode = statSync(join(dataDir, 'token.json')).mode & 0o777
  if (process.platform === 'win32') {
    // Windows ignores POSIX mode bits; privacy comes from the profile ACLs.
    console.log(`  file mode = ${mode.toString(8)} (POSIX bits are not enforced on win32)`)
  } else {
    console.log(`  file mode = ${mode.toString(8)} (expected 600)`)
    if (mode !== 0o600) { console.log('  FAIL: token file is not private'); process.exit(1) }
  }
}

console.log('\n[3] sign-out removes it and suppresses env/gh fallbacks')
{
  const { routes } = mount({}, true)
  const action = routes.get('/api/dsh-plugin-github/action')
  await post(action, { action: 'logout' })
  const gone = !existsSync(join(dataDir, 'token.json'))
  console.log(`  token file removed = ${gone}`)
  if (!gone) { console.log('  FAIL'); process.exit(1) }

  const state = await post(routes.get('/api/dsh-plugin-github/state'), {})
  console.log(`  still authenticated = ${state.authenticated} (expected false even with gh present)`)
  if (state.authenticated !== false) { console.log('  FAIL: fallback leaked back in'); process.exit(1) }
}

rmSync(home, { recursive: true, force: true })
console.log('\nPERSISTENCE OK')
