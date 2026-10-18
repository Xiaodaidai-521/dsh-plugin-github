// Smoke test for the repository switcher's list action.
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
    body: JSON.stringify(payload),
  }))
  return response.json()
}

const result = await call({ action: 'repos' })
if (!result.ok) {
  console.log('repos FAILED:', result.error)
  process.exit(1)
}

const { login, items } = result.result
console.log(`login = ${login}`)
console.log(`repos = ${items.length}`)
for (const item of items.slice(0, 12)) {
  console.log(`  ${item.private ? '🔒' : '  '} ${item.fullName.padEnd(34)} ${String(item.language || '').padEnd(12)} ${String(item.pushedAt || '').slice(0, 10)}`)
}
const hasCtf = items.some((item) => item.fullName === 'Xiaodaidai-521/ctf')
console.log(`\ncontains Xiaodaidai-521/ctf => ${hasCtf}`)
if (!hasCtf) process.exit(1)
