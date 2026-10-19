/**
 * dsh-plugin-github — client (browser) half.
 *
 * Contract: `window.__ModuleLoader__.load({ id, factory })`, where `require`
 * arrives as the factory ARGUMENT and the factory returns a CommonJS-style
 * exports object. No ambient `require` exists in this scope.
 *
 * The panel reproduces GitHub's repository page: the top nav, the repo header
 * with Watch/Fork/Star, the branch + "Go to file" toolbar, the latest-commit
 * row, the file table, the README card, and the right rail with About,
 * Releases, Packages, Contributors and Languages.
 *
 * Everything comes from the host half's two POST routes; the GitHub token never
 * reaches the browser. No third-party runtime is loaded: the module table only
 * exposes `react` and friends, so an external component library would have to
 * be inlined at build time rather than fetched from a CDN at runtime.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-github',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const PLUGIN_ID = 'dsh-plugin-github'
    const STATE_URL = 'api/dsh-plugin-github/state'
    const ACTION_URL = 'api/dsh-plugin-github/action'
    const LAST_REPO_KEY = 'dsh-plugin-github:last-repo'

    // Survives panel remounts (switching sessions), so a returning user never
    // sees a sign-in flash while the first request is in flight.
    let cachedSnapshot = null

    const CSS = `
.dpg-root { display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.5; }
.dpg-nav { display: flex; align-items: center; gap: 2px; padding: 0 12px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1); overflow-x: auto; }
.dpg-nav-item { display: inline-flex; align-items: center; gap: 6px; padding: 9px 11px;
  font-size: 13px; color: var(--dsw-alias-label-secondary); background: none; border: none;
  border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; }
.dpg-nav-item:hover { color: var(--dsw-alias-label-primary); }
.dpg-nav-item.on { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dpg-nav-item.off { opacity: .45; cursor: default; }
.dpg-count { font-size: 11px; padding: 0 6px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dpg-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px; flex: none; flex-wrap: wrap; }
.dpg-repo-title { display: flex; align-items: baseline; gap: 4px; font-size: 19px; font-weight: 400; }
.dpg-owner { color: var(--dsw-alias-brand-primary); }
.dpg-repo-name { font-weight: 600; }
.dpg-pill { font-size: 11px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dpg-spacer { flex: 1; }
.dpg-btn { display: inline-flex; align-items: center; gap: 5px; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  padding: 4px 10px; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; text-decoration: none; }
.dpg-btn:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dpg-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.dpg-btn.primary:hover { filter: brightness(1.08); }
.dpg-btn.ghost { background: transparent; }
.dpg-btn.on { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.dpg-btn:disabled { opacity: .45; cursor: default; }
.dpg-body { flex: 1; min-height: 0; overflow: auto; padding: 0 16px 20px; }
.dpg-grid { display: grid; grid-template-columns: minmax(0, 1fr) 296px; gap: 24px; align-items: start; }
.dpg-side { display: flex; flex-direction: column; gap: 20px; }
@media (max-width: 1000px) { .dpg-grid { grid-template-columns: minmax(0, 1fr); } .dpg-side { display: none; } }
.dpg-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 0; flex-wrap: wrap; }
.dpg-select, .dpg-input { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 4px 8px; font-size: 12px; outline: none; }
.dpg-select { font-weight: 600; cursor: pointer; }
.dpg-input:focus, .dpg-select:focus { border-color: var(--dsw-alias-brand-primary); }
.dpg-meta { display: inline-flex; align-items: center; gap: 4px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); }
.dpg-search { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.dpg-search .dpg-input { width: 190px; }
.dpg-commit { display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px 6px 0 0; background: var(--dsw-alias-bg-layer-1); }
.dpg-avatar { width: 20px; height: 20px; border-radius: 50%; flex: none; overflow: hidden;
  display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600;
  text-transform: uppercase; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.dpg-avatar img { width: 100%; height: 100%; object-fit: cover; }
.dpg-author { font-weight: 600; }
.dpg-msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dpg-sha { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-secondary); }
.dpg-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dpg-table { border: 1px solid var(--dsw-alias-border-l1); border-top: none; border-radius: 0 0 6px 6px; overflow: hidden; }
.dpg-row { display: grid; grid-template-columns: minmax(160px, 1.15fr) minmax(0, 2fr) 104px; align-items: center;
  gap: 10px; padding: 8px 12px; cursor: pointer; border-top: 1px solid var(--dsw-alias-border-l1); }
.dpg-row:first-child { border-top: none; }
.dpg-row:hover { background: var(--dsw-alias-bg-layer-1); }
.dpg-cell-name { display: flex; align-items: center; gap: 7px; min-width: 0; }
.dpg-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dpg-dir .dpg-name { font-weight: 600; }
.dpg-cell-msg, .dpg-cell-time { color: var(--dsw-alias-label-secondary); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dpg-cell-time { text-align: right; }
.dpg-empty { padding: 22px 12px; color: var(--dsw-alias-label-secondary); text-align: center; }
.dpg-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; overflow: hidden; margin-top: 20px; }
.dpg-card-head { display: flex; align-items: center; gap: 6px; padding: 8px 12px;
  background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-weight: 600; font-size: 12px; }
.dpg-card-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.dpg-field { display: flex; flex-direction: column; gap: 4px; }
.dpg-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dpg-field .dpg-input, .dpg-field textarea { width: 100%; box-sizing: border-box; }
.dpg-row-inline { display: flex; gap: 8px; flex-wrap: wrap; }
.dpg-row-inline > * { flex: 1 1 150px; }
.dpg-readme-empty { padding: 30px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dpg-side-block { border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 16px; }
.dpg-side-block:last-child { border-bottom: none; }
.dpg-side-title { display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.dpg-side-row { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 3px 0; }
.dpg-side-link { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dpg-side-link:hover { text-decoration: underline; }
.dpg-item { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.dpg-item:first-child { border-top: none; }
.dpg-item-title { font-weight: 600; color: var(--dsw-alias-label-primary); text-decoration: none; }
.dpg-item-title:hover { color: var(--dsw-alias-brand-primary); }
.dpg-item-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dpg-tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); flex: none; }
.dpg-tag.draft { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dpg-note { margin-top: 10px; padding: 8px 12px; border-radius: 6px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1); }
.dpg-note.err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dpg-note.ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dpg-code { margin: 0; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 1.55; white-space: pre; overflow: auto;
  background: var(--dsw-alias-bg-layer-1); max-height: 60vh; }
.dpg-crumb { background: none; border: none; padding: 0 2px; cursor: pointer;
  color: var(--dsw-alias-brand-primary); font-size: 13px; }
.dpg-crumb:hover { text-decoration: underline; }
.dpg-crumb.last { color: var(--dsw-alias-label-primary); font-weight: 600; cursor: default; }
.dpg-crumbs { display: flex; align-items: center; flex-wrap: wrap; }

/* ---- refinement layer: calmer spacing, single visual rhythm ---- */
.dpg-root { font-size: 13px; letter-spacing: .1px; }
.dpg-nav { padding: 0 18px; gap: 0; }
.dpg-nav-item { padding: 10px 12px; gap: 7px; font-size: 13px; border-bottom-width: 2px; }
.dpg-nav-item.on { border-bottom-color: var(--dsw-alias-brand-primary); }
.dpg-head { padding: 14px 18px; gap: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dpg-repo-title { font-size: 17px; }
.dpg-owner { color: var(--dsw-alias-label-secondary); }
.dpg-body { padding: 0 18px 24px; }
.dpg-grid { grid-template-columns: minmax(0, 1fr) 280px; gap: 28px; }
.dpg-toolbar { padding: 14px 0 10px; gap: 10px; }
.dpg-toolbar .dpg-btn { height: 28px; }
.dpg-select, .dpg-input { padding: 5px 9px; border-radius: 6px; }
.dpg-commit { padding: 10px 14px; }
.dpg-row { padding: 9px 14px; }
.dpg-row:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent); }
.dpg-table, .dpg-commit, .dpg-card { border-color: var(--dsw-alias-border-l1); }
.dpg-card { margin-top: 24px; }
.dpg-side { gap: 22px; padding-top: 14px; }
.dpg-side-title { font-size: 13px; font-weight: 600; letter-spacing: .2px;
  text-transform: uppercase; color: var(--dsw-alias-label-secondary); margin-bottom: 10px; }
.dpg-side-block { border-bottom: none; padding-bottom: 0; }
.dpg-side-row { padding: 2px 0; }
.dpg-empty { padding: 28px 14px; }
.dpg-note { margin-top: 12px; }

/* rendered markdown (README) */
.dpg-md { padding: 20px 18px; line-height: 1.65; font-size: 13px; }
.dpg-md > *:first-child { margin-top: 0; }
.dpg-md h1 { font-size: 22px; font-weight: 600; margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dpg-md h2 { font-size: 17px; font-weight: 600; margin: 22px 0 10px; padding-bottom: 5px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dpg-md h3 { font-size: 14px; font-weight: 600; margin: 18px 0 8px; }
.dpg-md p { margin: 10px 0; }
.dpg-md ul { margin: 10px 0; padding-left: 20px; }
.dpg-md li { margin: 4px 0; }
.dpg-md a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dpg-md a:hover { text-decoration: underline; }
.dpg-md-inline { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--dsw-alias-bg-layer-2); padding: 1px 5px; border-radius: 4px; }
.dpg-md-code { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; padding: 12px; overflow: auto; font-size: 12px; line-height: 1.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dpg-menu { display: flex; flex-direction: column; gap: 2px; margin: 0 0 12px;
  padding: 6px; width: 200px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.dpg-menu-item { text-align: left; background: none; border: none; border-radius: 6px;
  padding: 7px 10px; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dpg-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dpg-side-desc { margin-bottom: 10px; line-height: 1.6; }
.dpg-italic { font-style: italic; }

/* repo switcher */
.dpg-switch { display: inline-flex; align-items: center; gap: 6px; background: transparent;
  border: 1px solid transparent; border-radius: 6px; padding: 3px 8px 3px 4px; cursor: pointer;
  color: var(--dsw-alias-label-primary); font-size: 17px; }
.dpg-switch:hover { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); }
.dpg-caret { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.dpg-picker-wrap { position: relative; }
.dpg-backdrop { position: fixed; inset: 0; z-index: 30; }
.dpg-picker { position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; width: 380px;
  max-height: 62vh; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.28); overflow: hidden; }
.dpg-picker-head { padding: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dpg-picker-head .dpg-input { width: 100%; box-sizing: border-box; }
.dpg-picker-list { overflow: auto; padding: 6px; }
.dpg-picker-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-radius: 7px; cursor: pointer; }
.dpg-picker-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dpg-picker-item.on { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.dpg-picker-name { font-weight: 600; font-size: 13px; }
.dpg-picker-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dpg-picker-empty { padding: 16px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dpg-login { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 24px; overflow: auto; }
.dpg-login-card { width: 100%; max-width: 380px; display: flex; flex-direction: column; align-items: stretch;
  gap: 12px; padding: 28px 26px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: 0 8px 28px rgba(0,0,0,.16); }
.dpg-login-logo { width: 48px; height: 48px; border-radius: 50%; align-self: center;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); margin-bottom: 2px; }
.dpg-login-title { text-align: center; font-size: 18px; font-weight: 600; }
.dpg-login-sub { text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; margin-bottom: 4px; }
.dpg-login-warn { font-size: 11px; color: var(--dsw-alias-state-warn-primary);
  border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: 6px; padding: 6px 9px; }
.dpg-login-input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 13px; }
.dpg-login-btn { justify-content: center; height: 34px; font-size: 13px; }
.dpg-login-err { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dpg-login-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); text-align: center; }
.dpg-login-help { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.65;
  white-space: pre-wrap; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px; margin-top: 4px; }
.dpg-login-help code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--dsw-alias-bg-layer-2); padding: 0 4px; border-radius: 3px; }
.dpg-signout { font-size: 12px; }
.dpg-device { display: flex; flex-direction: column; gap: 10px; align-items: center; padding: 4px 0 2px; }
.dpg-device-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dpg-device-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 24px; letter-spacing: 4px;
  font-weight: 700; padding: 10px 18px; border-radius: 8px; border: 1px dashed var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); user-select: all; }
.dpg-device-wait { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dpg-linkbtn { background: none; border: none; padding: 0; cursor: pointer; font-size: 12px;
  color: var(--dsw-alias-brand-primary); align-self: center; }
.dpg-linkbtn:hover { text-decoration: underline; }
.dpg-setup { display: flex; flex-direction: column; gap: 10px; align-items: stretch; }
.dpg-lock { font-size: 11px; color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 0 6px; }
`

    let stylesInstalled = false
    function installStyles() {
      if (stylesInstalled || typeof document === 'undefined') return
      stylesInstalled = true
      const el = document.createElement('style')
      el.setAttribute('data-dsh-plugin', PLUGIN_ID)
      el.textContent = CSS
      document.head.appendChild(el)
    }

    async function postJson(url, payload) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      const data = await response.json().catch(() => null)
      if (!data) throw new Error(`HTTP ${response.status}`)
      return data
    }

    async function fileToBase64(file) {
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return btoa(binary)
    }

    function relativeTime(iso) {
      if (!iso) return ''
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return ''
      const seconds = Math.round((Date.now() - then) / 1000)
      if (seconds < 60) return 'just now'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
      const days = Math.round(hours / 24)
      if (days === 1) return 'yesterday'
      if (days < 30) return `${days} days ago`
      const months = Math.round(days / 30)
      if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
      return `${Math.round(months / 12)} year(s) ago`
    }

    function shortSha(sha) {
      return typeof sha === 'string' ? sha.slice(0, 7) : ''
    }

    /**
     * A deliberately small Markdown renderer: headings, lists, fenced code,
     * inline code, bold and links. The README is the visual centre of a
     * repository page — dumping it into a <pre> is the difference between a
     * product and a debug view. Written by hand because the client bundle can
     * only import the browser baseline, never an npm package.
     */
    function inlineNodes(text, keyBase) {
      const nodes = []
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/
      let rest = String(text || '')
      let guard = 0
      while (rest && guard < 300) {
        guard += 1
        const match = pattern.exec(rest)
        if (!match) {
          nodes.push(rest)
          break
        }
        if (match.index > 0) nodes.push(rest.slice(0, match.index))
        const key = `${keyBase}-${guard}`
        if (match[1]) nodes.push(h('code', { key, className: 'dpg-md-inline' }, match[1].slice(1, -1)))
        else if (match[2]) nodes.push(h('strong', { key }, match[2].slice(2, -2)))
        else nodes.push(h('a', { key, href: match[5], target: '_blank', rel: 'noreferrer' }, match[4]))
        rest = rest.slice(match.index + match[0].length)
      }
      return nodes
    }

    function renderMarkdown(source) {
      const lines = String(source || '').split(/\r?\n/)
      const blocks = []
      let i = 0

      while (i < lines.length) {
        const line = lines[i]

        if (/^\s*```/.test(line)) {
          const code = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) {
            code.push(lines[i])
            i += 1
          }
          i += 1
          blocks.push(h('pre', { key: `code-${i}`, className: 'dpg-md-code' }, code.join('\n')))
          continue
        }

        const heading = /^(#{1,3})\s+(.*)$/.exec(line)
        if (heading) {
          const level = heading[1].length
          blocks.push(
            h(`h${level}`, { key: `h-${i}`, className: `dpg-md-h${level}` }, ...inlineNodes(heading[2], `h-${i}`)),
          )
          i += 1
          continue
        }

        if (/^\s*[-*+]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(h('li', { key: `li-${i}` }, ...inlineNodes(lines[i].replace(/^\s*[-*+]\s+/, ''), `li-${i}`)))
            i += 1
          }
          blocks.push(h('ul', { key: `ul-${i}` }, items))
          continue
        }

        if (!line.trim()) {
          i += 1
          continue
        }

        const paragraph = []
        while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*```|\s*[-*+]\s+)/.test(lines[i])) {
          paragraph.push(lines[i].trim())
          i += 1
        }
        blocks.push(h('p', { key: `p-${i}` }, ...inlineNodes(paragraph.join(' '), `p-${i}`)))
      }

      return blocks
    }

    function splitRepo(fullName) {
      const name = typeof fullName === 'string' ? fullName : ''
      const at = name.indexOf('/')
      if (at < 0) return { owner: '', name }
      return { owner: name.slice(0, at), name: name.slice(at + 1) }
    }

    const ICONS = {
      code: 'M4.72 3.22a.75.75 0 0 1 1.06 1.06L2.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L.47 8.53a.75.75 0 0 1 0-1.06Zm6.56 0a.75.75 0 1 0-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06l4.25-4.25a.75.75 0 0 0 0-1.06Z',
      issue: 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z',
      pull: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
      play: 'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm-1.5 3.75 4 2.75-4 2.75Z',
      graph: 'M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.06-1.06l3.25-3.25a.75.75 0 0 1 1.06 0l2.47 2.47 4.72-4.72a.751.751 0 0 1 1.06 1.06Z',
      gear: 'M8 0l1.04 1.86 2.11.5.61 2.09L13.9 5.7l-.77 2.03.77 2.03-2.14 1.25-.61 2.09-2.11.5L8 15.46l-1.04-1.86-2.11-.5-.61-2.09-2.14-1.25.77-2.03-.77-2.03 2.14-1.25.61-2.09 2.11-.5Zm0 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
      book: 'M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Z',
      shield: 'M7.467.133a1.748 1.748 0 0 1 1.066 0l5.25 1.68A1.75 1.75 0 0 1 15 3.48V7c0 1.566-.32 3.182-1.303 4.682-.983 1.498-2.585 2.813-5.032 3.855a1.7 1.7 0 0 1-1.33 0c-2.447-1.042-4.049-2.357-5.032-3.855C1.32 10.182 1 8.566 1 7V3.48a1.75 1.75 0 0 1 1.217-1.667Z',
      repo: 'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z',
      folder: 'M0 3.75C0 2.784.784 2 1.75 2h3.5c.966 0 1.75.784 1.75 1.75v.25h6A1.75 1.75 0 0 1 14.75 5.75v6.5A1.75 1.75 0 0 1 13 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25H13a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25H7.75v1.75a.75.75 0 0 1-1.5 0V5.75h-2a.75.75 0 0 1 0-1.5h2v-.75a.25.25 0 0 0-.25-.25Z',
      file: 'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.5.75v11.75c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.25v2.75c0 .138.112.25.25.25h2.75a.25.25 0 0 0-.03-.12l-2.85-2.85a.25.25 0 0 0-.12-.03Z',
      refresh: 'M8 1.5a6.5 6.5 0 1 0 6.5 6.5.75.75 0 0 0-1.5 0A5 5 0 1 1 8 3v2.25a.25.25 0 0 0 .4.2l3-2.25a.25.25 0 0 0 0-.4l-3-2.25a.25.25 0 0 0-.4.2Z',
      search: 'M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z',
      star: 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z',
      fork: 'M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0Z',
      eye: 'M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.619 3.13a1.75 1.75 0 0 1 0 1.584c-.432.785-1.35 2.039-2.619 3.13C11.671 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.448 8.792a1.75 1.75 0 0 1 0-1.584c.432-.785 1.35-2.039 2.619-3.13C4.329 2.992 6.019 2 8 2Zm0 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
      link: 'M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95Z',
      tag: 'M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.75 1.75 0 0 1 1 7.775Z',
      dot: 'M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
    }

    function icon(key, size) {
      const px = size || 14
      return h(
        'svg',
        { width: px, height: px, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true',
          style: { flex: 'none' } },
        h('path', { d: ICONS[key] || ICONS.dot }),
      )
    }

    function Avatar(props) {
      const [broken, setBroken] = React.useState(false)
      const px = props.size || 20
      const style = {
        width: px, height: px, borderRadius: '50%', overflow: 'hidden', flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: Math.max(9, Math.round(px * 0.42)), fontWeight: 600, textTransform: 'uppercase',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
      }
      if (!props.url || broken) return h('span', { style }, String(props.name || '?').slice(0, 1))
      return h('span', { style },
        h('img', {
          src: props.url, alt: props.name || '', style: { width: '100%', height: '100%', objectFit: 'cover' },
          onError: () => setBroken(true),
        }))
    }

    // Two seats, both earning their place. Issues and Actions were cut: nobody
    // reads an issue thread inside a coding panel, and the agent summarises
    // either far better than a list can.
    const TABS = [
      { id: 'code', label: 'Code', icon: 'code' },
      { id: 'pulls', label: 'Pull requests', icon: 'pull' },
    ]

    function Panel() {
      const [repo, setRepo] = React.useState('')
      const [snapshot, setSnapshot] = React.useState(cachedSnapshot)
      const [overview, setOverview] = React.useState(null)
      const [tab, setTab] = React.useState('code')
      const [branch, setBranch] = React.useState('')
      const [path, setPath] = React.useState('')
      const [listing, setListing] = React.useState(null)
      const [filter, setFilter] = React.useState('')
      const [file, setFile] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [newBranch, setNewBranch] = React.useState('')
      const [branchFrom, setBranchFrom] = React.useState('')
      const [prTitle, setPrTitle] = React.useState('')
      const [prHead, setPrHead] = React.useState('')
      const [prBase, setPrBase] = React.useState('')
      const [prBody, setPrBody] = React.useState('')
      const [upPath, setUpPath] = React.useState('')
      const [upMessage, setUpMessage] = React.useState('')
      const [upFile, setUpFile] = React.useState(null)
      const [form, setForm] = React.useState('')
      const [repos, setRepos] = React.useState(null)
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const [pickerFilter, setPickerFilter] = React.useState('')
      const [loginToken, setLoginToken] = React.useState('')
      const [loginBusy, setLoginBusy] = React.useState(false)
      const [loginError, setLoginError] = React.useState('')
      const [device, setDevice] = React.useState(null)
      const [showPat, setShowPat] = React.useState(false)
      const [clientIdInput, setClientIdInput] = React.useState('')
      const [clientIdBusy, setClientIdBusy] = React.useState(false)
      const [stateError, setStateError] = React.useState('')
      // Generation counter: bumped on every repository switch so a late response
      // for the previous repository cannot paint over the current one.
      const switchSeq = React.useRef(0)

      /** Load the switcher's list once, on first open. */
      async function openPicker() {
        setPickerFilter('')
        setPickerOpen((open) => !open)
        if (repos !== null) return
        try {
          const data = await postJson(ACTION_URL, { action: 'repos', repo: repo || undefined })
          setRepos(data && data.ok ? data.result.items : [])
        } catch {
          setRepos([])
        }
      }

      /** Switch the whole panel to another repository. */
      async function selectRepo(fullName) {
        // Bump the generation first: any in-flight request for the previous
        // repository must not land on top of the new one.
        switchSeq.current += 1
        setPickerOpen(false)
        setError('')
        setNotice('')
        setFile(null)
        setFilter('')
        setPath('')
        setListing(null)
        setOverview(null)
        setTab('code')
        setForm('')
        setRepo(fullName)
        try {
          window.localStorage.setItem(LAST_REPO_KEY, fullName)
        } catch {
          /* storage unavailable */
        }
        const data = await loadState(fullName)
        if (!data || !data.repo) return
        const startBranch = data.repo.defaultBranch
        setBranch(startBranch)
        // `repo` is still the previous value in this closure — pass it explicitly.
        await Promise.all([browse('', startBranch, fullName), loadOverview(fullName)])
      }

      async function loadState(repoValue) {
        const seq = switchSeq.current
        let data = null
        try {
          data = await postJson(STATE_URL, { repo: repoValue || undefined })
        } catch (cause) {
          // A failed request is not the same as "not signed in"; keep them apart
          // so the sign-in screen can show the real reason instead of offering login.
          setStateError(String(cause && cause.message ? cause.message : cause))
          setLoading(false)
          return null
        }
        if (seq !== switchSeq.current) return null
        setStateError('')
        cachedSnapshot = data
        setSnapshot(data)
        if (data && data.error) setError(data.error)
        if (data && data.repo && data.repo.fullName) {
          setRepo(data.repo.fullName)
          try {
            window.localStorage.setItem(LAST_REPO_KEY, data.repo.fullName)
          } catch {
            /* storage unavailable; panel still works */
          }
        }
        return data
      }

      async function loadOverview(repoValue) {
        try {
          const data = await postJson(ACTION_URL, { action: 'overview', repo: repoValue || undefined })
          if (data && data.ok) setOverview(data.result)
        } catch {
          /* the rail is decoration; never block the page on it */
        }
      }

      /**
       * Browse one directory.
       *
       * `repoOverride` is load-bearing: `setRepo()` does not update this closure,
       * so a browse issued right after a repository switch would otherwise query
       * the PREVIOUS repository and paint its files under the new header.
       */
      async function browse(nextPath, nextBranch, repoOverride) {
        const targetRepo = typeof repoOverride === 'string' && repoOverride ? repoOverride : repo
        const seq = switchSeq.current
        setLoading(true)
        try {
          const data = await postJson(ACTION_URL, {
            action: 'browse',
            repo: targetRepo || undefined,
            branch: nextBranch || branch || undefined,
            path: nextPath || '',
          })
          if (seq !== switchSeq.current) return
          if (!data || data.ok !== true) {
            setError((data && data.error) || '无法读取仓库目录')
            setListing(null)
            return
          }
          setListing(data.result)
          setPath(data.result.path || '')
        } catch (cause) {
          if (seq !== switchSeq.current) return
          setError(String(cause && cause.message ? cause.message : cause))
          setListing(null)
        } finally {
          if (seq === switchSeq.current) setLoading(false)
        }
      }

      React.useEffect(() => {
        installStyles()
        let remembered = ''
        try {
          remembered = window.localStorage.getItem(LAST_REPO_KEY) || ''
        } catch {
          remembered = ''
        }
        loadState(remembered)
          .then((data) => {
            if (!data) {
              setLoading(false)
              return null
            }
            if (!data.repo) {
              // Signed in, but the configured/default repository is not
              // reachable for this account — let the user pick one instead of
              // showing a dead end.
              setLoading(false)
              if (data.authenticated) {
                setNotice('请选择一个仓库开始')
                openPicker()
              }
              return null
            }
            const startBranch = data.repo.defaultBranch
            setBranch(startBranch)
            return Promise.all([browse('', startBranch), loadOverview(data.repo.fullName)])
          })
          .catch((cause) => {
            setError(String(cause && cause.message ? cause.message : cause))
            setLoading(false)
          })
      }, [])

      async function run(payload, successText) {
        setBusy(payload.action)
        setError('')
        setNotice('')
        try {
          const data = await postJson(ACTION_URL, { repo: repo || undefined, ...payload })
          if (!data || data.ok !== true) {
            setError((data && data.error) || '操作失败')
            return null
          }
          if (successText) setNotice(successText)
          return data.result
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
          return null
        } finally {
          setBusy('')
        }
      }

      const authenticated = !!(snapshot && snapshot.authenticated)
      const repoInfo = snapshot ? snapshot.repo : null
      const branches = snapshot && Array.isArray(snapshot.branches) ? snapshot.branches : []
      const pulls = snapshot && Array.isArray(snapshot.pulls) ? snapshot.pulls : []
      const entries = listing && Array.isArray(listing.entries) ? listing.entries : []
      const head = listing ? listing.head : null
      const currentBranch = branch || (repoInfo ? repoInfo.defaultBranch : '')
      const parts = splitRepo(repoInfo ? repoInfo.fullName : repo)
      const needle = filter.trim().toLowerCase()
      const visible = needle
        ? entries.filter((entry) => String(entry.path || entry.name).toLowerCase().includes(needle))
        : entries

      function switchBranch(nextBranch) {
        setBranch(nextBranch)
        setFilter('')
        browse('', nextBranch)
      }

      function openFile(entry) {
        setTab('file')
        setFile(null)
        run({ action: 'file', path: entry.path, branch: currentBranch }, '').then((result) => {
          if (result) setFile(result)
        })
      }

      function breadcrumb() {
        const nodes = String(path || '').split('/').filter(Boolean)
        const trail = [
          h('button', {
            key: '__root',
            type: 'button',
            className: 'dpg-crumb' + (nodes.length === 0 ? ' last' : ''),
            onClick: () => {
              if (!nodes.length) return
              setTab('code')
              setFilter('')
              browse('', currentBranch)
            },
          }, parts.name || 'root'),
        ]
        let acc = ''
        nodes.forEach((node, index) => {
          acc = acc ? `${acc}/${node}` : node
          const isLast = index === nodes.length - 1
          trail.push(h('span', { key: `sep-${acc}`, className: 'dpg-muted' }, '/'))
          trail.push(h('button', {
            key: acc,
            type: 'button',
            className: 'dpg-crumb' + (isLast ? ' last' : ''),
            onClick: () => {
              if (isLast) return
              setTab('code')
              setFilter('')
              browse(acc, currentBranch)
            },
          }, node))
        })
        return trail
      }

      function renderCommitRow() {
        if (!head) return null
        return h(
          'div',
          { className: 'dpg-commit' },
          h(Avatar, { name: head.author, size: 20 }),
          h('span', { className: 'dpg-author' }, head.author || 'unknown'),
          h('span', { className: 'dpg-msg', title: head.message }, head.message || ''),
          h('span', { className: 'dpg-spacer' }),
          h('span', { className: 'dpg-sha' }, shortSha(head.sha)),
          h('span', { className: 'dpg-cell-time' }, relativeTime(head.date)),
          overview && overview.commitCount
            ? h('span', { className: 'dpg-meta' }, icon('graph'), `${overview.commitCount} Commits`)
            : null,
        )
      }

      function renderFiles() {
        if (loading && entries.length === 0) {
          return h('div', { className: 'dpg-table' }, h('div', { className: 'dpg-empty' }, '加载中…'))
        }
        if (visible.length === 0) {
          return h('div', { className: 'dpg-table' },
            h('div', { className: 'dpg-empty' }, needle ? `没有匹配 “${filter.trim()}” 的文件` : '此目录为空'))
        }
        return h(
          'div',
          { className: 'dpg-table' },
          visible.map((entry) =>
            h(
              'div',
              {
                key: entry.path,
                className: 'dpg-row' + (entry.type === 'dir' ? ' dpg-dir' : ''),
                title: entry.path,
                onClick: () => {
                  if (entry.type === 'dir') {
                    setFilter('')
                    browse(entry.path, currentBranch)
                  } else {
                    openFile(entry)
                  }
                },
              },
              h('div', { className: 'dpg-cell-name' }, icon(entry.type === 'dir' ? 'folder' : 'file'),
                h('span', { className: 'dpg-name' }, entry.name)),
              h('div', { className: 'dpg-cell-msg', title: entry.message || '' }, entry.message || ''),
              h('div', { className: 'dpg-cell-time' }, relativeTime(entry.date)),
            ),
          ),
        )
      }

      function renderReadme() {
        const readme = overview ? overview.readme : null
        if (!readme) {
          return h('div', { className: 'dpg-card' },
            h('div', { className: 'dpg-card-head' }, icon('book'), 'README'),
            h('div', { className: 'dpg-readme-empty' },
              h('div', { style: { fontSize: 16, fontWeight: 600, marginBottom: 6 } }, 'Add a README'),
              h('div', null, 'Help people interested in this repository understand your project.')))
        }
        return h('div', { className: 'dpg-card' },
          h('div', { className: 'dpg-card-head' }, icon('book'), readme.name || 'README'),
          h('div', { className: 'dpg-md' }, ...renderMarkdown(readme.content)))
      }

      /**
       * The rail keeps one thing: what this repository IS. Releases, Packages,
       * Contributors and Languages were cut — github.com needs them because it
       * is a community front door; a coding panel is not.
       */
      function renderSidebar() {
        if (!overview) return null
        const info = overview.repo

        return h(
          'div',
          { className: 'dpg-side' },
          h('div', { className: 'dpg-side-block' },
            h('div', { className: 'dpg-side-title' }, 'About'),
            info.description
              ? h('div', { className: 'dpg-side-desc' }, info.description)
              : h('div', { className: 'dpg-side-desc dpg-muted dpg-italic' },
                  'No description provided.'),
            h('div', { className: 'dpg-side-row' }, icon('star'), `${info.stars} star${info.stars === 1 ? '' : 's'}`),
            h('div', { className: 'dpg-side-row' }, icon('eye'), `${info.watchers || 0} watching`),
            h('div', { className: 'dpg-side-row' }, icon('fork'), `${info.forks} fork${info.forks === 1 ? '' : 's'}`)),
        )
      }


      function renderPulls() {
        return h('div', null,
          h('div', { className: 'dpg-toolbar', style: { paddingTop: 0 } },
            h('span', { className: 'dpg-muted' }, `${pulls.length} open`),
            h('span', { className: 'dpg-spacer' }),
            h('button', { type: 'button', className: 'dpg-btn primary', onClick: () => setTab('newPull') },
              'New pull request')),
          h('div', { className: 'dpg-card', style: { marginTop: 0 } },
            pulls.length
              ? pulls.map((pull) =>
                  h('div', { key: pull.number, className: 'dpg-item' }, icon('pull'),
                    h('div', { style: { minWidth: 0 } },
                      h('a', { className: 'dpg-item-title', href: pull.htmlUrl, target: '_blank', rel: 'noreferrer' },
                        pull.title),
                      h('div', { className: 'dpg-item-sub' },
                        `#${pull.number} · ${pull.head || '?'} → ${pull.base || '?'} · ${pull.author || ''} · ${relativeTime(pull.updatedAt)}`)),
                    pull.draft ? h('span', { className: 'dpg-tag draft' }, 'Draft') : h('span', { className: 'dpg-tag' }, 'Open')))
              : h('div', { className: 'dpg-empty' }, '没有打开的 Pull Request')))
      }

      function renderFileView() {
        return h('div', null,
          h('div', { className: 'dpg-toolbar', style: { paddingTop: 0 } },
            h('button', {
              type: 'button', className: 'dpg-btn ghost',
              onClick: () => { setTab('code'); setFile(null) },
            }, '返回'),
            h('div', { className: 'dpg-crumbs' }, breadcrumb()),
            h('span', { className: 'dpg-spacer' }),
            file ? h('span', { className: 'dpg-sha' }, shortSha(file.sha)) : null,
            file ? h('span', { className: 'dpg-muted' }, `${file.size} B`) : null),
          h('div', { className: 'dpg-card', style: { marginTop: 0 } },
            h('div', { className: 'dpg-card-head' }, icon('file'), file ? file.path : '读取中…'),
            file ? h('pre', { className: 'dpg-code' }, file.content || '')
              : h('div', { className: 'dpg-empty' }, '读取中…')))
      }

      function renderNewPull() {
        return h('div', { className: 'dpg-card', style: { marginTop: 0 } },
          h('div', { className: 'dpg-card-head' }, 'New pull request'),
          h('div', { className: 'dpg-card-body' },
            h('div', { className: 'dpg-field' },
              h('span', { className: 'dpg-label' }, '标题'),
              h('input', { className: 'dpg-input', value: prTitle, placeholder: 'Pull request 标题',
                onChange: (event) => setPrTitle(event.target.value) })),
            h('div', { className: 'dpg-row-inline' },
              h('div', { className: 'dpg-field' },
                h('span', { className: 'dpg-label' }, 'head（源分支）'),
                h('input', { className: 'dpg-input', value: prHead, placeholder: 'feat/x',
                  onChange: (event) => setPrHead(event.target.value) })),
              h('div', { className: 'dpg-field' },
                h('span', { className: 'dpg-label' }, `base（目标，默认 ${currentBranch || 'main'}）`),
                h('input', { className: 'dpg-input', value: prBase, placeholder: currentBranch,
                  onChange: (event) => setPrBase(event.target.value) }))),
            h('div', { className: 'dpg-field' },
              h('span', { className: 'dpg-label' }, '描述（可选）'),
              h('textarea', { className: 'dpg-input', rows: 4, value: prBody,
                onChange: (event) => setPrBody(event.target.value) })),
            h('div', { className: 'dpg-row-inline' },
              h('button', {
                type: 'button', className: 'dpg-btn primary',
                disabled: busy === 'createPull' || !prTitle.trim() || !prHead.trim(),
                onClick: async () => {
                  const created = await run({
                    action: 'createPull',
                    title: prTitle.trim(),
                    head: prHead.trim(),
                    base: prBase.trim() || undefined,
                    body: prBody.trim() || undefined,
                  }, 'Pull Request 已创建')
                  if (created) {
                    setPrTitle(''); setPrHead(''); setPrBase(''); setPrBody('')
                    await refresh()
                    setTab('pulls')
                  }
                },
              }, busy === 'createPull' ? '创建中…' : '创建 Pull Request'),
              h('button', { type: 'button', className: 'dpg-btn ghost', onClick: () => setTab('pulls') }, '取消'))))
      }

      function renderBranchForm() {
        return h('div', { className: 'dpg-card', style: { marginTop: 10 } },
          h('div', { className: 'dpg-card-head' }, 'New branch'),
          h('div', { className: 'dpg-card-body' },
            h('div', { className: 'dpg-field' },
              h('span', { className: 'dpg-label' }, '分支名'),
              h('input', { className: 'dpg-input', value: newBranch, placeholder: 'feat/login',
                onChange: (event) => setNewBranch(event.target.value) })),
            h('div', { className: 'dpg-field' },
              h('span', { className: 'dpg-label' }, '起点（留空 = 当前分支）'),
              h('input', { className: 'dpg-input', value: branchFrom, placeholder: currentBranch,
                onChange: (event) => setBranchFrom(event.target.value) })),
            h('div', { className: 'dpg-row-inline' },
              h('button', {
                type: 'button', className: 'dpg-btn primary',
                disabled: busy === 'createBranch' || !newBranch.trim(),
                onClick: async () => {
                  const created = await run({
                    action: 'createBranch',
                    branch: newBranch.trim(),
                    from: branchFrom.trim() || currentBranch || undefined,
                  }, '分支已创建')
                  if (created) {
                    const target = created.branch || newBranch.trim()
                    setNewBranch(''); setBranchFrom(''); setForm('')
                    await loadState(repo)
                    switchBranch(target)
                  }
                },
              }, busy === 'createBranch' ? '创建中…' : '创建分支'),
              h('button', { type: 'button', className: 'dpg-btn ghost', onClick: () => setForm('') }, '取消'))))
      }

      function renderUploadForm() {
        return h('div', { className: 'dpg-card', style: { marginTop: 10 } },
          h('div', { className: 'dpg-card-head' }, 'Add file'),
          h('div', { className: 'dpg-card-body' },
            h('div', { className: 'dpg-field' },
              h('span', { className: 'dpg-label' }, '目标路径'),
              h('input', { className: 'dpg-input', value: upPath, placeholder: 'docs/hello.md',
                onChange: (event) => setUpPath(event.target.value) })),
            h('div', { className: 'dpg-field' },
              h('span', { className: 'dpg-label' }, '提交信息（留空 = Upload <path>）'),
              h('input', { className: 'dpg-input', value: upMessage,
                onChange: (event) => setUpMessage(event.target.value) })),
            h('div', { className: 'dpg-field' },
              h('span', { className: 'dpg-label' }, `选择文件 → 提交到 ${currentBranch || '默认分支'}`),
              h('input', { type: 'file', className: 'dpg-input',
                onChange: (event) => setUpFile(event.target.files && event.target.files[0] ? event.target.files[0] : null) })),
            h('div', { className: 'dpg-row-inline' },
              h('button', {
                type: 'button', className: 'dpg-btn primary',
                disabled: busy === 'uploadFile' || !upFile || !upPath.trim(),
                onClick: async () => {
                  if (!upFile) return
                  const base64 = await fileToBase64(upFile)
                  const uploaded = await run({
                    action: 'uploadFile',
                    path: upPath.trim(),
                    branch: currentBranch || undefined,
                    message: upMessage.trim() || undefined,
                    content: base64,
                    encoding: 'base64',
                  }, '文件已上传')
                  if (uploaded) {
                    setUpPath(''); setUpMessage(''); setUpFile(null); setForm('')
                    await browse(path, currentBranch)
                  }
                },
              }, busy === 'uploadFile' ? '上传中…' : '上传并提交'),
              h('button', { type: 'button', className: 'dpg-btn ghost', onClick: () => setForm('') }, '取消'))))
      }

      async function refresh() {
        setNotice('')
        try {
          const current = repo
          const data = await loadState(current)
          if (!data || !data.repo) return
          // A listing from another repository must not survive a refresh, even
          // when the browse call below fails.
          setListing(null)
          await Promise.all([browse(path, branch || data.repo.defaultBranch, current), loadOverview(current)])
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }

      async function toggleStar() {
        if (!overview) return
        const next = !overview.starred
        const result = await run({ action: 'star', on: next }, next ? '已 Star' : '已取消 Star')
        if (result) await loadOverview(repo)
      }

      async function forkRepo() {
        const result = await run({ action: 'fork' }, '')
        if (result && result.htmlUrl) setNotice(`Fork 已创建：${result.fork}`)
      }

      /** After any successful sign-in: load the account, then the repo page. */
      async function afterLogin() {
        const info = await loadState(repo)
        if (info && info.repo) {
          const startBranch = info.repo.defaultBranch
          setBranch(startBranch)
          await Promise.all([browse('', startBranch), loadOverview(info.repo.fullName)])
        } else if (info && info.authenticated) {
          setNotice('已登录，请选择一个仓库')
          openPicker()
        }
      }

      /** Start GitHub's device flow — no Personal Access Token needed. */
      async function startDeviceFlow() {
        setLoginBusy(true)
        setLoginError('')
        try {
          const data = await postJson(ACTION_URL, { action: 'loginDeviceStart', repo: repo || undefined })
          if (!data || data.ok !== true) {
            setLoginError((data && data.error) || '无法发起 GitHub 授权')
            return
          }
          setDevice(data.result)
        } catch (cause) {
          setLoginError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setLoginBusy(false)
        }
      }

      async function cancelDeviceFlow() {
        setDevice(null)
        setLoginBusy(false)
        try {
          await postJson(ACTION_URL, { action: 'loginDeviceCancel', repo: repo || undefined })
        } catch {
          /* nothing to clean up host-side */
        }
      }

      // Poll GitHub while a device authorization is pending. The polling secret
      // stays on the host; this loop only asks it for the outcome.
      React.useEffect(() => {
        if (!device) return undefined
        let cancelled = false
        let timer = null
        let delay = Math.max(5, Number(device.interval) || 5) * 1000

        const tick = async () => {
          if (cancelled) return
          try {
            const data = await postJson(ACTION_URL, { action: 'loginDevicePoll', repo: repo || undefined })
            if (cancelled) return
            if (data && data.ok === true) {
              setDevice(null)
              await afterLogin()
              return
            }
            if (data && data.pending) {
              if (data.interval) delay = Math.max(5, Number(data.interval)) * 1000
              timer = setTimeout(tick, delay)
              return
            }
            setLoginError((data && data.error) || '授权失败')
            setDevice(null)
          } catch (cause) {
            if (cancelled) return
            setLoginError(String(cause && cause.message ? cause.message : cause))
            setDevice(null)
          }
        }

        timer = setTimeout(tick, delay)
        return () => {
          cancelled = true
          if (timer) clearTimeout(timer)
        }
      }, [device])

      /** Save the OAuth App client id from the sign-in screen. */
      async function saveClientId() {
        const value = clientIdInput.trim()
        if (!value) return
        setClientIdBusy(true)
        setLoginError('')
        try {
          const data = await postJson(ACTION_URL, { action: 'setClientId', clientId: value, repo: repo || undefined })
          if (!data || data.ok !== true) {
            setLoginError((data && data.error) || '保存失败')
            return
          }
          setClientIdInput('')
          await loadState(repo)
        } catch (cause) {
          setLoginError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setClientIdBusy(false)
        }
      }

      /** Fallback sign-in with a token the user created themselves. */
      async function signIn() {
        const value = loginToken.trim()
        if (!value) {
          setLoginError('请先粘贴 Personal Access Token')
          return
        }
        setLoginBusy(true)
        setLoginError('')
        try {
          const data = await postJson(ACTION_URL, { action: 'login', token: value })
          if (!data || data.ok !== true) {
            setLoginError((data && data.error) || '登录失败')
            return
          }
          setLoginToken('')
          await afterLogin()
        } catch (cause) {
          setLoginError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setLoginBusy(false)
        }
      }

      async function signOut() {
        try {
          await postJson(ACTION_URL, { action: 'logout', repo: repo || undefined })
        } catch {
          /* fall through: the UI returns to the sign-in screen regardless */
        }
        cachedSnapshot = snapshot ? Object.assign({}, snapshot, { authenticated: false, login: null }) : null
        setSnapshot(cachedSnapshot)
        setOverview(null)
        setListing(null)
        setRepo('')
        setPath('')
        setFile(null)
        setTab('code')
        setForm('')
        setNotice('')
        setError('')
        setDevice(null)
        try {
          window.localStorage.removeItem(LAST_REPO_KEY)
        } catch {
          /* storage unavailable */
        }
      }

      // A remount must not flash the sign-in card while the first request is in
      // flight: only draw it once we actually know the account is signed out.
      if (!authenticated && !snapshot && !stateError) {
        return h('div', { className: 'dpg-root' },
          h('div', { className: 'dpg-login' },
            h('div', { className: 'dpg-login-card' },
              h('div', { className: 'dpg-login-logo' }, icon('repo', 26)),
              h('div', { className: 'dpg-login-hint' }, '正在连接 GitHub…'))))
      }

      if (!authenticated) {
        const canDevice = !!(snapshot && snapshot.canDeviceFlow)

        return h('div', { className: 'dpg-root' },
          h('div', { className: 'dpg-login' },
            h('div', { className: 'dpg-login-card' },
              h('div', { className: 'dpg-login-logo' }, icon('repo', 26)),
              h('div', { className: 'dpg-login-title' }, 'Connect to GitHub'),
              stateError
                ? h('div', null,
                    h('div', { className: 'dpg-login-err' }, '读取登录状态失败：' + stateError),
                    h('button', {
                      type: 'button',
                      className: 'dpg-btn dpg-login-btn',
                      onClick: async () => {
                        setStateError('')
                        await loadState(repo)
                      },
                    }, '重试'))
                : null,
              h('div', { className: 'dpg-login-sub' },
                'Sign in with your GitHub account to browse repositories, review pull requests and commit files.'),

              snapshot && snapshot.reauthRequired
                ? h('div', { className: 'dpg-login-warn' },
                    '上次保存的令牌已被 GitHub 判定为失效（可能已撤销或过期），已自动清除。请重新登录一次。')
                : null,

              snapshot && !snapshot.canStore
                ? h('div', { className: 'dpg-login-warn' },
                    '提示：当前环境的凭据库不可写，登录只在本次运行期间有效，重启后需要重新登录。')
                : null,

              // ---- device flow (primary) ----
              device
                ? h('div', { className: 'dpg-device' },
                    h('div', { className: 'dpg-device-label' }, '在浏览器打开并输入此代码：'),
                    h('div', { className: 'dpg-device-code' }, device.userCode),
                    h('a', {
                      className: 'dpg-btn primary dpg-login-btn',
                      href: device.verificationUri,
                      target: '_blank',
                      rel: 'noreferrer',
                    }, '打开 GitHub 授权页面'),
                    h('div', { className: 'dpg-device-wait' }, '等待授权中…（页面会自动继续）'),
                    h('button', {
                      type: 'button',
                      className: 'dpg-btn ghost dpg-login-btn',
                      onClick: cancelDeviceFlow,
                    }, '取消'))
                : canDevice
                  ? h('button', {
                      type: 'button',
                      className: 'dpg-btn primary dpg-login-btn',
                      disabled: loginBusy,
                      onClick: startDeviceFlow,
                    }, loginBusy ? '正在连接…' : '使用 GitHub 账号登录')
                  : h('div', { className: 'dpg-setup' },
                      h('div', { className: 'dpg-login-warn' },
                        '未配置 OAuth App client_id，一键登录暂不可用。填入一次即可（公开值，不是密钥）。'),
                      h('a', {
                        className: 'dpg-linkbtn',
                        href: 'https://github.com/settings/applications/new',
                        target: '_blank',
                        rel: 'noreferrer',
                      }, '创建 OAuth App（记得勾选 Enable Device Flow）↗'),
                      h('div', { className: 'dpg-login-help' },
                        '填表要点：',
                        h('code', null, '重定向 URI'),
                        ' 随便填一个合法地址即可（例如 ',
                        h('code', null, 'https://github.com/login/device'),
                        '，设备流不会用到它，但留空无法提交）；往下滚动勾选 ',
                        h('code', null, 'Enable Device Flow'),
                        '；提交后复制 Client ID。'),
                      h('div', { className: 'dpg-field' },
                        h('span', { className: 'dpg-label' }, '把页面上的 Client ID 粘贴到这里'),
                        h('input', {
                          className: 'dpg-input dpg-login-input',
                          placeholder: 'Ov23li… / Iv1.…',
                          value: clientIdInput,
                          onChange: (event) => setClientIdInput(event.target.value),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') saveClientId()
                          },
                        })),
                      h('button', {
                        type: 'button',
                        className: 'dpg-btn dpg-login-btn',
                        disabled: clientIdBusy || !clientIdInput.trim(),
                        onClick: saveClientId,
                      }, clientIdBusy ? '保存中…' : '保存 Client ID')),

              // ---- PAT (fallback) ----
              canDevice
                ? h('button', {
                    type: 'button',
                    className: 'dpg-linkbtn',
                    onClick: () => setShowPat((value) => !value),
                  }, showPat ? '收起 Personal Access Token' : '或使用 Personal Access Token')
                : null,

              canDevice && !showPat
                ? null
                : h('div', null,
                    h('div', { className: 'dpg-field' },
                      h('span', { className: 'dpg-label' }, 'Personal Access Token'),
                      h('input', {
                        className: 'dpg-input dpg-login-input',
                        type: 'password',
                        autoComplete: 'off',
                        spellCheck: false,
                        placeholder: 'ghp_… / github_pat_…',
                        value: loginToken,
                        onChange: (event) => setLoginToken(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') signIn()
                        },
                      })),
                    h('button', {
                      type: 'button',
                      className: 'dpg-btn dpg-login-btn',
                      disabled: loginBusy || !loginToken.trim(),
                      onClick: signIn,
                    }, loginBusy ? '正在验证…' : 'Sign in'),
                    h('div', { className: 'dpg-login-help' },
                      '在 GitHub → Settings → Developer settings → Personal access tokens 生成 token，勾选 ',
                      h('code', null, 'repo'),
                      ' 权限（只读公开仓库可用 ',
                      h('code', null, 'public_repo'),
                      '）。'),
                  ),

              loginError ? h('div', { className: 'dpg-login-err' }, loginError) : null,

              h('div', { className: 'dpg-login-help' },
                '令牌只保存在本机宿主进程（可用时写入 DSH 凭据库），不会存入浏览器，也不会回显。'),
            )))
      }

      function navTabs() {
        return TABS.map((item) =>
          h('button', {
            key: item.id,
            type: 'button',
            className: 'dpg-nav-item' + (tab === item.id ? ' on' : ''),
            title: item.label,
            onClick: () => {
              setTab(item.id)
              setError('')
              setNotice('')
            },
          },
            icon(item.icon),
            item.label,
            item.id === 'pulls' && pulls.length
              ? h('span', { className: 'dpg-count' }, String(pulls.length))
              : null))
      }

      function renderPicker() {
        if (!pickerOpen) return null
        const needle = pickerFilter.trim().toLowerCase()
        const list = (repos || []).filter((item) =>
          !needle || item.fullName.toLowerCase().includes(needle) || String(item.language || '').toLowerCase().includes(needle))
        return h(
          'div',
          null,
          h('div', { className: 'dpg-backdrop', onClick: () => setPickerOpen(false) }),
          h('div',
          { className: 'dpg-picker' },
          h('div', { className: 'dpg-picker-head' },
            h('input', {
              className: 'dpg-input',
              placeholder: '搜索我的仓库…',
              value: pickerFilter,
              autoFocus: true,
              onChange: (event) => setPickerFilter(event.target.value),
            })),
          h('div', { className: 'dpg-picker-list' },
            repos === null
              ? h('div', { className: 'dpg-picker-empty' }, '加载中…')
              : list.length === 0
                ? h('div', { className: 'dpg-picker-empty' },
                    repos.length === 0 ? '没有可用的仓库' : '没有匹配的仓库')
                : list.map((item) =>
                    h('div', {
                      key: item.fullName,
                      className: 'dpg-picker-item' + (item.fullName === repo ? ' on' : ''),
                      onClick: () => selectRepo(item.fullName),
                      title: item.description || item.fullName,
                    },
                      h(Avatar, { name: item.owner, size: 24 }),
                      h('div', { style: { minWidth: 0, flex: 1 } },
                        h('div', { className: 'dpg-picker-name' }, item.fullName),
                        h('div', { className: 'dpg-picker-sub' },
                          [item.language, item.private ? 'private' : 'public',
                            item.pushedAt ? relativeTime(item.pushedAt) : ''].filter(Boolean).join(' · '))),
                      item.private ? h('span', { className: 'dpg-lock' }, 'Private') : null))),
          ),
        )
      }

      const showCodeToolbar = tab === 'code' || tab === 'file'

      return h(
        'div',
        { className: 'dpg-root' },
        h('div', { className: 'dpg-nav' }, navTabs()),
        h('div', { className: 'dpg-head' },
          h('div', { className: 'dpg-picker-wrap' },
            h('button', {
              type: 'button',
              className: 'dpg-switch',
              onClick: openPicker,
              title: '切换仓库',
            },
              h(Avatar, { name: parts.owner, size: 20 }),
              h('span', { className: 'dpg-repo-title' },
                h('span', { className: 'dpg-owner' }, parts.owner),
                h('span', { className: 'dpg-muted' }, '/'),
                h('span', { className: 'dpg-repo-name' }, parts.name)),
              h('span', { className: 'dpg-caret' }, '▼')),
            renderPicker()),
          repoInfo ? h('span', { className: 'dpg-pill' }, repoInfo.private ? 'Private' : 'Public') : null,
          h('span', { className: 'dpg-spacer' }),
          h('button', { type: 'button', className: 'dpg-btn ghost', title: '刷新', onClick: refresh,
            disabled: loading }, icon('refresh'), '刷新'),
          h('button', { type: 'button', className: 'dpg-btn ghost dpg-signout', title: '退出登录并清除已保存的 token',
            onClick: signOut }, '退出'),
          h('button', { type: 'button', className: 'dpg-btn ghost', title: 'Fork 到你的账号',
            disabled: busy === 'fork', onClick: forkRepo },
            icon('fork'), `Fork ${repoInfo ? repoInfo.forks : 0}`),
          h('button', {
            type: 'button',
            className: 'dpg-btn' + (overview && overview.starred ? ' on' : ''),
            title: overview && overview.starred ? '取消 Star' : 'Star 该仓库',
            disabled: busy === 'star',
            onClick: toggleStar,
          }, icon('star'),
            `${overview && overview.starred ? 'Starred' : 'Star'} ${overview && overview.repo ? overview.repo.stars : repoInfo ? repoInfo.stars : ''}`),
          repoInfo && repoInfo.htmlUrl
            ? h('a', { className: 'dpg-btn ghost', href: repoInfo.htmlUrl, target: '_blank', rel: 'noreferrer' },
                icon('link'), '打开')
            : null),
        h('div', { className: 'dpg-body' },
          h('div', { className: 'dpg-grid' },
            h('div', null,
              showCodeToolbar
                ? h('div', { className: 'dpg-toolbar', style: { paddingTop: 0, paddingBottom: 6 } },
                    h('select', {
                      className: 'dpg-select',
                      value: currentBranch,
                      onChange: (event) => switchBranch(event.target.value),
                      title: `切换分支（共 ${branches.length} 个）`,
                    },
                      (branches.length ? branches : [{ name: currentBranch || 'main' }]).map((item) =>
                        h('option', { key: item.name, value: item.name }, item.name))),
                    h('div', { className: 'dpg-crumbs' }, breadcrumb()),
                    h('div', { className: 'dpg-search' },
                      icon('search'),
                      h('input', {
                        className: 'dpg-input',
                        placeholder: 'Go to file',
                        value: filter,
                        onChange: (event) => setFilter(event.target.value),
                      })),
                    h('button', {
                      type: 'button',
                      className: 'dpg-btn',
                      title: '添加文件 / 新建分支',
                      onClick: () => setForm(form === 'menu' ? '' : 'menu'),
                    }, 'New ▾'))
                : null,
              form === 'menu'
                ? h('div', { className: 'dpg-menu' },
                    h('button', { type: 'button', className: 'dpg-menu-item', onClick: () => setForm('upload') },
                      'Add file…'),
                    h('button', { type: 'button', className: 'dpg-menu-item', onClick: () => setForm('branch') },
                      'New branch…'))
                : null,
              form === 'branch' ? renderBranchForm() : null,
              form === 'upload' ? renderUploadForm() : null,
              tab === 'code' ? h('div', null, renderCommitRow(), renderFiles(), renderReadme()) : null,
              tab === 'file' ? renderFileView() : null,
              tab === 'pulls' ? renderPulls() : null,
              tab === 'newPull' ? renderNewPull() : null,
              error ? h('div', { className: 'dpg-note err' }, error) : null,
              notice ? h('div', { className: 'dpg-note ok' }, notice) : null),
            renderSidebar())),
      )
    }

    function apply(ctx) {
      try {
        installStyles()
        if (!ctx || !ctx.slots) {
          console.error('[dsh-plugin-github] slots service is unavailable; panel not mounted')
          return
        }
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PLUGIN_ID }, () => h(Panel)))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PLUGIN_ID, order: 40, label: () => 'GitHub' },
            (props) => icon('repo', props && typeof props.size === 'number' ? props.size : 18)))
      } catch (error) {
        console.error('[dsh-plugin-github] client activation failed:', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
