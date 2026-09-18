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

## Web Search & Extract

`web_search` / `web_extract` are provided by a single extension
(`extensions/web-search.ts`) with **api-first, local-fallback** routing:

- **api backend** — a self-hosted [Firecrawl](https://github.com/firecrawl/firecrawl)
  instance. `web_search` calls `/v1/search`; `web_extract` calls `/v1/scrape`
  (renders JavaScript).
- **local backend** — no instance needed. `web_search` runs a local search
  engine chain (brave → google → duckduckgo → bing) built for restrictive
  firewalls; `web_extract` does a plain-HTTP fetch (no JS rendering, clearly
  labeled).

The `backend` parameter selects the routing: `auto` (default) uses the api
when it is configured and healthy, falling back to local when the api is
unavailable, fails, or returns nothing; `api` forces the api (errors instead
of falling back); `local` forces the local path.

### Configuration

| Var | Meaning |
|---|---|
| `PI_FIRECRAWL_URL` | Origin (scheme + host + port) of the instance, e.g. `http://firecrawl.internal:3002`. Do **not** include `/v1` — the client appends it. Unset or empty → api backend disabled (local paths only). Trailing slashes are trimmed. |
| `PI_FIRECRAWL_DISABLE` | Value `true` forces the api backend off even when `PI_FIRECRAWL_URL` is set. Any other value, or unset, has no effect. |
| `WEB_SEARCH_ENGINES` | Comma-separated local chain (subset/reordering of `brave,google,duckduckgo,bing`). |

Set these in your shell profile (e.g. `~/.bashrc`). The deployment target is a
**keyless** instance on a trusted internal network — the client sends no
Authorization header (the old `PI_FIRECRAWL_API_KEY` is removed).

### Security & privacy

- Every URL that will be fetched (the api `url` parameter **and** the local
  plain fetch, including every redirect target) passes an `assertPublicUrl`
  guard that denies `localhost`/`*.local` and private/loopback IPs
  (`127.*`, `0.*`, `10.*`, `169.254.*`, `172.16.*`–`172.31.*`, `192.168.*`,
  `::1`, `fc00::/7`, `fe80::/10`). A blocked URL is a clean tool error, not a
  crash. The guard is **string-based** (no DNS resolution): a public hostname
  that resolves to an internal IP is *not* caught — it is a guardrail against
  accidental or model-driven probing, not a security boundary.
- Consequence: the local fetch (and the api, for scrape targets) cannot reach
  private/loopback URLs. On an internal network, internal-page extraction
  needs the api backend pointed at a reachable instance.
- **Privacy:** the api path sends the query (search) and the target URL plus
  page content (extract) to the Firecrawl instance. On a trusted-network
  deployment that is the point; `PI_FIRECRAWL_DISABLE` and
  `backend: "local"` are the opt-outs.

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
  - `web-search.ts` — `web_search` / `web_extract` tools (Firecrawl api with local fallback) + `/websearch` command
  - `notify.ts` — desktop notifications on agent events
  - `subagent.ts` — delegate tasks to subagents (single / parallel / chain)
  - `subprocess.ts` — run subprocesses sync/async with status checks
  - `sync.ts` — `/sync` and `/sync-up` commands (this file)
- `prompts/` — prompt templates (`.md` → `/name` commands)
- `skills/` — agent skills
