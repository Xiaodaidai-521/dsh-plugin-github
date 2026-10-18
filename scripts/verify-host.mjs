// Verification harness: exercises the host routes and the client bundle shape.
import { apply } from '../lib/index.js'

const routes = new Map()
const tools = new Map()

const fakeConnection = {
  fetch: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}

const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
  get: (name) => (name === 'connection' ? fakeConnection : undefined),
  effect: (fn, label) => { fn(); return () => {} },
  inject: (deps, fn) => { fn(ctx); return () => {} },
}

apply(ctx, {})

console.log('tools =', tools.size)
console.log('routes =', [...routes.keys()].join(', '))

// Hit the state route as the browser would.
const stateRoute = routes.get('/api/dsh-plugin-github/state')
const stateRes = await stateRoute.fetch(new Request('http://x/api/dsh-plugin-github/state', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repo: 'octocat/Hello-World' }),
}))
const state = await stateRes.json()
console.log('state.authenticated =', state.authenticated, '| login =', state.login)
console.log('state.repo =', state.repo && state.repo.fullName, '| branches =', state.branches.length, '| pulls =', state.pulls.length)
console.log('state.branches[0] =', JSON.stringify(state.branches[0]))
console.log('state.pulls[0] =', state.pulls[0] && ('#' + state.pulls[0].number + ' ' + state.pulls[0].title))

// Unknown action handling
const actionRoute = routes.get('/api/dsh-plugin-github/action')
const bad = await (await actionRoute.fetch(new Request('http://x/go', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'nope' }),
}))).json()
console.log('unknown action =>', JSON.stringify(bad))

// listFiles action (read-only, real API)
const files = await (await actionRoute.fetch(new Request('http://x/go', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'listFiles', repo: 'octocat/Hello-World' }),
}))).json()
console.log('listFiles =>', files.ok, JSON.stringify((files.result && files.result.entries || []).map((e) => e.path)))
