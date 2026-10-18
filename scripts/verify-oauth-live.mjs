// Live check against a real OAuth App client id.
//
//   1. persist the client id through the plugin's own setClientId action
//   2. start a real device flow (proves "Enable Device Flow" is on)
//   3. poll until the user authorizes, then report the account
//
// Run with the real DSH_HOME so the saved id lands in the user's profile data.
import { apply } from '../lib/index.js'

const clientId = process.argv[2]
if (!clientId) {
  console.error('usage: node verify-oauth-live.mjs <client-id>')
  process.exit(2)
}

function mount(config) {
  const routes = new Map()
  const store = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const credentials = {
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref), source: 'live-test' } : undefined },
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

// ---- 1. persist -------------------------------------------------------------
const first = mount({})
const saved = await post(first.routes.get('/api/dsh-plugin-github/action'), {
  action: 'setClientId',
  clientId,
})
console.log(`save client id => ok=${saved.ok}${saved.ok ? '' : ' error=' + saved.error}`)
if (!saved.ok) process.exit(1)

// ---- 2. a fresh instance must read it back ---------------------------------
const second = mount({})
const state = await post(second.routes.get('/api/dsh-plugin-github/state'), {})
console.log(`fresh instance canDeviceFlow = ${state.canDeviceFlow}`)
if (state.canDeviceFlow !== true) process.exit(1)

// ---- 3. start a real device flow -------------------------------------------
const action = second.routes.get('/api/dsh-plugin-github/action')
const started = await post(action, { action: 'loginDeviceStart' })
if (!started.ok) {
  console.log(`device/code FAILED: ${started.error}`)
  console.log('如果提示错误，通常是该 OAuth App 没有勾选 Enable Device Flow。')
  process.exit(1)
}

const { userCode, verificationUri, interval, expiresIn, scopes } = started.result
console.log('')
console.log('==================================================')
console.log(`  请在浏览器打开：${verificationUri}`)
console.log(`  输入代码：      ${userCode}`)
console.log(`  （有效期 ${Math.round(expiresIn / 60)} 分钟，请求权限：${scopes}）`)
console.log('==================================================')
console.log('')
console.log('等待授权…（最长 10 分钟，每 ' + interval + ' 秒检查一次）')

// ---- 4. poll to completion --------------------------------------------------
const deadline = Date.now() + Math.min(expiresIn * 1000, 10 * 60 * 1000)
let delay = Math.max(5, Number(interval) || 5) * 1000

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, delay))
  const polled = await post(action, { action: 'loginDevicePoll' })

  if (polled.ok) {
    console.log('')
    console.log(`授权成功 ✓ 账号：${polled.result.login}  持久化：${polled.result.stored}`)
    const after = await post(second.routes.get('/api/dsh-plugin-github/state'), {})
    console.log(`登录后 state：authenticated=${after.authenticated} login=${after.login} repo=${after.repo ? after.repo.fullName : '(需选择)'}`)

    const repos = await post(action, { action: 'repos' })
    if (repos.ok) {
      console.log(`可访问仓库数：${repos.result.items.length}`)
      for (const item of repos.result.items.slice(0, 5)) {
        console.log(`  ${item.private ? '🔒' : '  '} ${item.fullName}`)
      }
    }
    console.log('')
    console.log('LIVE OAUTH OK')
    process.exit(0)
  }

  if (polled.pending) {
    if (polled.interval) delay = Math.max(5, Number(polled.interval)) * 1000
    console.log(`  … 仍在等待（${new Date().toLocaleTimeString()}）`)
    continue
  }

  console.log(`授权失败：${polled.error}`)
  process.exit(1)
}

console.log('超时未授权')
process.exit(1)
