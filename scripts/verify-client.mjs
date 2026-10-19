/**
 * Faithful self-check for a DSH client bundle.
 *
 * It reproduces what the real module-loader facade does and nothing more:
 *   1. evaluate the file with NO ambient `require` (a bundle that reads one must
 *      fail here exactly as it fails in the browser)
 *   2. hand `require` to the factory as its ARGUMENT
 *   3. require the factory to return a CommonJS-style exports object
 *   4. assert the registered id equals the package name
 *   5. mount the exports against a fake `slots` service
 *
 * A negative control re-runs the pre-fix backup, which must throw — that proves
 * this harness catches the `client-modules: <pkg> import failed` class of bug
 * instead of silently passing it.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// scripts/ lives one level below the package root
const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

/** Modules the browser module table exposes (asar PLATFORM_MODULES). */
const BASELINE = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

/** Build the shimmed `require` the facade would supply. */
function makeRequire(seen, reactImpl) {
  return (id) => {
    seen.push(id)
    if (!BASELINE.has(id)) {
      throw new Error(`module table has no "${id}" — it must be bundled at build time or declared in dsh.client.external`)
    }
    if (id === 'react') return reactImpl || fakeReact
    return {}
  }
}

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${label}\n        ${String(error && error.message ? error.message : error)}`)
  }
}

/** Load one bundle the way the facade does; returns its exports. */
function loadBundle(source, reactImpl) {
  let spec
  globalThis.window = { __ModuleLoader__: { load: (captured) => { spec = captured } } }

  // No parameters: no ambient require, no module/exports. Exactly the browser.
  const run = new Function(source + '\n//# sourceURL=dsh-plugin-github/client.js')
  run()

  if (!spec) throw new Error('bundle did not call window.__ModuleLoader__.load')
  if (typeof spec.factory !== 'function') throw new Error('spec.factory is not a function')

  const seen = []
  const exported = spec.factory(makeRequire(seen, reactImpl))
  return { spec, exported, seen }
}

function assertPluginShape(spec, exported) {
  if (spec.id !== pkg.name) throw new Error(`id "${spec.id}" != package name "${pkg.name}"`)
  if (!exported || typeof exported !== 'object') throw new Error('factory did not return an object')
  if (typeof exported.apply !== 'function') throw new Error('exports.apply is not a function')
  if (!Array.isArray(exported.inject)) throw new Error('exports.inject is not an array')
}

/** Mount against a fake slots service; returns the registrations it made. */
function mount(exported) {
  const registrations = []
  const ctx = {
    slots: {
      inject: (slot, fn) => { fn(); return () => {} },
      register: (declaration, renderer) => {
        registrations.push({ declaration, renderer })
        return () => {}
      },
    },
  }
  exported.apply(ctx)
  return registrations
}

console.log(`\nSelf-check: ${pkg.name} @ ${pkg.version}\n`)

console.log('[1] package declarations')
check('dsh.client.platform is "web"', () => {
  const platform = pkg.dsh?.client?.platform
  if (platform !== 'web') throw new Error(`dsh.client.platform = ${JSON.stringify(platform)}`)
})
check('exports["./client"] declared', () => {
  if (!pkg.exports?.['./client']) throw new Error('package.json exports has no "./client"')
})
check('exports["./client"] file exists on disk', () => {
  const entry = pkg.exports['./client']
  const rel = typeof entry === 'string' ? entry : entry.default
  if (!rel) throw new Error('"./client" has no default path')
  if (!existsSync(join(here, rel))) throw new Error(`missing file: ${rel}`)
})
check('dsh.client.inject is a string array', () => {
  const inject = pkg.dsh?.client?.inject
  if (!Array.isArray(inject) || inject.some((x) => typeof x !== 'string')) {
    throw new Error(`dsh.client.inject = ${JSON.stringify(inject)}`)
  }
})

// ---------------------------------------------------------------- real bundle
console.log('\n[2] client bundle loads under the facade contract')
let loaded = null
check('bundle evaluates with no ambient require', () => {
  const entry = pkg.exports['./client']
  const rel = typeof entry === 'string' ? entry : entry.default
  const source = readFileSync(join(here, rel), 'utf8')

  if (/require\(\s*['"]node:/.test(source)) {
    throw new Error('bundle requires a node: builtin — not available in the browser')
  }

  loaded = loadBundle(source)
  assertPluginShape(loaded.spec, loaded.exported)
})

if (loaded) {
  console.log(`        id = ${loaded.spec.id}`)
  console.log(`        exports = ${Object.keys(loaded.exported).join(', ')}`)
  console.log(`        inject = ${JSON.stringify(loaded.exported.inject)}`)
  console.log(`        require() calls = ${JSON.stringify(loaded.seen)}`)
}

console.log('\n[3] slot seats mount')
check('apply() registers seats without throwing', () => {
  const registrations = mount(loaded.exported)
  if (registrations.length === 0) throw new Error('apply() registered nothing')
  for (const { declaration, renderer } of registrations) {
    if (!declaration || typeof declaration.name !== 'string') throw new Error('a registration has no slot name')
    if (typeof renderer !== 'function') throw new Error(`slot ${declaration.name} has no renderer`)
    console.log(`        seat: ${declaration.name} (${declaration.id || declaration.key || '-'})`)
  }
  const panellist = registrations.find((r) => r.declaration.name === 'sidebar.panellist')
  if (!panellist) throw new Error('no sidebar.panellist seat — the icon would never appear')
  panellist.renderer({ size: 18 })
})

// --------------------------------------------------------------- render smoke
console.log('\n[4] panel renders (shallow)')
check('main slot component executes without throwing', () => {
  const main = mount(loaded.exported).find((r) => r.declaration.name === 'main')
  if (!main) throw new Error('no main seat')
  const element = main.renderer({})
  const component = element && element.type
  if (typeof component !== 'function') throw new Error('main renderer did not produce a component')
  const tree = component()
  if (!tree || typeof tree !== 'object') throw new Error('component produced no element tree')
})

// --------------------------------------------------------------- login screen
console.log('\n[5] sign-in screen renders when unauthenticated')
check('login form is shown for a fresh user', () => {
  const source = readFileSync(join(here, pkg.exports['./client']), 'utf8')
  const anon = loadBundle(source, reactWith([
    '',                                                  // repo
    { authenticated: false, login: null, canStore: true }, // snapshot
  ]))
  const seats = mount(anon.exported)
  const main = seats.find((r) => r.declaration.name === 'main')
  const text = collectText(main.renderer({}).type(), []).join(' | ')

  for (const token of ['Connect to GitHub', 'Personal Access Token', 'Sign in', 'Personal access tokens']) {
    if (!text.includes(token)) throw new Error('login screen missing: ' + token)
  }
  if (text.includes('12 Commits')) throw new Error('login screen leaked the repository page')
})
check('device-code screen renders while authorization is pending', () => {
  const source = readFileSync(join(here, pkg.exports['./client']), 'utf8')
  const queue = new Array(33).fill('')
  queue[0] = ''                       // repo
  queue[1] = { authenticated: false, login: null, canStore: true, canDeviceFlow: true }
  queue[9] = false                    // loading
  queue[29] = { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5 }
  const anon = loadBundle(source, reactWith(queue))
  const seats = mount(anon.exported)
  const main = seats.find((r) => r.declaration.name === 'main')
  const text = collectText(main.renderer({}).type(), []).join(' | ')

  for (const token of ['ABCD-1234', '打开 GitHub 授权页面', '等待授权中']) {
    if (!text.includes(token)) throw new Error('device screen missing: ' + token)
  }
})

check('missing client id explains itself', () => {
  const source = readFileSync(join(here, pkg.exports['./client']), 'utf8')
  const queue = new Array(33).fill('')
  queue[1] = { authenticated: false, login: null, canStore: true, canDeviceFlow: false }
  queue[9] = false
  const anon = loadBundle(source, reactWith(queue))
  const main = mount(anon.exported).find((r) => r.declaration.name === 'main')
  const text = collectText(main.renderer({}).type(), []).join(' | ')
  if (!text.includes('未配置 OAuth App client_id')) throw new Error('missing client-id guidance')
  if (!text.includes('Personal Access Token')) throw new Error('PAT fallback not offered')
  // the setup affordances must be on screen, not hidden in a config file
  if (!text.includes('创建 OAuth App')) throw new Error('no link to create the OAuth App')
  if (!text.includes('保存 Client ID')) throw new Error('no in-UI client id save button')
})
// --------------------------------------------------------------- deep render
console.log('\n[5] authenticated page renders (state injected)')

const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString()

/** React whose useState pops preset values, so a second render sees real state. */
function reactWith(preset) {
  const queue = preset.slice()
  return Object.assign({}, fakeReact, {
    useState: (initial) => [queue.length ? queue.shift() : (typeof initial === 'function' ? initial() : initial), () => {}],
  })
}

function collectText(node, out) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object') {
    if (node.children) for (const child of node.children) collectText(child, out)
    if (node.props && node.props.children) collectText(node.props.children, out)
  }
  return out
}

const repoInfo = {
  fullName: 'Xiaodaidai-521/ctf',
  defaultBranch: 'main',
  private: false,
  description: '',
  stars: 1,
  forks: 1,
  watchers: 0,
  htmlUrl: 'https://github.com/Xiaodaidai-521/ctf',
}
const overviewFixture = {
  repo: repoInfo,
  repository: repoInfo.fullName,
  starred: false,
  languages: { Python: 1000, Vue: 380, JavaScript: 20 },
  releases: [],
  contributors: [{ login: 'Xiaodaidai-521', avatarUrl: '', contributions: 9 }],
  tagCount: 0,
  commitCount: 12,
  readme: null,
}
const listingFixture = {
  repository: repoInfo.fullName,
  branch: 'main',
  path: '',
  head: { sha: '42dd39c0000000000000000000000000000000', message: 'Merge pull request #4', author: 'Xiaodaidai-521', date: oneHourAgo },
  entries: [
    { name: 'backend', path: 'backend', type: 'dir', message: 'chore: remove debug scripts', author: 'x', date: oneHourAgo },
    { name: '.gitignore', path: '.gitignore', type: 'file', message: 'Update platform', author: 'x', date: oneHourAgo },
  ],
}

check('code page renders with repo state', () => {
  const source = readFileSync(join(here, pkg.exports['./client']), 'utf8')
  const deep = loadBundle(source, reactWith([
    repoInfo.fullName,              // repo
    { authenticated: true, login: 'Xiaodaidai-521', repo: repoInfo, branches: [{ name: 'main' }], pulls: [] }, // snapshot
    overviewFixture,                // overview
    'code',                         // tab
    'main',                         // branch
    '',                             // path
    listingFixture,                 // listing
    '',                             // filter
    null,                           // file
    false,                          // loading
    '',                             // busy
    '',                             // error
    '',                             // notice
    '', '', '', '', '', '',         // newBranch .. prBody
    '', '', null,                   // upPath, upMessage, upFile
    '',                             // form
    [                               // repos (switcher list)
      { fullName: 'Xiaodaidai-521/ctf', owner: 'Xiaodaidai-521', private: false, language: 'Python', pushedAt: oneHourAgo },
      { fullName: 'Xiaodaidai-521/artex-global', owner: 'Xiaodaidai-521', private: false, language: '', pushedAt: oneHourAgo },
    ],
    true,                           // pickerOpen
    '',                             // pickerFilter
  ]))

  const seats = mount(deep.exported)
  const main = seats.find((r) => r.declaration.name === 'main')
  const tree = main.renderer({}).type()
  const text = collectText(tree, []).join(' | ')

  const expected = ['Code', 'Pull requests', 'About', '12 Commits', 'backend', '.gitignore', 'Add a README']
  const missing = expected.filter((token) => !text.includes(token))
  if (missing.length) throw new Error(`missing from rendered page: ${missing.join(', ')}`)

  // the switcher lists the other repositories
  if (!text.includes('artex-global')) throw new Error('repo switcher did not render the repository list')

  // cut surfaces must really be gone
  const removed = ['Issues', 'Actions', 'Projects', 'Wiki', 'Security and quality', 'Insights',
    'Settings', 'Packages', 'Languages', 'Contributors', 'Releases']
  const still = removed.filter((token) => text.includes(token))
  if (still.length) throw new Error(`removed surfaces still render: ${still.join(', ')}`)
})

// ------------------------------------------------- switching repositories
// Regression guard: clicking another repository used to keep `repo` from the
// stale closure, so the browse request carried the PREVIOUS repository and its
// files were painted under the new header.
console.log('\n[6] switching repositories queries the NEW repository')
{
  const source = readFileSync(join(here, pkg.exports['./client']), 'utf8')
  const queue = new Array(35).fill('')
  queue[0] = 'Xiaodaidai-521/ctf'
  queue[1] = {
    authenticated: true,
    login: 'Xiaodaidai-521',
    canStore: true,
    canDeviceFlow: true,
    repo: { fullName: 'Xiaodaidai-521/ctf', defaultBranch: 'main', stars: 1, forks: 0, watchers: 0, private: false, htmlUrl: '' },
    branches: [{ name: 'main' }],
    pulls: [],
  }
  queue[9] = false // loading
  queue[23] = [
    { fullName: 'Xiaodaidai-521/ctf', owner: 'Xiaodaidai-521', private: false, language: 'Python', pushedAt: null },
    { fullName: 'Xiaodaidai-521/dsh-plugin-github', owner: 'Xiaodaidai-521', private: false, language: 'JavaScript', pushedAt: null },
  ]
  queue[24] = true // picker open
  queue[25] = '' // picker filter

  const calls = []
  const previousFetch = globalThis.fetch
  const respond = (data) => ({ ok: true, status: 200, json: async () => data })
  globalThis.fetch = async (url, init) => {
    const payload = init && init.body ? JSON.parse(init.body) : {}
    calls.push({ url: String(url), payload })
    if (String(url).includes('/state')) {
      const repo = payload.repo || 'Xiaodaidai-521/ctf'
      return respond({
        authenticated: true,
        login: 'Xiaodaidai-521',
        repo: { fullName: repo, defaultBranch: 'main', stars: 0, forks: 0, watchers: 0, private: false, htmlUrl: '' },
        branches: [{ name: 'main' }],
        pulls: [],
      })
    }
    if (payload.action === 'browse') {
      return respond({ ok: true, result: { repository: payload.repo, branch: payload.branch, path: payload.path || '', entries: [], head: null } })
    }
    if (payload.action === 'overview') {
      return respond({ ok: true, result: { repo: { fullName: payload.repo, stars: 0, forks: 0, watchers: 0, description: '' }, languages: {}, releases: [], contributors: [], tagCount: 0, commitCount: 0, readme: null } })
    }
    return respond({ ok: true })
  }

  try {
    const deep = loadBundle(source, reactWith(queue))
    const main = mount(deep.exported).find((r) => r.declaration.name === 'main')
    const tree = main.renderer({}).type()

    // find the picker row for the second repository and click it
    let target = null
    const walk = (node) => {
      if (!node || typeof node !== 'object' || target) return
      if (Array.isArray(node)) {
        for (const child of node) walk(child)
        return
      }
      const props = node.props || {}
      if (typeof props.onClick === 'function' && String(props.className || '').includes('dpg-picker-item')) {
        const text = collectText(node, []).join(' ')
        if (text.includes('dsh-plugin-github')) target = props
        return
      }
      walk(node.children)
      walk(props.children)
    }
    walk(tree)
    if (!target) throw new Error('could not find the other repository in the picker')

    target.onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))

    const browses = calls.filter((c) => c.payload.action === 'browse')
    if (browses.length === 0) throw new Error('clicking a repository issued no browse request')
    const wanted = browses.filter((c) => c.payload.repo === 'Xiaodaidai-521/dsh-plugin-github')
    if (wanted.length === 0) {
      throw new Error(`browse used the wrong repository: ${JSON.stringify(browses.map((c) => c.payload.repo))}`)
    }
    console.log(`        browse targets after switch: ${JSON.stringify(wanted.map((c) => c.payload.repo))}`)
  } finally {
    globalThis.fetch = previousFetch
  }
}
// --------------------------------------------------------------- negative control
console.log('\n[5] negative control (a broken backup must be rejected)')
const libDir = join(here, 'lib')
const backups = existsSync(libDir) ? readdirSync(libDir).filter((f) => f.startsWith('client.js.bak-')).sort() : []

if (backups.length === 0) {
  console.log('  SKIP  no client.js.bak-* found')
} else {
  const rejected = []
  const accepted = []
  for (const name of backups) {
    try {
      loadBundle(readFileSync(join(libDir, name), 'utf8'))
      accepted.push(name)
    } catch (error) {
      rejected.push({ name, reason: String(error && error.message).split('\n')[0] })
    }
  }
  check('at least one historical bundle is rejected (harness has teeth)', () => {
    if (rejected.length === 0) {
      throw new Error('every backup loaded cleanly — this harness would not catch a broken bundle')
    }
  })
  for (const item of rejected) console.log(`        rejected ${item.name}: ${item.reason}`)
  for (const item of accepted) console.log(`        accepted ${item} (already fixed)`)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)
