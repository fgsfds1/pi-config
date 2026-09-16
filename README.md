# pi-config

My [pi](https://pi.dev) coding-agent configuration, synchronized across devices
via GitHub. Installed as a pi package: extensions, prompt templates, and skills.

## Setup (new device)

1. Install pi (see [quickstart](https://pi.dev/quickstart)).
2. Install this package — the repo is public, so **no auth is needed**:

   ```sh
   pi install git:github.com/fgfsfds1/pi-config
   ```

3. **Optional, for pushing** (`/sync-up`): give the device write access —
   either add its SSH public key to GitHub, or configure a git credential
   (PAT) for `github.com`.
4. **Optional, for editing**: clone a working checkout. The sync commands
   operate on this checkout (default path `~/projects/pi-config`, override
   with `PI_SYNC_DIR`):

   ```sh
   git clone git@github.com:fgfsfds1/pi-config ~/projects/pi-config
   ```

## Syncing

| Command | What it does |
|---|---|
| `/sync` | Pull latest from GitHub → `pi update --extensions` → reload |
| `/sync-up [message]` | `git add -A` + commit + push in the checkout → apply locally |

Workflow: edit files in the checkout, `/sync-up "what changed"`, then `/sync`
on the other device. Conflicts are plain git conflicts — resolve in the
checkout, then push.

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
