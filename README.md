# dsh-approve-for-me

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) host plugin that adds an **approve-for-me** approval mode.

When enabled, every approval request that reaches the DSH answerer chain is judged by an LLM safety reviewer against a summary of the prior conversation. The model answers `ALLOW` or `REJECT`. Destructive high-risk commands — `rm -r`, `rm -rf`, `drop table`, `drop database`, and friends — skip the model entirely and are sent to the normal interactive user prompt.

> The plugin does **not** add a new `approve-for-me` policy enum (that is hardcoded in the host package `dsh-user-approval`). It works inside the existing `ask` approval policy: the plugin's enabled state *is* the mode switch. The DSH approval audit events (`approval/asked` + `approval/decided`) are still recorded normally.

## Behavior

- Listens on `approval/request` with `prepend: true`, so it runs before the interactive (user-prompt) answerer.
- Extracts the concrete action text for the request:
  - `command` from bash-family tool-call arguments,
  - tool arguments JSON for other tools,
  - or the request `reason` as a fallback.
- If the action (or the request reason) matches a high-risk pattern → `next()`, i.e. the normal user approval prompt.
- Otherwise it sends the LLM:
  - the **conversation summary** (most recent ~12k chars of user messages, assistant tool activity, and tool calls),
  - the **requested action** (tool name, reason, command/args).
- The model must reply with exactly one word: `ALLOW` or `REJECT`.
  - `ALLOW` → `allowed-once`
  - `REJECT` → `rejected`
  - unparseable / timeout / model error / no model service → `next()` (falls back to asking the user; never silently allows, never silently rejects)

## High-risk patterns

The following are matched as exact patterns against the extracted action text (case-insensitive regex, no `g` flag):

- `rm -r`, `rm -rf`, `rm -fr`, `rm -R`, `rm -rfv`, ... (any `rm` with an `r` flag)
- `rm ... /` (recursive/force remove targeting the filesystem root)
- `drop table`, `drop database`, `drop schema`
- `truncate table ...`
- `delete from ...`
- `mkfs`, `mkfs.ext4`, ...
- `dd if=`
- `shred`, `wipefs`
- `git push -f` / `git push --force`
- `git reset --hard`
- `chmod -R 777`, `chown -R`
- fork bomb `:(){ :|:& };:`

## Install (static, survives restart)

### Option A: `dsh plugin add` (recommended)

The package declares `dsh.bundle.patch`, so `dsh plugin add` installs it and
adds it to the profile's `dsh.profile.bundles` automatically — no manual
patch editing.

Clone the repo, then from the directory that contains it run:

```bash
git clone https://github.com/shifan3/dsh-approve-for-me.git
dsh plugin --profile web add ./dsh-approve-for-me
```

Or by absolute path:

```bash
dsh plugin --profile web add /path/to/dsh-approve-for-me
```

Or, once it is published to npm:

```bash
dsh plugin --profile web add dsh-approve-for-me
```

Then restart `dsh web`. The command runs `pnpm add` inside
`~/.dsh/profiles/web/`, then reconciles `dsh.profile.bundles` against the
installed package. The row that activates the plugin lives in this repo's
`cordis.patch.yml`.

### Option B: manual home patch layer

If you prefer not to use `dsh plugin`, clone the repo into your DSH home and
insert the row into `~/.dsh/cordis.patch.yml` yourself (applies to every
profile):

```bash
mkdir -p ~/.dsh/plugins
git clone https://github.com/shifan3/dsh-approve-for-me.git ~/.dsh/plugins/approve-for-me
```

Then create or extend `~/.dsh/cordis.patch.yml` with:

```yaml
- insert:
    - id: approve-for-me
      name: '../../plugins/approve-for-me/lib/index.js'
      config:
        enabled: true
        provider: deepseek-official
        model: deepseek-v4-flash
        maxTokens: 512
        summaryMaxChars: 12000
        timeoutMs: 60000
```

Then restart `dsh web`. The relative `name` resolves against each profile
directory (`~/.dsh/profiles/<name>/`), so `../../plugins/...` reaches
`~/.dsh/plugins/...` for the shipped `web`, `tui`, and `cc-tui` profiles.

> If you previously installed via Option B and then switch to Option A,
> remove the `approve-for-me` insert from `~/.dsh/cordis.patch.yml` first so
> the row is not defined twice.

### Enable / disable / configure

- Disable: set `enabled: false` in the row config and restart.
  - Option A: add an id-targeted override to the profile patch
    (`~/.dsh/profiles/web/cordis.patch.yml`):
    ```yaml
    - id: approve-for-me
      config:
        enabled: false
    ```
  - Option B: edit the insert block in `~/.dsh/cordis.patch.yml`.
- Uninstall:
  - Option A: `dsh plugin --profile web remove dsh-approve-for-me`, then restart.
  - Option B: remove the `insert` block (or the whole patch file), then restart.
- Config keys (all optional):
  - `enabled` (default `true`)
  - `provider` (default `deepseek-official`)
  - `model` (default `deepseek-v4-flash`)
  - `maxTokens` (default `512`)
  - `summaryMaxChars` (default `12000`)
  - `timeoutMs` (default `60000`)

## Install (dynamic, per-run)

If you prefer not to write to `~/.dsh`, you can load `host-code.js` as a dynamic Cordis Host package (does not survive restart):

- Web UI: open the Cordis panel → new Plugin (id prefix such as `afm`) → paste `host-code.js` as the Host code → run.
- With `cordis_define` / `cordis_run`: read `host-code.js` and pass it as `code.host`.

## Files

- `lib/index.js` — static host plugin (ESM, no runtime dependencies).
- `host-code.js` — dynamic Cordis Host package variant (same logic, sandbox-safe subset).
- `cordis.patch.yml` — bundle patch (declared via `dsh.bundle.patch`) that activates the plugin row.

## Limitations

- The dynamic variant runs in the DSH dynamic-host vm sandbox: no `setTimeout` / `AbortController`, so its timeout relies on the LLM adapter's `streamIdleTimeoutMs` (default 300s). The static variant uses a real `AbortSignal.timeout`.
- The session approval policy still displays as `ask`; the plugin is a prepended answerer, not a new policy enum.
- Only one approve-for-me answerer should be active: if you load both the static and the dynamic variant, the later-prepended one wins.

## License

MIT
