// Client-id precedence, proven against the live GitHub API:
//
//   plugin config  >  value saved from the sign-in screen  >  built-in default
//
// A bogus id makes GitHub answer "Not Found", so "which id was used" is
// observable from the outside instead of asserted from internals.
import { apply } from '../lib/index.js'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const builtIn = /const DEFAULT_OAUTH_CLIENT_ID = '([^']+)'/.exec(readFileSync(join(here, 'lib/index.js'), 'utf8'))
if (!builtIn) {
  console.error('could not find DEFAULT_OAUTH_CLIENT_ID in lib/index.js')
  process.exit(1)
}
const BUILT_IN = builtIn[1]
const BOGUS = 'Ov23liBogusStoredTest01'

const home = join(tmpdir(), 'dsh-plugin-github-clientid-' + Date.now())
process.env.DSH_HOME = home
const configFile = join(home, 'storages', 'dsh-plugin-github', 'config.json')

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

async function tryStart(config) {
  const routes = mount(config)
  const action = routes.get('/api/dsh-plugin-github/action')
  const started = await post(action, { action: 'loginDeviceStart' })
  if (started.ok) await post(action, { action: 'loginDeviceCancel' })
  return started
}

let failures = 0
function ok(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`)
  }
}

if (existsSync(configFile)) rmSync(configFile)

console.log('\n[1] fresh install uses the built-in client id')
{
  const state = await post(mount({}).get('/api/dsh-plugin-github/state'), {})
  ok('canDeviceFlow', state.canDeviceFlow === true)
  ok('nothing saved yet', !existsSync(configFile))

  const started = await tryStart({})
  ok('built-in id works against GitHub', started.ok === true, started.ok ? '' : String(started.error).slice(0, 60))
}

console.log('\n[2] a saved client id takes over from the built-in one')
{
  const action = mount({}).get('/api/dsh-plugin-github/action')

  const rejected = await post(action, { action: 'setClientId', clientId: 'abc' })
  ok('short value rejected', rejected.ok === false)

  const saved = await post(action, { action: 'setClientId', clientId: BOGUS })
  ok('value saved', saved.ok === true)
  ok('config file written', existsSync(configFile))
  if (existsSync(configFile)) {
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    ok('file holds the id', raw.oauthClientId === BOGUS, raw.oauthClientId)
  }

  // A fresh instance must prefer the stored (bogus) id, so GitHub rejects it.
  const started = await tryStart({})
  ok('stored id beats the built-in default (bogus id rejected)', started.ok === false, String(started.error || '').slice(0, 40))
}

console.log('\n[3] plugin config beats the saved value')
{
  const started = await tryStart({ oauthClientId: BUILT_IN })
  ok('config id is used instead of the stored one', started.ok === true, started.ok ? '' : String(started.error).slice(0, 60))
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'CLIENT ID SETUP OK' : failures + ' CHECK(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)
