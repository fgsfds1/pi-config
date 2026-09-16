# pi-config

My [pi](https://pi.dev) coding-agent configuration, synchronized across devices
via GitHub. Installed as a pi package: extensions, prompt templates, and skills.

## Setup (new device)

1. Install pi (see [quickstart](https://pi.dev/quickstart)).
2. Install this package — the repo is public, so **no auth is needed**:

   ```sh
   pi install git:github.com/fgsfds1/pi-config
   ```

3. **Optional, for pushing** (`/sync-up`): give the device write access —
   either add its SSH public key to GitHub, or configure a git credential
   (PAT) for `github.com`.

## Syncing

Pi keeps git packages in a live clone at
`~/.pi/agent/git/github.com/fgsfds1/pi-config` and loads resources directly
from it — **that clone is the working copy**. Edit files there; no separate
checkout needed. (Override the path with `PI_SYNC_DIR` if you move it.)

| Command | What it does |
|---|---|
| `/sync` | `git pull --rebase --autostash` in the clone → reload |
| `/sync-up [message]` | `git add -A` + commit + push in the clone → reload |

Workflow: edit files in the clone, `/sync-up "what changed"`, then `/sync`
on the other device. Conflicts are plain git conflicts — resolve in the
clone, then push.

> **Caveat:** `pi update --extensions` / `pi update --all` reset the clone to
> the remote when the remote has moved, wiping uncommitted edits. Run
> `/sync-up` first if you have unsaved changes.

## Firecrawl

`web_search` / `web_extract` talk to a self-hosted [Firecrawl](https://github.com/firecrawl/firecrawl)
instance. Configure per device with `PI_FIRECRAWL_URL`:

| Value | Behavior |
|---|---|
| unset | defaults to `http://localhost:3002` |
| a URL | uses that instance, e.g. `https://fc.example.com` |
| `off` or empty | disables both tools entirely |

Set it in your shell profile (e.g. `~/.bashrc`), or disable per device with
`pi config` (package resource filtering).

## Per-device files (not synced)

These live in `~/.pi/agent/` and are intentionally **not** in this repo —
they are machine-specific or may contain secrets:

- `settings.json` — model/provider defaults, theme (see `settings.example.json`)
- `auth.json` — API keys and provider env overrides
- `trust.json` — project trust decisions (absolute paths)
- `models-store.json` — auto-generated model catalog
- `sessions/` — session history

The `.gitignore` guards against committing them by accident.

## Contents

- `extensions/`
  - `clipboard.ts` — `clipboard_read` / `clipboard_write` tools
  - `firecrawl.ts` — `web_search` / `web_extract` tools (self-hosted Firecrawl)
  - `notify.ts` — desktop notifications on agent events
  - `subagent.ts` — delegate tasks to subagents (single / parallel / chain)
  - `subprocess.ts` — run subprocesses sync/async with status checks
  - `sync.ts` — `/sync` and `/sync-up` commands (this file)
- `prompts/` — prompt templates (`.md` → `/name` commands)
- `skills/` — agent skills
