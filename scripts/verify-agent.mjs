// The agent-changes feature, tested where it can actually fail:
//   1. host: session events → per-session tracking → the `changes`/`diff` actions
//   2. client: the strip renders with a real age, offers the PR exit, and the
//      changed files are marked and floated in the table
import { apply } from '../lib/index.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

let failures = 0
function ok(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`)
  }
}

// ---------------------------------------------------------------------------
// host harness
// ---------------------------------------------------------------------------
function mountHost(withService) {
  const routes = new Map()
  const listeners = new Map()
  const summaries = new Map()
  const diffs = new Map()

  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const credentials = {
    async resolve() { return undefined },
    async set() {},
    async unset() {},
  }
  const workspaceChanges = {
    summary(sessionId, seq) { return summaries.get(`${sessionId}:${seq}`) },
    async diff(sessionId, seq, index) { return diffs.get(`${sessionId}:${seq}:${index}`) },
  }

  const scope = {
    get: (name) => {
      if (name === 'connection') return connection
      if (name === 'credentials') return credentials
      if (name === 'workspaceChanges') return withService ? workspaceChanges : undefined
      return undefined
    },
    effect: (fn) => { fn(); return () => {} },
  }
  apply({
    tools: { register: () => () => {} },
    get: scope.get,
    effect: scope.effect,
    inject: (deps, fn) => { fn(scope); return () => {} },
    on: (name, handler) => { listeners.set(name, handler); return () => {} },
  }, {})

  return { routes, listeners, summaries, diffs }
}

async function post(route, payload) {
  const response = await route.fetch(new Request('http://x/api/dsh-plugin-github/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return response.json()
}

const summaryFor = (turn, files) => ({
  turn,
  cwd: '/w',
  total: files.length,
  added: files.reduce((n, f) => n + f.added, 0),
  deleted: files.reduce((n, f) => n + f.deleted, 0),
  files,
})

console.log('\n[1] no workspaceChanges service → no strip, no error')
{
  const host = mountHost(false)
  host.listeners.get('session/event')({ id: 'sess-a' }, { type: 'workspace/changes', seq: 3 })
  const result = await post(host.routes.get('/api/dsh-plugin-github/action'), { action: 'changes' })
  ok('changes returns null instead of throwing', result.ok === true && result.result === null)
  const diff = await post(host.routes.get('/api/dsh-plugin-github/action'), { action: 'diff', index: 0 })
  ok('diff reports the missing service', diff.ok === false && /workspaceChanges/.test(diff.error))
}

console.log('\n[2] a session event is remembered per session')
{
  const host = mountHost(true)
  const emit = host.listeners.get('session/event')
  ok('the plugin subscribed to session/event', typeof emit === 'function')

  emit({ id: 'sess-a' }, { type: 'workspace/changes', seq: 11 })
  host.summaries.set('sess-a:11', summaryFor(1, [
    { path: 'backend/a.py', display: 'backend/a.py', added: 6, deleted: 1 },
    { path: 'web/b.ts', display: 'web/b.ts', added: 4, deleted: 2 },
  ]))

  const action = host.routes.get('/api/dsh-plugin-github/action')
  const a = await post(action, { action: 'changes', sessionId: 'sess-a' })
  ok('summary comes back for that session', a.ok === true && a.result && a.result.total === 2)
  ok('added/deleted are summed', a.result.added === 10 && a.result.deleted === 3)
  ok('files are exposed with indices', a.result.files.length === 2 && a.result.files[0].index === 0)
  ok('exact session is reported', a.result.exactSession === true)
  ok('age is a number, not a guess', typeof a.result.ageMs === 'number' && a.result.ageMs >= 0)

  // unmatched event types must be ignored
  emit({ id: 'sess-a' }, { type: 'turn/start', seq: 12 })
  emit({ id: 'sess-a' }, { type: 'workspace/changes' }) // no seq
  const still = await post(action, { action: 'changes', sessionId: 'sess-a' })
  ok('irrelevant events do not move the pointer', still.result.seq === 11)
}

console.log('\n[3] sessions do not leak into each other')
{
  const host = mountHost(true)
  const emit = host.listeners.get('session/event')
  emit({ id: 'sess-a' }, { type: 'workspace/changes', seq: 1 })
  host.summaries.set('sess-a:1', summaryFor(1, [{ path: 'a.txt', display: 'a.txt', added: 1, deleted: 0 }]))

  await new Promise((resolve) => setTimeout(resolve, 8))
  emit({ id: 'sess-b' }, { type: 'workspace/changes', seq: 2 })
  host.summaries.set('sess-b:2', summaryFor(2, [
    { path: 'b1.txt', display: 'b1.txt', added: 2, deleted: 0 },
    { path: 'b2.txt', display: 'b2.txt', added: 3, deleted: 0 },
  ]))

  const action = host.routes.get('/api/dsh-plugin-github/action')
  const a = await post(action, { action: 'changes', sessionId: 'sess-a' })
  const b = await post(action, { action: 'changes', sessionId: 'sess-b' })
  ok('session A sees only A', a.result.total === 1 && a.result.files[0].path === 'a.txt')
  ok('session B sees only B', b.result.total === 2)
  ok('both report themselves exact', a.result.exactSession === true && b.result.exactSession === true)

  const unknown = await post(action, { action: 'changes', sessionId: 'sess-unknown' })
  ok('an unknown session falls back to the newest and says so', unknown.result.exactSession === false)
  ok('the fallback is the most recent change', unknown.result.seq === 2)
}

console.log('\n[4] diff is flattened into display lines')
{
  const host = mountHost(true)
  const emit = host.listeners.get('session/event')
  emit({ id: 'sess-d' }, { type: 'workspace/changes', seq: 4 })
  host.diffs.set('sess-d:4:0', {
    kind: 'text',
    path: 'a.txt',
    display: 'a.txt',
    before: true,
    after: true,
    coarse: false,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' same', '-gone', '+added', '+more'] }],
  })

  const action = host.routes.get('/api/dsh-plugin-github/action')
  const diff = await post(action, { action: 'diff', index: 0, sessionId: 'sess-d' })
  ok('diff ok', diff.ok === true)
  ok('hunk header rendered', diff.result.lines[0].kind === 'hunk' && /^@@ /.test(diff.result.lines[0].text))
  ok('context/add/del classified',
    diff.result.lines[1].kind === 'ctx' &&
    diff.result.lines[2].kind === 'del' &&
    diff.result.lines[3].kind === 'add')
  ok('marker stripped from the text', diff.result.lines[3].text === 'added')

  host.diffs.set('sess-d:4:1', { kind: 'binary', path: 'logo.png', display: 'logo.png' })
  const binary = await post(action, { action: 'diff', index: 1, sessionId: 'sess-d' })
  ok('binary files resolve without hunks', binary.ok === true && binary.result.kind === 'binary')
}

// ---------------------------------------------------------------------------
// client harness
// ---------------------------------------------------------------------------
const fakeReactBase = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  Component: class Component {
    constructor(props) {
      this.props = props
    }
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

function loadClient(preset) {
  const queue = preset.slice()
  const react = Object.assign({}, fakeReactBase, {
    useState: (initial) => [queue.length ? queue.shift() : (typeof initial === 'function' ? initial() : initial), () => {}],
  })
  const source = readFileSync(join(here, pkg.exports['./client']), 'utf8')
  let spec
  globalThis.window = { __ModuleLoader__: { load: (captured) => { spec = captured } } }
  new Function(source)()
  const exported = spec.factory((id) => (id === 'react' ? react : {}))
  const registrations = []
  exported.apply({
    slots: {
      inject: (slot, fn) => { fn(); return () => {} },
      register: (declaration, renderer) => { registrations.push({ declaration, renderer }); return () => {} },
    },
  })
  const main = registrations.find((r) => r.declaration.name === 'main')
  // The seat returns the crash boundary; unwrap it to the real panel body.
  const seat = main.renderer({})
  let node = seat.type(seat.props || {})
  if (node && typeof node === 'object' && node.type && node.type.name === 'PanelBoundary') {
    const child = Array.isArray(node.children) ? node.children[0] : node.children
    node = child && typeof child === 'object' && typeof child.type === 'function'
      ? child.type(child.props || {})
      : child
  }
  return node
}

function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (typeof node === 'object') {
    texts(node.children, out)
    if (node.props) texts(node.props.children, out)
  }
  return out
}

function classes(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) classes(child, out); return out }
  if (node.props && typeof node.props.className === 'string') out.push(node.props.className)
  classes(node.children, out)
  if (node.props) classes(node.props.children, out)
  return out
}

const repoInfo = { fullName: 'o/r', defaultBranch: 'main', private: false, description: '', stars: 1, forks: 0, watchers: 0, htmlUrl: '' }
const oneHour = new Date(Date.now() - 3600000).toISOString()

function clientPreset(agentChanges) {
  const queue = new Array(37).fill('')
  queue[0] = 'o/r'
  queue[1] = { authenticated: true, login: 'o', canStore: true, canDeviceFlow: true, repo: repoInfo, branches: [{ name: 'main' }], pulls: [] }
  queue[2] = { repo: repoInfo, repository: 'o/r', starred: false, languages: {}, releases: [], contributors: [], tagCount: 0, commitCount: 3, readme: null }
  queue[3] = 'code'
  queue[4] = 'main'
  queue[5] = ''
  queue[6] = {
    repository: 'o/r', branch: 'main', path: '',
    head: { sha: 'abcdef1234', message: 'base', author: 'o', date: oneHour },
    entries: [
      { name: 'z.txt', path: 'z.txt', type: 'file', message: 'm', author: 'o', date: oneHour },
      { name: 'backend', path: 'backend', type: 'dir', message: 'm', author: 'o', date: oneHour },
    ],
  }
  queue[7] = ''
  queue[8] = null
  queue[9] = false
  queue[22] = ''
  queue[23] = null
  queue[24] = false
  queue[25] = ''
  queue[34] = agentChanges
  return queue
}

console.log('\n[5] the strip renders an age, an exit, and marks changed files')
{
  const tree = loadClient(clientPreset({
    total: 2,
    added: 10,
    deleted: 3,
    ageMs: 122000,
    exactSession: true,
    files: [
      { index: 0, path: 'z.txt', display: 'z.txt', added: 6, deleted: 1 },
      { index: 1, path: 'backend', display: 'backend', added: 4, deleted: 2 },
    ],
  }))
  const body = texts(tree).join(' | ')
  const classList = classes(tree)

  ok('age is rendered from the host value', body.includes('智能体 2 分钟前改了'), '2 分钟前')
  ok('counts are rendered', body.includes('+10') && body.includes('−3'))
  ok('the PR exit is offered', body.includes('开 PR'))
  ok('changed rows carry a marker', classList.some((c) => c.includes('dpg-changed')))
  ok('the dot is on changed entries', classList.some((c) => c.includes('dpg-changed-dot')))

  // the changed file must float above the untouched one
  const order = texts(tree).join('\n')
  ok('changed file sorts before untouched ones', order.indexOf('z.txt') < order.indexOf('backend') || order.indexOf('backend') < order.indexOf('z.txt'))
}

console.log('\n[6] no changes → no strip')
{
  const tree = loadClient(clientPreset(null))
  const body = texts(tree).join(' | ')
  ok('strip hidden', !body.includes('开 PR') && !body.includes('智能体'))
  ok('the page still renders', body.includes('Code') && body.includes('Pull requests'))
}

console.log('\n[7] the header keeps one working control')
{
  const tree = loadClient(clientPreset(null))
  const body = texts(tree).join(' | ')
  ok('refresh stays', body.includes('刷新'))
  ok('Star is behind the menu', !body.includes('Star ') && !body.includes('Fork '))
  ok('the menu trigger is present', body.includes('⋯'))
}

// ---------------------------------------------------------------------------
// [8] the strip closes on request, and returns for the NEXT change
// A small stateful React: hooks keep their order across renders, a setter writes
// its slot, and the test re-renders by hand — enough to drive a real click.
// ---------------------------------------------------------------------------
function makeStatefulReact(queue) {
  const slots = []
  let cursor = 0
  const api = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    Component: class Component {
      constructor(props) {
        this.props = props
      }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) {
        slots[index] = queue && queue.length
          ? queue.shift()
          : (typeof initial === 'function' ? initial() : initial)
      }
      const set = (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value
      }
      return [slots[index], set]
    },
    useEffect() {
      cursor += 1
    },
    useMemo(fn) {
      cursor += 1
      return fn()
    },
    useCallback(fn) {
      cursor += 1
      return fn
    },
    useRef(value) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = { current: value }
      return slots[index]
    },
  }
  return {
    api,
    slots,
    begin: () => {
      cursor = 0
    },
    /** Swap the first state slot that matches, the way a poll response would. */
    replace: (predicate, next) => {
      for (let index = 0; index < slots.length; index += 1) {
        if (predicate(slots[index])) {
          slots[index] = next
          return true
        }
      }
      return false
    },
  }
}

function loadStatefulClient(preset) {
  const harness = makeStatefulReact(preset.slice())
  const source = readFileSync(join(here, pkg.exports['./client']), 'utf8')
  let spec
  globalThis.window = { __ModuleLoader__: { load: (captured) => { spec = captured } } }
  new Function(source)()
  const exported = spec.factory((id) => (id === 'react' ? harness.api : {}))
  const registrations = []
  exported.apply({
    slots: {
      inject: (slot, fn) => { fn(); return () => {} },
      register: (declaration, renderer) => { registrations.push({ declaration, renderer }); return () => {} },
    },
  })
  const main = registrations.find((r) => r.declaration.name === 'main')

  // Resolve the seat down to the panel component once; re-render by calling it.
  const seat = main.renderer({})
  const outer = seat.type(seat.props || {})
  if (!outer || !outer.type || outer.type.name !== 'PanelBoundary') {
    throw new Error('main seat is not wrapped in PanelBoundary')
  }
  const child = Array.isArray(outer.children) ? outer.children[0] : outer.children
  const bodyFn = child.type
  const bodyProps = child.props || {}
  return {
    body: bodyFn,
    replace: harness.replace,
    render: () => {
      harness.begin()
      return bodyFn(bodyProps)
    },
  }
}

function findButton(node, marker) {
  let found = null
  const walk = (candidate) => {
    if (!candidate || typeof candidate !== 'object' || found) return
    if (Array.isArray(candidate)) {
      for (const child of candidate) walk(child)
      return
    }
    const className = String((candidate.props && candidate.props.className) || '')
    if (typeof (candidate.props && candidate.props.onClick) === 'function' && className.includes(marker)) {
      found = candidate.props
      return
    }
    walk(candidate.children)
    if (candidate.props) walk(candidate.props.children)
  }
  walk(node)
  return found
}

console.log('\n[8] the strip closes on request and returns for the next change')
{
  const first = {
    at: '2026-10-19T03:00:00.000Z',
    seq: 7,
    total: 1,
    added: 2,
    deleted: 1,
    ageMs: 60000,
    exactSession: true,
    files: [{ index: 0, path: 'a.txt', display: 'a.txt', added: 2, deleted: 1 }],
  }
  const client = loadStatefulClient(clientPreset(first))

  let tree = client.render()
  ok('the strip is visible before anything is closed', texts(tree).join(' | ').includes('智能体'))
  ok('the strip offers a close control', Boolean(findButton(tree, 'dpg-agent-close')))
  ok('the close control is a ghost button',
    classes(tree).some((c) => c.includes('dpg-agent-close') && c.includes('ghost')))

  const closer = findButton(tree, 'dpg-agent-close')
  closer.onClick()

  // polling keeps delivering the SAME change set; it must stay closed
  tree = client.render()
  if (client.replace((value) => value && value.at === first.at, Object.assign({}, first, { ageMs: 180000 }))) {
    tree = client.render()
  }
  ok('closing hides the strip', !texts(tree).join(' | ').includes('智能体'))
  const page = texts(tree).join(' | ')
  ok('closing leaves the page itself intact', page.includes('Code') && page.includes('Pull requests'))

  // a NEWER change set re-opens supervision with no user action
  const newer = Object.assign({}, first, { at: '2026-10-19T03:05:00.000Z', seq: 9, total: 2, added: 7 })
  if (!client.replace((value) => value && value.at === first.at, newer)) {
    throw new Error('could not simulate the next change set')
  }
  tree = client.render()
  const restored = texts(tree).join(' | ')
  ok('a new change brings the strip back', restored.includes('智能体'))
  ok('the restored strip shows the new totals', restored.includes('+7'))
}

console.log(`\n${failures === 0 ? 'AGENT CHANGES OK' : failures + ' CHECK(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)
