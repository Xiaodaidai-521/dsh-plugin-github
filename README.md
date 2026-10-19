# dsh-plugin-github

[![ci](https://github.com/Xiaodaidai-521/dsh-plugin-github/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiaodaidai-521/dsh-plugin-github/actions/workflows/ci.yml)

GitHub integration for DeepSeek Harness — sign in with your GitHub account, browse repositories the way github.com lays them out, and drive branches, pull requests, issues, Actions and file commits straight from the agent.

<p align="center">
  <img src="icon.svg" width="72" alt="">
</p>

## What you get

A **GitHub panel** in the left rail:

- **Sign in with GitHub** (OAuth device flow) — no Personal Access Token to create by hand
- Repository switcher: every repository the token can reach, searchable, remembered across restarts
- GitHub-style code page: branch picker, tags/branches counts, `Go to file` filter, latest-commit row, a file table showing each entry's last commit, and a README card
- Right rail: About / Releases / Contributors / Languages (GitHub's language colours)
- Tabs that actually work: **Code**, **Issues**, **Pull requests**, **Actions**
- Star / unstar and fork buttons
- Inline file viewer, `Add file` upload, `New branch`, `New pull request`

And **14 agent tools**, so the assistant can do the same work without you clicking:

| Tool | Purpose |
| --- | --- |
| `github_auth_status` | Which account the token belongs to, and where it came from |
| `github_repo_info` | Default branch, visibility, stars, forks, watchers |
| `github_list_branches` / `github_create_branch` | Inspect and create branches |
| `github_list_pulls` / `github_get_pull` / `github_create_pull` | Review and open pull requests |
| `github_list_files` / `github_read_file` | Browse and read a repository without cloning |
| `github_upload_file` / `github_delete_file` | Create, update or remove a single file |
| `github_commit` | Commit many files in **one atomic commit** (Git Data API) |
| `github_list_commits` | Recent commits, optionally per path |

## Install

The plugin is plain ESM with no runtime dependencies and no build step.

### 1. Make the package resolvable by name

DSH discovers the panel (`dsh.client`) from the **package manifest**, so the plugin must resolve as a package rather than as a bare file path. Link it into the profile's `node_modules`:

```powershell
# Windows
$nm = "$env:APPDATA\dsh-desktop\harness\profiles\web\node_modules"
New-Item -ItemType Junction -Path "$nm\dsh-plugin-github" -Target "C:\path\to\dsh-plugin-github"
```

```bash
# macOS / Linux
ln -s /path/to/dsh-plugin-github "$HOME/.config/dsh-desktop/harness/profiles/web/node_modules/dsh-plugin-github"
```

### 2. Add the loader row

Append to the profile's `cordis.patch.yml`:

```yaml
# >>> dsh-plugin-github >>>
- insert:
    - id: dsh-plugin-github
      name: dsh-plugin-github
# <<< dsh-plugin-github <<<
```

Optional config on that row:

```yaml
      config:
        repository: 'owner/name'   # default repo when a call omits `repo`
        oauthClientId: 'Ov23li…'   # OAuth App client id (see below)
        tokenEnv: GITHUB_TOKEN
        apiUrl: https://api.github.com
```

### 3. Restart DSH Desktop

Host plugins are composed at startup; a hand-edited patch is not re-read live. Quit completely (including the tray) and start again.

## Signing in

### One-click: OAuth device flow (recommended)

Register a GitHub OAuth App **once** — about a minute — and the client id is a **public** value you can ship with the plugin so every user gets one-click sign-in:

1. <https://github.com/settings/applications/new>
2. Name and homepage can be anything.
3. **Authorization callback URL**: any valid URL, for example `https://github.com/login/device` — the device flow never redirects, but the form rejects an empty value.
4. Scroll down and tick **Enable Device Flow**. The flow fails without it.
5. Copy the **Client ID**.

Paste it into the panel's sign-in screen (stored in `<DSH_HOME>/storages/dsh-plugin-github/config.json`), or supply it through the patch config / `GITHUB_OAUTH_CLIENT_ID`.

**Sign in with GitHub** then shows an 8-character code; enter it at `github.com/login/device` and the panel continues on its own.

The requested scopes are `repo read:user read:org workflow`. `workflow` is included because
GitHub answers **404** — not 403 — when a write touches `.github/workflows/` without it.

### Fallback: Personal Access Token

The sign-in screen also accepts a PAT — `repo` scope, or `public_repo` for read-only public work.

### Where the token lives

A successful sign-in writes **both** places, on purpose:

- The DSH credential store (`GITHUB_TOKEN`), written through `ctx.credentials` — the preferred one.
- `<DSH_HOME>/storages/dsh-plugin-github/token.json` — an independent copy, **AES-256-GCM encrypted**,
  with the key derived from the machine name, the current user and the platform.

The second copy exists because the credential store is owned by the host: a profile rebuild, an app
update or a reset can drop the entry, and then the panel silently becomes "signed out" and asks you to
sign in again. Keeping an independent, encrypted copy is what makes a sign-in survive that.

The file is unreadable on another account or machine, and a modified file fails its authentication tag
instead of being used. What the encryption buys, honestly: it removes the "plaintext secret sitting on
disk" case. It is **not** a secret store — anyone who can already run code as this user can re-derive the
key.

If GitHub ever rejects a saved token with 401, the plugin deletes it from both places and asks for a
fresh sign-in rather than failing forever.

- The token is **never** sent to the browser, never stored in `localStorage`, and never echoed in any response.

Resolution order: credential store → token saved by the panel → environment (`GITHUB_TOKEN` / `GH_TOKEN`) → `gh auth token`. Signing out removes the saved copies and suppresses the environment / `gh` fallbacks for that process.

## Security notes

- The panel is a browser module; it talks to the host over two POST routes (`api/dsh-plugin-github/state` and `.../action`). The token stays host-side.
- The device-flow polling secret never leaves the host; the browser only ever sees the short user code.
- Sign-in validates the token against `GET /user` before storing it, so a typo never becomes the saved credential.

## Known limits

- Sign-in state is per host, not per DSH user — the last account signed in is the one used.
- The panel implements Code / Issues / Pull requests / Actions. Projects, Wiki, Security and Insights are deliberately absent rather than shown as dead tabs.
- `github_commit` requires the target branch to exist; create it first with `github_create_branch` or in the panel.
- The bundled client id identifies this plugin's OAuth App, **not you**: every user who signs in
  authorizes their own GitHub account, and the resulting token never leaves their machine.
- Writing a file under `.github/workflows/` needs the `workflow` scope; without it GitHub answers 404.

## Verifying it yourself

The repository ships the same scripts used to validate every behaviour above:

```bash
node scripts/verify-client.mjs     # browser-bundle contract, mounts, both screens, render smoke
node scripts/verify-json.mjs       # every tool result is lossless JSON
node scripts/verify-login.mjs      # PAT sign-in, refusal of bad tokens, sign-out
node scripts/verify-device.mjs     # device-flow wiring
node scripts/verify-clientid.mjs   # a client id saved from the UI survives a restart
node scripts/verify-persist.mjs    # token persistence and a real sign-out
node scripts/verify-repos.mjs      # repository switcher list
node scripts/verify-overview.mjs   # About / Releases / Contributors / Languages data
node scripts/verify-browse.mjs     # directory listing and file reads
node scripts/verify-oauth-live.mjs <client-id>   # full device flow, end to end
```

Most of them talk to the live GitHub API, so they need a token on the machine (`GITHUB_TOKEN` or `gh auth login`).

## License

MIT — see [LICENSE](LICENSE).
