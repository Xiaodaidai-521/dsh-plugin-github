// Device-flow wiring against a real OAuth App.
//
// The package ships a built-in public client id, so a fresh host can start a
// real device flow with no configuration at all. A configured override must win
// over it — proven by GitHub rejecting the override.
import { apply } from '../lib/index.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate from the real harness data dir so a saved id cannot mask a failure.
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

let failures = 0
function ok(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`)
  }
}

console.log('\n[1] built-in client id: zero configuration')
{
  const routes = mount({})
  const state = await post(routes.get('/api/dsh-plugin-github/state'), {})
  ok('canDeviceFlow without any config', state.canDeviceFlow === true)

  const started = await post(routes.get('/api/dsh-plugin-github/action'), { action: 'loginDeviceStart' })
  ok('device/code accepted by GitHub', started.ok === true, started.ok ? '' : String(started.error).slice(0, 80))
  if (started.ok) {
    ok('user code shape', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(started.result.userCode), started.result.userCode)
    ok('verification uri', /login\/device/.test(started.result.verificationUri), started.result.verificationUri)
    ok('scopes include workflow', String(started.result.scopes).includes('workflow'), started.result.scopes)
    const cancelled = await post(routes.get('/api/dsh-plugin-github/action'), { action: 'loginDeviceCancel' })
    ok('cancel clears the flow', cancelled.ok === true)
  }
}

console.log('\n[2] a configured client id overrides the built-in one')
{
  const routes = mount({ oauthClientId: 'Iv1.0000000000000000' })
  const state = await post(routes.get('/api/dsh-plugin-github/state'), {})
  ok('still reports device flow available', state.canDeviceFlow === true)

  const started = await post(routes.get('/api/dsh-plugin-github/action'), { action: 'loginDeviceStart' })
  ok('the override is the id GitHub sees (bogus id rejected)', started.ok === false, String(started.error || '').slice(0, 60))
}

console.log(`\n${failures === 0 ? 'DEVICE FLOW WIRING OK' : failures + ' CHECK(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)
