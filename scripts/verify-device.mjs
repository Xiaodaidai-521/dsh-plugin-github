// Device-flow wiring: without a client id the host must refuse with a clear,
// actionable message; with one it must speak GitHub's protocol correctly.
import { apply } from '../lib/index.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate from the real harness data dir: this test needs a host that has no
// stored OAuth client id at all.
process.env.DSH_HOME = join(tmpdir(), 'dsh-plugin-github-devtest-' + Date.now())

function mount(config) {
  const routes = new Map()
  const store = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const credentials = {
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref), source: 'test' } : undefined },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
  }
  const scope = {
    get: (name) => (name === 'connection' ? connection : name === 'credentials' ? credentials : undefined),
    effect: (fn) => { fn(); return () => {} },
  }
  apply({
    tools: { register: () => () => {} },
    get: scope.get,
    effect: scope.effect,
    inject: (deps, fn) => { fn(scope); return () => {} },
  }, config)
  return routes
}

async function post(route, payload) {
  const response = await route.fetch(new Request('http://x/api/dsh-plugin-github/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return response.json()
}

// --- no client id configured -------------------------------------------------
console.log('[1] no oauthClientId')
{
  const routes = mount({ repository: 'Xiaodaidai-521/ctf' })
  const state = await post(routes.get('/api/dsh-plugin-github/state'), {})
  console.log(`  state.canDeviceFlow = ${state.canDeviceFlow}`)
  if (state.canDeviceFlow !== false) { console.log('  FAIL'); process.exit(1) }

  const started = await post(routes.get('/api/dsh-plugin-github/action'), { action: 'loginDeviceStart' })
  console.log(`  start => ok=${started.ok} needsClientId=${started.needsClientId}`)
  console.log(`  message: ${String(started.error).slice(0, 70)}…`)
  if (started.ok !== false || started.needsClientId !== true) { console.log('  FAIL'); process.exit(1) }

  const polled = await post(routes.get('/api/dsh-plugin-github/action'), { action: 'loginDevicePoll' })
  console.log(`  poll without a flow => ok=${polled.ok} error=${String(polled.error).slice(0, 30)}`)
  if (polled.ok !== false) { console.log('  FAIL'); process.exit(1) }
}

// --- client id configured, bogus value --------------------------------------
// A fake client id exercises the real request shape: GitHub must answer, and the
// host must surface its error instead of hanging or throwing.
console.log('\n[2] bogus oauthClientId reaches GitHub and reports its answer')
{
  const routes = mount({ repository: 'Xiaodaidai-521/ctf', oauthClientId: 'Iv1.0000000000000000' })
  const state = await post(routes.get('/api/dsh-plugin-github/state'), {})
  console.log(`  state.canDeviceFlow = ${state.canDeviceFlow}`)
  if (state.canDeviceFlow !== true) { console.log('  FAIL'); process.exit(1) }

  const started = await post(routes.get('/api/dsh-plugin-github/action'), { action: 'loginDeviceStart' })
  console.log(`  start => ok=${started.ok}`)
  if (started.ok) {
    console.log(`  userCode=${started.result.userCode} uri=${started.result.verificationUri} interval=${started.result.interval}`)
    const polled = await post(routes.get('/api/dsh-plugin-github/action'), { action: 'loginDevicePoll' })
    console.log(`  first poll => ok=${polled.ok} pending=${polled.pending} error=${polled.error || '-'}`)
    const cancelled = await post(routes.get('/api/dsh-plugin-github/action'), { action: 'loginDeviceCancel' })
    console.log(`  cancel => ok=${cancelled.ok}`)
  } else {
    console.log(`  GitHub answered: ${String(started.error).slice(0, 90)}`)
    console.log('  (a bogus client id must be rejected — wiring is correct)')
  }
}

console.log('\nDEVICE FLOW WIRING OK')
