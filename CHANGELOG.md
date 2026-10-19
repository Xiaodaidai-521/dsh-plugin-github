# Changelog

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
