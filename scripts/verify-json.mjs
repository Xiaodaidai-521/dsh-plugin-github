// Check that every tool result is lossless JSON (no `undefined` anywhere),
// which is what DSH validates. Regression guard for
// "tool returned invalid output: value is not lossless JSON".
import { apply } from '../lib/index.js'

const defs = new Map()
apply(
  {
    tools: { register: (d) => { defs.set(d.name, d); return () => {} } },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
    inject: (deps, fn) => { fn({ get: () => undefined }); return () => {} },
  },
  {},
)

const exec = { signal: new AbortController().signal }

function findUndefined(value, path = '<root>') {
  if (value === undefined) return path
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findUndefined(value[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const hit = findUndefined(value[key], `${path}.${key}`)
      if (hit) return hit
    }
    return null
  }
  return null
}

const cases = [
  ['github_list_branches', { repo: 'Xiaodaidai-521/ctf', limit: 10 }],
  ['github_list_pulls', { repo: 'Xiaodaidai-521/ctf', state: 'all', limit: 5 }],
  ['github_list_commits', { repo: 'Xiaodaidai-521/ctf', limit: 3 }],
  ['github_list_files', { repo: 'Xiaodaidai-521/ctf' }],
  ['github_repo_info', { repo: 'Xiaodaidai-521/ctf' }],
]

let bad = 0
for (const [name, args] of cases) {
  try {
    const result = await defs.get(name).execute(args, exec)
    const hit = findUndefined(result)
    if (hit) {
      bad += 1
      console.log(`FAIL  ${name} — undefined at ${hit}`)
    } else {
      console.log(`PASS  ${name} — lossless`)
    }
  } catch (error) {
    bad += 1
    console.log(`FAIL  ${name} — threw: ${String(error && error.message).slice(0, 140)}`)
  }
}

console.log(bad === 0 ? '\nALL TOOL OUTPUTS LOSSLESS' : `\n${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
