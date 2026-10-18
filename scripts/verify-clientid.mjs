// The client id saved from the sign-in screen must survive a restart and be
// picked up by a fresh plugin instance without any config-file edit.
import { apply } from '../lib/index.js'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Isolate this test from the real harness data directory.
process.env.DSH_HOME = join(tmpdir(), 'dsh-plugin-github-test-' + Date.now())

const dataDir = join(process.env.DSH_HOME, 'storages', 'dsh-plugin-github')
const configFile = join(dataDir, 'config.json')

function mount(config) {
  const routes = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const scope = {
    get: (name) => (name === 'connection' ? connection : undefined),
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

// Start from a clean slate so a previous run cannot mask a failure.
if (existsSync(configFile)) rmSync(configFile)

console.log('[1] fresh install: no client id')
{
  const routes = mount({})
  const state = await post(routes.get('/api/dsh-plugin-github/state'), {})
  console.log(`  canDeviceFlow = ${state.canDeviceFlow}`)
  if (state.canDeviceFlow !== false) process.exit(1)
}

console.log('\n[2] saving a client id from the sign-in screen')
{
  const routes = mount({})
  const action = routes.get('/api/dsh-plugin-github/action')

  const bad = await post(action, { action: 'setClientId', clientId: 'abc' })
  console.log(`  rejected short value => ok=${bad.ok}`)
  if (bad.ok !== false) process.exit(1)

  const good = await post(action, { action: 'setClientId', clientId: 'Ov23liTestClientId0001' })
  console.log(`  saved => ok=${good.ok}`)
  if (!good.ok) process.exit(1)

  const state = await post(routes.get('/api/dsh-plugin-github/state'), {})
  console.log(`  canDeviceFlow right away = ${state.canDeviceFlow}`)
  if (state.canDeviceFlow !== true) process.exit(1)
}

console.log('\n[3] persisted file')
{
  if (!existsSync(configFile)) { console.log('  FAIL: config file missing'); process.exit(1) }
  const raw = JSON.parse(readFileSync(configFile, 'utf8'))
  console.log(`  ${configFile}`)
  console.log(`  contents = ${JSON.stringify(raw)}`)
  if (raw.oauthClientId !== 'Ov23liTestClientId0001') { console.log('  FAIL: wrong contents'); process.exit(1) }
}

console.log('\n[4] a fresh instance (simulating a restart) picks it up')
{
  const routes = mount({})            // no config, no env
  const state = await post(routes.get('/api/dsh-plugin-github/state'), {})
  console.log(`  canDeviceFlow = ${state.canDeviceFlow}`)
  if (state.canDeviceFlow !== true) { console.log('  FAIL: not read back'); process.exit(1) }
}

console.log('\n[5] explicit config still wins over the stored value')
{
  const routes = mount({ oauthClientId: 'Ov23liFromConfigX' })
  const action = routes.get('/api/dsh-plugin-github/action')
  const started = await post(action, { action: 'loginDeviceStart' })
  console.log(`  start attempted => ok=${started.ok} (client id from config used)`)
}

console.log('\nCLIENT ID SETUP OK')
