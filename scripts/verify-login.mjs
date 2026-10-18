// Verifies the panel sign-in path: token validation, refusal of bad tokens,
// and that a stored token is what subsequent calls use.
import { apply } from '../lib/index.js'

const routes = new Map()
const store = new Map()

const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
const credentials = {
  async resolve(ref) {
    return store.has(ref) ? { value: store.get(ref), source: 'test-store' } : undefined
  },
  async set(ref, value) {
    store.set(ref, value)
  },
  async unset(ref) {
    store.delete(ref)
  },
}
const scope = {
  get: (name) => {
    if (name === 'connection') return connection
    if (name === 'credentials') return credentials
    return undefined
  },
  effect: (fn) => { fn(); return () => {} },
}

apply(
  {
    tools: { register: () => () => {} },
    get: scope.get,
    effect: scope.effect,
    inject: (deps, fn) => { fn(scope); return () => {} },
  },
  { repository: 'Xiaodaidai-521/ctf' },
)

const state = routes.get('/api/dsh-plugin-github/state')
const action = routes.get('/api/dsh-plugin-github/action')

async function post(route, payload) {
  const response = await route.fetch(new Request('http://x/api/dsh-plugin-github/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return { status: response.status, body: await response.json() }
}

// 1. unauthenticated snapshot advertises whether storing is possible
const before = await post(state, {})
console.log(`before: authenticated=${before.body.authenticated} canStore=${before.body.canStore}`)

// 2. a bogus token must be rejected and must not be stored
const bogus = await post(action, { action: 'login', token: 'ghp_definitely_not_a_real_token_000' })
console.log(`bad token  => ok=${bogus.body.ok} error=${bogus.body.error}`)
if (bogus.body.ok !== false) { console.log('FAIL: bogus token accepted'); process.exit(1) }
if (store.has('GITHUB_TOKEN')) { console.log('FAIL: bogus token was stored'); process.exit(1) }
console.log('           nothing stored ✓')

// 3. a real token (from the host's gh CLI) must be accepted and stored
const { execFileSync } = await import('node:child_process')
let real = ''
try {
  real = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
} catch { /* no gh on this host */ }

if (!real) {
  console.log('no gh token available to test the positive path; aborting')
  process.exit(0)
}

const good = await post(action, { action: 'login', token: real })
console.log(`good token => ok=${good.body.ok} login=${good.body.result && good.body.result.login} stored=${good.body.result && good.body.result.stored}`)
if (!good.body.ok) process.exit(1)
if (!store.has('GITHUB_TOKEN')) { console.log('FAIL: token not persisted to the credential store'); process.exit(1) }

// 4. the snapshot now reports the account
const after = await post(state, {})
console.log(`after:  authenticated=${after.body.authenticated} login=${after.body.login} repo=${after.body.repo && after.body.repo.fullName}`)

// 5. logout removes it
const out = await post(action, { action: 'logout' })
console.log(`logout  => ok=${out.body.ok} stillStored=${store.has('GITHUB_TOKEN')}`)
if (store.has('GITHUB_TOKEN')) { console.log('FAIL: logout left the token behind'); process.exit(1) }

// 6. no token is echoed back anywhere in the payloads
const leaked = JSON.stringify([before.body, bogus.body, good.body, after.body, out.body]).includes(real.slice(0, 12))
console.log(`token never echoed => ${!leaked}`)
if (leaked) { console.log('FAIL: token leaked into a response'); process.exit(1) }

console.log('\nLOGIN FLOW OK')
