// Smoke test for the expanded panel actions against a real repository.
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
  { repository: 'Xiaodaidai-521/ctf' },
)

const action = routes.get('/api/dsh-plugin-github/action')

async function call(payload) {
  const response = await action.fetch(new Request('http://x/api/dsh-plugin-github/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: payload.action, ...payload }),
  }))
  return response.json()
}

const overview = await call({ action: 'overview' })
if (!overview.ok) {
  console.log('overview FAILED:', overview.error)
  process.exit(1)
}
const o = overview.result
const langs = Object.entries(o.languages || {}).sort((a, b) => b[1] - a[1])
const total = langs.reduce((sum, [, bytes]) => sum + bytes, 0) || 1
console.log(`overview: repo=${o.repository} starred=${o.starred}`)
console.log(`  stars=${o.repo.stars} forks=${o.repo.forks} commits=${o.commitCount} tags=${o.tagCount}`)
console.log(`  languages=${langs.slice(0, 3).map(([n, b]) => `${n} ${(b / total * 100).toFixed(1)}%`).join(', ')}`)
console.log(`  contributors=${o.contributors.slice(0, 3).map((c) => c.login).join(', ')} (${o.contributors.length} shown)`)
console.log(`  releases=${o.releases.length}`)
console.log(`  readme=${o.readme ? `${o.readme.path} (${o.readme.content.length} chars)` : 'none'}`)

const issues = await call({ action: 'issues' })
console.log(`\nissues   => ok=${issues.ok} count=${issues.ok ? issues.result.items.length : issues.error}`)
if (issues.ok && issues.result.items[0]) {
  console.log(`  #${issues.result.items[0].number} ${issues.result.items[0].title}`)
}

const runs = await call({ action: 'actions' })
console.log(`\nactions  => ok=${runs.ok} runs=${runs.ok ? runs.result.runs.length : runs.error}`)

// Star must round-trip without changing the end state.
if (o.starred) {
  const unstar = await call({ action: 'star', on: false })
  const restar = await call({ action: 'star', on: true })
  console.log(`\nstar     => unstar ok=${unstar.ok} restar ok=${restar.ok} stars=${restar.ok ? restar.result.stars : '-'}`)
} else {
  console.log('\nstar     => skipped (repo not starred; not changing the account)')
}
