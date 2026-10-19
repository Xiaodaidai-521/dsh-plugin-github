/**
 * dsh-plugin-github — GitHub integration for DeepSeek Harness.
 *
 * Host half: registers a set of `ctx.tools` tools that talk to the GitHub REST
 * API v3 (and the Git Data API for atomic multi-file commits).
 *
 * Capabilities
 *   • inspect a repository and its branches
 *   • create branches from any existing ref
 *   • list / read / open / inspect pull requests
 *   • browse, read, upload and delete files
 *   • commit several files atomically in one commit
 *   • list commits
 *
 * Authentication: resolved per call from the DSH credentials service
 * (`GITHUB_TOKEN` by default), then the process environment, then `gh auth
 * token`. Nothing is cached across calls, so a rotated token reaches the next
 * operation without a restart.
 */

import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-plugin-github'

/** Hard dependency: the tool registry. Everything else is resolved optionally. */
export const inject = ['tools']

const DEFAULT_API_URL = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The plugin's own public OAuth App client id. A client id is not a secret, so
 * it ships here to make one-click sign-in work with no setup. A deployment can
 * point at its own app through the plugin config, GITHUB_OAUTH_CLIENT_ID, or
 * the value saved from the sign-in screen — all of those win over this.
 */
const DEFAULT_OAUTH_CLIENT_ID = 'Ov23liALtslm2dfnOjfO'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  return {
    /** "owner/repo" used when a tool call omits `repo`. */
    repository: typeof c.repository === 'string' && c.repository.trim() ? c.repository.trim() : undefined,
    /** Environment variable / credential name holding the token. */
    tokenEnv: typeof c.tokenEnv === 'string' && c.tokenEnv.trim() ? c.tokenEnv.trim() : 'GITHUB_TOKEN',
    /** REST base URL (GitHub Enterprise support). */
    apiUrl: typeof c.apiUrl === 'string' && c.apiUrl.trim() ? c.apiUrl.trim().replace(/\/+$/, '') : DEFAULT_API_URL,
    /**
     * OAuth App client id for the device flow. Public, not a secret — ship the
     * same value to every user of the plugin.
     */
    oauthClientId: (() => {
      const fromConfig = typeof c.oauthClientId === 'string' && c.oauthClientId.trim() ? c.oauthClientId.trim() : ''
      if (fromConfig) return fromConfig
      const fromEnv = process.env.GITHUB_OAUTH_CLIENT_ID
      return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : undefined
    })(),
    /**
     * Scopes requested by the device flow. workflow is included because
     * writing a file under .github/workflows/ without it returns 404.
     */
    oauthScopes:
      typeof c.oauthScopes === 'string' && c.oauthScopes.trim()
        ? c.oauthScopes.trim()
        : 'repo read:user read:org workflow',
  }
}

// ---------------------------------------------------------------------------
// Plugin-owned settings (only the public OAuth client id lives here)
// ---------------------------------------------------------------------------

/**
 * Where this plugin keeps its own small settings file. Under DSH_HOME when the
 * host exposes it, so it sits beside the rest of the user's harness data.
 */
function pluginDataDir() {
  const home = process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || process.cwd()
  return join(home, 'storages', 'dsh-plugin-github')
}

function readStoredClientId() {
  try {
    const parsed = JSON.parse(readFileSync(join(pluginDataDir(), 'config.json'), 'utf8'))
    return typeof parsed.oauthClientId === 'string' && parsed.oauthClientId.trim()
      ? parsed.oauthClientId.trim()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Token persisted by an explicit panel sign-in.
 *
 * The value is encrypted with AES-256-GCM under a key derived from the machine
 * and the current user, so copying the file to another account or another
 * machine does not yield a usable token. This is **not** a substitute for a
 * secret store: anyone who can already run code as this user can re-derive the
 * key. It removes the "readable secret lying on disk" case, nothing more.
 */
function tokenFile() {
  return join(pluginDataDir(), 'token.json')
}

const TOKEN_FILE_VERSION = 2
let cachedKey = null

function tokenKey() {
  if (cachedKey) return cachedKey
  const material = [
    'dsh-plugin-github/token/v2',
    hostname(),
    (() => {
      try {
        return userInfo().username
      } catch {
        return ''
      }
    })(),
    process.platform,
    process.env.USERDOMAIN || '',
  ].join('|')
  // Fixed salt: the key must be stable across restarts, not unique per file.
  cachedKey = scryptSync(material, 'dsh-plugin-github/token-salt', 32)
  return cachedKey
}

function encryptToken(token) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv)
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return {
    v: TOKEN_FILE_VERSION,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function decryptToken(record) {
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(record.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(record.data, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

function readStoredToken() {
  try {
    const parsed = JSON.parse(readFileSync(tokenFile(), 'utf8'))

    // v2: encrypted. A wrong machine/user, or a tampered file, fails the GCM
    // tag check and reads as "no token" rather than as a corrupt one.
    if (parsed && parsed.v === TOKEN_FILE_VERSION && typeof parsed.data === 'string') {
      try {
        const token = decryptToken(parsed)
        return token.trim() ? token.trim() : undefined
      } catch {
        return undefined
      }
    }

    // v1: a plaintext `{ token }` left by an older build; still readable, and
    // rewritten encrypted on the next successful sign-in.
    return typeof parsed.token === 'string' && parsed.token.trim() ? parsed.token.trim() : undefined
  } catch {
    return undefined
  }
}

function writeStoredToken(token) {
  try {
    mkdirSync(pluginDataDir(), { recursive: true })
    writeFileSync(tokenFile(), JSON.stringify(encryptToken(token)), { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* best effort: the credential service may already hold it */
  }
}

function clearStoredToken() {
  try {
    rmSync(tokenFile(), { force: true })
  } catch {
    /* nothing stored */
  }
}

function writeStoredClientId(clientId) {
  const dir = pluginDataDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ oauthClientId: clientId }, null, 2), 'utf8')
}

/**
 * Resolve the effective OAuth client id, re-reading the saved value when the
 * config/env did not provide one. Called per request so a client id saved from
 * the sign-in screen takes effect immediately, with no restart.
 */
function ensureClientId(cfg) {
  if (!cfg.oauthClientId) {
    const stored = readStoredClientId()
    if (stored) cfg.oauthClientId = stored
  }
  if (!cfg.oauthClientId) cfg.oauthClientId = DEFAULT_OAUTH_CLIENT_ID
  return cfg.oauthClientId
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Token supplied through the panel's login form during this process. It exists
 * so a host whose credential store is not writable still works for the rest of
 * the session; the durable copy lives in the DSH credentials service when it
 * accepts one. Never serialized into any response.
 */
let runtimeToken = null

/** Set by an explicit sign-out: the env / gh fallbacks must not sneak back in. */
let fallbacksSuppressed = false

/**
 * A device-flow authorization in progress: the polling secret never leaves the
 * host, the browser only ever sees the short user code.
 */
let deviceFlow = null

const OAUTH_ORIGIN = 'https://github.com'

/** POST to GitHub's OAuth endpoints (github.com, not api.github.com). */
async function oauthPost(path, params) {
  const response = await fetch(`${OAUTH_ORIGIN}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { ok: response.ok, status: response.status, data }
}

/**
 * Resolve the GitHub token. Order:
 *   1. DSH credentials service (login form, env var, managed store, .env)
 *   2. a token entered in the panel during this process
 *   3. process environment (tokenEnv, GITHUB_TOKEN, GH_TOKEN)
 *   4. `gh auth token` when the CLI is installed and logged in — a host-local
 *      convenience only, so another user's machine never depends on it
 */
async function resolveToken(ctx, cfg) {
  const candidates = [cfg.tokenEnv, 'GITHUB_TOKEN', 'GH_TOKEN']

  const credentials = ctx.get('credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    for (const key of candidates) {
      try {
        const resolved = await credentials.resolve(key)
        if (resolved && typeof resolved.value === 'string' && resolved.value.trim()) {
          return { token: resolved.value.trim(), source: `credential:${key}` }
        }
      } catch {
        // Unconfigured references are expected; keep looking.
      }
    }
  }

  if (fallbacksSuppressed) return { token: undefined, source: undefined }

  if (typeof runtimeToken === 'string' && runtimeToken) {
    return { token: runtimeToken, source: 'panel-login' }
  }

  const storedToken = readStoredToken()
  if (storedToken) return { token: storedToken, source: 'panel-login:saved' }

  for (const key of candidates) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) {
      return { token: value.trim(), source: `env:${key}` }
    }
  }

  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (typeof out === 'string' && out.trim()) {
      return { token: out.trim(), source: 'gh-cli' }
    }
  } catch {
    // gh not installed or not logged in.
  }

  return { token: undefined, source: undefined }
}

async function requireToken(ctx, cfg) {
  const { token, source } = await resolveToken(ctx, cfg)
  if (!token) {
    throw new Error(
      'No GitHub token found. Set GITHUB_TOKEN (a Personal Access Token with `repo` scope), ' +
        'or install and log in with the GitHub CLI (`gh auth login`).',
    )
  }
  return { token, source }
}

// ---------------------------------------------------------------------------
// Repository resolution
// ---------------------------------------------------------------------------

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Parse a GitHub remote URL into "owner/repo". */
function parseRemote(url) {
  if (typeof url !== 'string' || !url) return undefined
  const cleaned = url.trim()
  const match =
    /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(cleaned) ||
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(cleaned)
  if (!match) return undefined
  return `${match[1]}/${match[2]}`
}

/** Best-effort inference of the current repository from the local git remote. */
function inferRepoFromGit() {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: process.cwd(),
    })
    return parseRemote(out)
  } catch {
    return undefined
  }
}

function resolveRepo(args, cfg) {
  const explicit = args && typeof args.repo === 'string' ? args.repo.trim() : ''
  const candidate = explicit || cfg.repository || inferRepoFromGit()
  if (!candidate) {
    throw new Error(
      'No repository given. Pass `repo: "owner/name"`, or configure `repository` for this plugin, ' +
        'or run the call from a git checkout with a GitHub `origin` remote.',
    )
  }
  if (!REPO_PATTERN.test(candidate)) {
    throw new Error(`Invalid repository "${candidate}" — expected "owner/name".`)
  }
  return candidate
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function encodePath(path) {
  return String(path)
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * One GitHub REST call. Returns parsed JSON, or `{ ok: true }` shaped text for
 * empty bodies. Throws a readable error for non-2xx responses.
 */
async function githubFetch(ctx, cfg, token, path, { method = 'GET', body, signal } = {}) {
  const url = `${cfg.apiUrl}${path}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-plugin-github',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? 'request aborted or timed out' : String(error && error.message ? error.message : error)
    throw new Error(`GitHub request failed (${method} ${path}): ${reason}`)
  } finally {
    clearTimeout(timeout)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  const text = await response.text()

  if (!response.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.message === 'string') {
        detail = parsed.message
        if (Array.isArray(parsed.errors) && parsed.errors.length) {
          detail += ' — ' + parsed.errors.map((e) => (typeof e === 'string' ? e : e.message || e.code)).filter(Boolean).join('; ')
        }
      }
    } catch {
      // Non-JSON error body; keep the raw text.
    }
    const hint =
      response.status === 401
        ? ' (the token is missing, expired, or lacks the required scope)'
        : response.status === 403
          ? ' (rate limited, or the token lacks permission for this repository)'
          : response.status === 404
            ? ' (not found — check the owner/repo, branch, or file path, and that the token can see it)'
            : ''
    throw new Error(`GitHub API ${response.status} ${response.statusText}${hint}: ${String(detail || '').slice(0, 600)}`)
  }

  if (!text) return { ok: true }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Like `githubFetch`, but keeps the transport facts: status and headers.
 * Needed where a header carries the answer (pagination counts) or where a
 * non-2xx status is itself the result (204/404 for "is this repo starred").
 */
async function githubMeta(ctx, cfg, token, path, { method = 'GET', body, signal } = {}) {
  const url = `${cfg.apiUrl}${path}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-plugin-github',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    const reason =
      error && error.name === 'AbortError'
        ? 'request aborted or timed out'
        : String(error && error.message ? error.message : error)
    throw new Error(`GitHub request failed (${method} ${path}): ${reason}`)
  } finally {
    clearTimeout(timeout)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  return { ok: response.ok, status: response.status, headers: response.headers, data }
}

/** Read `rel="last"` out of a Link header — the total when `per_page=1`. */
function lastPageFromLink(link) {
  if (typeof link !== 'string') return null
  const match = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link)
  return match ? Number(match[1]) : null
}

// ---------------------------------------------------------------------------
// Output plumbing
// ---------------------------------------------------------------------------

/** Build a ToolOutputDefinition rendering pretty JSON as a text block. */
function jsonResult(schema, summary) {
  return {
    schema,
    render(args, value) {
      if (summary) {
        const lines = summary(args, value)
        if (lines) return [{ type: 'text', text: lines }]
      }
      return [{ type: 'text', text: '```json\n' + JSON.stringify(value, null, 2) + '\n```' }]
    },
  }
}

function base64Encode(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

function base64Decode(b64) {
  return Buffer.from(String(b64).replace(/\n/g, ''), 'base64').toString('utf8')
}

// ---------------------------------------------------------------------------
// Small shape helpers
// ---------------------------------------------------------------------------

function branchView(branch) {
  const commit = branch && branch.commit ? branch.commit : {}
  return {
    name: branch && branch.name,
    sha: commit.sha,
    protected: branch ? branch.protected === true : undefined,
    message: commit.commit && commit.commit.message ? String(commit.commit.message).split('\n')[0] : undefined,
    author: commit.commit && commit.commit.author ? commit.commit.author.name : undefined,
    date: commit.commit && commit.commit.author ? commit.commit.author.date : undefined,
  }
}

function pullView(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.merged_at ? 'merged' : pr.state,
    draft: pr.draft === true,
    author: pr.user ? pr.user.login : undefined,
    head: pr.head ? pr.head.ref : undefined,
    headSha: pr.head ? pr.head.sha : undefined,
    base: pr.base ? pr.base.ref : undefined,
    mergeable: pr.mergeable,
    merged: pr.merged === true,
    htmlUrl: pr.html_url,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    body: typeof pr.body === 'string' ? pr.body : '',
  }
}

function fileView(entry) {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    size: entry.size,
    sha: entry.sha,
    downloadUrl: entry.download_url,
    htmlUrl: entry.html_url,
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const cfg = readConfig(config)

  // A client id saved from the sign-in screen outlives restarts; the plugin
  // config and the environment stay the higher-precedence sources.
  if (!cfg.oauthClientId) {
    const stored = readStoredClientId()
    if (stored) cfg.oauthClientId = stored
  }

  // ---- parameter fragments ------------------------------------------------

  const repoParam = {
    type: 'string',
    description: 'Repository as "owner/name". Omit to use the configured default or the local git origin.',
  }

  const tokenHint =
    'Requires a GitHub token (GITHUB_TOKEN with `repo` scope). If you get a 401/403, tell the user to configure one.'

  // ---- tool registry ------------------------------------------------------

  /** Tool name -> definition, so the browser routes can reuse the same logic. */
  const defs = new Map()
  const tool = (definition) => {
    // DSH validates a tool result as lossless JSON: one property whose value is
    // `undefined` invalidates the whole result ("value is not lossless JSON").
    // Strip them centrally rather than asking every tool to omit them.
    const execute = definition.execute
    const wrapped = {
      ...definition,
      execute: async (args, exec) => stripUndefined(await execute(args, exec)),
    }
    defs.set(wrapped.name, wrapped)
    ctx.tools.register(wrapped)
  }

  // ---- tools --------------------------------------------------------------

  /** 1. auth status */
  tool({
    name: 'github_auth_status',
    description:
      'Report whether a GitHub token is available and which account it belongs to. Call this first if other GitHub tools fail with 401/403. ' +
      tokenHint,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          authenticated: { type: 'boolean' },
          login: { type: 'string' },
          name: { type: 'string' },
          source: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          apiUrl: { type: 'string' },
        },
      },
      (args, value) =>
        value && value.authenticated
          ? `GitHub authenticated as **${value.login}** (token from ${value.source}).`
          : 'GitHub is **not** authenticated: no token found.',
    ),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { token, source } = await resolveToken(ctx, cfg)
      if (!token) {
        return { authenticated: false, apiUrl: cfg.apiUrl }
      }
      const user = await githubFetch(ctx, cfg, token, '/user', { signal: exec.signal })
      return {
        authenticated: true,
        login: user && user.login,
        name: user && (user.name || user.login),
        source,
        apiUrl: cfg.apiUrl,
      }
    },
  })

  /** 2. repository info */
  tool({
    name: 'github_repo_info',
    description: 'Get metadata for a GitHub repository: default branch, visibility, description, stars, forks and URL.',
    parameters: {
      type: 'object',
      properties: { repo: repoParam },
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          fullName: { type: 'string' },
          defaultBranch: { type: 'string' },
          private: { type: 'boolean' },
          description: { type: 'string' },
          stars: { type: 'number' },
          forks: { type: 'number' },
          watchers: { type: 'number' },
          openIssues: { type: 'number' },
          htmlUrl: { type: 'string' },
          permissions: { type: 'object' },
        },
      },
      (args, value) =>
        `**${value.fullName}** — default branch \`${value.defaultBranch}\`, ${value.private ? 'private' : 'public'}, ` +
        `★ ${value.stars}, forks ${value.forks}. ${value.htmlUrl}`,
    ),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const data = await githubFetch(ctx, cfg, token, `/repos/${repo}`, { signal: exec.signal })
      return {
        fullName: data.full_name,
        defaultBranch: data.default_branch,
        private: data.private === true,
        description: data.description || '',
        stars: data.stargazers_count,
        forks: data.forks_count,
        watchers: data.subscribers_count || 0,
        openIssues: data.open_issues_count,
        htmlUrl: data.html_url,
        permissions: data.permissions,
      }
    },
  })

  /** 3. list branches */
  tool({
    name: 'github_list_branches',
    description:
      'List the branches of a repository, newest commit first. Use this to see what branches exist before creating one or opening a pull request.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        limit: { type: 'number', description: 'Maximum branches to return (1-100, default 30).' },
      },
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          total: { type: 'number' },
          branches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                sha: { type: 'string' },
                protected: { type: 'boolean' },
                message: { type: 'string' },
                author: { type: 'string' },
                date: { type: 'string' },
              },
            },
          },
        },
      },
      (args, value) =>
        value.total === 0
          ? `No branches found in ${value.repository}.`
          : `${value.total} branch(es) in ${value.repository}:\n` +
            value.branches.map((b) => `- \`${b.name}\` (${b.sha ? b.sha.slice(0, 7) : '?'})${b.protected ? ' — protected' : ''}`).join('\n'),
    ),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const limit = clampLimit(args && args.limit, 30)
      const data = await githubFetch(ctx, cfg, token, `/repos/${repo}/branches?per_page=${limit}`, { signal: exec.signal })
      const branches = Array.isArray(data) ? data.map(branchView) : []
      return { repository: repo, total: branches.length, branches }
    },
  })

  /** 4. create branch */
  tool({
    name: 'github_create_branch',
    description:
      'Create a new branch in a repository, starting from an existing branch (default: the repository default branch). ' +
      'Returns the new branch SHA. Fails if the branch already exists.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        branch: { type: 'string', description: 'Name of the branch to create, e.g. "feat/login".' },
        from: { type: 'string', description: 'Existing branch or commit SHA to start from. Default: the default branch.' },
      },
      required: ['branch'],
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          branch: { type: 'string' },
          from: { type: 'string' },
          sha: { type: 'string' },
          htmlUrl: { type: 'string' },
        },
      },
      (args, value) => `Created branch \`${value.branch}\` in ${value.repository} from \`${value.from}\` at ${value.sha.slice(0, 7)}.`,
    ),
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const branch = requireString(args && args.branch, 'branch')

      let from = args && typeof args.from === 'string' && args.from.trim() ? args.from.trim() : undefined
      if (!from) {
        const info = await githubFetch(ctx, cfg, token, `/repos/${repo}`, { signal: exec.signal })
        from = info && info.default_branch
        if (!from) throw new Error(`Could not determine the default branch of ${repo}.`)
      }

      // Resolve the source to a commit SHA (accepts a branch name or a SHA).
      let sha = from
      try {
        const ref = await githubFetch(ctx, cfg, token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(from)}`, {
          signal: exec.signal,
        })
        const remoteSha = ref && ref.object ? ref.object.sha : undefined
        if (remoteSha) sha = remoteSha
      } catch {
        // `from` may already be a commit SHA — GitHub validates it below.
      }

      const created = await githubFetch(ctx, cfg, token, `/repos/${repo}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha },
        signal: exec.signal,
      })

      return {
        repository: repo,
        branch,
        from,
        sha: created && created.object ? created.object.sha : sha,
        htmlUrl: `https://github.com/${repo}/tree/${encodeURIComponent(branch)}`,
      }
    },
  })

  /** 5. list pull requests */
  tool({
    name: 'github_list_pulls',
    description:
      'List pull requests for a repository. Filter by state (open, closed, all) and optionally by head or base branch.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default: open.' },
        head: { type: 'string', description: 'Filter by head branch (owner:branch accepted).' },
        base: { type: 'string', description: 'Filter by base branch.' },
        limit: { type: 'number', description: 'Maximum results (1-100, default 20).' },
      },
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          total: { type: 'number' },
          pulls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                number: { type: 'number' },
                title: { type: 'string' },
                state: { type: 'string' },
                draft: { type: 'boolean' },
                author: { type: 'string' },
                head: { type: 'string' },
                base: { type: 'string' },
                htmlUrl: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
      (args, value) =>
        value.total === 0
          ? `No pull requests found in ${value.repository}.`
          : `${value.total} pull request(s) in ${value.repository}:\n` +
            value.pulls
              .map((p) => `- #${p.number} ${p.title} — \`${p.head}\` → \`${p.base}\` [${p.state}${p.draft ? ', draft' : ''}]`)
              .join('\n'),
    ),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const state = args && typeof args.state === 'string' ? args.state : 'open'
      const limit = clampLimit(args && args.limit, 20)
      const params = new URLSearchParams({ state, per_page: String(limit) })
      if (args && typeof args.head === 'string' && args.head.trim()) params.set('head', args.head.trim())
      if (args && typeof args.base === 'string' && args.base.trim()) params.set('base', args.base.trim())

      const data = await githubFetch(ctx, cfg, token, `/repos/${repo}/pulls?${params}`, { signal: exec.signal })
      const pulls = Array.isArray(data) ? data.map(pullView) : []
      return { repository: repo, total: pulls.length, pulls }
    },
  })

  /** 6. get one pull request */
  tool({
    name: 'github_get_pull',
    description: 'Read one pull request in full: title, body, branches, mergeability, draft/merged state and URL.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['number'],
      additionalProperties: false,
    },
    output: jsonResult({
      type: 'object',
      properties: {
        number: { type: 'number' },
        title: { type: 'string' },
        state: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        mergeable: { type: 'boolean' },
        htmlUrl: { type: 'string' },
      },
    }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const number = requireNumber(args && args.number, 'number')
      const data = await githubFetch(ctx, cfg, token, `/repos/${repo}/pulls/${number}`, { signal: exec.signal })
      return pullView(data)
    },
  })

  /** 7. create pull request */
  tool({
    name: 'github_create_pull',
    description:
      'Open a pull request. The head branch must already exist (create it with github_create_branch first). ' +
      'Returns the PR number and URL.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Source branch (owner:branch allowed for cross-fork PRs).' },
        base: { type: 'string', description: 'Target branch. Default: the repository default branch.' },
        body: { type: 'string', description: 'Pull request description (Markdown).' },
        draft: { type: 'boolean', description: 'Open as a draft pull request.' },
      },
      required: ['title', 'head'],
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          number: { type: 'number' },
          title: { type: 'string' },
          head: { type: 'string' },
          base: { type: 'string' },
          draft: { type: 'boolean' },
          htmlUrl: { type: 'string' },
        },
      },
      (args, value) => `Opened pull request #${value.number} — **${value.title}** (${value.head} → ${value.base}). ${value.htmlUrl}`,
    ),
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const title = requireString(args && args.title, 'title')
      const head = requireString(args && args.head, 'head')

      let base = args && typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined
      if (!base) {
        const info = await githubFetch(ctx, cfg, token, `/repos/${repo}`, { signal: exec.signal })
        base = info && info.default_branch
        if (!base) throw new Error(`Could not determine the default branch of ${repo}.`)
      }

      const body = {
        title,
        head,
        base,
        ...(typeof args.body === 'string' ? { body: args.body } : {}),
        ...(args.draft === true ? { draft: true } : {}),
      }

      const data = await githubFetch(ctx, cfg, token, `/repos/${repo}/pulls`, {
        method: 'POST',
        body,
        signal: exec.signal,
      })

      return {
        repository: repo,
        number: data.number,
        title: data.title,
        head: data.head ? data.head.ref : head,
        base: data.base ? data.base.ref : base,
        draft: data.draft === true,
        htmlUrl: data.html_url,
      }
    },
  })

  /** 8. list files */
  tool({
    name: 'github_list_files',
    description:
      'List the files and directories at a path in a repository (or the repository root when path is omitted). ' +
      'Uses the contents API, so it does not need a local clone.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        path: { type: 'string', description: 'Directory path inside the repository. Default: root.' },
        ref: { type: 'string', description: 'Branch, tag or commit SHA. Default: the default branch.' },
      },
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          path: { type: 'string' },
          ref: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                type: { type: 'string' },
                size: { type: 'number' },
                sha: { type: 'string' },
                htmlUrl: { type: 'string' },
              },
            },
          },
        },
      },
      (args, value) =>
        value.entries.length === 0
          ? `No entries at \`${value.path || '/'}\` in ${value.repository}.`
          : `${value.entries.length} entr(ies) at \`${value.path || '/'}\` in ${value.repository} (${value.ref || 'default branch'}):\n` +
            value.entries.map((e) => `- ${e.type === 'dir' ? '📁' : '📄'} \`${e.path}\`${e.size ? ` (${e.size} B)` : ''}`).join('\n'),
    ),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const path = args && typeof args.path === 'string' ? args.path : ''
      const ref = args && typeof args.ref === 'string' && args.ref.trim() ? args.ref.trim() : undefined

      const query = new URLSearchParams()
      if (ref) query.set('ref', ref)
      const suffix = query.toString() ? `?${query}` : ''
      const target = path ? `/repos/${repo}/contents/${encodePath(path)}${suffix}` : `/repos/${repo}/contents${suffix}`

      const data = await githubFetch(ctx, cfg, token, target, { signal: exec.signal })
      const entries = (Array.isArray(data) ? data : [data]).filter(Boolean).map(fileView)

      return { repository: repo, path, ref: ref || '', entries }
    },
  })

  /** 9. read file */
  tool({
    name: 'github_read_file',
    description: 'Read a text file from a repository without cloning it. Returns the decoded UTF-8 content.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        path: { type: 'string', description: 'File path inside the repository.' },
        ref: { type: 'string', description: 'Branch, tag or commit SHA. Default: the default branch.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          path: { type: 'string' },
          ref: { type: 'string' },
          sha: { type: 'string' },
          size: { type: 'number' },
          content: { type: 'string' },
        },
      },
      (args, value) => `\`${value.path}\` in ${value.repository}:\n\n\`\`\`\n${value.content}\n\`\`\``,
    ),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const path = requireString(args && args.path, 'path')
      const ref = args && typeof args.ref === 'string' && args.ref.trim() ? args.ref.trim() : undefined

      const query = new URLSearchParams()
      if (ref) query.set('ref', ref)
      const suffix = query.toString() ? `?${query}` : ''
      const data = await githubFetch(ctx, cfg, token, `/repos/${repo}/contents/${encodePath(path)}${suffix}`, {
        signal: exec.signal,
      })

      if (Array.isArray(data)) throw new Error(`\`${path}\` is a directory — use github_list_files.`)
      const content = data.encoding === 'base64' && typeof data.content === 'string' ? base64Decode(data.content) : ''

      return { repository: repo, path: data.path || path, ref: ref || '', sha: data.sha, size: data.size, content }
    },
  })

  /** 10. upload (create or update) a file */
  tool({
    name: 'github_upload_file',
    description:
      'Create or update a single file in a repository via the contents API — this is the "upload" operation. ' +
      'Provide `content` as text (default) or base64. When updating an existing file, its current sha is fetched ' +
      'automatically unless you pass `sha`.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        path: { type: 'string', description: 'Destination file path inside the repository.' },
        content: { type: 'string', description: 'File content.' },
        encoding: { type: 'string', enum: ['text', 'base64'], description: 'How `content` is encoded. Default: text.' },
        message: { type: 'string', description: 'Commit message. Default: "Upload <path>".' },
        branch: { type: 'string', description: 'Target branch. Default: the repository default branch.' },
        sha: { type: 'string', description: 'Existing blob sha — required by GitHub only when replacing without lookup.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          path: { type: 'string' },
          branch: { type: 'string' },
          operation: { type: 'string' },
          commitSha: { type: 'string' },
          htmlUrl: { type: 'string' },
        },
      },
      (args, value) =>
        `${value.operation === 'created' ? 'Created' : 'Updated'} \`${value.path}\` on \`${value.branch}\` in ${value.repository} ` +
        `(commit ${String(value.commitSha || '').slice(0, 7)}).`,
    ),
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const path = requireString(args && args.path, 'path')
      const rawContent = typeof args.content === 'string' ? args.content : undefined
      if (rawContent === undefined) throw new Error('`content` is required.')
      const encoding = args && args.encoding === 'base64' ? 'base64' : 'utf8'
      const branch = args && typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined
      const message =
        args && typeof args.message === 'string' && args.message.trim() ? args.message.trim() : `Upload ${path}`

      // Look up an existing blob so updates do not fail with 422 "sha wasn't supplied".
      let sha = args && typeof args.sha === 'string' && args.sha.trim() ? args.sha.trim() : undefined
      let existed = false
      if (!sha) {
        try {
          const q = branch ? `?ref=${encodeURIComponent(branch)}` : ''
          const existing = await githubFetch(ctx, cfg, token, `/repos/${repo}/contents/${encodePath(path)}${q}`, {
            signal: exec.signal,
          })
          if (existing && !Array.isArray(existing) && existing.sha) {
            sha = existing.sha
            existed = true
          }
        } catch {
          // 404 means the file does not exist yet — a plain create.
        }
      } else {
        existed = true
      }

      const body = {
        message,
        content: encoding === 'base64' ? rawContent.replace(/\s+/g, '') : base64Encode(rawContent),
        ...(sha ? { sha } : {}),
        ...(branch ? { branch } : {}),
      }

      const data = await githubFetch(ctx, cfg, token, `/repos/${repo}/contents/${encodePath(path)}`, {
        method: 'PUT',
        body,
        signal: exec.signal,
      })

      return {
        repository: repo,
        path,
        branch: branch || '',
        operation: existed ? 'updated' : 'created',
        commitSha: data && data.commit ? data.commit.sha : undefined,
        htmlUrl: data && data.content ? data.content.html_url : undefined,
      }
    },
  })

  /** 11. delete a file */
  tool({
    name: 'github_delete_file',
    description: 'Delete a file from a repository. The file sha is looked up automatically when not supplied.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        path: { type: 'string', description: 'File path to delete.' },
        message: { type: 'string', description: 'Commit message. Default: "Delete <path>".' },
        branch: { type: 'string', description: 'Target branch. Default: the repository default branch.' },
        sha: { type: 'string', description: 'Existing blob sha. Looked up automatically when omitted.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          path: { type: 'string' },
          branch: { type: 'string' },
          commitSha: { type: 'string' },
        },
      },
      (args, value) => `Deleted \`${value.path}\` on \`${value.branch || 'default branch'}\` in ${value.repository} (commit ${String(value.commitSha || '').slice(0, 7)}).`,
    ),
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const path = requireString(args && args.path, 'path')
      const branch = args && typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined
      const message =
        args && typeof args.message === 'string' && args.message.trim() ? args.message.trim() : `Delete ${path}`

      let sha = args && typeof args.sha === 'string' && args.sha.trim() ? args.sha.trim() : undefined
      if (!sha) {
        const q = branch ? `?ref=${encodeURIComponent(branch)}` : ''
        const existing = await githubFetch(ctx, cfg, token, `/repos/${repo}/contents/${encodePath(path)}${q}`, {
          signal: exec.signal,
        })
        if (Array.isArray(existing)) throw new Error(`\`${path}\` is a directory — the contents API cannot delete directories.`)
        sha = existing && existing.sha
        if (!sha) throw new Error(`Could not determine the sha of \`${path}\`.`)
      }

      const data = await githubFetch(ctx, cfg, token, `/repos/${repo}/contents/${encodePath(path)}`, {
        method: 'DELETE',
        body: { message, sha, ...(branch ? { branch } : {}) },
        signal: exec.signal,
      })

      return {
        repository: repo,
        path,
        branch: branch || '',
        commitSha: data && data.commit ? data.commit.sha : undefined,
      }
    },
  })

  /** 12. atomic multi-file commit (Git Data API) */
  tool({
    name: 'github_commit',
    description:
      'Commit several files to one branch in a SINGLE atomic commit using the Git Data API (more reliable than one ' +
      'contents-API call per file). Each change is `{ path, content }` to write or `{ path, delete: true }` to remove. ' +
      'The branch is updated to the new commit; the branch must already exist.',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        branch: { type: 'string', description: 'Branch to commit to.' },
        message: { type: 'string', description: 'Commit message.' },
        changes: {
          type: 'array',
          description: 'Files to write or delete.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              encoding: { type: 'string', enum: ['text', 'base64'] },
              delete: { type: 'boolean' },
            },
            required: ['path'],
          },
        },
      },
      required: ['branch', 'message', 'changes'],
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          branch: { type: 'string' },
          commitSha: { type: 'string' },
          commitUrl: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
      (args, value) =>
        `Committed ${value.files.length} file change(s) to \`${value.branch}\` in ${value.repository} as ${String(value.commitSha).slice(0, 7)}.`,
    ),
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const branch = requireString(args && args.branch, 'branch')
      const message = requireString(args && args.message, 'message')
      const changes = Array.isArray(args && args.changes) ? args.changes : []
      if (changes.length === 0) throw new Error('`changes` must contain at least one entry.')

      // 1. Current head of the branch.
      const ref = await githubFetch(ctx, cfg, token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
        signal: exec.signal,
      })
      const headSha = ref && ref.object ? ref.object.sha : undefined
      if (!headSha) throw new Error(`Could not resolve branch \`${branch}\` in ${repo}.`)

      // 2. Base tree of that commit.
      const headCommit = await githubFetch(ctx, cfg, token, `/repos/${repo}/git/commits/${headSha}`, { signal: exec.signal })
      const baseTree = headCommit && headCommit.tree ? headCommit.tree.sha : undefined
      if (!baseTree) throw new Error(`Could not resolve the tree of commit ${headSha}.`)

      // 3. One blob per written file.
      const tree = []
      const touched = []
      for (const change of changes) {
        const path = requireString(change && change.path, 'changes[].path')
        touched.push(path)
        if (change && change.delete === true) {
          tree.push({ path, mode: '100644', type: 'blob', sha: null })
          continue
        }
        const content = typeof change.content === 'string' ? change.content : ''
        const blob = await githubFetch(ctx, cfg, token, `/repos/${repo}/git/blobs`, {
          method: 'POST',
          body: {
            content: change.encoding === 'base64' ? content.replace(/\s+/g, '') : content,
            encoding: change.encoding === 'base64' ? 'base64' : 'utf-8',
          },
          signal: exec.signal,
        })
        tree.push({ path, mode: '100644', type: 'blob', sha: blob && blob.sha })
      }

      // 4. New tree over the base.
      const newTree = await githubFetch(ctx, cfg, token, `/repos/${repo}/git/trees`, {
        method: 'POST',
        body: { base_tree: baseTree, tree },
        signal: exec.signal,
      })

      // 5. New commit.
      const newCommit = await githubFetch(ctx, cfg, token, `/repos/${repo}/git/commits`, {
        method: 'POST',
        body: { message, tree: newTree && newTree.sha, parents: [headSha] },
        signal: exec.signal,
      })
      const newSha = newCommit && newCommit.sha
      if (!newSha) throw new Error('GitHub did not return a commit sha.')

      // 6. Fast-forward the branch.
      await githubFetch(ctx, cfg, token, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: { sha: newSha, force: false },
        signal: exec.signal,
      })

      return {
        repository: repo,
        branch,
        commitSha: newSha,
        commitUrl: `https://github.com/${repo}/commit/${newSha}`,
        files: touched,
      }
    },
  })

  /** 13. list commits */
  tool({
    name: 'github_list_commits',
    description: 'List recent commits on a branch (default: the repository default branch).',
    parameters: {
      type: 'object',
      properties: {
        repo: repoParam,
        branch: { type: 'string', description: 'Branch, tag or SHA. Default: the default branch.' },
        path: { type: 'string', description: 'Only commits touching this path.' },
        limit: { type: 'number', description: 'Maximum commits (1-100, default 20).' },
      },
      additionalProperties: false,
    },
    output: jsonResult(
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          branch: { type: 'string' },
          commits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sha: { type: 'string' },
                message: { type: 'string' },
                author: { type: 'string' },
                date: { type: 'string' },
                htmlUrl: { type: 'string' },
              },
            },
          },
        },
      },
      (args, value) =>
        `${value.commits.length} commit(s) on \`${value.branch || 'default branch'}\` in ${value.repository}:\n` +
        value.commits.map((c) => `- ${String(c.sha).slice(0, 7)} ${c.message} — ${c.author} (${c.date})`).join('\n'),
    ),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { token } = await requireToken(ctx, cfg)
      const repo = resolveRepo(args, cfg)
      const limit = clampLimit(args && args.limit, 20)
      const params = new URLSearchParams({ per_page: String(limit) })
      if (args && typeof args.branch === 'string' && args.branch.trim()) params.set('sha', args.branch.trim())
      if (args && typeof args.path === 'string' && args.path.trim()) params.set('path', args.path.trim())

      const data = await githubFetch(ctx, cfg, token, `/repos/${repo}/commits?${params}`, { signal: exec.signal })
      const commits = (Array.isArray(data) ? data : []).map((item) => ({
        sha: item.sha,
        message: item.commit && item.commit.message ? String(item.commit.message).split('\n')[0] : '',
        author: item.commit && item.commit.author ? item.commit.author.name : item.author ? item.author.login : undefined,
        date: item.commit && item.commit.author ? item.commit.author.date : undefined,
        htmlUrl: item.html_url,
      }))

      return {
        repository: repo,
        branch: args && typeof args.branch === 'string' ? args.branch : '',
        commits,
      }
    },
  })

  // ---- browser panel routes ----------------------------------------------

  /**
   * The panel is a browser module served by the web app, so it talks to this
   * host half over two plain POST routes. Registration is optional: a headless
   * profile has no connection service, and the tools keep working there.
   */
  const registerPanelRoutes = (scope) => {
    const connection = scope.get('connection')
    const registerRoute =
      connection && connection.fetch && typeof connection.fetch.register === 'function'
        ? connection.fetch.register.bind(connection.fetch)
        : undefined
    if (!registerRoute) return

    const call = async (toolName, args) => {
      const definition = defs.get(toolName)
      if (!definition) throw new Error(`Unknown tool: ${toolName}`)
      return definition.execute(args, { signal: new AbortController().signal })
    }

    const jsonResponse = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })

    const readJson = async (request) => {
      try {
        return (await request.json()) || {}
      } catch {
        return {}
      }
    }

    /**
     * Keep a validated token.
     *
     * Both destinations are written on purpose. The credential store is the
     * primary one, but it is owned by the host and can be reset by a profile
     * rebuild or an app update — and when that happened this plugin silently
     * became "signed out" after a day. The encrypted file is the independent
     * copy that survives it.
     */
    const persistToken = async (candidate) => {
      let stored = false
      const credentials = ctx.get('credentials')
      if (credentials && typeof credentials.set === 'function') {
        try {
          await credentials.set('GITHUB_TOKEN', candidate)
          stored = true
        } catch {
          stored = false
        }
      }
      runtimeToken = candidate
      fallbacksSuppressed = false
      writeStoredToken(candidate)
      return stored
    }

    // Snapshot for the panel: auth + repository + branches + open pull requests.
    scope.effect(
      () =>
        registerRoute({
          path: '/api/dsh-plugin-github/state',
          methods: ['POST'],
          requestBody: 'buffered',
          async fetch(request) {
            const body = await readJson(request)
            const repoArg = typeof body.repo === 'string' && body.repo.trim() ? { repo: body.repo.trim() } : {}

            const out = {
              authenticated: false,
              login: null,
              source: null,
              apiUrl: cfg.apiUrl,
              // Whether a token entered in the panel can be stored durably.
              canStore: (() => {
                const credentials = ctx.get('credentials')
                return !!(credentials && typeof credentials.set === 'function')
              })(),
              // Whether "Sign in with GitHub" (device flow) is available here.
              canDeviceFlow: !!ensureClientId(cfg),
              repo: null,
              branches: [],
              pulls: [],
              error: null,
            }

            let authFailure = null
            try {
              const auth = await call('github_auth_status', {})
              out.authenticated = auth.authenticated === true
              out.login = auth.login || null
              out.source = auth.source || null
            } catch (error) {
              authFailure = String(error && error.message ? error.message : error)
              out.error = authFailure
              // A stored token GitHub rejects can never succeed again: drop it
              // everywhere and let the panel ask for a fresh sign-in instead of
              // failing forever.
              if (/GitHub API 401|Bad credentials|token 无效/i.test(authFailure)) {
                if (readStoredToken()) clearStoredToken()
                const credentials = ctx.get('credentials')
                if (credentials && typeof credentials.unset === 'function') {
                  try {
                    await credentials.unset('GITHUB_TOKEN')
                  } catch {
                    /* nothing stored, or read-only */
                  }
                }
                runtimeToken = null
                out.reauthRequired = true
              }
            }

            // One line of evidence per snapshot, emitted before ANY early
            // return so a failure is never invisible. Never prints the token.
            try {
              console.log(
                '[dsh-plugin-github] state ' +
                  JSON.stringify({
                    authenticated: out.authenticated,
                    source: out.source,
                    dataDir: pluginDataDir(),
                    tokenFile: existsSync(tokenFile()),
                    canStore: out.canStore,
                    canDevice: out.canDeviceFlow,
                    authFailure,
                    error: out.error || null,
                  }),
              )
            } catch {
              /* diagnostics must never break the route */
            }

            if (!out.authenticated) return jsonResponse(out)

            try {
              out.repo = await call('github_repo_info', repoArg)
            } catch (error) {
              out.error = String(error && error.message ? error.message : error)
              return jsonResponse(out)
            }

            try {
              const branches = await call('github_list_branches', { ...repoArg, limit: 100 })
              out.branches = branches.branches
            } catch (error) {
              out.branchError = String(error && error.message ? error.message : error)
            }

            try {
              const pulls = await call('github_list_pulls', { ...repoArg, state: 'open', limit: 50 })
              out.pulls = pulls.pulls
            } catch (error) {
              out.pullError = String(error && error.message ? error.message : error)
            }

            return jsonResponse(out)
          },
        }),
      'dsh-plugin-github: panel state route',
    )

    // Write actions triggered from the panel.
    scope.effect(
      () =>
        registerRoute({
          path: '/api/dsh-plugin-github/action',
          methods: ['POST'],
          requestBody: 'buffered',
          async fetch(request) {
            const body = await readJson(request)
            const action = typeof body.action === 'string' ? body.action : ''
            const repoArg = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : undefined

            try {
              switch (action) {
                case 'createBranch': {
                  const result = await call('github_create_branch', {
                    repo: repoArg,
                    branch: body.branch,
                    from: body.from || undefined,
                  })
                  return jsonResponse({ ok: true, result })
                }
                case 'createPull': {
                  const result = await call('github_create_pull', {
                    repo: repoArg,
                    title: body.title,
                    head: body.head,
                    base: body.base || undefined,
                    body: body.body || undefined,
                    draft: body.draft === true,
                  })
                  return jsonResponse({ ok: true, result })
                }
                case 'uploadFile': {
                  const result = await call('github_upload_file', {
                    repo: repoArg,
                    path: body.path,
                    content: body.content,
                    encoding: body.encoding === 'base64' ? 'base64' : 'text',
                    message: body.message || undefined,
                    branch: body.branch || undefined,
                  })
                  return jsonResponse({ ok: true, result })
                }
                case 'listFiles': {
                  const result = await call('github_list_files', {
                    repo: repoArg,
                    path: body.path || '',
                    ref: body.ref || undefined,
                  })
                  return jsonResponse({ ok: true, result })
                }
                case 'browse': {
                  // One repository directory, rendered like GitHub's file table:
                  // every entry carries the last commit that touched it.
                  const branch = body.branch || undefined
                  const path = typeof body.path === 'string' ? body.path.replace(/^\/+|\/+$/g, '') : ''

                  const listing = await call('github_list_files', {
                    repo: repoArg,
                    path,
                    ref: branch,
                  })
                  const entries = Array.isArray(listing.entries) ? listing.entries : []

                  const lastCommits = await Promise.all(
                    entries.slice(0, 30).map(async (entry) => {
                      try {
                        const commits = await call('github_list_commits', {
                          repo: repoArg,
                          branch,
                          path: entry.path,
                          limit: 1,
                        })
                        return (commits.commits && commits.commits[0]) || null
                      } catch {
                        return null
                      }
                    }),
                  )

                  const withHistory = entries.map((entry, index) => {
                    const commit = lastCommits[index]
                    return commit
                      ? {
                          ...entry,
                          message: commit.message,
                          author: commit.author,
                          date: commit.date,
                        }
                      : entry
                  })

                  // Directories first, then files, each alphabetical — GitHub's order.
                  withHistory.sort((a, b) => {
                    const aDir = a.type === 'dir' ? 0 : 1
                    const bDir = b.type === 'dir' ? 0 : 1
                    if (aDir !== bDir) return aDir - bDir
                    return String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' })
                  })

                  let head = null
                  try {
                    const commits = await call('github_list_commits', { repo: repoArg, branch, limit: 1 })
                    head = (commits.commits && commits.commits[0]) || null
                  } catch {
                    head = null
                  }

                  return jsonResponse({
                    ok: true,
                    result: {
                      repository: listing.repository,
                      branch: branch || '',
                      path,
                      entries: withHistory,
                      head,
                    },
                  })
                }
                case 'file': {
                  const result = await call('github_read_file', {
                    repo: repoArg,
                    path: body.path,
                    ref: body.branch || undefined,
                  })
                  return jsonResponse({ ok: true, result })
                }
                case 'setClientId': {
                  // Save the OAuth App's public client id from the sign-in screen
                  // so the user never has to edit a config file by hand.
                  const candidate = typeof body.clientId === 'string' ? body.clientId.trim() : ''
                  if (!/^[A-Za-z0-9._-]{10,}$/.test(candidate)) {
                    return jsonResponse({
                      ok: false,
                      error: 'Client ID 看起来不正确：应为 GitHub OAuth App 页面上的那一串字母数字（约 20 位）。',
                    })
                  }
                  try {
                    writeStoredClientId(candidate)
                  } catch (error) {
                    return jsonResponse({
                      ok: false,
                      error: `无法保存 Client ID：${String(error && error.message ? error.message : error)}`,
                    })
                  }
                  cfg.oauthClientId = candidate
                  return jsonResponse({ ok: true, result: { clientId: candidate } })
                }
                case 'loginDeviceStart': {
                  // GitHub's device flow: no Personal Access Token to create by
                  // hand. Needs an OAuth App client id (public, not a secret).
                  const clientId = ensureClientId(cfg)
                  if (!clientId) {
                    return jsonResponse({
                      ok: false,
                      needsClientId: true,
                      error:
                        '未配置 OAuth App client_id。请在插件配置里填写 oauthClientId（或设置环境变量 GITHUB_OAUTH_CLIENT_ID）；也可以继续用 Personal Access Token 登录。',
                    })
                  }

                  const started = await oauthPost('/login/device/code', {
                    client_id: clientId,
                    scope: cfg.oauthScopes,
                  })
                  const data = started.data || {}
                  if (!started.ok || !data.device_code) {
                    return jsonResponse({
                      ok: false,
                      error: data.error_description || data.error || `device/code HTTP ${started.status}`,
                    })
                  }

                  deviceFlow = {
                    deviceCode: data.device_code,
                    clientId,
                    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
                    interval: Number(data.interval) || 5,
                  }

                  return jsonResponse({
                    ok: true,
                    result: {
                      userCode: data.user_code,
                      verificationUri: data.verification_uri || 'https://github.com/login/device',
                      expiresIn: Number(data.expires_in) || 900,
                      interval: deviceFlow.interval,
                      scopes: cfg.oauthScopes,
                    },
                  })
                }
                case 'loginDevicePoll': {
                  if (!deviceFlow) {
                    return jsonResponse({ ok: false, error: '没有进行中的设备授权，请重新发起登录' })
                  }
                  if (Date.now() > deviceFlow.expiresAt) {
                    deviceFlow = null
                    return jsonResponse({ ok: false, error: '授权码已过期，请重新发起登录' })
                  }

                  const polled = await oauthPost('/login/oauth/access_token', {
                    client_id: deviceFlow.clientId,
                    device_code: deviceFlow.deviceCode,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                  })
                  const data = polled.data || {}

                  if (data.access_token) {
                    deviceFlow = null
                    const probe = await githubMeta(ctx, cfg, data.access_token, '/user')
                    if (!probe.ok) {
                      return jsonResponse({ ok: false, error: '授权成功但读取账号失败，请重试' })
                    }
                    const stored = await persistToken(data.access_token)
                    return jsonResponse({
                      ok: true,
                      result: { login: probe.data ? probe.data.login : null, stored },
                    })
                  }

                  if (data.error === 'authorization_pending') {
                    return jsonResponse({ ok: false, pending: true, interval: deviceFlow.interval })
                  }
                  if (data.error === 'slow_down') {
                    deviceFlow.interval = deviceFlow.interval + 5
                    return jsonResponse({ ok: false, pending: true, interval: deviceFlow.interval })
                  }

                  deviceFlow = null
                  return jsonResponse({
                    ok: false,
                    error:
                      data.error === 'expired_token'
                        ? '授权码已过期，请重新发起登录'
                        : data.error === 'access_denied'
                          ? '授权被拒绝'
                          : data.error_description || data.error || '授权失败',
                  })
                }
                case 'loginDeviceCancel': {
                  deviceFlow = null
                  return jsonResponse({ ok: true, result: { cancelled: true } })
                }
                case 'login': {
                  // Panel sign-in: validate the token against GitHub before
                  // storing it, so a typo never becomes the saved credential.
                  const candidate = typeof body.token === 'string' ? body.token.trim() : ''
                  if (!candidate) {
                    return jsonResponse({ ok: false, error: '请输入 GitHub Personal Access Token' }, 400)
                  }

                  const probe = await githubMeta(ctx, cfg, candidate, '/user')
                  if (!probe.ok) {
                    const reason =
                      probe.status === 401
                        ? 'token 无效、已过期，或已被撤销'
                        : probe.status === 403
                          ? 'token 被拒绝（可能已过期或被限制）'
                          : `GitHub API ${probe.status}`
                    return jsonResponse({ ok: false, error: reason })
                  }

                  const who = probe.data && probe.data.login ? probe.data.login : null
                  // Same persistence path as the device flow: durable store
                  // when possible, encrypted file otherwise, in-memory always.
                  const stored = await persistToken(candidate)
                  return jsonResponse({ ok: true, result: { login: who, stored } })
                }
                case 'logout': {
                  runtimeToken = null
                  fallbacksSuppressed = true
                  clearStoredToken()
                  const credentials = ctx.get('credentials')
                  if (credentials && typeof credentials.unset === 'function') {
                    try {
                      await credentials.unset('GITHUB_TOKEN')
                    } catch {
                      /* nothing stored, or not writable */
                    }
                  }
                  return jsonResponse({ ok: true, result: { loggedOut: true } })
                }
                case 'changes': {
                  // What the session's agent changed most recently. Delegated to
                  // the host's workspaceChanges service, which already keeps the
                  // summaries and the before/after snapshots.
                  const service = ctx.get('workspaceChanges')
                  if (!service) return jsonResponse({ ok: true, result: null })

                  // Prefer the session the panel says it is showing; fall back to
                  // the newest change, and say how old it is so the UI never has
                  // to claim "just now" when it cannot know that.
                  const requested = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null
                  const entry = (requested && changeTracker.get(requested)) || latestChange()
                  if (!entry) return jsonResponse({ ok: true, result: null })

                  let summary = null
                  try {
                    summary = service.summary(entry.sessionId, entry.seq)
                  } catch {
                    summary = null
                  }
                  if (!summary) return jsonResponse({ ok: true, result: null })
                  return jsonResponse({
                    ok: true,
                    result: {
                      at: entry.at,
                      ageMs: Date.now() - entry.at,
                      exactSession: !!requested && requested === entry.sessionId,
                      sessionId: entry.sessionId,
                      seq: entry.seq,
                      turn: summary.turn,
                      total: summary.total,
                      added: summary.added,
                      deleted: summary.deleted,
                      files: (summary.files || []).slice(0, 12).map((file, index) => ({
                        index,
                        path: file.path,
                        display: file.display || file.path,
                        added: file.added,
                        deleted: file.deleted,
                        binary: file.binary === true,
                        oversized: file.oversized === true,
                      })),
                    },
                  })
                }
                case 'diff': {
                  const service = ctx.get('workspaceChanges')
                  if (!service) return jsonResponse({ ok: false, error: 'workspaceChanges 服务不可用' })
                  const requestedDiff = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null
                  const diffEntry = (requestedDiff && changeTracker.get(requestedDiff)) || latestChange()
                  if (!diffEntry) return jsonResponse({ ok: false, error: '没有可用的改动记录' })
                  const index = typeof body.index === 'number' ? body.index : -1
                  if (index < 0) return jsonResponse({ ok: false, error: 'index 缺失' })
                  let diff = null
                  try {
                    diff = await service.diff(diffEntry.sessionId, diffEntry.seq, index, new AbortController().signal)
                  } catch (error) {
                    return jsonResponse({ ok: false, error: String(error && error.message ? error.message : error) })
                  }
                  if (!diff) return jsonResponse({ ok: false, error: '该文件没有可比较的内容' })
                  if (diff.kind !== 'text') {
                    return jsonResponse({ ok: true, result: { kind: diff.kind, path: diff.path, lines: [] } })
                  }
                  // Flatten hunks into display lines so the browser does no work.
                  const lines = []
                  for (const hunk of diff.hunks) {
                    lines.push({ kind: 'hunk', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` })
                    for (const line of hunk.lines) {
                      const marker = line.slice(0, 1)
                      if (marker === '+' || marker === '-' || marker === ' ') {
                        lines.push({ kind: marker === '+' ? 'add' : marker === '-' ? 'del' : 'ctx', text: line.slice(1) })
                      } else {
                        // Some producers omit the marker; keep the text intact.
                        lines.push({ kind: 'ctx', text: line })
                      }
                    }
                  }
                  return jsonResponse({
                    ok: true,
                    result: { kind: 'text', path: diff.path, coarse: diff.coarse === true, lines: lines.slice(0, 600) },
                  })
                }
                case 'repos': {
                  // The switcher's data: every repository this token can open,
                  // most recently pushed first.
                  const { token } = await requireToken(ctx, cfg)
                  const meta = await githubMeta(
                    ctx,
                    cfg,
                    token,
                    '/user/repos?sort=pushed&direction=desc&per_page=100&affiliation=owner,collaborator,organization_member',
                  )
                  if (!meta.ok) {
                    return jsonResponse({ ok: false, error: `GitHub API ${meta.status}: 无法读取仓库列表` })
                  }
                  const items = (Array.isArray(meta.data) ? meta.data : []).map((item) => ({
                    fullName: item.full_name,
                    name: item.name,
                    owner: item.owner ? item.owner.login : '',
                    private: item.private === true,
                    description: item.description || '',
                    language: item.language || '',
                    defaultBranch: item.default_branch,
                    pushedAt: item.pushed_at,
                    stars: item.stargazers_count,
                  }))
                  const me = await githubMeta(ctx, cfg, token, '/user')
                  return jsonResponse({
                    ok: true,
                    result: { login: me.ok && me.data ? me.data.login : '', items },
                  })
                }
                case 'overview': {
                  const { token } = await requireToken(ctx, cfg)
                  // Everything the repo page's side rail and README card need,
                  // gathered in one round trip so the panel does not stampede.
                  const safe = async (fn, fallback) => {
                    try {
                      return await fn()
                    } catch {
                      return fallback
                    }
                  }

                  const [info, languages, releases, contributors, tags, commitMeta, readme, starMeta] =
                    await Promise.all([
                      call('github_repo_info', { repo: repoArg }),
                      safe(async () => (await githubMeta(ctx, cfg, token, `/repos/${resolveRepo({ repo: repoArg }, cfg)}/languages`)).data, null),
                      safe(async () => (await githubMeta(ctx, cfg, token, `/repos/${resolveRepo({ repo: repoArg }, cfg)}/releases?per_page=3`)).data, null),
                      safe(async () => (await githubMeta(ctx, cfg, token, `/repos/${resolveRepo({ repo: repoArg }, cfg)}/contributors?per_page=12`)).data, null),
                      safe(async () => (await githubMeta(ctx, cfg, token, `/repos/${resolveRepo({ repo: repoArg }, cfg)}/tags?per_page=1`)).headers, null),
                      safe(async () => (await githubMeta(ctx, cfg, token, `/repos/${resolveRepo({ repo: repoArg }, cfg)}/commits?per_page=1`)).headers, null),
                      safe(async () => (await githubMeta(ctx, cfg, token, `/repos/${resolveRepo({ repo: repoArg }, cfg)}/readme`)).data, null),
                      safe(async () => (await githubMeta(ctx, cfg, token, `/user/starred/${resolveRepo({ repo: repoArg }, cfg)}`)), null),
                    ])

                  const resolvedRepo = resolveRepo({ repo: repoArg }, cfg)

                  return jsonResponse({
                    ok: true,
                    result: {
                      repo: info,
                      repository: resolvedRepo,
                      starred: !!(starMeta && starMeta.status === 204),
                      languages: languages || {},
                      releases: Array.isArray(releases)
                        ? releases.map((release) => ({
                            tag: release.tag_name,
                            name: release.name,
                            publishedAt: release.published_at,
                            htmlUrl: release.html_url,
                          }))
                        : [],
                      contributors: Array.isArray(contributors)
                        ? contributors.map((person) => ({
                            login: person.login,
                            avatarUrl: person.avatar_url,
                            contributions: person.contributions,
                          }))
                        : [],
                      tagCount: lastPageFromLink(tags ? tags.get('link') : null) || 0,
                      commitCount: lastPageFromLink(commitMeta ? commitMeta.get('link') : null) || 0,
                      readme:
                        readme && typeof readme.content === 'string'
                          ? { name: readme.name, path: readme.path, content: base64Decode(readme.content) }
                          : null,
                    },
                  })
                }
                case 'issues': {
                  const { token } = await requireToken(ctx, cfg)
                  const repository = resolveRepo({ repo: repoArg }, cfg)
                  const state = body.state === 'closed' || body.state === 'all' ? body.state : 'open'
                  const meta = await githubMeta(
                    ctx,
                    cfg,
                    token,
                    `/repos/${repository}/issues?state=${state}&per_page=30`,
                  )
                  if (!meta.ok) {
                    return jsonResponse({ ok: false, error: `GitHub API ${meta.status}` })
                  }
                  const items = (Array.isArray(meta.data) ? meta.data : [])
                    .filter((item) => !item.pull_request)
                    .map((item) => ({
                      number: item.number,
                      title: item.title,
                      state: item.state,
                      author: item.user ? item.user.login : '',
                      createdAt: item.created_at,
                      updatedAt: item.updated_at,
                      comments: item.comments,
                      htmlUrl: item.html_url,
                    }))
                  return jsonResponse({ ok: true, result: { repository, state, items } })
                }
                case 'actions': {
                  const { token } = await requireToken(ctx, cfg)
                  const repository = resolveRepo({ repo: repoArg }, cfg)
                  const meta = await githubMeta(ctx, cfg, token, `/repos/${repository}/actions/runs?per_page=10`)
                  if (!meta.ok) {
                    return jsonResponse({ ok: true, result: { repository, runs: [], error: `GitHub API ${meta.status}` } })
                  }
                  const runs = (meta.data && Array.isArray(meta.data.workflow_runs) ? meta.data.workflow_runs : []).map(
                    (run) => ({
                      id: run.id,
                      name: run.name,
                      title: run.display_title,
                      status: run.status,
                      conclusion: run.conclusion,
                      branch: run.head_branch,
                      createdAt: run.created_at,
                      htmlUrl: run.html_url,
                      event: run.event,
                    }),
                  )
                  return jsonResponse({ ok: true, result: { repository, runs } })
                }
                case 'star': {
                  const { token } = await requireToken(ctx, cfg)
                  const repository = resolveRepo({ repo: repoArg }, cfg)
                  const on = body.on !== false
                  const meta = await githubMeta(ctx, cfg, token, `/user/starred/${repository}`, {
                    method: on ? 'PUT' : 'DELETE',
                  })
                  if (!meta.ok) {
                    return jsonResponse({ ok: false, error: `GitHub API ${meta.status}: 无法修改 Star` })
                  }
                  const refreshed = await call('github_repo_info', { repo: repository })
                  return jsonResponse({ ok: true, result: { starred: on, stars: refreshed.stars } })
                }
                case 'fork': {
                  const { token } = await requireToken(ctx, cfg)
                  const repository = resolveRepo({ repo: repoArg }, cfg)
                  const meta = await githubMeta(ctx, cfg, token, `/repos/${repository}/forks`, { method: 'POST' })
                  if (!meta.ok) {
                    return jsonResponse({ ok: false, error: `GitHub API ${meta.status}: fork 失败` })
                  }
                  return jsonResponse({
                    ok: true,
                    result: { fork: meta.data && meta.data.full_name, htmlUrl: meta.data && meta.data.html_url },
                  })
                }
                default:
                  return jsonResponse({ ok: false, error: `Unknown action: ${action || '(empty)'}` }, 400)
              }
            } catch (error) {
              return jsonResponse({ ok: false, error: String(error && error.message ? error.message : error) })
            }
          },
        }),
      'dsh-plugin-github: panel action route',
    )
  }

  // ---- what the agent just changed ----------------------------------------
  // `workspaceChanges` stores one summary per (sessionId, seq); the seq is
  // announced by a session event. Remember the newest one so the panel can ask
  // for it later — that is the difference between a GitHub clone and a panel
  // that knows what the session is doing.
  // One entry per session: a panel that shows another session's edits is worse
  // than one that shows nothing.
  const changeTracker = new Map()

  const latestChange = () => {
    let newest = null
    for (const [sessionId, entry] of changeTracker) {
      if (!newest || entry.at > newest.at) newest = { sessionId, ...entry }
    }
    return newest
  }

  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      try {
        const type = event && typeof event.type === 'string' ? event.type : ''
        if (!/workspace/i.test(type) || !/change/i.test(type)) return
        const seq = typeof event.seq === 'number' ? event.seq : null
        if (!seq) return
        const sessionId = session && session.id ? String(session.id) : null
        if (!sessionId) return
        changeTracker.set(sessionId, { sessionId, seq, at: Date.now() })
      } catch {
        /* the session feed must never be disturbed by an observer */
      }
    })
  }

  if (typeof ctx.inject === 'function') ctx.inject(['connection'], registerPanelRoutes)
  else registerPanelRoutes(ctx)
}

// ---------------------------------------------------------------------------
// Argument validation helpers
// ---------------------------------------------------------------------------

/**
 * Recursively drop `undefined` properties. A tool result must be lossless JSON;
 * a single `undefined` value makes DSH reject the whole result.
 */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = stripUndefined(entry)
    }
    return out
  }
  return value
}

function clampLimit(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(100, Math.max(1, Math.floor(n)))
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`\`${field}\` is required and must be a non-empty string.`)
  return value.trim()
}

function requireNumber(value, field) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`\`${field}\` is required and must be a positive number.`)
  return Math.floor(n)
}
