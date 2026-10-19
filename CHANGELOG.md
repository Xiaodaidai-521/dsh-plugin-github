# Changelog

## 1.3.3

The change strip can be closed — for one change, not for good.

- **A close control on the strip.** `✕` at the end of the header puts the strip away. It acknowledges the
  change set the host reported (`at|seq`), so polling the same change every 10 seconds cannot bring it back
  immediately, and a **newer** change re-opens the strip on its own — closing means "I have seen this",
  never "stop supervising me".
- The acknowledgement lives in memory, not in storage: it survives switching panels but resets on reload, so
  the strip is back the next time you open the app or switch repositories.
- Tests: `verify-agent.mjs` now drives a real click on the close control with a stateful hook harness, and
  proves the strip stays closed for the same change set and returns for the next one.

## 1.3.2

The panel can no longer disappear and leave a blank white column.

- **Crash found and removed.** The panel called `props.useSessions()` — an optional hook that a root-scoped
  main panel is not guaranteed to have — from inside a `try/catch`, after 35 unconditional `useState` calls.
  A hook that throws (or that appears on a later render) corrupts React's hook ledger, the render throws, and
  the slot registry retires the entry as *abdicated*. The seat still had its sidebar icon, but the panel
  column rendered nothing at all. Session identity now comes from the plain `sessionId` prop only; no hook is
  called here that the seat does not guarantee.
- **A blank column is now impossible.** The seat is wrapped in an error boundary: if the panel ever throws, it
  renders the real error message plus `重试` instead of vanishing, and logs
  `[dsh-plugin-github] panel crashed:` with the stack.
- Tests: `verify-client.mjs` now fails if the optional hook is ever called again, and renders a deliberately
  throwing panel to prove the boundary shows the message rather than a white column.

## 1.3.0

The panel stops being a repository browser with a status line and starts being a supervision console.

- **Per-session changes.** The tracker is keyed by Session, so the strip can no longer show another
  session's edits. The client asks for the session it can identify (`useSessions` through the slot
  props, best effort) and the host falls back to the newest entry.
- **No more lying about time.** The strip reads `智能体 N 分钟前改了 …` from the host timestamp instead of
  claiming "just now", and polls every 10 seconds while Code is open.
- **An exit, not just telemetry.** `开 PR` turns the change set into a pull-request draft: a title from the
  first file, and a body listing every changed path with the added/deleted totals.
- **The fact lives in the table too.** Files the agent touched float to the top of the file table and
  carry a dot, so the strip and the table tell one story.
- **One working surface.** `Star / Fork / 在 GitHub 打开 / 退出登录` moved behind a single `⋯` menu; the
  header is now `刷新` + `⋯`. Those are once-a-month actions, not working controls.

## 1.2.0

The panel now knows what the session's agent is doing.

- **Agent-changes strip.** Above the commit row: how many files the agent just changed, the added/deleted
  counts, one chip per file, and a click opens the real diff (hunks rendered inline) without leaving the
  page.
- Source of truth is the host's workspaceChanges service. The plugin remembers the newest
  workspace/changes sequence from the session/event feed, then asks that service for the summary and
  for each file's diff — so nothing is re-implemented and no snapshot is duplicated.
- Degrades silently: no service, no recorded change, or a non-text file simply hides the strip.

This is the first feature a github.com replica cannot have: the clone shows what the repository
contains, this shows what just happened to it.

## 1.0.2

A sign-in now survives more than a day.

- Persist the token to **both** the DSH credential store and an AES-256-GCM encrypted `token.json`.
  The store belongs to the host; when its entry disappeared (profile rebuild, update, reset) the panel
  silently became "signed out". The encrypted file is the independent copy that survives it.
- Emit the `state` diagnostic **before** any early return and include the auth failure, so a rejected
  token can no longer be invisible in `harness.log`.
- On `401`, delete the dead token from both places and flag `reauthRequired`; the sign-in screen explains
  that the previous session was invalidated instead of failing forever.
- `scripts/verify-persist.mjs`: assert a working credential store does not replace the disk backup.

## 1.0.1

- **One-click sign-in with no setup.** The package ships its own public OAuth App client id. The plugin
  config, `GITHUB_OAUTH_CLIENT_ID` and the value saved from the sign-in screen all override it.
- **Encrypted token at rest.** When the credential store cannot hold the token it is written with
  AES-256-GCM under a machine/user-derived key; plaintext files from earlier builds migrate on the next
  sign-in. A modified file fails its authentication tag instead of being used.
- PAT sign-in and the device flow share one persistence path (the PAT path previously persisted nothing).
- Request the `workflow` scope: GitHub answers **404** when a write touches `.github/workflows/` without it.

## 1.0.0

First working release.

- Panel: GitHub-style code page (branch picker, tag/branch counts, `Go to file`, latest-commit row, file
  table with each entry's last commit, README card), right rail with About / Releases / Contributors /
  Languages, working tabs for Code, Issues, Pull requests and Actions, star/unstar, fork, inline file
  viewer, upload, new branch, new pull request.
- Sign-in: OAuth device flow and Personal Access Token. The token never reaches the browser; the device
  flow's polling secret stays host-side.
- 14 agent tools, including `github_commit` for many files in one atomic commit (Git Data API).
- Plain ESM, no runtime dependencies, no build step. Ten verification scripts, CI runs the offline ones.
