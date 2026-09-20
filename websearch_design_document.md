# Unified web_search / web_extract extension -- design document

Status: approved for implementation
Date: 2026-09-17
Target repo: fgsfds1/pi-config (branch main)
Deliverable: extensions/web-search.ts (new), extensions/firecrawl.ts (deleted), README updated

## 0. Purpose

Two existing extensions provide web access:

1. A machine-local extension, `web-search.ts`, that scrapes public search engines
   (brave, google, duckduckgo, bing) with bot-challenge retries and a decoy-result
   coverage warning. Zero dependencies, zero credentials, no arbitrary-URL fetching.
   Verbatim source: Appendix A.
2. A package extension, `firecrawl.ts`, that talks to a self-hosted, keyless
   Firecrawl instance: `web_search` (POST /v1/search) and `web_extract`
   (POST /v1/scrape). Verbatim source: Appendix B.

They register the same tool name (`web_search`), so on any machine that has both,
one is filtered out in settings. This document specifies ONE unified extension
that replaces both:

- `web_search` -- search the web. A Firecrawl api backend is the main path when
  configured and healthy; the local scraper chain is the automatic fallback.
- `web_extract` -- fetch a page as markdown/html/links via the api backend; when
  the api backend is unavailable or fails, a degraded plain-HTTP fetch (no JS
  rendering) is the fallback, clearly labeled.

The same file runs on every machine. Machine-specific behavior is expressed
entirely through environment variables:

- Machine A (corporate laptop, restrictive egress, no reachable instance):
  PI_FIRECRAWL_URL unset -> behaves EXACTLY like today's local scraper
  extension. Tool output is byte-identical (that is the regression gate, S10).
- Machine B (keyless self-hosted Firecrawl instance on the internal network):
  PI_FIRECRAWL_URL set -> api-first, local fallback on failure or on a clean
  api empty.

Why this shape:

- The model sees two stable, vendor-neutral tool names with one escape-hatch
  parameter, instead of two competing tools that collide on a name.
- A machine that loses its instance (network change, instance down) degrades to
  full local capability automatically instead of losing web access.
- The false negative observed on Machine B -- the api returned success with
  zero results where results demonstrably existed, and the tool result looked
  green/clean -- is addressed three ways: (1) in `auto` mode a clean api empty
  triggers a second opinion from the local chain (section 5.1); (2) every empty
  result states its provenance (section 9); (3) a rollout-time instance sanity
  check, I1 (section 12), which targets the most likely root cause: a
  self-hosted instance whose search provider is not configured returns
  success with empty data.

## 1. Rules for the implementing agent

You are implementing this on a machine with push access to fgsfds1/pi-config.
This document is self-contained; you do not need access to either source
machine. Read sections 2-14 first.

- Where this document specifies behavior, follow it exactly. Where it is
  silent, Appendix A behavior is canonical for the local path and Appendix B
  behavior is canonical for the api request/response shapes.
- Appendices A and B are base64-encoded with sha256. Decode both and verify
  the hashes before using anything from them. Do not hand-modify the decoded
  sources; the unified file reuses large portions of them verbatim (section 11
  lists exactly what is verbatim and what is new).
- The decoded sources intentionally contain non-ASCII characters (a warning
  marker, a checkmark, ellipsis characters, em dashes, box-drawing characters
  in the TUI overlay). They are part of user-visible output and must survive
  byte-identical into the final file. This document is ASCII by construction;
  the code is not.
- The final file is UTF-8, tab-indented (matching the local extension's
  style, which is the dominant style of the reused code).
- Implement, run the section 12 tests, push only after they pass.
- Keep commit messages short and imperative, e.g.
  "Unify web_search/web_extract: api backend with local scraper fallback".

## 2. Files and repo changes

- ADD `extensions/web-search.ts` (single file; expected ~1100-1300 lines).
- DELETE `extensions/firecrawl.ts`.
- UPDATE the README: replace the firecrawl entry with web-search in the
  extension list; document PI_FIRECRAWL_URL, PI_FIRECRAWL_DISABLE and
  WEB_SEARCH_ENGINES in the env table; include the security/privacy notes from
  section 10.
- No new dependencies. Imports are the union of the two appendices' imports
  (all from @earendil-works/pi-coding-agent, @earendil-works/pi-ai,
  @earendil-works/pi-tui, and typebox; all already used by the package).

## 3. Configuration

Exactly three environment variables govern the unified extension:

| Var | Meaning |
|---|---|
| PI_FIRECRAWL_URL | Origin (scheme + host + port) of a self-hosted Firecrawl instance, e.g. `http://firecrawl.internal:3002`. Do NOT include `/v1` -- the client appends `/v1/search` and `/v1/scrape` itself. Unset or empty -> api backend disabled (local paths only). Trailing slashes are trimmed. This keeps the existing convention from Appendix B EXCEPT that the old default of `http://localhost:3002` when unset is REMOVED: unset now means "no api backend". |
| PI_FIRECRAWL_DISABLE | Value `true` forces the api backend off even when PI_FIRECRAWL_URL is set.
Any other value, or unset, has no effect. |
| WEB_SEARCH_ENGINES | Comma-separated local chain (subset/reordering of brave,google,duckduckgo,bing). Existing convention from Appendix A, unchanged. |

The old `PI_FIRECRAWL_API_KEY` is REMOVED: the client sends no Authorization
header at all. The target deployment is a keyless instance on a trusted
internal network. Keyed-instance support is future work (section 14).

Availability, evaluated per call:

	apiAvailable =
		PI_FIRECRAWL_URL is set and trim() != ""
		and PI_FIRECRAWL_DISABLE != "true"
		and the breaker is not tripped (section 5.3)

## 4. Tool contracts

### 4.1 web_search

TypeBox schema:

	Type.Object({
		query: Type.String({ description: "Search query" }),
		count: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 15, description: "Number of results to return (default 5)" }),
		),
		backend: Type.Optional(
			StringEnum(["auto", "api", "local"] as const, {
				description: "'auto' (default): api backend if configured and healthy, else the local search engine chain -- including as a second opinion when the api returns no results. 'api': force the api backend; errors instead of falling back. 'local': force the local chain.",
		}),
		),
		engine: Type.Optional(
			StringEnum(["auto", "brave", "google", "duckduckgo", "bing"] as const, {
				description: "Constrains the local chain to one engine (applies whenever the local path runs; ignored otherwise). 'auto' (default) tries the chain in order.",
			}),
		),
		freshness: Type.Optional(
			Type.String({ description: "api backend only: time filter, e.g. 'day', 'week', 'month', 'year', '7d', '30d', or a raw tbs value like 'qdr:w'. Best-effort: most of the api's search engines apply it, but not all (a note is appended to the results). Ignored by the local backend." }),
		),
		tbs: Type.Optional(
			Type.String({ description: "api backend only: raw Google time-based search string (e.g. 'qdr:w'). Takes precedence over freshness. Best-effort: most of the api's search engines apply it, but not all (a note is appended to the results). Ignored by the local backend." }),
		),
		lang: Type.Optional(
			Type.String({ description: "api backend only: language code (e.g. 'en', 'zh', 'ja'). Ignored by the local backend." }),
		),
		country: Type.Optional(
			Type.String({ description: "api backend only: country code (e.g. 'us', 'cn', 'jp'). Ignored by the local backend." }),
		),
		filter: Type.Optional(
			Type.String({ description: "api backend only: domain filter (e.g. 'github.com'). Ignored by the local backend." }),
		),
	})

Notes:
- Parameter renamed from the old api tool: `limit` -> `count` (matches the
  local tool; both defaulted to 5). Unified cap is 15 (the local chain's cap;
  the api allows 20, we clamp).
- `freshness`/`tbs`/`lang`/`country`/`filter` are accepted in all modes but
  applied only by the api backend; the local backend silently ignores them
  (documented in the description; the model should not expect them to work
  locally).
- `tbs`/`freshness` are BEST-EFFORT even on the api backend: the Firecrawl
  search backend only applies a time filter where its underlying search
  engines support one (SearXNG maps the mappable values to
  `time_range=day|week|month|year`; values without an equivalent such as
  `qdr:7d` are dropped). So a "fresh" result set is a request, not a
  guarantee. To keep the agent from treating "fresh" as verified, when
  `tbs`/`freshness` is set AND the results came from the api backend, a note
  is appended to the results (section 9): `(time filter "<tbs>" is
  best-effort: most of the api's search engines apply it, but not all -
  verify recency before relying on it)`.
  - Per-engine reality (verified 2026-09-19 against
    `searxng/searxng:latest`, effective config = image defaults +
    `/home/lw/llms/search/searxng/settings.yml`): of the 7 active
    general-category engines, **6 apply the time filter** — google, google
    cse, yahoo, mojeek, swisscows (module-level `time_range_support = True`)
    and brave (instance-level `time_range_support: true` in the image's
    default settings; the module default is `False`, time-range only for
    `brave_category: search`/goggles, which is the active instance).
    **wikipedia does not** (no `time_range_support` in its module). The
    note says "most ... but not all" — accurate for this deployment; if the
    engine curation changes (re-checked on SearXNG image bumps), re-verify
    and adjust the wording if the majority flips.
- `engine` constrains the local chain; useful with `backend: "local"`, or as
  the fallback half of `auto`.

Exact description string (model-facing; use verbatim):

"Search the web and return top results as title, URL, and snippet. Backend: 'auto' (default) uses the Firecrawl api backend when PI_FIRECRAWL_URL is set and healthy, falling back to the local search engine chain (brave, google, duckduckgo, bing) when the api is unavailable, fails, or returns no results; 'api' forces the api backend (error instead of falling back); 'local' forces the local chain. The local chain is built for restrictive firewalls: engines are tried in order with retries on bot-challenge pages. freshness/tbs/lang/country/filter apply only to the api backend and are ignored by the local chain. Results are best-effort and may occasionally be incomplete or off; when no result title/snippet/URL contains a quoted query phrase or any significant query word, a coverage warning is appended -- verify such results against the source."

promptSnippet:
"Search the web; returns titles, URLs and snippets from top results"

promptGuidelines:
- "Use web_search for information that is not in the local workspace: documentation, API references,
  library versions, recent events, or anything the user expects to be verified online."
- "Use web_extract to read full content from URLs returned by web_search."

### 4.2 web_extract

TypeBox schema:

    Type.Object({
      url: Type.String({ description: "URL to extract content from (public http/https URLs only)" }),
      format: Type.Optional(
        StringEnum(["markdown", "html", "links"] as const, { description: "Output format (default: markdown)" }),
      ),
      backend: Type.Optional(
        StringEnum(["auto", "api", "local"] as const, {
          description: "'auto' (default): api backend if configured and healthy (renders JavaScript), else a plain-HTTP fetch that is clearly labeled as not rendering JS. 'api': force the api backend;
 errors instead of falling back. 'local': force the plain fetch.",
        }),
      ),
      wait_seconds: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 30, description: "api backend only: seconds to wait for page load before extracting (default: 0). Ignored by the local backend." }),
      ),
      selector: Type.Optional(
        Type.String({ description: "api backend only: HTML tag name to extract only (e.g. 'article', 'main'). Ignored by the local backend." }),
    ),
      include_links: Type.Optional(
        Type.Boolean({ description: "Also extract links from the page (default: false). Works on both backends." }),
      ),
      mobile: Type.Optional(
        Type.Boolean({ description: "api backend only: use mobile viewport (default: false). Ignored by the local backend." }),
      ),
    })

Exact description string (model-facing; use verbatim):

"Extract web page content as clean markdown (or raw html, or the page's links). Backend: 'auto' (default) uses the Firecrawl api backend when PI_FIRECRAWL_URL is set and healthy (renders JavaScript), falling back to a plain-HTTP fetch -- no JS rendering, clearly labeled -- when the api is unavailable or fails; 'api' forces the api backend; 'local' forces the plain fetch. wait_seconds, selector, and mobile apply only to the api backend. JavaScript-heavy pages may return little content from the local backend."

promptSnippet:
"Extract web page content as markdown/html/links (api renders JS; local is a plain fetch)"

promptGuidelines:
- "Use web_extract to read full page content from a URL."
- "Use web_extract after web_search to read the full content of search results."
- "Use wait_seconds for JavaScript-heavy or slow-loading pages (api backend)."

## 5. Search routing and failure semantics

### 5.1 Routing

`backend` values (default `auto`):

- `local`: run the local chain (honoring `engine`). No api involvement, no
annotation. Output is byte-identical to Appendix A's behavior.
- `api`: require apiAvailable; if not, throw:
 `api backend unavailable (set PI_FIRECRAWL_URL and ensure PI_FIRECRAWL_DISABLE is not "true")`.
Run the api search. Any failure (5.2) -> throw the error. NO fallback, ever:
an explicit request for the api that silently becomes an unfiltered local
scrape (dropping freshness/tbs/etc.) would be worse than an error.
 A clean api empty -> `No results found for "<query>". (api backend)`.
- `auto` (default):
 - apiAvailable is true:
 - api search returns results -> return them (section 9), no annotation.
 - api search clean empty (success, data === []): SECOND OPINION -- run the
 local chain (honoring `engine`):
 - local has results -> return them, first line:
 `api backend returned no results for this query - results from local search`
 - local clean empty ->
 `No results found for "<query>". (api backend: no results; local engines: no results)`
 - local all-failed -> throw `web_search failed for "<query>": api: no results | local: <failures...>`.
  - api search fails (any 5.2 failure) -> breaker.note(kind, reason); run
 the local chain:
  - local has results -> first line:
  `(api backend unavailable: <reason> - results from local search)`
  - local clean empty -> throw
  `web_search failed for "<query>": api: <reason> | local: clean empty`
  - local all-failed -> throw
  `web_search failed for "<query>": api: <reason> | local: <failures...>`
- apiAvailable is false: run the local chain directly. No annotation, no
 wasted call, no breaker interaction. Output identical to `backend:"local"`.

The second opinion on a clean api empty is deliberate and is the fix for the
observed Machine B false negative (a self-hosted instance with a
misconfigured search provider returns success + zero results where results
exist). Cost: one extra local run, and only on empties.

### 5.2 What counts as an api failure

Detected in this order:

1. Network error / connection refused / DNS failure -> reason
 `unreachable (<message>)`
2. Timeout (70s) -> reason `timed out after 70s`
3. HTTP status not 2xx -> reason `HTTP <status>`
 (401/403 and 429 are handled by the breaker, 5.3)
4. Malformed JSON body -> reason `malformed response`
5. `success === false` -> reason from the response's `error` field, or
 `api reported failure`
6. `success === true` but `data` missing, null, or (search) not an array
 -> reason `malformed response (missing data)`
7. Invalid `freshness`/`tbs` input -> validated BEFORE any api call, and only
 when the api backend will be used (apiAvailable, or backend "api"); throw
 immediately with no fallback (input error, not backend failure). Reuse
 `freshnessToTbs` from Appendix B (it throws a descriptive error for
 invalid values).

### 5.3 Circuit breaker

Module-level state per pi process:

    { trippedUntil: number, lastError: string, failStreak: number }

(trip timestamps in epoch ms; `Infinity` means "for the session").

- 401/403 -> `trippedUntil = Infinity`, `lastError = "HTTP 401/403"`. A bad
 credential/configuration will not fix itself within a session; do not pay a
 call's latency per query.
- 429 -> `trippedUntil = now + 10 min`.
- Failure classes 1, 2, 3 (other statuses), 4, 5, 6 -> `failStreak++`; when
 `failStreak >= 2` -> `trippedUntil = now + 10 min`.
- Any api success -> `failStreak = 0`.
- While `now < trippedUntil`: `auto` mode silently skips the api (local chain
 only, no annotation); explicit `api` throws
 `api backend cooling down after: <lastError>`.
- No persistence. Headless invocations start fresh, which is the correct
 conservative default.

### 5.4 Stage (partial) updates

Reuse Appendix A's `onUpdate` partial mechanism, with stage strings:

- api phase: `trying api backend...`
- on api failure in auto mode: `api backend failed (<reason>), trying local engines...`
- then Appendix A's existing local-chain partial behavior, unchanged.

## 6. web_extract semantics

### 6.1 Routing

- `backend: "local"`, or `auto` with !apiAvailable: degraded plain fetch
(6.3). First line of the output is the label
 `[local fetch - no JS rendering]`. No annotation (no api was attempted).
- `backend: "api"`: require apiAvailable (same error text as 5.1); run the api
scrape; any failure or empty content -> throw (no fallback).
- `backend: "auto"` with apiAvailable:
 - api scrape (rung 1, normal browser UA) succeeds with clean content ->
 return it (6.2), no label.
 - api scrape fails (any 5.2 failure) -> breaker.note; run the plain fetch
 (6.3, browser UA); if it yields content -> output = label line +
 `(api backend unavailable: <reason>)` + content.
 If the plain fetch also fails -> throw with both reasons.
 - api scrape succeeds but the content is empty or looks challenged
 (6.4) -> the plain-UA ladder:
   - rung 2: api scrape with the plain UA (payload `headers:
    {"user-agent": "pi-fetch/1.0"}` -- the api forwards `headers` to the
    browser service, which uses a user-agent header there as the context
    UA override). Clean content -> `[plain-UA api retry after
    <challenge|no content>]` + content.
   - rung 3 (auto only -- explicit api never falls back to local): the
    plain fetch with the plain UA (6.3). Clean content ->
    `[local fetch - no JS rendering - plain UA]` + content.
   - rung 4 (auto only, markdown format, 6.5): the Jina Reader fallback
    (`https://r.jina.ai/<url>`). A third-party renderer that clears the
    CF-hard class the local browser can't (REPORT-antibot.md step 3).
    Clean content -> `[Jina Reader fallback after <challenge|no content>]`
    + content. `backend: "jina"` in details.
   - no clean rung -> return the FIRST rung that produced any content +
    `[challenge detected - retries did not improve]` (or `[no clean content
    - retries did not improve]`); when no rung produced any content ->
    throw `Extraction returned no content for <url> (api)` / `(api and
    local)` as before.

### 6.2 Api scrape path

Request/response shapes: EXACTLY as Appendix B --
POST /v1/scrape, payload `{ url, formats, waitFor?, includeTags?, mobile?,
headers? }` (formats = [format] plus "links" when include_links; waitFor =
wait_seconds * 1000 when > 0; includeTags = [selector]; headers =
`{"user-agent": PLAIN_USER_AGENT}` ONLY for the plain-UA rung, 6.4),
response envelope
`{ success, error?, data? { markdown?, html?, links?, metadata? } }`
(metadata.statusCode is the upstream page status).

Additions over Appendix B:

- 70s timeout on the fetch (Appendix B has none; a hanging instance must not
 hang the tool). Kept above the self-hosted v1 scrape deadline (45 s) so the
 api's own 408 reaches the router before this ceiling does.
- Envelope validation per 5.2 items 4-6 (scrape's item 6 is
 `success === true` but `!data` -> `malformed response (missing data)`).
- NO Authorization header (keyless; section 3).
- Output assembly unchanged from Appendix B: `Title: ...` line (when
metadata.title present), `truncateHead(content, { maxLines:
DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })` with the
 `[Output truncated: ...]` note, then the `Links (N):` section (first 20
links, `... and N more` overflow) when links exist.

### 6.3 Degraded plain fetch (the "local" backend)

- assertPublicUrl guard (section 10) FIRST. This path fetches directly from
 the user's machine, so the guard is mandatory here even though Appendix B
 lacks one.
- http/https only. GET via global fetch, `redirect: "manual"` in a hop loop
(max 10 hops): every redirect target must itself pass assertPublicUrl
(global fetch would follow blindly otherwise; this closes redirect-based
SSRF). Per-call cookie jar: every response's Set-Cookie values are stored
(host-scoped, latest-wins per name+host) and sent back on subsequent hops --
some sites gate content behind a redirect+Set-Cookie handshake (307 ->
/?rr=1 + cookie) that cookieless clients loop on forever (undici's fetch
has no cookie jar). Scope: this call only, no persistence.
- 20s timeout. Body cap 2 MB (beyond -> error `page too large for local
fetch`). User-Agent: the first Chrome UA from Appendix A's USER_AGENTS, or
PLAIN_USER_AGENT when the caller passes it (the ladder's plain-UA rung,
6.4). Challenge-gated retry: when the first attempt (browser UA) comes back
challenged (6.4), exactly one retry with PLAIN_USER_AGENT; best-result --
keep the first attempt if the retry is still challenged or fails.
- format `markdown` (default), the html-to-text pipeline:
  1. Remove `<script>`, `<style>`, `<noscript>`, `<template>`, `<head>`
     elements including their contents.
  2. Insert a newline at each block-level tag boundary (p, div, br, hr, li,
     h1-h6, tr, table, section, article, header, footer, blockquote, pre).
  3. Strip all remaining tags.
  4. Decode entities (reuse Appendix A's `decodeEntities`).
  5. Collapse runs of 3+ newlines to 2; trim trailing whitespace per line;
     trim the whole.
  6. Cap output at 100k characters; append ` [truncated]` when cut.
     Prepend a `Title: <title>` line (from `<title>`) when present.
- format `html`: the raw fetched HTML, 2 MB cap, ` [truncated]` when cut.
- format `links`: all `<a href>` targets -- absolute URLs kept, relative
  resolved against the request URL, protocol-relative (`//host/...`) unwrapped
  to https -- deduped, max 200, output as `Links (N):` + one URL per line
  (same shape as the api path's links section, so the model sees one format).
- JavaScript-app heuristic (markdown format only): if the final text is under
  200 characters AND the raw HTML is over 5000 characters, append:
  `(page appears to be a JavaScript application - the static fetch returned little content; the api
  backend renders JS and would be needed for full content)`
- Output ordering: label line (`[local fetch - no JS rendering]`), optional
  auto-fallback annotation line (6.1), then the content per format.
- Details shape: `{ url, title?, format, backend: "local", linkCount?,
  statusCode, truncated? }` (the api path's details carry statusCode too).

### 6.4 Challenge detection (the plain-UA ladder)

Some WAFs apply a higher bar to browser UAs (JS/fingerprint checks) and let
self-identifying bots through: Anubis's default policy challenges only UAs
containing "Mozilla", and several measured CF/403 cases (danbooru,
codeberg, gitlab.gnome, atwiki) passed with a plain UA. Detection gates the
ladder; it never rejects content on its own.

> **Service-side note (step ②, firecrawl fork `c5ea72b6d`):** the
> self-hosted api's playwright service now ALSO handles challenges
> internally, detection-gated (Anubis PoW solved in Node, plain-UA probe in
> the same browser context, solver wait with a 5 s margin). So rung 1 (api,
> browser UA) already absorbs most Anubis/UA-gated challenges before this
> ladder ever runs; the ladder remains the backstop for what the service
> leaves challenged (CF fingerprint / IP-reputation class) and for the local
> path. Details: `REPORT-antibot.md` §12 and
> `playwright-overlay/README.md` in the deployment dir.

- `looksChallenged(statusCode, body)`: true when statusCode is in
  {403, 406, 429, 498, 503} OR a marker appears in the first 3 KB of the
  body (lowercased): `anubis`, `making sure you're not a bot`, `just a
  moment`, `cf-chl`, `please enable cookies`, `fab_chlg`, `recaptcha`,
  `проверк`, `доступ ограничен`. Deliberately conservative -- generic words
  ("robot", "captcha") false-positive on real content. A wrong retry is
  cheap (best-result logic keeps the first clean result); a wrong skip is
  not.
- `PLAIN_USER_AGENT = "pi-fetch/1.0"`: an honest non-browser UA. Tried only
  after a challenge is detected on the normal attempt, so normal requests
  are unaffected.
- The ladder is plugin-driven and transparent to the model: the model sees
  only the final result plus the winning rung's annotation.
- renderCall/renderResult: reuse Appendix B's renderers; the collapsed
  success line reads `checked via local fetch` (vs Appendix B's
  `checked`); the Jina rung reads `via Jina Reader (third-party)`. Error
  states: the unified extension throws (pi's standard error rendering
  applies), so Appendix B's `details.error` branch is dropped as
  unreachable.

### 6.5 Jina Reader fallback (rung 4)

The last rung of the `web_extract` ladder (auto mode, markdown format,
detection-gated). `r.jina.ai` is a third-party scraping service that renders
JS and clears bot challenges. Measured (REPORT-antibot.md step 3): it clears
the CF-hard class (economist/producthunt/substack/ycombinator) in 1–2 s where
the local browser is challenged. It is the last resort because it sends the
URL to a third party (privacy), so it is only reached when every local rung
(api browser-UA, api plain-UA, local plain-UA) was challenged or empty.

- `jinaFetch(url, signal)`: GET `https://r.jina.ai/<url>` with
  `Accept: text/plain` (+ `Authorization: Bearer $PI_JINA_KEY` when set).
  25 s timeout. Parses the Jina header (`Title:` / `Markdown Content:`) and
  returns the markdown body + title.
- Optional `PI_JINA_KEY` raises the rate limit (~20 RPM keyless, ~200 RPM
  with). A Jina failure (rate limit / network) falls through to the
  no-clean-rung fallback/error (it never hard-fails the extract).
- `details.backend = "jina"` (distinct from `api`/`local`); the result label
  is `[Jina Reader fallback after <challenge|no content>]`.

## 7. Local scraper backend (detailed technique)

This section specifies the local path in detail. Appendix A is the canonical
implementation and is reused verbatim (section 11). Everything below must
survive byte-identical in behavior: Machine A's regression gate (S10) is
byte-identical tool output.

### 7.1 Engines and chain

Four engines; default chain order brave -> google -> duckduckgo -> bing;
`WEB_SEARCH_ENGINES` overrides (subset or reordering; unknown names dropped;
empty/invalid value -> default chain). Rationale is encoded in Appendix A's
comments and must be kept:

- brave: primary; roughly 1/3 of requests hit an anti-bot challenge page
  (and 429s under rapid use) -- the UA-rotating retry exists for it.
- google: non-JS SERP (`gbv=1`); often works on normal networks, blocked on
  some corporate egress.
- duckduckgo: lite.duckduckgo.com; works with compressed requests; challenged
  from some datacenter IPs.
- bing: parseable HTML, but from flagged IPs it can serve irrelevant "decoy"
  result sets -- hence last in the chain.

Chain semantics (`searchWeb`): iterate the chain; the first engine returning
>= 1 result wins. An engine that fails (blocked/unreachable after all
retries) records `<engine>: <error>` in the failures list; an engine that
answers cleanly with zero results sets `cleanEmpty`. Tool result:

- results > 0 -> formatted results (section 9).
- else cleanEmpty -> `No results found for "<query>".` (the api-related
  provenance variants in 5.1 apply only when the api was involved).
- else -> throw `web_search failed for "<query>": <failures joined by " | ">`.

### 7.2 Per-engine fetch (`fetchHtml` + `runEngine`)

- Transport preference: `curl` via `pi.exec` FIRST. curl uses the system CA
  store, which is what works behind corporate TLS-intercepting proxies; Node's
  bundled CA store rejects the corporate MITM certificates, and
  NODE_EXTRA_CA_CERTS only takes effect at Node startup, so it cannot be set
  from an extension. Falls back to global `fetch` when curl is unavailable
  (detected once, `curlUnavailable` flag; `resetCurlState()` for tests).
- curl arguments: `-sS -L --compressed --max-time <ceil(timeout/1000)> -A
  <UA>` plus Accept/Accept-Language headers, and `-w "\n__WS_STATUS__:%{http_code}"`
  appended after the body; the status marker is parsed off the tail and the
  body is everything before it.
- Retries: MAX_ATTEMPTS = 3 per engine. Each attempt rotates to the NEXT user
  agent in a 3-UA rotation (challenge pages frequently clear on UA change).
  Backoff: sleep 1s then 2s between attempts. Per-attempt timeout
  REQUEST_TIMEOUT_MS = 20000, combined with any external AbortSignal via
  `withTimeout`.
- Bot-challenge detection is per-engine (`isBlocked`), i.e. "this response is
  a challenge/error page, not results":
    brave:      status != 200 || html lacks `data-type="web"`
    google:     status != 200 || /enablejs|httpservice|/sorry/|unusual traffic/i || no `/url?q=` links
    duckduckgo: status != 200 || no `result-link` class
    bing:       status != 200 || no `b_algo` list items
- A blocked page is not an answer: it consumes a retry. After 3 attempts the
  engine is recorded as failed and the chain moves on.

### 7.3 Per-engine parsing

- brave: split on `<div ... data-type="web">`; per chunk: first http(s) href
  = url (entity-decoded); title from `div.title` (its `title` attribute, else
  inner HTML); snippet from `div.content` up to the first closing-div
  boundary.
- google: split on `<div class="g">`; link from `href="/url?q=<encoded>[&...]"`
  -- take the q parameter only (up to the first &), then `%26` -> `&` (Google
  double-encodes ampersands); must be http(s); dedupe by URL. Title from
  `<h3>`. Snippet: the first `<span>` of 30-600 chars occurring after `</h3>`
  within the chunk.
- duckduckgo: global regex over `<a class="result-link" href="...">` in either
  attribute order; unwrap protocol-relative `//` URLs and
  `duckduckgo.com/l/?uddg=<url>` redirect links (the real URL is in the
  `uddg` parameter). Snippet: the `result-snippet` cell that follows the link
  cell in the same table row -- search window: from the end of the match up to
  the next `result-link` or 4000 chars.
- bing: split on `<li class="b_algo">`; link from `h2 > a`; unwrap Bing's
  `/ck/a?u=a1<base64url>` redirect: the real URL is URL-safe base64 in the
  `u=a1...` parameter (restore `+`/`/` and `=` padding), used only if it
  decodes to something starting with `http`; snippet from the first `<p>`.
- All parsers: entity-decode, strip tags, collapse whitespace, truncate
  snippets to 300 chars, stop collecting at `count` results.
- Entity decoder (`decodeEntities`): hex and decimal numeric references via
  String.fromCodePoint, then the named references &quot;, &#39;/&apos;, &lt;,
  &gt;, &nbsp;, and &amp; LAST (so double-escaped entities decode exactly
  once).

### 7.4 URL-decoding pitfalls (do not "simplify" these)

- Google SERP hrefs are `/url?q=<url>&...`; take the q param only, then fix
  `%26` -> `&`.
- DuckDuckGo lite wraps results in `/l/?uddg=` redirects; the real URL is the
  parameter -- following the redirect would be an extra round-trip and more
  challenge surface.
- Bing wraps results in `/ck/a?u=a1<urlsafe-base64>`; decode only when the
  result starts with `http`.
- Protocol-relative `//host/path` URLs must be unwrapped to `https:`.
- Snippet/title HTML is entity-decoded AFTER tag stripping; `&amp;` decodes
  last.

### 7.5 Coverage (decoy) detection

Several engines (notably bing from flagged IPs, duckduckgo-lite from
datacenter IPs) never report "no results": for an unmatched query they
silently return a relaxed or decoy result set sharing no words with the
query. There is no reliable engine-side marker, so the tool checks coverage
itself (`coverageWarning`):

- Quoted phrases ("..." or '...', length >= 3, deduped): if NO result's
  title/snippet/URL contains the phrase -> a warning line naming the missing
  phrases, noting that snippets are truncated so the pages themselves may
  still contain the phrase (verify against the source).
- Significant tokens (alphanumeric, length >= 4, not in the stopword list;
  quoted phrases stripped first so their words do not double-count): if there
  are >= 2 such tokens and NO result contains ANY of them -> the stronger
  warning: the engine likely relaxed the query or returned decoy results;
  treat the set with caution (try another engine or a narrower query).
- The exact warning line text (including its leading marker character) is in
  Appendix A; preserve it byte-identically.
- Additionally, in `formatResults`: when >= 3 results all come from a single
  host, a single-host caution note is appended.

### 7.6 What the local path never does

- Never sends the query anywhere except the four engine domains.
- Never fetches arbitrary URLs (search only; page fetching is web_extract's
  job).
- api.duckduckgo.com (Instant Answer API) is deliberately NOT a search source
  (stripped/empty content for general queries) -- keep the comment saying so.

## 8. Api backend spec

- Base: PI_FIRECRAWL_URL (origin, trailing slashes trimmed). Paths appended:
  `/v1/search`, `/v1/scrape`. Same convention as Appendix B, except the old
  unset-default of `http://localhost:3002` is removed (section 3).
- POST, JSON body, header `Content-Type: application/json`. NO Authorization
  header (keyless deployment; section 3).
- 70s timeout (new; Appendix B had none).
- Response envelope: `{ success: boolean, error?: string, data?: ... }`.
  search data: array of `{ url, title, description }` (description may be
  an empty string).
  scrape data: `{ markdown?, html?, links?, metadata? }`.
- Envelope validation per section 5.2 items 4-6.
- Search payload: `{ query, limit: count, tbs?, lang?, country?, filter? }`
  with `tbs = params.tbs ?? freshnessToTbs(params.freshness)` when either is
  set (Appendix B's mapping: named values hour/day/week/month/year, patterns
  like `7d`/`30d`, raw `qdr:*` passthrough; invalid -> throw, 5.2 item 7).
- Normalization: an api result `{ url, title, description }` becomes a local
  SearchResult `{ title: title || "No title", url, snippet: description
  truncated to 300 chars }`. The result then goes through the unified
  formatting (section 9) -- including the coverage warning and the single-
  host note, which apply to api results as well as local ones.

## 9. Output contract

- Search result items: `{ title, url, snippet? }`; snippet <= 300 chars on
  BOTH backends (the api's description is truncated to match).
- Search text: Appendix A's `formatResults` behavior, verbatim, for both
  backends:

    Web search results for "<query>" (via <token>, <n>):
    <blank>
    1. <title>
        <url>
       <snippet>

       ...
    (optional single-host note)
    (optional coverage warnings)
    (optional tbs best-effort note, api results only)

  where `<token>` is the engine name (brave/google/duckduckgo/bing) for the
  local path -- exactly as today -- and `api` for the api path. The tbs note
  is appended (after the coverage warnings) only when `tbs`/`freshness` was
  set AND the results came from the api backend; it never appears on local
  results (the local chain ignores tbs by contract).
- Empty-result lines (provenance is always explicit):
    local, api not involved:     No results found for "<query>".
    backend "api", clean empty:  No results found for "<query>". (api backend)
    auto, api empty + local empty:
      No results found for "<query>". (api backend: no results; local engines: no results)
- Annotation lines (first line of the result, only when the local path
  answered in auto mode):
    (api backend unavailable: <reason> - results from local search)
    (api backend returned no results for this query - results from local search)
- Details (tool-result details, consumed by renderers/UI):
    search: { backend: "api" | "local", engine?: EngineName, query,
              results, failures?, stage? }
    extract: { url, title?, format, backend: "api" | "local", linkCount?,
               statusCode?, truncated? }
- web_extract output: Appendix B's assembly (Title line, truncateHead
  content, links section) plus the 6.3 additions for the local backend.

## 10. Security

- `assertPublicUrl` guard on EVERY url that will be fetched: the api path's
  `url` parameter AND the degraded plain fetch. Deny: host `localhost` or
  ending in `.local`; IPs `127.*`, `0.*`, `10.*`, `169.254.*`, `172.16.*`
  through `172.31.*`, `192.168.*`, `::1`, `fc00::/7`, `fe80::/10`, plus the
  IPv4-mapped IPv6 forms of the denied IPv4 ranges (`::ffff:127.0.0.1`,
  `::ffff:7f00:1`, ...). Appendix B currently has NO guard -- this is a new
  function in the unified file, and the guard error must be a clean tool
  error (e.g. `blocked non-public URL: <url>`), not a crash.
- Redirect re-validation on the plain fetch: every redirect target must pass
  assertPublicUrl (6.3).
- The guard is string-based (no DNS resolution): a public hostname that
  resolves to an internal IP is NOT caught. It is a guardrail against
  accidental or model-driven probing, not a security boundary. Say so in the
  README.
- Consequence: the plain fetch (and the api, for scrape targets) cannot reach
  private/loopback URLs. On an internal network, internal-page extraction
  needs the api backend pointed at a reachable instance.
- Privacy: the api path sends the query (search) and the target URL plus page
  content (extract) to the Firecrawl instance. On a trusted-network
  deployment that is the point; PI_FIRECRAWL_DISABLE and `backend: "local"`
  are the opt-outs. State this in the README.

## 11. Assembly spec (what is verbatim, what is new)

File: `extensions/web-search.ts`, Tab-indented. Layout:

1. Header comment (REWRITE, generic): purpose, the two backends, the three
   env vars. Do NOT carry Appendix A's header claims about one specific
   machine's firewall (brave "works here", google "blocked here", etc.) into
   the package file; keep the engine-rationale as neutral commentary in 7.1
   form.
2. Imports: the union of both appendices' imports
   (ExtensionAPI, ExtensionCommandContext, Theme, KeyHint, truncateHead,
   DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize from
   @earendil-works/pi-coding-agent; StringEnum from
   @earendil-works/pi-ai; matchesKey, Text, visibleWidth from
   @earendil-works/pi-tui; Type from typebox).
3. Config + availability + breaker (NEW; sections 3, 5.3).
4. Api client (FROM Appendix B, modified): `firecrawlFetch` with a 70s
   timeout, no auth header, and error throwing that carries the 5.2 reason
   string (so the router can classify failures by inspecting the thrown
   error); `freshnessToTbs` VERBATIM; NEW: a small `classifyApiError` that
   maps thrown errors to breaker kinds (401/403, 429, 5xx/timeout/network/
   malformed).
5. Local scraper core (FROM Appendix A, VERBATIM, minus its
   extension-registration tail): all types, USER_AGENTS, fetchHtml,
   resetCurlState, withTimeout, sleep, decodeEntities, stripTags, cleanText,
   parseBrave, parseBing, parseGoogle, unwrapDuckDuckGoUrl,
   parseDuckDuckGo, ENGINES, DEFAULT_CHAIN, autoEngineOrder, runEngine,
   searchWeb, SearchOptions, STOPWORDS, quotedPhrases, significantTokens,
   haystackOf, coverageWarning, hostOf, formatResults,
   SearchResultsOverlay. Keep all comments. Keep the existing exports
   (ExecFn, resetCurlState, searchWeb, coverageWarning, formatResults,
   WebSearchToolInput) -- they are harmless and useful for tests.
6. assertPublicUrl (NEW; section 10).
7. Degraded plain fetch (NEW; section 6.3), including the html-to-text
   pipeline, the links extraction, and the JS-app heuristic.
8. Unified routing: `runUnifiedSearch(query, params, signal, exec)` per 5.1
   (with 5.4 stage updates) and `runUnifiedExtract(url, params, signal)` per
   6.1.
9. Tool registrations: web_search + web_extract. Schemas per section 4.
   Descriptions/promptSnippet/promptGuidelines EXACTLY as section 4.
   renderCall/renderResult: from Appendix A (search: partial
   "Searching..." stage line, `N results via <engine>` collapsed line,
   coverage marker, expand hint; extend the collapsed line with the backend
   when it is not `auto` or when the api answered) and Appendix B (extract),
   adjusted per 6.3.
10. `/websearch` command (FROM Appendix A, rerouted through
    runUnifiedSearch with defaults engine auto / count 5; the overlay and the
    non-TUI notify summary are unchanged).

Expected size ~1100-1300 lines. If you find yourself rewriting Appendix A
logic instead of reusing it, stop: the local path must stay byte-identical.

## 12. Acceptance tests (all must pass before push)

Harness: a mock Firecrawl server (any trivial HTTP server on 127.0.0.1) +
PI_FIRECRAWL_URL pointed at it + headless pi (`pi --mode rpc --no-session`)
invoking the tools, watching the tool results. Note: some machines' security
agents block script execution from /tmp -- run test scripts from a writable
home directory instead.

Search (mock /v1/search):

- S1  200 `{success:true, data:[3 realistic items]}` -> results formatted,
  "(via api, 3)", snippets capped at 300 chars, coverage check applied,
  NO annotation line.
- S2  200 `{success:true, data:[]}` with a nonsense query (e.g.
  "zxqvwt plorb-98765") -> second opinion runs; expect
  `No results found ... (api backend: no results; local engines: no results)`.
- S3  200 `{success:false, error:"provider not configured"}` with a real
  query -> MUST NOT be a green empty: the local chain runs and the output
  is prefixed `(api backend unavailable: provider not configured - results
  from local search)`. This is the regression test for the observed
  Machine B false negative.
- S4  200 `{success:true}` with NO data field -> malformed; fallback;
  annotation present.
- S5  500 -> fallback; then 500 again -> the second failure sets a 10-minute
  cooldown; a third call within the window must skip the api (verify via
  the mock's hit counter, not just the output).
- S6  401 -> fallback; the breaker trips for the session: subsequent calls in
  the same pi process skip the api even if the mock now returns 200.
- S7  429 -> fallback + 10-minute cooldown (same hit-counter check as S5).
- S8  mock sleeps 75s -> the tool times out at 70s and falls back; it must
  not hang.
- S9  backend:"api" + mock 500 -> tool error (red), with NO local results in
  the output.
- S10 PI_FIRECRAWL_URL unset + a real query -> output BYTE-IDENTICAL to
  Appendix A's extension run for the same query/engine/count (the Machine
  A regression gate; diff the full tool text, including any warnings).
- S11 PI_FIRECRAWL_DISABLE=true with PI_FIRECRAWL_URL set -> behaves exactly
  like S10.
- S12 invalid freshness ("banana") with the api available -> immediate input
  error; no api call is made (mock hit counter unchanged); no local
  fallback.

Extract (mock /v1/scrape + public static pages for the local path):

- E1  200 `{success:true, data:{markdown:"# T\n\ntext", metadata:{statusCode:200, title:"T"}, links:
  ["http://x/y"]}}`
  -> `Title: T`, content, `Links (1):` section.
- E2  200 `{success:false, error:"boom"}` with a public url (e.g.
  https://example.com) -> auto: falls back to the plain fetch; output =
  label line + `(api backend unavailable: boom)` + fetched content.
  Explicit backend:"api": hard error containing "boom", no fetch.
- E3  PI_FIRECRAWL_URL unset, url = a public static page -> output starts
  `[local fetch - no JS rendering]`, then `Title: ...` and the markdown
  text.
- E4  format:"links" on a page with several links -> `Links (N):` + one URL
  per line, on both the api path (mock) and the local path.
- E5  a JavaScript-shell page (small visible text, script-heavy HTML) -> the
  JS-app heuristic line is appended.
- E6  url `http://127.0.0.1:1/` (and one 192.168.x variant) -> clean guard
  error; the mock/server hit counter proves no request was made.
- E7  mock /v1/scrape returns `{success:true, data:{markdown:""}}` for a
  public url that does have content -> second opinion: plain fetch runs;
  output = label + `(api backend returned no content - content from local
  fetch)` + content. (Requires egress to the public url; if the test
  machine has no egress, skip with a note.)
- E8  PI_FIRECRAWL_URL pointed at a dead port (e.g. http://127.0.0.1:1) with
  a public url -> api unreachable -> fallback annotation + local fetch
  content.

Command / UI smoke:

- C1  `/websearch <query>` in the TUI opens the overlay; in non-TUI mode the
  notify summary is produced. (One visual check suffices.)
- C2  pi starts cleanly with the new file; both tools are registered; no
  other extension registers web_search or web_extract (true after
  firecrawl.ts is deleted -- verify no startup collision).

Instance sanity check (Machine B, rollout time; targets the root cause of the
original green-empty report):

- I1  `curl -s -X POST $PI_FIRECRAWL_URL/v1/search -H 'Content-Type: application/json' -d '{"query":
  "OpenAI","limit":3}'`
  -> expect `success:true` with NON-EMPTY data. If the instance answers
  success + empty data for a query that must have results, its search
  provider is misconfigured (self-hosted Firecrawl search requires an
  external provider such as Serper; check the instance's environment and
  logs). Fix the instance before declaring rollout done.

## 13. Rollout checklist

Machine B (push-capable, has the instance):

1. Decode appendices A and B; verify both sha256 values.
2. Implement extensions/web-search.ts per section 11; delete
   extensions/firecrawl.ts; update the README.
3. Run the section 12 tests (S1-S12, E1-E8, C1-C2) plus I1.
4. Commit and push to main.
5. Update the local pi package (the package's sync/update flow) and restart
   pi.
6. Verify live: web_search answers "(via api, N)" with no annotation;
   web_extract renders a JS-heavy page.

Machine A (the corporate laptop; no instance; push is blocked but pull works):

7. Temporarily rename ~/.pi/agent/extensions/web-search.ts to
   web-search.ts.bak (two files registering the same tool name would collide;
   the local copy must not be active during verification).
8. /sync (pull) from the package.
9. Smoke: web_search with a real query -> output byte-identical to before
   (spot-check the S10 diff); /websearch works; web_extract on a public
   static page -> `[local fetch - no JS rendering]` output.
10. Only after step 9 passes: delete web-search.ts.bak.

Both machines:

11. settings.json: remove the now-stale `!extensions/firecrawl.ts` entry from
    the package's extensions list (keep `!extensions/clipboard.ts`).

## 14. Known limitations and future work

- The guard is string-based (no DNS resolution); a public hostname resolving
  to an internal IP is not caught.
- The plain fetch cannot reach private/loopback targets (guard); internal-
  page extraction requires the api backend on a network that can reach the
  instance.
- Keyed instances are unsupported (PI_FIRECRAWL_API_KEY removed); re-add if
  the deployment changes.
- web_map / LLM-based structured-extract endpoints are out of scope; the
  two-tool surface is deliberate.
- The 10-minute cooldown and the 70s/20s timeouts are hardcoded; promote to
  env vars only if they ever need tuning.
- Single file; if it grows past ~1500 lines, split into an
  extensions/web-search/ directory with index.ts (requires adding
  extensions/*/index.ts to the package's extensions glob in settings.json on
  every machine).
- The coverage warning applies to api results too; if the api's snippets are
  consistently too short for the token check, relax the threshold for api
  results (future).

## 15. Appendix A -- current local web-search.ts (verbatim, base64)

sha256 and line count follow; decode with `base64 -d` and verify the hash.
sha256: c33757cc8227d49181bc48f767e0270bec589700e05930dd9ff2813785ed9dba
lines:  785

```base64
LyoqCiAqIFBpIFdlYiBTZWFyY2ggRXh0ZW5zaW9uCiAqCiAqIFJlZ2lzdGVycyBhIGB3ZWJfc2Vh
cmNoYCB0b29sIHRoYXQgbGV0cyB0aGUgTExNIHNlYXJjaCB0aGUgd2ViIGJ5IHNjcmFwaW5nCiAq
IHB1YmxpYyBzZWFyY2ggZW5naW5lcywgcGx1cyBhIGAvd2Vic2VhcmNoIDxxdWVyeT5gIGNvbW1h
bmQgZm9yIG1hbnVhbCB1c2UuCiAqCiAqIERlc2lnbmVkIGZvciByZXN0cmljdGl2ZSBjb3Jwb3Jh
dGUgZmlyZXdhbGxzIHdoZXJlIHNvbWUgZW5naW5lcyBhcmUgYmxvY2tlZAogKiBvciBzZXJ2ZSBi
b3QtY2hhbGxlbmdlcy4gRW5naW5lcyBhcmUgdHJpZWQgaW4gb3JkZXIgd2l0aCByZXRyaWVzOgog
KgogKiAgIGJyYXZlICAgICAgIHNlYXJjaC5icmF2ZS5jb20gIOKAlCBwcmltYXJ5OyB3b3JrcyBi
ZWhpbmQgdGhpcyBmaXJld2FsbCwgYnV0CiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
ICAgICB+MS8zIG9mIHJlcXVlc3RzIGhpdCBhbiBhbnRpLWJvdCBjaGFsbGVuZ2UKICogICAgICAg
ICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhZ2UgKGFuZCA0MjlzIHVuZGVyIHJhcGlkIHVz
ZSksIHNvCiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXF1ZXN0cyBhcmUg
cmV0cmllZCB3aXRoIGEgZGlmZmVyZW50CiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
ICAgICB1c2VyIGFnZW50CiAqICAgZ29vZ2xlICAgICAgZ29vZ2xlLmNvbS9zZWFyY2g/Z2J2PTEg
KG5vbi1KUyB2ZXJzaW9uKSDigJQgb2Z0ZW4gd29ya3Mgb24KICogICAgICAgICAgICAgICAgICAg
ICAgICAgICAgICAgICAgIG5vcm1hbCBuZXR3b3JrcywgYmxvY2tlZCBoZXJlCiAqICAgZHVja2R1
Y2tnbyAgbGl0ZS5kdWNrZHVja2dvLmNvbSDigJQgd29ya3MgaGVyZSAod2l0aCAtLWNvbXByZXNz
ZWQgY3VybCk7CiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjaGFsbGVuZ2Vk
IGZyb20gc29tZSBkYXRhY2VudGVyIElQcwogKiAgIGJpbmcgICAgICAgIGJpbmcuY29tL3NlYXJj
aCDigJQgcGFyc2VhYmxlIEhUTUwsIGJ1dCBmcm9tIGZsYWdnZWQgSVBzIGl0IGNhbgogKiAgICAg
ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VydmUgaXJyZWxldmFudCAiZGVjb3kiIHJl
c3VsdCBzZXRzLCBzbwogKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaXQgaXMg
bGFzdCBpbiB0aGUgY2hhaW4KICoKICogU2V2ZXJhbCBlbmdpbmVzIChCaW5nLCBEdWNrRHVja0dv
LWxpdGUgZnJvbSBkYXRhY2VudGVyIElQcykgbmV2ZXIgcmVwb3J0CiAqICJubyByZXN1bHRzIjog
Zm9yIGFuIHVubWF0Y2hlZCBxdWVyeSB0aGV5IHNpbGVudGx5IHJldHVybiBhIHJlbGF4ZWQgb3IK
ICogZGVjb3kgcmVzdWx0IHNldCB0aGF0IHNoYXJlcyBubyB3b3JkcyB3aXRoIHRoZSBxdWVyeS4g
VGhlcmUgaXMgbm8gcmVsaWFibGUKICogZW5naW5lLXNpZGUgbWFya2VyIGZvciB0aGlzLCBzbyB0
aGUgdG9vbCBjaGVja3MgKmNvdmVyYWdlKiBpdHNlbGY6IHdoZXRoZXIKICogdGhlIHF1ZXJ5J3Mg
b3duIHF1b3RlZCBwaHJhc2VzIGFuZCBzaWduaWZpY2FudCB0b2tlbnMgYXBwZWFyIGluIGFueSBy
ZXN1bHQKICogdGl0bGUvc25pcHBldC9VUkwuIFdoZW4gdGhleSBkb24ndCwgYSDimqDvuI8gY292
ZXJhZ2Ugd2FybmluZyBpcyBhcHBlbmRlZC4KICoKICogVGhlIGNoYWluIGlzIGNvbmZpZ3VyYWJs
ZSB2aWEgdGhlIFdFQl9TRUFSQ0hfRU5HSU5FUyBlbnYgdmFyLCBlLmcuCiAqICAgV0VCX1NFQVJD
SF9FTkdJTkVTPWJyYXZlLGdvb2dsZSAgcGkKICoKICogTm90ZTogYXBpLmR1Y2tkdWNrZ28uY29t
IChJbnN0YW50IEFuc3dlciBBUEkpIGlzIHJlYWNoYWJsZSBmcm9tIHRoaXMKICogbWFjaGluZSBi
dXQgcmV0dXJucyBzdHJpcHBlZC9lbXB0eSBjb250ZW50IGZvciBnZW5lcmFsIHF1ZXJpZXMsIHNv
IGl0IGlzCiAqIG5vdCB1c2VkIGFzIGEgc2VhcmNoIHNvdXJjZS4KICovCgppbXBvcnQgdHlwZSB7
IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIFRoZW1lIH0gZnJvbSAiQGVh
cmVuZGlsLXdvcmtzL3BpLWNvZGluZy1hZ2VudCI7CmltcG9ydCB7IGtleUhpbnQgfSBmcm9tICJA
ZWFyZW5kaWwtd29ya3MvcGktY29kaW5nLWFnZW50IjsKaW1wb3J0IHsgU3RyaW5nRW51bSB9IGZy
b20gIkBlYXJlbmRpbC13b3Jrcy9waS1haSI7CmltcG9ydCB7IG1hdGNoZXNLZXksIFRleHQsIHZp
c2libGVXaWR0aCB9IGZyb20gIkBlYXJlbmRpbC13b3Jrcy9waS10dWkiOwppbXBvcnQgeyBUeXBl
IH0gZnJvbSAidHlwZWJveCI7CgovLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KLy8gVHlwZXMKLy8gLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tCgp0eXBlIEVuZ2luZU5hbWUgPSAiYnJhdmUiIHwgImdvb2dsZSIgfCAi
ZHVja2R1Y2tnbyIgfCAiYmluZyI7CgppbnRlcmZhY2UgU2VhcmNoUmVzdWx0IHsKCXRpdGxlOiBz
dHJpbmc7Cgl1cmw6IHN0cmluZzsKCXNuaXBwZXQ/OiBzdHJpbmc7Cn0KCmludGVyZmFjZSBXZWJT
ZWFyY2hEZXRhaWxzIHsKCWVuZ2luZTogRW5naW5lTmFtZSB8ICJhdXRvIjsKCXF1ZXJ5OiBzdHJp
bmc7CglyZXN1bHRzOiBTZWFyY2hSZXN1bHRbXTsKCWZhaWx1cmVzPzogc3RyaW5nW107CgkvKiog
U2V0IG9uIHBhcnRpYWwgKGluLWZsaWdodCkgcmVzdWx0cyBvbmx5ICovCglzdGFnZT86IHN0cmlu
ZzsKfQoKLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCi8vIEhUVFAgaGVscGVycwovLyAtLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0KCmNvbnN0IFVTRVJfQUdFTlRTID0gWwoJIk1vemlsbGEvNS4wIChYMTE7IExpbnV4
IHg4Nl82NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEy
Ni4wLjAuMCBTYWZhcmkvNTM3LjM2IiwKCSJNb3ppbGxhLzUuMCAoV2luZG93cyBOVCAxMC4wOyBX
aW42NDsgeDY0KSBBcHBsZVdlYktpdC81MzcuMzYgKEtIVE1MLCBsaWtlIEdlY2tvKSBDaHJvbWUv
MTI1LjAuMC4wIFNhZmFyaS81MzcuMzYiLAoJIk1vemlsbGEvNS4wIChNYWNpbnRvc2g7IEludGVs
IE1hYyBPUyBYIDEwXzE1XzcpIEFwcGxlV2ViS2l0LzYwNS4xLjE1IChLSFRNTCwgbGlrZSBHZWNr
bykgVmVyc2lvbi8xNy40IFNhZmFyaS82MDUuMS4xNSIsCl07Cgpjb25zdCBSRVFVRVNUX1RJTUVP
VVRfTVMgPSAyMF8wMDA7CmNvbnN0IE1BWF9BVFRFTVBUUyA9IDM7CgovKiogTWluaW1hbCBzaGFw
ZSBvZiBwaS5leGVjIChzbyB0aGUgY29yZSBjYW4gYmUgdGVzdGVkIHdpdGhvdXQgcGkpLiAqLwpl
eHBvcnQgaW50ZXJmYWNlIEV4ZWNGbiB7CgkoCgkJY29tbWFuZDogc3RyaW5nLAoJCWFyZ3M6IHN0
cmluZ1tdLAoJCW9wdGlvbnM/OiB7IHNpZ25hbD86IEFib3J0U2lnbmFsOyB0aW1lb3V0PzogbnVt
YmVyIH0sCgkpOiBQcm9taXNlPHsgc3Rkb3V0OiBzdHJpbmc7IHN0ZGVycjogc3RyaW5nOyBjb2Rl
OiBudW1iZXI7IGtpbGxlZDogYm9vbGVhbiB9PjsKfQoKLyoqIFNldCBvbmNlIHdoZW4gdGhlIGN1
cmwgYmluYXJ5IHR1cm5zIG91dCB0byBiZSB1bmF2YWlsYWJsZS4gKi8KbGV0IGN1cmxVbmF2YWls
YWJsZSA9IGZhbHNlOwoKZXhwb3J0IGZ1bmN0aW9uIHJlc2V0Q3VybFN0YXRlKCk6IHZvaWQgewoJ
Y3VybFVuYXZhaWxhYmxlID0gZmFsc2U7Cn0KCi8qKgogKiBGZXRjaCBhIHBhZ2Ugb3ZlciBIVFRQ
Uy4KICoKICogUHJlZmVycyBgY3VybGAgdmlhIGV4ZWM6IGN1cmwgdXNlcyB0aGUgc3lzdGVtIENB
IHN0b3JlLCB3aGljaCBpcyB3aGF0IG1ha2VzCiAqIHRoaXMgd29yayBiZWhpbmQgY29ycG9yYXRl
IFRMUy1pbnRlcmNlcHRpbmcgcHJveGllcyAoTm9kZSdzIGJ1bmRsZWQgQ0Egc3RvcmUKICogcmVq
ZWN0cyB0aGUgY29ycG9yYXRlIE1JVE0gY2VydGlmaWNhdGVzLCBhbmQgTk9ERV9FWFRSQV9DQV9D
RVJUUyBvbmx5IHRha2VzCiAqIGVmZmVjdCBhdCBOb2RlIHN0YXJ0dXAsIHNvIGl0IGNhbm5vdCBi
ZSBzZXQgZnJvbSBhbiBleHRlbnNpb24pLiBGYWxscyBiYWNrCiAqIHRvIGdsb2JhbCBmZXRjaCB3
aGVuIGV4ZWMvY3VybCBpcyBub3QgYXZhaWxhYmxlLgogKi8KYXN5bmMgZnVuY3Rpb24gZmV0Y2hI
dG1sKG9wdHM6IHsgdXJsOiBzdHJpbmc7IHRpbWVvdXRNczogbnVtYmVyOyBzaWduYWw6IEFib3J0
U2lnbmFsIHwgdW5kZWZpbmVkOyB1c2VyQWdlbnQ6IHN0cmluZzsgZXhlYz86IEV4ZWNGbiB9KTog
UHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBodG1sOiBzdHJpbmcgfT4gewoJY29uc3QgeyB1cmws
IHRpbWVvdXRNcywgc2lnbmFsLCB1c2VyQWdlbnQsIGV4ZWMgfSA9IG9wdHM7CgoJaWYgKGV4ZWMg
JiYgIWN1cmxVbmF2YWlsYWJsZSkgewoJCWNvbnN0IHIgPSBhd2FpdCBleGVjKCJjdXJsIiwgWwoJ
CQkiLXNTIiwKCQkJIi1MIiwKCQkJIi0tY29tcHJlc3NlZCIsCgkJCSItLW1heC10aW1lIiwKCQkJ
U3RyaW5nKE1hdGgubWF4KDUsIE1hdGguY2VpbCh0aW1lb3V0TXMgLyAxMDAwKSkpLAoJCQkiLUEi
LAoJCQl1c2VyQWdlbnQsCgkJCSItSCIsCgkJCSJBY2NlcHQ6IHRleHQvaHRtbCxhcHBsaWNhdGlv
bi94aHRtbCt4bWwsYXBwbGljYXRpb24veG1sO3E9MC45LCovKjtxPTAuOCIsCgkJCSItSCIsCgkJ
CSJBY2NlcHQtTGFuZ3VhZ2U6IGVuLVVTLGVuO3E9MC45IiwKCQkJIi13IiwKCQkJIlxuX19XU19T
VEFUVVNfXzole2h0dHBfY29kZX0iLAoJCQkiLS0iLAoJCQl1cmwsCgkJXSwgeyBzaWduYWwsIHRp
bWVvdXQ6IHRpbWVvdXRNcyArIDUwMDAgfSk7CgoJCWlmIChyLmNvZGUgPT09IDApIHsKCQkJY29u
c3QgbSA9IHIuc3Rkb3V0Lm1hdGNoKC9cbl9fV1NfU1RBVFVTX186KFxkezN9KSQvKTsKCQkJcmV0
dXJuIHsgc3RhdHVzOiBtID8gcGFyc2VJbnQobVsxXSEsIDEwKSA6IDAsIGh0bWw6IG0gPyByLnN0
ZG91dC5zbGljZSgwLCBtLmluZGV4ISkgOiByLnN0ZG91dCB9OwoJCX0KCQlpZiAoci5raWxsZWQp
IHRocm93IG5ldyBFcnJvcihgdGltZWQgb3V0IGFmdGVyICR7TWF0aC5jZWlsKHRpbWVvdXRNcyAv
IDEwMDApfXNgKTsKCQljb25zdCBzdGRlcnIgPSByLnN0ZGVyci50cmltKCkuc3BsaXQoIlxuIiku
ZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/IGBjdXJsIGV4aXQgJHtyLmNvZGV9YDsKCQlpZiAoci5j
b2RlID09PSAxMjcgfHwgL25vIHN1Y2ggZmlsZXxjb21tYW5kIG5vdCBmb3VuZC9pLnRlc3Qoc3Rk
ZXJyKSkgewoJCQljdXJsVW5hdmFpbGFibGUgPSB0cnVlOwoJCX0gZWxzZSB7CgkJCXRocm93IG5l
dyBFcnJvcihzdGRlcnIucmVwbGFjZSgvXmN1cmw6XHMqLywgIiIpKTsKCQl9Cgl9CgoJLy8gRmFs
bGJhY2s6IGdsb2JhbCBmZXRjaCAod29ya3Mgd2hlcmUgTm9kZSdzIENBIHN0b3JlIGlzIHRydXN0
ZWQsIGUuZy4gbm8gTUlUTSkuCgljb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsKCQloZWFk
ZXJzOiB7CgkJCSJVc2VyLUFnZW50IjogdXNlckFnZW50LAoJCQlBY2NlcHQ6ICJ0ZXh0L2h0bWws
YXBwbGljYXRpb24veGh0bWwreG1sLGFwcGxpY2F0aW9uL3htbDtxPTAuOSwqLyo7cT0wLjgiLAoJ
CQkiQWNjZXB0LUxhbmd1YWdlIjogImVuLVVTLGVuO3E9MC45IiwKCQl9LAoJCXJlZGlyZWN0OiAi
Zm9sbG93IiwKCQlzaWduYWw6IHNpZ25hbCA/PyBBYm9ydFNpZ25hbC50aW1lb3V0KG9wdHMudGlt
ZW91dE1zKSwKCX0pOwoJY29uc3QgaHRtbCA9IGF3YWl0IHJlcy50ZXh0KCk7CglyZXR1cm4geyBz
dGF0dXM6IHJlcy5zdGF0dXMsIGh0bWwgfTsKfQoKLyoqIENvbWJpbmUgYW4gb3B0aW9uYWwgZXh0
ZXJuYWwgYWJvcnQgc2lnbmFsIHdpdGggYSB0aW1lb3V0LiAqLwpmdW5jdGlvbiB3aXRoVGltZW91
dChzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLCBtczogbnVtYmVyKTogeyBzaWduYWw6
IEFib3J0U2lnbmFsOyBjYW5jZWw6ICgpID0+IHZvaWQgfSB7Cgljb25zdCBjb250cm9sbGVyID0g
bmV3IEFib3J0Q29udHJvbGxlcigpOwoJY29uc3Qgb25BYm9ydCA9ICgpID0+IGNvbnRyb2xsZXIu
YWJvcnQoc2lnbmFsPy5yZWFzb24pOwoJaWYgKHNpZ25hbCkgewoJCWlmIChzaWduYWwuYWJvcnRl
ZCkgY29udHJvbGxlci5hYm9ydChzaWduYWwucmVhc29uKTsKCQllbHNlIHNpZ25hbC5hZGRFdmVu
dExpc3RlbmVyKCJhYm9ydCIsIG9uQWJvcnQsIHsgb25jZTogdHJ1ZSB9KTsKCX0KCWNvbnN0IHRp
bWVyID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KG5ldyBFcnJvcigidGltZW91
dCIpKSwgbXMpOwoJdGltZXIudW5yZWY/LigpOwoJcmV0dXJuIHsKCQlzaWduYWw6IGNvbnRyb2xs
ZXIuc2lnbmFsLAoJCWNhbmNlbDogKCkgPT4gewoJCQljbGVhclRpbWVvdXQodGltZXIpOwoJCQlz
aWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoImFib3J0Iiwgb25BYm9ydCk7CgkJfSwKCX07Cn0K
CmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogUHJvbWlz
ZTx2b2lkPiB7CglyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHsKCQlpZiAoc2lnbmFs
Py5hYm9ydGVkKSByZXR1cm4gcmVzb2x2ZSgpOwoJCWNvbnN0IHRpbWVyID0gc2V0VGltZW91dChk
b25lLCBtcyk7CgkJZnVuY3Rpb24gZG9uZSgpIHsKCQkJY2xlYXJUaW1lb3V0KHRpbWVyKTsKCQkJ
c2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCJhYm9ydCIsIG9uQWJvcnQpOwoJCQlyZXNvbHZl
KCk7CgkJfQoJCWZ1bmN0aW9uIG9uQWJvcnQoKSB7CgkJCWRvbmUoKTsKCQl9CgkJc2lnbmFsPy5h
ZGRFdmVudExpc3RlbmVyKCJhYm9ydCIsIG9uQWJvcnQsIHsgb25jZTogdHJ1ZSB9KTsKCX0pOwp9
CgovLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KLy8gSFRNTCBoZWxwZXJzCi8vIC0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLQoKZnVuY3Rpb24gZGVjb2RlRW50aXRpZXMoczogc3RyaW5nKTogc3RyaW5nIHsKCXJldHVy
biBzCgkJLnJlcGxhY2UoLyYjeChbMC05YS1mXSspOy9naSwgKF9tLCBuKSA9PiBTdHJpbmcuZnJv
bUNvZGVQb2ludChwYXJzZUludChuLCAxNikpKQoJCS5yZXBsYWNlKC8mIyhcZCspOy9nLCAoX20s
IG4pID0+IFN0cmluZy5mcm9tQ29kZVBvaW50KE51bWJlcihuKSkpCgkJLnJlcGxhY2UoLyZxdW90
Oy9nLCAnIicpCgkJLnJlcGxhY2UoLyYjMzk7fCZhcG9zOy9nLCAiJyIpCgkJLnJlcGxhY2UoLyZs
dDsvZywgIjwiKQoJCS5yZXBsYWNlKC8mZ3Q7L2csICI+IikKCQkucmVwbGFjZSgvJm5ic3A7L2cs
ICIgIikKCQkucmVwbGFjZSgvJmFtcDsvZywgIiYiKTsKfQoKZnVuY3Rpb24gc3RyaXBUYWdzKHM6
IHN0cmluZyk6IHN0cmluZyB7CglyZXR1cm4gcy5yZXBsYWNlKC88W14+XSo+L2csICIgIik7Cn0K
CmZ1bmN0aW9uIGNsZWFuVGV4dChzOiBzdHJpbmcpOiBzdHJpbmcgewoJcmV0dXJuIGRlY29kZUVu
dGl0aWVzKHN0cmlwVGFncyhzKSkucmVwbGFjZSgvXHMrL2csICIgIikudHJpbSgpOwp9CgovLyAt
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0KLy8gRW5naW5lIHBhcnNlcnMKLy8gLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
CgpmdW5jdGlvbiBwYXJzZUJyYXZlKGh0bWw6IHN0cmluZywgY291bnQ6IG51bWJlcik6IFNlYXJj
aFJlc3VsdFtdIHsKCWNvbnN0IHJlc3VsdHM6IFNlYXJjaFJlc3VsdFtdID0gW107Cgljb25zdCBj
aHVua3MgPSBodG1sLnNwbGl0KC88ZGl2W14+XSpkYXRhLXR5cGU9IndlYiIvKS5zbGljZSgxKTsK
CWZvciAoY29uc3QgY2h1bmsgb2YgY2h1bmtzKSB7CgkJY29uc3QgbGluayA9IGNodW5rLm1hdGNo
KC88YVtePl0qaHJlZj0iKGh0dHBzPzpcL1wvW14iXSspIi8pOwoJCWlmICghbGluaykgY29udGlu
dWU7CgkJY29uc3QgdGl0bGVNYXRjaCA9CgkJCWNodW5rLm1hdGNoKC88ZGl2IGNsYXNzPSJ0aXRs
ZVteIl0qIltePl0qdGl0bGU9IihbXiJdKykiLykgPz8KCQkJY2h1bmsubWF0Y2goLzxkaXYgY2xh
c3M9InRpdGxlW14iXSoiW14+XSo+KFtcc1xTXSo/KTxcL2Rpdj4vKTsKCQljb25zdCBzbmlwcGV0
TWF0Y2ggPSBjaHVuay5tYXRjaCgvPGRpdiBjbGFzcz0iY29udGVudFteIl0qIltePl0qPihbXHNc
U10qPyk8XC9kaXY+XHMqPFwvZGl2Pi8pOwoJCWNvbnN0IHNuaXBwZXQgPSBzbmlwcGV0TWF0Y2gg
PyBjbGVhblRleHQoc25pcHBldE1hdGNoWzFdKSA6ICIiOwoJCXJlc3VsdHMucHVzaCh7CgkJCXVy
bDogZGVjb2RlRW50aXRpZXMobGlua1sxXSksCgkJCXRpdGxlOiB0aXRsZU1hdGNoID8gY2xlYW5U
ZXh0KHRpdGxlTWF0Y2hbMV0pIDogZGVjb2RlRW50aXRpZXMobGlua1sxXSksCgkJCXNuaXBwZXQ6
IHNuaXBwZXQgPyBzbmlwcGV0LnNsaWNlKDAsIDMwMCkgOiB1bmRlZmluZWQsCgkJfSk7CgkJaWYg
KHJlc3VsdHMubGVuZ3RoID49IGNvdW50KSBicmVhazsKCX0KCXJldHVybiByZXN1bHRzOwp9Cgpm
dW5jdGlvbiBwYXJzZUJpbmcoaHRtbDogc3RyaW5nLCBjb3VudDogbnVtYmVyKTogU2VhcmNoUmVz
dWx0W10gewoJY29uc3QgcmVzdWx0czogU2VhcmNoUmVzdWx0W10gPSBbXTsKCWNvbnN0IGNodW5r
cyA9IGh0bWwuc3BsaXQoLzxsaSBjbGFzcz0iYl9hbGdvIi8pLnNsaWNlKDEpOwoJZm9yIChjb25z
dCBjaHVuayBvZiBjaHVua3MpIHsKCQljb25zdCBsaW5rID0gY2h1bmsubWF0Y2goLzxoMltePl0q
PlxzKjxhW14+XSpocmVmPSIoW14iXSspIltePl0qPihbXHNcU10qPyk8XC9hPi8pOwoJCWlmICgh
bGluaykgY29udGludWU7CgkJbGV0IHVybCA9IGRlY29kZUVudGl0aWVzKGxpbmtbMV0pOwoJCS8v
IEJpbmcgd3JhcHMgcmVzdWx0IFVSTHMgaW4gYSAvY2svYSByZWRpcmVjdDsgdGhlIHJlYWwgVVJM
IGlzIGJhc2U2NCBpbiB1PWExLi4uCgkJY29uc3QgdSA9IHVybC5tYXRjaCgvWz8mXXU9YTEoW0Et
WmEtejAtOSsvPV8tXSspLyk7CgkJaWYgKHUpIHsKCQkJbGV0IGI2NCA9IHVbMV0ucmVwbGFjZSgv
LS9nLCAiKyIpLnJlcGxhY2UoL18vZywgIi8iKTsKCQkJYjY0ICs9ICI9Ii5yZXBlYXQoKDQgLSAo
YjY0Lmxlbmd0aCAlIDQpKSAlIDQpOwoJCQl0cnkgewoJCQkJY29uc3QgZGVjb2RlZCA9IEJ1ZmZl
ci5mcm9tKGI2NCwgImJhc2U2NCIpLnRvU3RyaW5nKCJ1dGY4Iik7CgkJCQlpZiAoZGVjb2RlZC5z
dGFydHNXaXRoKCJodHRwIikpIHVybCA9IGRlY29kZWQ7CgkJCX0gY2F0Y2ggewoJCQkJLy8ga2Vl
cCB0aGUgcmVkaXJlY3QgVVJMCgkJCX0KCQl9CgkJY29uc3Qgc25pcHBldE1hdGNoID0gY2h1bmsu
bWF0Y2goLzxwW14+XSo+KFtcc1xTXSo/KTxcL3A+Lyk7CgkJY29uc3Qgc25pcHBldCA9IHNuaXBw
ZXRNYXRjaCA/IGNsZWFuVGV4dChzbmlwcGV0TWF0Y2hbMV0pIDogIiI7CgkJcmVzdWx0cy5wdXNo
KHsKCQkJdXJsLAoJCQl0aXRsZTogY2xlYW5UZXh0KGxpbmtbMl0pLAoJCQlzbmlwcGV0OiBzbmlw
cGV0ID8gc25pcHBldC5zbGljZSgwLCAzMDApIDogdW5kZWZpbmVkLAoJCX0pOwoJCWlmIChyZXN1
bHRzLmxlbmd0aCA+PSBjb3VudCkgYnJlYWs7Cgl9CglyZXR1cm4gcmVzdWx0czsKfQoKZnVuY3Rp
b24gcGFyc2VHb29nbGUoaHRtbDogc3RyaW5nLCBjb3VudDogbnVtYmVyKTogU2VhcmNoUmVzdWx0
W10gewoJY29uc3QgcmVzdWx0czogU2VhcmNoUmVzdWx0W10gPSBbXTsKCWNvbnN0IHNlZW4gPSBu
ZXcgU2V0PHN0cmluZz4oKTsKCWNvbnN0IGNodW5rcyA9IGh0bWwuc3BsaXQoLzxkaXYgY2xhc3M9
ImciLykuc2xpY2UoMSk7Cglmb3IgKGNvbnN0IGNodW5rIG9mIGNodW5rcykgewoJCWNvbnN0IGxp
bmsgPSBjaHVuay5tYXRjaCgvPGFbXj5dKmhyZWY9IlwvdXJsXD9xPShbXiYiPD5dKylbXiJdKiIv
KTsKCQlpZiAoIWxpbmspIGNvbnRpbnVlOwoJCWNvbnN0IHVybCA9IGRlY29kZUVudGl0aWVzKGxp
bmtbMV0pLnJlcGxhY2UoLyUyNi9nLCAiJiIpOwoJCWlmICghL15odHRwcz86XC9cLy9pLnRlc3Qo
dXJsKSkgY29udGludWU7CgkJaWYgKHNlZW4uaGFzKHVybCkpIGNvbnRpbnVlOwoJCXNlZW4uYWRk
KHVybCk7CgkJY29uc3QgdGl0bGVNYXRjaCA9IGNodW5rLm1hdGNoKC88aDNbXj5dKj4oW1xzXFNd
Kj8pPFwvaDM+Lyk7CgkJY29uc3QgaDNFbmQgPSB0aXRsZU1hdGNoID8gY2h1bmsuaW5kZXhPZigi
PC9oMz4iKSA6IC0xOwoJCWNvbnN0IHRhaWwgPSBoM0VuZCA+PSAwID8gY2h1bmsuc2xpY2UoaDNF
bmQpIDogIiI7CgkJY29uc3Qgc25pcHBldE1hdGNoID0gdGFpbC5tYXRjaCgvPHNwYW5bXj5dKj4o
W1xzXFNdezMwLDYwMH0/KTxcL3NwYW4+Lyk7CgkJY29uc3Qgc25pcHBldCA9IHNuaXBwZXRNYXRj
aCA/IGNsZWFuVGV4dChzbmlwcGV0TWF0Y2hbMV0pIDogIiI7CgkJcmVzdWx0cy5wdXNoKHsKCQkJ
dXJsLAoJCQl0aXRsZTogdGl0bGVNYXRjaCA/IGNsZWFuVGV4dCh0aXRsZU1hdGNoWzFdKSA6IHVy
bCwKCQkJc25pcHBldDogc25pcHBldCA/IHNuaXBwZXQuc2xpY2UoMCwgMzAwKSA6IHVuZGVmaW5l
ZCwKCQl9KTsKCQlpZiAocmVzdWx0cy5sZW5ndGggPj0gY291bnQpIGJyZWFrOwoJfQoJcmV0dXJu
IHJlc3VsdHM7Cn0KCi8qKiBVbndyYXAgcHJvdG9jb2wtcmVsYXRpdmUgVVJMcyBhbmQgRHVja0R1
Y2tHbydzIC9sLz91ZGRnPSByZWRpcmVjdCBsaW5rcy4gKi8KZnVuY3Rpb24gdW53cmFwRHVja0R1
Y2tHb1VybCh1cmw6IHN0cmluZyk6IHN0cmluZyB7CglsZXQgdSA9IHVybC5zdGFydHNXaXRoKCIv
LyIpID8gYGh0dHBzOiR7dXJsfWAgOiB1cmw7Cgl0cnkgewoJCWlmICgvXmh0dHBzPzpcL1wvKHd3
d1wuKT9kdWNrZHVja2dvXC5jb21cL2xcLy9pLnRlc3QodSkpIHsKCQkJY29uc3QgdWRkZyA9IG5l
dyBVUkwodSkuc2VhcmNoUGFyYW1zLmdldCgidWRkZyIpOwoJCQlpZiAodWRkZykgcmV0dXJuIHVk
ZGc7CgkJfQoJfSBjYXRjaCB7CgkJLy8ga2VlcCBhcy1pcwoJfQoJcmV0dXJuIHU7Cn0KCmZ1bmN0
aW9uIHBhcnNlRHVja0R1Y2tHbyhodG1sOiBzdHJpbmcsIGNvdW50OiBudW1iZXIpOiBTZWFyY2hS
ZXN1bHRbXSB7Cgljb25zdCByZXN1bHRzOiBTZWFyY2hSZXN1bHRbXSA9IFtdOwoJY29uc3QgcmUg
PQoJCS88YVtePl0qY2xhc3M9WyciXXJlc3VsdC1saW5rWyciXVtePl0qaHJlZj1bJyJdKFteJyJd
KylbJyJdW14+XSo+KFtcc1xTXSo/KTxcL2E+fDxhW14+XSpocmVmPVsnIl0oW14nIl0rKVsnIl1b
Xj5dKmNsYXNzPVsnIl1yZXN1bHQtbGlua1snIl1bXj5dKj4oW1xzXFNdKj8pPFwvYT4vZzsKCWZv
ciAoY29uc3QgbSBvZiBodG1sLm1hdGNoQWxsKHJlKSkgewoJCWNvbnN0IHJhd1VybCA9IG1bMV0g
Pz8gbVszXTsKCQljb25zdCB0aXRsZSA9IG1bMl0gPz8gbVs0XTsKCQljb25zdCB1cmwgPSB1bndy
YXBEdWNrRHVja0dvVXJsKGRlY29kZUVudGl0aWVzKHJhd1VybCA/PyAiIikpOwoJCWlmICghL15o
dHRwcz86XC9cLy9pLnRlc3QodXJsKSkgY29udGludWU7CgkJLy8gVGhlIHNuaXBwZXQgY2VsbCAo
cmVzdWx0LXNuaXBwZXQpIGZvbGxvd3MgdGhlIGxpbmsgY2VsbCBpbiB0aGUgc2FtZSByb3cuCgkJ
Y29uc3Qgc3RhcnQgPSAobS5pbmRleCA/PyAwKSArIG1bMF0ubGVuZ3RoOwoJCWNvbnN0IG5leHRM
aW5rID0gaHRtbC5pbmRleE9mKCJyZXN1bHQtbGluayIsIHN0YXJ0KTsKCQljb25zdCBlbmQgPSBu
ZXh0TGluayA9PT0gLTEgPyBNYXRoLm1pbihzdGFydCArIDQwMDAsIGh0bWwubGVuZ3RoKSA6IE1h
dGgubWluKHN0YXJ0ICsgNDAwMCwgbmV4dExpbmspOwoJCWNvbnN0IHNtID0gaHRtbC5zbGljZShz
dGFydCwgZW5kKS5tYXRjaCgvcmVzdWx0LXNuaXBwZXRbJyJdW14+XSo+KFtcc1xTXSo/KTxcL3Rk
Pi8pOwoJCWNvbnN0IHNuaXBwZXQgPSBzbSA/IGNsZWFuVGV4dChzbVsxXSkgOiAiIjsKCQlyZXN1
bHRzLnB1c2goewoJCQl1cmwsCgkJCXRpdGxlOiBjbGVhblRleHQodGl0bGUpLAoJCQlzbmlwcGV0
OiBzbmlwcGV0ID8gc25pcHBldC5zbGljZSgwLCAzMDApIDogdW5kZWZpbmVkLAoJCX0pOwoJCWlm
IChyZXN1bHRzLmxlbmd0aCA+PSBjb3VudCkgYnJlYWs7Cgl9CglyZXR1cm4gcmVzdWx0czsKfQoK
aW50ZXJmYWNlIEVuZ2luZSB7CgluYW1lOiBFbmdpbmVOYW1lOwoJdXJsOiAocXVlcnk6IHN0cmlu
ZywgY291bnQ6IG51bWJlcikgPT4gc3RyaW5nOwoJcGFyc2U6IChodG1sOiBzdHJpbmcsIGNvdW50
OiBudW1iZXIpID0+IFNlYXJjaFJlc3VsdFtdOwoJLyoqIFRydWUgd2hlbiB0aGUgcmVzcG9uc2Ug
aXMgYSBib3QtY2hhbGxlbmdlIC8gZXJyb3IgcGFnZSByYXRoZXIgdGhhbiByZXN1bHRzLiAqLwoJ
aXNCbG9ja2VkOiAoc3RhdHVzOiBudW1iZXIsIGh0bWw6IHN0cmluZykgPT4gYm9vbGVhbjsKfQoK
Y29uc3QgRU5HSU5FUzogUmVjb3JkPEVuZ2luZU5hbWUsIEVuZ2luZT4gPSB7CglicmF2ZTogewoJ
CW5hbWU6ICJicmF2ZSIsCgkJdXJsOiAocSwgX24pID0+IGBodHRwczovL3NlYXJjaC5icmF2ZS5j
b20vc2VhcmNoP3E9JHtlbmNvZGVVUklDb21wb25lbnQocSl9JnNvdXJjZT13ZWJgLAoJCXBhcnNl
OiBwYXJzZUJyYXZlLAoJCWlzQmxvY2tlZDogKHN0YXR1cywgaHRtbCkgPT4gc3RhdHVzICE9PSAy
MDAgfHwgIWh0bWwuaW5jbHVkZXMoJ2RhdGEtdHlwZT0id2ViIicpLAoJfSwKCWdvb2dsZTogewoJ
CW5hbWU6ICJnb29nbGUiLAoJCXVybDogKHEsIG4pID0+IGBodHRwczovL3d3dy5nb29nbGUuY29t
L3NlYXJjaD9xPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHEpfSZudW09JHtufSZobD1lbiZnbD11cyZn
YnY9MWAsCgkJcGFyc2U6IHBhcnNlR29vZ2xlLAoJCWlzQmxvY2tlZDogKHN0YXR1cywgaHRtbCkg
PT4KCQkJc3RhdHVzICE9PSAyMDAgfHwgL2VuYWJsZWpzfGh0dHBzZXJ2aWNlfFwvc29ycnlcL3x1
bnVzdWFsIHRyYWZmaWMvaS50ZXN0KGh0bWwpIHx8ICFodG1sLmluY2x1ZGVzKCIvdXJsP3E9Iiks
Cgl9LAoJZHVja2R1Y2tnbzogewoJCW5hbWU6ICJkdWNrZHVja2dvIiwKCQl1cmw6IChxKSA9PiBg
aHR0cHM6Ly9saXRlLmR1Y2tkdWNrZ28uY29tL2xpdGUvP3E9JHtlbmNvZGVVUklDb21wb25lbnQo
cSl9YCwKCQlwYXJzZTogcGFyc2VEdWNrRHVja0dvLAoJCWlzQmxvY2tlZDogKHN0YXR1cywgaHRt
bCkgPT4gc3RhdHVzICE9PSAyMDAgfHwgIWh0bWwuaW5jbHVkZXMoInJlc3VsdC1saW5rIiksCgl9
LAoJYmluZzogewoJCW5hbWU6ICJiaW5nIiwKCQl1cmw6IChxLCBuKSA9PiBgaHR0cHM6Ly93d3cu
YmluZy5jb20vc2VhcmNoP3E9JHtlbmNvZGVVUklDb21wb25lbnQocSl9JmNvdW50PSR7bn0mc2V0
bGFuZz1lbiZjYz11c2AsCgkJcGFyc2U6IHBhcnNlQmluZywKCQlpc0Jsb2NrZWQ6IChzdGF0dXMs
IGh0bWwpID0+IHN0YXR1cyAhPT0gMjAwIHx8ICFodG1sLmluY2x1ZGVzKCJiX2FsZ28iKSwKCX0s
Cn07Cgpjb25zdCBERUZBVUxUX0NIQUlOOiBFbmdpbmVOYW1lW10gPSBbImJyYXZlIiwgImdvb2ds
ZSIsICJkdWNrZHVja2dvIiwgImJpbmciXTsKCmZ1bmN0aW9uIGF1dG9FbmdpbmVPcmRlcigpOiBF
bmdpbmVOYW1lW10gewoJY29uc3QgcmF3ID0gcHJvY2Vzcy5lbnYuV0VCX1NFQVJDSF9FTkdJTkVT
ID8/IERFRkFVTFRfQ0hBSU4uam9pbigiLCIpOwoJY29uc3QgbmFtZXMgPSByYXcKCQkuc3BsaXQo
IiwiKQoJCS5tYXAoKHMpID0+IHMudHJpbSgpLnRvTG93ZXJDYXNlKCkpCgkJLmZpbHRlcigocyk6
IHMgaXMgRW5naW5lTmFtZSA9PiBzIGluIEVOR0lORVMpOwoJcmV0dXJuIG5hbWVzLmxlbmd0aCA+
IDAgPyBuYW1lcyA6IFsuLi5ERUZBVUxUX0NIQUlOXTsKfQoKLy8gLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
Ci8vIFNlYXJjaCBvcmNoZXN0cmF0aW9uCi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLQoKaW50ZXJmYWNl
IEVuZ2luZU91dGNvbWUgewoJcmVzdWx0czogU2VhcmNoUmVzdWx0W107CgkvKiogU2V0IHdoZW4g
dGhlIGVuZ2luZSB3YXMgYmxvY2tlZC91bnJlYWNoYWJsZSAoYXMgb3Bwb3NlZCB0byBhIGNsZWFu
ICJubyByZXN1bHRzIikuICovCgllcnJvcj86IHN0cmluZzsKfQoKYXN5bmMgZnVuY3Rpb24gcnVu
RW5naW5lKAoJbmFtZTogRW5naW5lTmFtZSwKCXF1ZXJ5OiBzdHJpbmcsCgljb3VudDogbnVtYmVy
LAoJc2lnbmFsPzogQWJvcnRTaWduYWwsCglleGVjPzogRXhlY0ZuLAopOiBQcm9taXNlPEVuZ2lu
ZU91dGNvbWU+IHsKCWNvbnN0IGVuZ2luZSA9IEVOR0lORVNbbmFtZV07CglsZXQgbGFzdEVycm9y
ID0gInVua25vd24gZXJyb3IiOwoKCWZvciAobGV0IGF0dGVtcHQgPSAxOyBhdHRlbXB0IDw9IE1B
WF9BVFRFTVBUUzsgYXR0ZW1wdCsrKSB7CgkJaWYgKHNpZ25hbD8uYWJvcnRlZCkgcmV0dXJuIHsg
cmVzdWx0czogW10sIGVycm9yOiAiY2FuY2VsbGVkIiB9OwoJCWNvbnN0IHQgPSB3aXRoVGltZW91
dChzaWduYWwsIFJFUVVFU1RfVElNRU9VVF9NUyk7CgkJdHJ5IHsKCQkJY29uc3QgeyBzdGF0dXMs
IGh0bWwgfSA9IGF3YWl0IGZldGNoSHRtbCh7CgkJCQl1cmw6IGVuZ2luZS51cmwocXVlcnksIGNv
dW50KSwKCQkJCXRpbWVvdXRNczogUkVRVUVTVF9USU1FT1VUX01TLAoJCQkJc2lnbmFsOiB0LnNp
Z25hbCwKCQkJCXVzZXJBZ2VudDogVVNFUl9BR0VOVFNbKGF0dGVtcHQgLSAxKSAlIFVTRVJfQUdF
TlRTLmxlbmd0aF0hLAoJCQkJZXhlYywKCQkJfSk7CgkJCWlmIChlbmdpbmUuaXNCbG9ja2VkKHN0
YXR1cywgaHRtbCkpIHsKCQkJCWxhc3RFcnJvciA9IGBibG9ja2VkIChIVFRQICR7c3RhdHVzfSwg
Ym90IGNoYWxsZW5nZSBwYWdlKWA7CgkJCX0gZWxzZSB7CgkJCQlyZXR1cm4geyByZXN1bHRzOiBl
bmdpbmUucGFyc2UoaHRtbCwgY291bnQpIH07CgkJCX0KCQl9IGNhdGNoIChlcnIpIHsKCQkJY29u
c3QgZSA9IGVyciBhcyB7IG5hbWU/OiBzdHJpbmc7IG1lc3NhZ2U/OiBzdHJpbmc7IGNhdXNlPzog
eyBtZXNzYWdlPzogc3RyaW5nIH0gfTsKCQkJbGV0IG1zZyA9IGU/Lm1lc3NhZ2UgPz8gU3RyaW5n
KGVycik7CgkJCWlmIChtc2cgPT09ICJmZXRjaCBmYWlsZWQiICYmIGU/LmNhdXNlPy5tZXNzYWdl
KSBtc2cgPSBgZmV0Y2ggZmFpbGVkICgke2UuY2F1c2UubWVzc2FnZX0pYDsKCQkJbGFzdEVycm9y
ID0gc2lnbmFsPy5hYm9ydGVkIHx8IHQuc2lnbmFsLmFib3J0ZWQKCQkJCT8gImNhbmNlbGxlZCBv
ciB0aW1lZCBvdXQiCgkJCQk6IG1zZzsKCQl9IGZpbmFsbHkgewoJCQl0LmNhbmNlbCgpOwoJCX0K
CQlpZiAoYXR0ZW1wdCA8IE1BWF9BVFRFTVBUUykgYXdhaXQgc2xlZXAoMTAwMCAqIGF0dGVtcHQs
IHNpZ25hbCk7Cgl9CgoJcmV0dXJuIHsgcmVzdWx0czogW10sIGVycm9yOiBsYXN0RXJyb3IgfTsK
fQoKaW50ZXJmYWNlIFdlYlNlYXJjaE91dGNvbWUgewoJZW5naW5lOiBFbmdpbmVOYW1lOwoJcmVz
dWx0czogU2VhcmNoUmVzdWx0W107CglmYWlsdXJlczogc3RyaW5nW107CgkvKiogQXQgbGVhc3Qg
b25lIGVuZ2luZSBhbnN3ZXJlZCBjbGVhbmx5IHdpdGggemVybyByZXN1bHRzLiAqLwoJY2xlYW5F
bXB0eTogYm9vbGVhbjsKfQoKZXhwb3J0IGludGVyZmFjZSBTZWFyY2hPcHRpb25zIHsKCWVuZ2lu
ZT86ICJhdXRvIiB8IEVuZ2luZU5hbWU7Cgljb3VudD86IG51bWJlcjsKCXNpZ25hbD86IEFib3J0
U2lnbmFsOwoJZXhlYz86IEV4ZWNGbjsKfQoKZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNlYXJjaFdl
YihxdWVyeTogc3RyaW5nLCBvcHRzOiBTZWFyY2hPcHRpb25zID0ge30pOiBQcm9taXNlPFdlYlNl
YXJjaE91dGNvbWU+IHsKCWNvbnN0IGVuZ2luZSA9IG9wdHMuZW5naW5lID8/ICJhdXRvIjsKCWNv
bnN0IGNvdW50ID0gTWF0aC5taW4oMTUsIE1hdGgubWF4KDEsIG9wdHMuY291bnQgPz8gNSkpOwoJ
Y29uc3QgY2hhaW4gPSBlbmdpbmUgPT09ICJhdXRvIiA/IGF1dG9FbmdpbmVPcmRlcigpIDogW2Vu
Z2luZV07Cgljb25zdCBmYWlsdXJlczogc3RyaW5nW10gPSBbXTsKCWxldCBjbGVhbkVtcHR5ID0g
ZmFsc2U7CgoJZm9yIChjb25zdCBuYW1lIG9mIGNoYWluKSB7CgkJaWYgKG9wdHMuc2lnbmFsPy5h
Ym9ydGVkKSByZXR1cm4geyBlbmdpbmU6IGNoYWluWzBdISwgcmVzdWx0czogW10sIGZhaWx1cmVz
LCBjbGVhbkVtcHR5IH07CgkJY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bkVuZ2luZShuYW1lLCBx
dWVyeSwgY291bnQsIG9wdHMuc2lnbmFsLCBvcHRzLmV4ZWMpOwoJCWlmIChvdXRjb21lLnJlc3Vs
dHMubGVuZ3RoID4gMCkgewoJCQlyZXR1cm4geyBlbmdpbmU6IG5hbWUsIHJlc3VsdHM6IG91dGNv
bWUucmVzdWx0cywgZmFpbHVyZXMsIGNsZWFuRW1wdHkgfTsKCQl9CgkJaWYgKG91dGNvbWUuZXJy
b3IpIGZhaWx1cmVzLnB1c2goYCR7bmFtZX06ICR7b3V0Y29tZS5lcnJvcn1gKTsKCQllbHNlIGNs
ZWFuRW1wdHkgPSB0cnVlOwoJfQoKCXJldHVybiB7IGVuZ2luZTogY2hhaW5bMF0hLCByZXN1bHRz
OiBbXSwgZmFpbHVyZXMsIGNsZWFuRW1wdHkgfTsKfQoKLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCi8v
IFF1ZXJ5LWZyYWdtZW50IGNvdmVyYWdlIGNoZWNrCi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLQoKY29u
c3QgU1RPUFdPUkRTID0gbmV3IFNldChbCgkiYSIsImFuIiwidGhlIiwiYW5kIiwib3IiLCJidXQi
LCJpZiIsInRoZW4iLCJlbHNlIiwib2YiLCJ0byIsImluIiwib24iLCJmb3IiLCJ3aXRoIiwiYnki
LCJhdCIsImFzIiwKCSJpcyIsImFyZSIsIndhcyIsIndlcmUiLCJiZSIsImJlZW4iLCJiZWluZyIs
ImFtIiwiZG8iLCJkb2VzIiwiZGlkIiwiZG9uZSIsImhhdmUiLCJoYXMiLCJoYWQiLAoJInRoaXMi
LCJ0aGF0IiwidGhlc2UiLCJ0aG9zZSIsIml0IiwiaXRzIiwiaGlzIiwiaGVyIiwidGhlaXIiLCJv
dXIiLCJ5b3VyIiwibXkiLCJtZSIsIndlIiwieW91IiwiaSIsCgkidnMiLCJ2ZXJzdXMiLCJob3ci
LCJ3aGF0Iiwid2hpY2giLCJ3aG8iLCJ3aG9tIiwid2hvc2UiLCJ3aGVuIiwid2hlcmUiLCJ3aHki
LCJjYW4iLCJjb3VsZCIsInNob3VsZCIsCgkid291bGQiLCJ3aWxsIiwic2hhbGwiLCJtYXkiLCJt
aWdodCIsIm11c3QiLCJub3QiLCJubyIsIm5vciIsInNvIiwidGhhbiIsInRvbyIsInZlcnkiLCJq
dXN0Iiwib25seSIsCgkiYWxzbyIsImFib3V0IiwiaW50byIsIm92ZXIiLCJ1bmRlciIsImFnYWlu
IiwiaGVyZSIsInRoZXJlIiwiYWxsIiwiYW55IiwiYm90aCIsImVhY2giLCJmZXciLCJtb3JlIiwK
CSJtb3N0Iiwib3RoZXIiLCJzb21lIiwic3VjaCIsIm93biIsInNhbWUiLCJ1cCIsIm91dCIsIm9m
ZiIsInBlciIsInZpYSIsCl0pOwoKLyoqIFF1b3RlZCBwaHJhc2VzICgiLi4uIiBvciAnLi4uJykg
aW4gYSBxdWVyeSwgdHJpbW1lZCBhbmQgZGVkdXBlZC4gKi8KZnVuY3Rpb24gcXVvdGVkUGhyYXNl
cyhxdWVyeTogc3RyaW5nKTogc3RyaW5nW10gewoJY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdOwoJ
Zm9yIChjb25zdCBtIG9mIHF1ZXJ5Lm1hdGNoQWxsKC8iKFteIl0rKSJ8JyhbXiddKyknL2cpKSB7
CgkJY29uc3QgcCA9IChtWzFdID8/IG1bMl0gPz8gIiIpLnRyaW0oKTsKCQlpZiAocC5sZW5ndGgg
Pj0gMykgb3V0LnB1c2gocCk7Cgl9CglyZXR1cm4gWy4uLm5ldyBTZXQob3V0KV07Cn0KCi8qKgog
KiBNZWFuaW5nZnVsIHN0YW5kYWxvbmUgdG9rZW5zOiBhbHBoYW51bWVyaWMsID49IDQgY2hhcnMs
IG5vdCBhIHN0b3B3b3JkLgogKiBRdW90ZWQgcGhyYXNlcyBhcmUgc3RyaXBwZWQgZmlyc3Qgc28g
dGhlaXIgd29yZHMgZG9uJ3QgZG91YmxlLWNvdW50IGhlcmUuCiAqLwpmdW5jdGlvbiBzaWduaWZp
Y2FudFRva2VucyhxdWVyeTogc3RyaW5nKTogc3RyaW5nW10gewoJY29uc3Qgc3RyaXBwZWQgPSBx
dWVyeS5yZXBsYWNlKC8iKFteIl0qKSJ8JyhbXiddKiknL2csICIgIik7Cgljb25zdCBvdXQ6IHN0
cmluZ1tdID0gW107Cglmb3IgKGNvbnN0IG0gb2Ygc3RyaXBwZWQubWF0Y2hBbGwoL1thLXowLTld
W2EtejAtOV8uK1wtXSovZ2kpKSB7CgkJY29uc3QgdCA9IG1bMF0udG9Mb3dlckNhc2UoKTsKCQlp
ZiAodC5sZW5ndGggPj0gNCAmJiAhU1RPUFdPUkRTLmhhcyh0KSkgb3V0LnB1c2godCk7Cgl9Cgly
ZXR1cm4gWy4uLm5ldyBTZXQob3V0KV07Cn0KCmZ1bmN0aW9uIGhheXN0YWNrT2YocjogU2VhcmNo
UmVzdWx0KTogc3RyaW5nIHsKCXJldHVybiBgJHtyLnRpdGxlfSAke3Iuc25pcHBldCA/PyAiIn0g
JHtyLnVybH1gLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvXHMrL2csICIgIik7Cn0KCi8qKgogKiBD
b21wYXJlIHRoZSBxdWVyeSdzIG93biBmcmFnbWVudHMgYWdhaW5zdCB0aGUgcmV0dXJuZWQgcmVz
dWx0cyBhbmQgcmV0dXJuCiAqIGh1bWFuLXJlYWRhYmxlIHdhcm5pbmdzIChlbXB0eSBhcnJheSA9
IG5vIHByb2JsZW0gZGV0ZWN0ZWQpLgogKgogKiAtIE1pc3NpbmcgcXVvdGVkIHBocmFzZTogbm8g
cmVzdWx0J3MgdGl0bGUvc25pcHBldC9VUkwgY29udGFpbnMgdGhlIHBocmFzZS4KICogLSBObyB0
b2tlbiBjb3ZlcmFnZTogbm8gcmVzdWx0IGNvbnRhaW5zIEFOWSBzaWduaWZpY2FudCBxdWVyeSB0
b2tlbiDigJQgdGhlCiAqICAgc3Ryb25nZXN0IGRlY295IHNpZ25hbCAoZS5nLiBCaW5nIHNlcnZp
bmcgdW5yZWxhdGVkIGxpc3RpbmdzIGZvciBhCiAqICAgbm9uc2Vuc2UgcXVlcnkpLgogKi8KZXhw
b3J0IGZ1bmN0aW9uIGNvdmVyYWdlV2FybmluZyhxdWVyeTogc3RyaW5nLCByZXN1bHRzOiBTZWFy
Y2hSZXN1bHRbXSk6IHN0cmluZ1tdIHsKCWlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMCkgcmV0dXJu
IFtdOwoJY29uc3QgaGF5cyA9IHJlc3VsdHMubWFwKGhheXN0YWNrT2YpOwoKCWNvbnN0IG1pc3Np
bmdQaHJhc2VzID0gcXVvdGVkUGhyYXNlcyhxdWVyeSkuZmlsdGVyKAoJCShwKSA9PiAhaGF5cy5z
b21lKChoKSA9PiBoLmluY2x1ZGVzKHAudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9ccysvZywgIiAi
KSkpLAoJKTsKCgljb25zdCB0b2tlbnMgPSBzaWduaWZpY2FudFRva2VucyhxdWVyeSk7Cgljb25z
dCBub1Rva2VuQ292ZXJhZ2UgPQoJCXRva2Vucy5sZW5ndGggPj0gMiAmJiAhaGF5cy5zb21lKCho
KSA9PiB0b2tlbnMuc29tZSgodCkgPT4gaC5pbmNsdWRlcyh0KSkpOwoKCWNvbnN0IGxpbmVzOiBz
dHJpbmdbXSA9IFtdOwoJaWYgKG5vVG9rZW5Db3ZlcmFnZSkgewoJCWxpbmVzLnB1c2goCgkJCSLi
mqDvuI8gY292ZXJhZ2U6IG5vIHJlc3VsdCdzIHRpdGxlL3NuaXBwZXQvVVJMIGNvbnRhaW5zIGFu
eSBzaWduaWZpY2FudCB3b3JkIG9mIHRoZSBxdWVyeSDigJQgdGhlIGVuZ2luZSBsaWtlbHkgcmVs
YXhlZCB0aGUgcXVlcnkgb3IgcmV0dXJuZWQgZGVjb3kgcmVzdWx0czsgdHJlYXQgdGhpcyBzZXQg
d2l0aCBjYXV0aW9uICh0cnkgYW5vdGhlciBlbmdpbmUgb3IgYSBuYXJyb3dlciBxdWVyeSkiLAoJ
CSk7Cgl9CglpZiAobWlzc2luZ1BocmFzZXMubGVuZ3RoID4gMCkgewoJCWxpbmVzLnB1c2goCgkJ
CWDimqDvuI8gY292ZXJhZ2U6IG5vIHJlc3VsdCBtZW50aW9ucyAke21pc3NpbmdQaHJhc2VzLm1h
cCgocCkgPT4gYCIke3B9ImApLmpvaW4oIiwgIil9IOKAlCB0aGUgZW5naW5lIG1heSBoYXZlIGRy
b3BwZWQgdGhhdCBjb25zdHJhaW50IChzbmlwcGV0cyBhcmUgdHJ1bmNhdGVkLCBzbyB0aGUgcGFn
ZXMgdGhlbXNlbHZlcyBjb3VsZCBzdGlsbCBjb250YWluIGl0OyB2ZXJpZnkgYWdhaW5zdCB0aGUg
c291cmNlKWAsCgkJKTsKCX0KCXJldHVybiBsaW5lczsKfQoKLy8gLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
Ci8vIE91dHB1dCBmb3JtYXR0aW5nCi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLQoKZnVuY3Rpb24gaG9z
dE9mKHVybDogc3RyaW5nKTogc3RyaW5nIHsKCXRyeSB7CgkJcmV0dXJuIG5ldyBVUkwodXJsKS5o
b3N0bmFtZS5yZXBsYWNlKC9ed3d3XC4vLCAiIik7Cgl9IGNhdGNoIHsKCQlyZXR1cm4gIiI7Cgl9
Cn0KCmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRSZXN1bHRzKHF1ZXJ5OiBzdHJpbmcsIGVuZ2luZTog
RW5naW5lTmFtZSwgcmVzdWx0czogU2VhcmNoUmVzdWx0W10pOiBzdHJpbmcgewoJY29uc3QgbGlu
ZXM6IHN0cmluZ1tdID0gW2BXZWIgc2VhcmNoIHJlc3VsdHMgZm9yICIke3F1ZXJ5fSIgKHZpYSAk
e2VuZ2luZX0sICR7cmVzdWx0cy5sZW5ndGh9KTpgLCAiIl07CglyZXN1bHRzLmZvckVhY2goKHIs
IGkpID0+IHsKCQlsaW5lcy5wdXNoKGAke2kgKyAxfS4gJHtyLnRpdGxlfWApOwoJCWxpbmVzLnB1
c2goYCAgICR7ci51cmx9YCk7CgkJaWYgKHIuc25pcHBldCkgbGluZXMucHVzaChgICAgJHtyLnNu
aXBwZXR9YCk7CgkJbGluZXMucHVzaCgiIik7Cgl9KTsKCWNvbnN0IGhvc3RzID0gbmV3IFNldChy
ZXN1bHRzLm1hcCgocikgPT4gaG9zdE9mKHIudXJsKSkuZmlsdGVyKEJvb2xlYW4pKTsKCWlmIChy
ZXN1bHRzLmxlbmd0aCA+PSAzICYmIGhvc3RzLnNpemUgPT09IDEpIHsKCQlsaW5lcy5wdXNoKGAo
bm90ZTogYWxsIHJlc3VsdHMgY29tZSBmcm9tIGEgc2luZ2xlIGhvc3QgKCR7Wy4uLmhvc3RzXVsw
XX0pIC0gdHJlYXQgd2l0aCBjYXV0aW9uKWApOwoJfQoJbGluZXMucHVzaCguLi5jb3ZlcmFnZVdh
cm5pbmcocXVlcnksIHJlc3VsdHMpKTsKCXJldHVybiBsaW5lcy5qb2luKCJcbiIpLnRyaW1FbmQo
KTsKfQoKLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCi8vIE92ZXJsYXkgZm9yIC93ZWJzZWFyY2gKLy8g
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tCgpjbGFzcyBTZWFyY2hSZXN1bHRzT3ZlcmxheSB7CglyZWFkb25s
eSB3aWR0aCA9IDg2OwoJZm9jdXNlZCA9IGZhbHNlOwoKCXByaXZhdGUgcmVhZG9ubHkgbGluZXM6
IHN0cmluZ1tdOwoKCWNvbnN0cnVjdG9yKAoJCXByaXZhdGUgdGhlbWU6IFRoZW1lLAoJCWxpbmVz
OiBzdHJpbmdbXSwKCQlwcml2YXRlIGRvbmU6IChyZXN1bHQ/OiBuZXZlcikgPT4gdm9pZCwKCSkg
ewoJCXRoaXMubGluZXMgPSBsaW5lczsKCX0KCgloYW5kbGVJbnB1dChkYXRhOiBzdHJpbmcpOiB2
b2lkIHsKCQlpZiAobWF0Y2hlc0tleShkYXRhLCAiZXNjYXBlIikgfHwgbWF0Y2hlc0tleShkYXRh
LCAicmV0dXJuIikgfHwgZGF0YSA9PT0gInEiIHx8IGRhdGEgPT09ICJRIikgewoJCQl0aGlzLmRv
bmUoKTsKCQl9Cgl9CgoJcmVuZGVyKCk6IHN0cmluZ1tdIHsKCQljb25zdCBpbm5lclcgPSB0aGlz
LndpZHRoIC0gMjsKCQljb25zdCB0aCA9IHRoaXMudGhlbWU7CgkJY29uc3QgcGFkID0gKHM6IHN0
cmluZykgPT4gewoJCQljb25zdCB3ID0gdmlzaWJsZVdpZHRoKHMpOwoJCQlyZXR1cm4gdyA+PSBp
bm5lclcgPyBzLnNsaWNlKDAsIGlubmVyVykgOiBzICsgIiAiLnJlcGVhdChpbm5lclcgLSB3KTsK
CQl9OwoJCWNvbnN0IHJvdyA9IChjb250ZW50OiBzdHJpbmcpID0+IHRoLmZnKCJib3JkZXIiLCAi
4pSCIikgKyBwYWQoY29udGVudCkgKyB0aC5mZygiYm9yZGVyIiwgIuKUgiIpOwoKCQljb25zdCBv
dXQ6IHN0cmluZ1tdID0gWwoJCQl0aC5mZygiYm9yZGVyIiwgYOKVrSR7IuKUgCIucmVwZWF0KGlu
bmVyVyl94pWuYCksCgkJCXJvdyhgICR7dGguZmcoImFjY2VudCIsIHRoLmJvbGQoIndlYl9zZWFy
Y2ggcmVzdWx0cyIpKX1gKSwKCQkJcm93KCIiKSwKCQldOwoJCWZvciAoY29uc3QgbGluZSBvZiB0
aGlzLmxpbmVzKSBvdXQucHVzaChyb3coYCAke2xpbmV9YCkpOwoJCW91dC5wdXNoKHJvdygiIikp
OwoJCW91dC5wdXNoKHJvdyhgICR7dGguZmcoImRpbSIsICJFc2MgLyBFbnRlciAvIHEgdG8gY2xv
c2UiKX1gKSk7CgkJb3V0LnB1c2godGguZmcoImJvcmRlciIsIGDilbAkeyLilIAiLnJlcGVhdChp
bm5lclcpfeKVr2ApKTsKCQlyZXR1cm4gb3V0OwoJfQoKCWludmFsaWRhdGUoKTogdm9pZCB7fQoJ
ZGlzcG9zZSgpOiB2b2lkIHt9Cn0KCi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLQovLyBFeHRlbnNpb24K
Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t
LS0tLS0tLS0tLS0tLS0tLS0tLS0tCgpjb25zdCB3ZWJTZWFyY2hTY2hlbWEgPSBUeXBlLk9iamVj
dCh7CglxdWVyeTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogIlNlYXJjaCBxdWVyeSIgfSks
CgllbmdpbmU6IFR5cGUuT3B0aW9uYWwoCgkJU3RyaW5nRW51bShbImF1dG8iLCAiYnJhdmUiLCAi
Z29vZ2xlIiwgImR1Y2tkdWNrZ28iLCAiYmluZyJdIGFzIGNvbnN0LCB7CgkJCWRlc2NyaXB0aW9u
OiAiU2VhcmNoIGVuZ2luZSB0byB1c2UuICdhdXRvJyAoZGVmYXVsdCkgdHJpZXMgZW5naW5lcyBp
biBvcmRlciB1bnRpbCBvbmUgcmV0dXJucyByZXN1bHRzLiIsCgkJfSksCgkpLAoJY291bnQ6IFR5
cGUuT3B0aW9uYWwoVHlwZS5JbnRlZ2VyKHsgbWluaW11bTogMSwgbWF4aW11bTogMTUsIGRlc2Ny
aXB0aW9uOiAiTnVtYmVyIG9mIHJlc3VsdHMgdG8gcmV0dXJuIChkZWZhdWx0IDUpIiB9KSksCn0p
OwoKZXhwb3J0IHR5cGUgV2ViU2VhcmNoVG9vbElucHV0ID0gewoJcXVlcnk6IHN0cmluZzsKCWVu
Z2luZT86ICJhdXRvIiB8IEVuZ2luZU5hbWU7Cgljb3VudD86IG51bWJlcjsKfTsKCmV4cG9ydCBk
ZWZhdWx0IGZ1bmN0aW9uIHdlYlNlYXJjaEV4dGVuc2lvbihwaTogRXh0ZW5zaW9uQVBJKSB7Cglw
aS5yZWdpc3RlclRvb2woewoJCW5hbWU6ICJ3ZWJfc2VhcmNoIiwKCQlsYWJlbDogIldlYiBTZWFy
Y2giLAoJCWRlc2NyaXB0aW9uOgoJCQkiU2VhcmNoIHRoZSB3ZWIgYW5kIHJldHVybiB0b3AgcmVz
dWx0cyBhcyB0aXRsZSwgVVJMLCBhbmQgc25pcHBldC4gRGVzaWduZWQgZm9yIHJlc3RyaWN0aXZl
ICIgKwoJCQkiZmlyZXdhbGxzOiB3aXRoIGVuZ2luZT0nYXV0bycgaXQgdHJpZXMgZW5naW5lcyBp
biBvcmRlciAoZGVmYXVsdDogYnJhdmUsIGdvb2dsZSwgZHVja2R1Y2tnbywgYmluZzsgIiArCgkJ
CSJvdmVycmlkZSB0aGUgY2hhaW4gd2l0aCB0aGUgV0VCX1NFQVJDSF9FTkdJTkVTIGVudiB2YXIp
IGFuZCByZXRyaWVzIG9uIGJvdC1jaGFsbGVuZ2UgcGFnZXMgdW50aWwgb25lICIgKwoJCQkiZW5n
aW5lIHJldHVybnMgcmVzdWx0cy4gU2V0IGVuZ2luZSB0byBmb3JjZSBhIHNwZWNpZmljIG9uZS4g
UmVzdWx0cyBhcmUgc2NyYXBlZCBmcm9tIHB1YmxpYyBwYWdlcyAiICsKCQkJImFuZCBtYXkgb2Nj
YXNpb25hbGx5IGJlIGluY29tcGxldGUgb3Igb2ZmLiBTb21lIGVuZ2luZXMgc2lsZW50bHkgcmVs
YXggdW5tYXRjaGVkIHF1ZXJpZXMgIiArCgkJCSIocmV0dXJuaW5nIGRlY295IHJlc3VsdHMgaW5z
dGVhZCBvZiAnbm8gcmVzdWx0cycpOyB3aGVuIG5vIHJlc3VsdCB0aXRsZS9zbmlwcGV0L1VSTCBj
b250YWlucyBhICIgKwoJCQkicXVvdGVkIHF1ZXJ5IHBocmFzZSBvciBhbnkgc2lnbmlmaWNhbnQg
cXVlcnkgd29yZCwgYSDimqDvuI8gY292ZXJhZ2Ugd2FybmluZyBpcyBhcHBlbmRlZCDigJQgdmVy
aWZ5ICIgKwoJCQkic3VjaCByZXN1bHRzIGFnYWluc3QgdGhlIHNvdXJjZS4iLAoJCXByb21wdFNu
aXBwZXQ6ICJTZWFyY2ggdGhlIHdlYjsgcmV0dXJucyB0aXRsZXMsIFVSTHMgYW5kIHNuaXBwZXRz
IGZyb20gdG9wIHJlc3VsdHMiLAoJCXByb21wdEd1aWRlbGluZXM6IFsKCQkJIlVzZSB3ZWJfc2Vh
cmNoIGZvciBpbmZvcm1hdGlvbiB0aGF0IGlzIG5vdCBpbiB0aGUgbG9jYWwgd29ya3NwYWNlOiBk
b2N1bWVudGF0aW9uLCBBUEkgcmVmZXJlbmNlcywgIiArCgkJCQkibGlicmFyeSB2ZXJzaW9ucywg
cmVjZW50IGV2ZW50cywgb3IgYW55dGhpbmcgdGhlIHVzZXIgZXhwZWN0cyB0byBiZSB2ZXJpZmll
ZCBvbmxpbmUuIiwKCQldLAoJCXBhcmFtZXRlcnM6IHdlYlNlYXJjaFNjaGVtYSwKCgkJYXN5bmMg
ZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zOiBXZWJTZWFyY2hUb29sSW5wdXQsIHNpZ25hbCwg
b25VcGRhdGUpIHsKCQkJY29uc3QgcXVlcnkgPSBwYXJhbXMucXVlcnkudHJpbSgpOwoJCQlpZiAo
IXF1ZXJ5KSB0aHJvdyBuZXcgRXJyb3IoInF1ZXJ5IG11c3Qgbm90IGJlIGVtcHR5Iik7CgkJCWNv
bnN0IGNvdW50ID0gTWF0aC5taW4oMTUsIE1hdGgubWF4KDEsIHBhcmFtcy5jb3VudCA/PyA1KSk7
CgkJCWNvbnN0IGVuZ2luZSA9IHBhcmFtcy5lbmdpbmUgPz8gImF1dG8iOwoKCQkJY29uc3QgcGFy
dGlhbCA9IChzdGFnZTogc3RyaW5nKTogV2ViU2VhcmNoRGV0YWlscyA9PiAoewoJCQkJZW5naW5l
OiBlbmdpbmUgYXMgV2ViU2VhcmNoRGV0YWlsc1siZW5naW5lIl0sCgkJCQlxdWVyeSwKCQkJCXJl
c3VsdHM6IFtdLAoJCQkJc3RhZ2UsCgkJCX0pOwoKCQkJb25VcGRhdGU/Lih7IGNvbnRlbnQ6IFt7
IHR5cGU6ICJ0ZXh0IiwgdGV4dDogIiIgfV0sIGRldGFpbHM6IHBhcnRpYWwoInRyeWluZyBlbmdp
bmVz4oCmIikgfSk7CgkJCWNvbnN0IG91dGNvbWUgPSBhd2FpdCBzZWFyY2hXZWIocXVlcnksIHsg
ZW5naW5lLCBjb3VudCwgc2lnbmFsLCBleGVjOiAoLi4uYSkgPT4gcGkuZXhlYyguLi5hKSB9KTsK
CgkJCWlmIChvdXRjb21lLnJlc3VsdHMubGVuZ3RoID4gMCkgewoJCQkJcmV0dXJuIHsKCQkJCQlj
b250ZW50OiBbeyB0eXBlOiAidGV4dCIsIHRleHQ6IGZvcm1hdFJlc3VsdHMocXVlcnksIG91dGNv
bWUuZW5naW5lLCBvdXRjb21lLnJlc3VsdHMpIH1dLAoJCQkJCWRldGFpbHM6IHsKCQkJCQkJZW5n
aW5lOiBvdXRjb21lLmVuZ2luZSwKCQkJCQkJcXVlcnksCgkJCQkJCXJlc3VsdHM6IG91dGNvbWUu
cmVzdWx0cywKCQkJCQkJZmFpbHVyZXM6IG91dGNvbWUuZmFpbHVyZXMubGVuZ3RoID4gMCA/IG91
dGNvbWUuZmFpbHVyZXMgOiB1bmRlZmluZWQsCgkJCQkJfSBzYXRpc2ZpZXMgV2ViU2VhcmNoRGV0
YWlscywKCQkJCX07CgkJCX0KCgkJCWlmIChvdXRjb21lLmNsZWFuRW1wdHkpIHsKCQkJCXJldHVy
biB7CgkJCQkJY29udGVudDogW3sgdHlwZTogInRleHQiLCB0ZXh0OiBgTm8gcmVzdWx0cyBmb3Vu
ZCBmb3IgIiR7cXVlcnl9Ii5gIH1dLAoJCQkJCWRldGFpbHM6IHsKCQkJCQkJZW5naW5lOiAiYXV0
byIsCgkJCQkJCXF1ZXJ5LAoJCQkJCQlyZXN1bHRzOiBbXSwKCQkJCQkJZmFpbHVyZXM6IG91dGNv
bWUuZmFpbHVyZXMubGVuZ3RoID4gMCA/IG91dGNvbWUuZmFpbHVyZXMgOiB1bmRlZmluZWQsCgkJ
CQkJfSBzYXRpc2ZpZXMgV2ViU2VhcmNoRGV0YWlscywKCQkJCX07CgkJCX0KCgkJCXRocm93IG5l
dyBFcnJvcihgd2ViX3NlYXJjaCBmYWlsZWQgZm9yICIke3F1ZXJ5fSI6ICR7b3V0Y29tZS5mYWls
dXJlcy5qb2luKCIgfCAiKX1gKTsKCQl9LAoKCQlyZW5kZXJDYWxsKGFyZ3M6IFdlYlNlYXJjaFRv
b2xJbnB1dCwgdGhlbWUpIHsKCQkJY29uc3QgcSA9IGFyZ3MucXVlcnkubGVuZ3RoID4gNjAgPyBg
JHthcmdzLnF1ZXJ5LnNsaWNlKDAsIDU3KX0uLi5gIDogYXJncy5xdWVyeTsKCQkJbGV0IHRleHQg
PSB0aGVtZS5mZygidG9vbFRpdGxlIiwgdGhlbWUuYm9sZCgid2ViX3NlYXJjaCAiKSk7CgkJCXRl
eHQgKz0gdGhlbWUuZmcoImFjY2VudCIsIGAiJHtxfSJgKTsKCQkJaWYgKGFyZ3MuZW5naW5lICYm
IGFyZ3MuZW5naW5lICE9PSAiYXV0byIpIHRleHQgKz0gdGhlbWUuZmcoImRpbSIsIGAgWyR7YXJn
cy5lbmdpbmV9XWApOwoJCQlpZiAoYXJncy5jb3VudCkgdGV4dCArPSB0aGVtZS5mZygiZGltIiwg
YCAoJHthcmdzLmNvdW50fSlgKTsKCQkJcmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApOwoJCX0s
CgoJCXJlbmRlclJlc3VsdChyZXN1bHQsIHsgZXhwYW5kZWQsIGlzUGFydGlhbCB9LCB0aGVtZSkg
ewoJCQljb25zdCBkZXRhaWxzID0gcmVzdWx0LmRldGFpbHMgYXMgV2ViU2VhcmNoRGV0YWlscyB8
IHVuZGVmaW5lZDsKCQkJaWYgKGlzUGFydGlhbCkgewoJCQkJY29uc3Qgc3RhZ2UgPSBkZXRhaWxz
Py5zdGFnZSA/PyAiIjsKCQkJCXJldHVybiBuZXcgVGV4dCh0aGVtZS5mZygid2FybmluZyIsIGBT
ZWFyY2hpbmfigKYke3N0YWdlID8gYCAke3N0YWdlfWAgOiAiIn1gKSwgMCwgMCk7CgkJCX0KCgkJ
CWNvbnN0IHJlc3VsdHMgPSBkZXRhaWxzPy5yZXN1bHRzID8/IFtdOwoJCQlpZiAocmVzdWx0cy5s
ZW5ndGggPT09IDApIHsKCQkJCWNvbnN0IGZpcnN0TGluZSA9CgkJCQkJcmVzdWx0LmNvbnRlbnQ/
LlswXT8udHlwZSA9PT0gInRleHQiCgkJCQkJCT8gcmVzdWx0LmNvbnRlbnRbMF0udGV4dC5zcGxp
dCgiXG4iKVswXQoJCQkJCQk6ICJObyByZXN1bHRzIjsKCQkJCXJldHVybiBuZXcgVGV4dCh0aGVt
ZS5mZygibXV0ZWQiLCBmaXJzdExpbmUpLCAwLCAwKTsKCQkJfQoKCQkJbGV0IHRleHQgPSB0aGVt
ZS5mZygic3VjY2VzcyIsIGDinJMgJHtyZXN1bHRzLmxlbmd0aH0gcmVzdWx0cyB2aWEgJHtkZXRh
aWxzPy5lbmdpbmUgPz8gIj8ifWApOwoJCQlpZiAoZGV0YWlscyAmJiBjb3ZlcmFnZVdhcm5pbmco
ZGV0YWlscy5xdWVyeSwgcmVzdWx0cykubGVuZ3RoID4gMCkgewoJCQkJdGV4dCArPSB0aGVtZS5m
Zygid2FybmluZyIsICIg4pqgIGNvdmVyYWdlIik7CgkJCX0KCQkJaWYgKCFleHBhbmRlZCkgewoJ
CQkJdGV4dCArPSB0aGVtZS5mZygiZGltIiwgYCAoJHtrZXlIaW50KCJhcHAudG9vbHMuZXhwYW5k
IiwgInRvIGV4cGFuZCIpfSlgKTsKCQkJfSBlbHNlIHsKCQkJCXJlc3VsdHMuZm9yRWFjaCgociwg
aSkgPT4gewoJCQkJCXRleHQgKz0gYFxuJHtpICsgMX0uICR7dGhlbWUuZmcoImFjY2VudCIsIHIu
dGl0bGUpfWA7CgkJCQkJdGV4dCArPSBgXG4gICAke3RoZW1lLmZnKCJkaW0iLCByLnVybCl9YDsK
CQkJCQlpZiAoci5zbmlwcGV0KSB0ZXh0ICs9IGBcbiAgICR7dGhlbWUuZmcoIm11dGVkIiwgci5z
bmlwcGV0Lmxlbmd0aCA+IDE0MCA/IGAke3Iuc25pcHBldC5zbGljZSgwLCAxMzcpfS4uLmAgOiBy
LnNuaXBwZXQpfWA7CgkJCQl9KTsKCQkJfQoJCQlyZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7
CgkJfSwKCX0pOwoKCXBpLnJlZ2lzdGVyQ29tbWFuZCgid2Vic2VhcmNoIiwgewoJCWRlc2NyaXB0
aW9uOiAiUnVuIGEgd2ViIHNlYXJjaCBhbmQgc2hvdyByZXN1bHRzIGluIGFuIG92ZXJsYXk6IC93
ZWJzZWFyY2ggPHF1ZXJ5PiIsCgkJaGFuZGxlcjogYXN5bmMgKGFyZ3MsIGN0eDogRXh0ZW5zaW9u
Q29tbWFuZENvbnRleHQpID0+IHsKCQkJY29uc3QgcXVlcnkgPSAoYXJncyA/PyAiIikudHJpbSgp
OwoJCQlpZiAoIXF1ZXJ5KSB7CgkJCQljdHgudWkubm90aWZ5KCJVc2FnZTogL3dlYnNlYXJjaCA8
cXVlcnk+IiwgIndhcm5pbmciKTsKCQkJCXJldHVybjsKCQkJfQoJCQlpZiAoIWN0eC5oYXNVSSkg
cmV0dXJuOwoKCQkJY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHNlYXJjaFdlYihxdWVyeSwgeyBlbmdp
bmU6ICJhdXRvIiwgY291bnQ6IDUsIGV4ZWM6ICguLi5hKSA9PiBwaS5leGVjKC4uLmEpIH0pOwoK
CQkJaWYgKGN0eC5tb2RlID09PSAidHVpIikgewoJCQkJYXdhaXQgY3R4LnVpLmN1c3RvbSgoX3R1
aSwgdGhlbWUsIF9rYiwgZG9uZSkgPT4gewoJCQkJCWNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtd
OwoJCQkJCWlmIChvdXRjb21lLnJlc3VsdHMubGVuZ3RoID09PSAwKSB7CgkJCQkJCWxpbmVzLnB1
c2godGhlbWUuZmcoIm11dGVkIiwgYE5vIHJlc3VsdHMgZm9yICIke3F1ZXJ5fSJgKSk7CgkJCQkJ
CWZvciAoY29uc3QgZiBvZiBvdXRjb21lLmZhaWx1cmVzKSBsaW5lcy5wdXNoKHRoZW1lLmZnKCJk
aW0iLCBgICAke2Z9YCkpOwoJCQkJCX0gZWxzZSB7CgkJCQkJCWxpbmVzLnB1c2godGhlbWUuZmco
ImRpbSIsIGAiJHtxdWVyeX0iIHZpYSAke291dGNvbWUuZW5naW5lfWApKTsKCQkJCQkJb3V0Y29t
ZS5yZXN1bHRzLmZvckVhY2goKHIsIGkpID0+IHsKCQkJCQkJCWxpbmVzLnB1c2goYCR7aSArIDF9
LiAke3RoZW1lLmZnKCJhY2NlbnQiLCByLnRpdGxlKX1gKTsKCQkJCQkJCWxpbmVzLnB1c2godGhl
bWUuZmcoImRpbSIsIGAgICAke3IudXJsfWApKTsKCQkJCQkJCWlmIChyLnNuaXBwZXQpIGxpbmVz
LnB1c2godGhlbWUuZmcoIm11dGVkIiwgYCAgICR7ci5zbmlwcGV0fWApKTsKCQkJCQkJfSk7CgkJ
CQkJCWZvciAoY29uc3QgdyBvZiBjb3ZlcmFnZVdhcm5pbmcocXVlcnksIG91dGNvbWUucmVzdWx0
cykpIHsKCQkJCQkJCWxpbmVzLnB1c2godGhlbWUuZmcoIndhcm5pbmciLCBgICAke3d9YCkpOwoJ
CQkJCQl9CgkJCQkJfQoJCQkJCXJldHVybiBuZXcgU2VhcmNoUmVzdWx0c092ZXJsYXkodGhlbWUs
IGxpbmVzLCBkb25lKTsKCQkJCX0sIHsgb3ZlcmxheTogdHJ1ZSB9KTsKCQkJfSBlbHNlIHsKCQkJ
CWNvbnN0IHN1bW1hcnkgPQoJCQkJCW91dGNvbWUucmVzdWx0cy5sZW5ndGggPiAwCgkJCQkJCT8g
b3V0Y29tZS5yZXN1bHRzLm1hcCgociwgaSkgPT4gYCR7aSArIDF9LiAke3IudGl0bGV9IOKAlCAk
e3IudXJsfWApLmpvaW4oIlxuIikKCQkJCQkJOiBgTm8gcmVzdWx0cy4gJHtvdXRjb21lLmZhaWx1
cmVzLmpvaW4oIjsgIikgfHwgImNsZWFuIGVtcHR5In1gOwoJCQkJY3R4LnVpLm5vdGlmeShzdW1t
YXJ5LCAiaW5mbyIpOwoJCQl9CgkJfSwKCX0pOwp9Cg==
```

## 16. Appendix B -- current package firecrawl.ts (verbatim, base64)

sha256 and line count follow; decode with `base64 -d` and verify the hash.
sha256: fe3d6ec638c186dfede9816ca2dc2e90983cb4dfc0a6a89c6f069922a72dd32b
lines:  406

```base64
aW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tICJAZWFyZW5kaWwtd29ya3MvcGktY29k
aW5nLWFnZW50IjsKaW1wb3J0IHsgVHlwZSB9IGZyb20gInR5cGVib3giOwppbXBvcnQgeyBTdHJp
bmdFbnVtIH0gZnJvbSAiQGVhcmVuZGlsLXdvcmtzL3BpLWFpIjsKaW1wb3J0IHsKICB0cnVuY2F0
ZUhlYWQsCiAgREVGQVVMVF9NQVhfQllURVMsCiAgREVGQVVMVF9NQVhfTElORVMsCiAgZm9ybWF0
U2l6ZSwKfSBmcm9tICJAZWFyZW5kaWwtd29ya3MvcGktY29kaW5nLWFnZW50IjsKaW1wb3J0IHsg
VGV4dCB9IGZyb20gIkBlYXJlbmRpbC13b3Jrcy9waS10dWkiOwoKLyoqCiAqIEZpcmVjcmF3bCBp
bnN0YW5jZSBVUkwsIGNvbmZpZ3VyYWJsZSBwZXItZGV2aWNlIHZpYSBQSV9GSVJFQ1JBV0xfVVJM
OgogKiAgIHVuc2V0ICAgICAgICAgIOKGkiBodHRwOi8vbG9jYWxob3N0OjMwMDIgKGxvY2FsIGlu
c3RhbmNlKQogKiAgIGFueSBVUkwgICAgICAgIOKGkiB1c2UgdGhhdCBpbnN0YW5jZQogKiAgICJv
ZmYiIG9yICIiICAgIOKGkiBkaXNhYmxlIHRoZSBleHRlbnNpb24gKG5vIHRvb2xzIHJlZ2lzdGVy
ZWQpCiAqLwpjb25zdCByYXdGaXJlY3Jhd2xVcmwgPSBwcm9jZXNzLmVudi5QSV9GSVJFQ1JBV0xf
VVJMOwpjb25zdCBGSVJFQ1JBV0xfVVJMID0gKAogIHJhd0ZpcmVjcmF3bFVybCA9PT0gdW5kZWZp
bmVkID8gImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMiIgOiByYXdGaXJlY3Jhd2xVcmwudHJpbSgpCiku
cmVwbGFjZSgvXC8rJC8sICIiKTsKY29uc3QgRklSRUNSQVdMX0VOQUJMRUQgPSBGSVJFQ1JBV0xf
VVJMICE9PSAiIiAmJiBGSVJFQ1JBV0xfVVJMICE9PSAib2ZmIjsKY29uc3QgRklSRUNSQVdMX0tF
WSA9IHByb2Nlc3MuZW52LlBJX0ZJUkVDUkFXTF9BUElfS0VZPy50cmltKCkgfHwgdW5kZWZpbmVk
OwoKLyoqCiAqIEZpcmVjcmF3bCBleHRlbnNpb24g4oCUIHdlYiBzZWFyY2ggYW5kIHBhZ2UgZXh0
cmFjdGlvbiB2aWEgc2VsZi1ob3N0ZWQgRmlyZWNyYXdsLgogKgogKiBUb29sczoKICogICB3ZWJf
c2VhcmNoICDigJQgc2VhcmNoIHRoZSB3ZWIgKFBPU1QgL3YxL3NlYXJjaCkKICogICB3ZWJfZXh0
cmFjdCDigJQgZXh0cmFjdCBwYWdlIGNvbnRlbnQgYXMgbWFya2Rvd24gKFBPU1QgL3YxL3NjcmFw
ZSkKICovCgovKioKICogTWFwIGEgbW9kZWwtZnJpZW5kbHkgZnJlc2huZXNzIHZhbHVlIHRvIEdv
b2dsZSdzIHRicyB0aW1lIGZpbHRlcgogKiAodGhlIEFQSSBoYXMgbm8gImZyZXNobmVzcyIgZmll
bGQg4oCUIGl0IHJlamVjdHMgdW5rbm93biBrZXlzIHdpdGggNDAwKToKICogICAiZGF5IiDihpIg
InFkcjpkIiwgIndlZWsiIOKGkiAicWRyOnciLCAiN2QiIOKGkiAicWRyOjdkIiwgInFkcjptIiDi
hpIgcGFzc3Rocm91Z2gKICovCmZ1bmN0aW9uIGZyZXNobmVzc1RvVGJzKGZyZXNobmVzczogc3Ry
aW5nKTogc3RyaW5nIHsKICBjb25zdCBmID0gZnJlc2huZXNzLnRyaW0oKS50b0xvd2VyQ2FzZSgp
OwogIGlmICgvXnFkcjpbYS16MC05XSskL2kudGVzdChmKSkgcmV0dXJuIGY7CiAgY29uc3QgbmFt
ZWQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7CiAgICBob3VyOiAicWRyOmgiLAogICAgZGF5
OiAicWRyOmQiLAogICAgd2VlazogInFkcjp3IiwKICAgIG1vbnRoOiAicWRyOm0iLAogICAgeWVh
cjogInFkcjp5IiwKICB9OwogIGlmIChuYW1lZFtmXSkgcmV0dXJuIG5hbWVkW2ZdOwogIGNvbnN0
IG0gPSBmLm1hdGNoKC9eKFxkKykoW2RobXldKSQvKTsKICBpZiAobSkgcmV0dXJuIGBxZHI6JHtt
WzFdfSR7bVsyXX1gOwogIHRocm93IG5ldyBFcnJvcigKICAgIGBJbnZhbGlkIGZyZXNobmVzcyAi
JHtmcmVzaG5lc3N9Ii4gVXNlICJkYXkiLCAid2VlayIsICJtb250aCIsICJ5ZWFyIiwgIjdkIiwg
IjMwZCIsIG9yIGEgcmF3IHRicyB2YWx1ZSBsaWtlICJxZHI6dyIuYCwKICApOwp9Cgphc3luYyBm
dW5jdGlvbiBmaXJlY3Jhd2xGZXRjaDxUPigKICBwYXRoOiBzdHJpbmcsCiAgcGF5bG9hZDogUmVj
b3JkPHN0cmluZywgdW5rbm93bj4sCiAgc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCwK
KTogUHJvbWlzZTxUPiB7CiAgY29uc3QgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9
IHsgIkNvbnRlbnQtVHlwZSI6ICJhcHBsaWNhdGlvbi9qc29uIiB9OwogIGlmIChGSVJFQ1JBV0xf
S0VZKSBoZWFkZXJzLkF1dGhvcml6YXRpb24gPSBgQmVhcmVyICR7RklSRUNSQVdMX0tFWX1gOwog
IGxldCByZXNwb25zZTogUmVzcG9uc2U7CiAgdHJ5IHsKICAgIHJlc3BvbnNlID0gYXdhaXQgZmV0
Y2goYCR7RklSRUNSQVdMX1VSTH0ke3BhdGh9YCwgewogICAgICBtZXRob2Q6ICJQT1NUIiwKICAg
ICAgaGVhZGVycywKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCksCiAgICAgIHNp
Z25hbCwKICAgIH0pOwogIH0gY2F0Y2ggKGVycikgewogICAgaWYgKHNpZ25hbD8uYWJvcnRlZCkg
dGhyb3cgZXJyOwogICAgdGhyb3cgbmV3IEVycm9yKAogICAgICBgRmlyZWNyYXdsIHVucmVhY2hh
YmxlIGF0ICR7RklSRUNSQVdMX1VSTH06ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gLAogICAg
KTsKICB9CiAgaWYgKCFyZXNwb25zZS5vaykgewogICAgdGhyb3cgbmV3IEVycm9yKAogICAgICBg
RmlyZWNyYXdsICR7cGF0aH0gZmFpbGVkOiAke3Jlc3BvbnNlLnN0YXR1c30gJHtyZXNwb25zZS5z
dGF0dXNUZXh0fWAsCiAgICApOwogIH0KICByZXR1cm4gKGF3YWl0IHJlc3BvbnNlLmpzb24oKSkg
YXMgVDsKfQpleHBvcnQgZGVmYXVsdCBmdW5jdGlvbiAocGk6IEV4dGVuc2lvbkFQSSkgewogIGlm
ICghRklSRUNSQVdMX0VOQUJMRUQpIHJldHVybjsKCiAgLy8gLS0tIFNlYXJjaCB0b29sIC0tLQog
IHBpLnJlZ2lzdGVyVG9vbCh7CiAgICBuYW1lOiAid2ViX3NlYXJjaCIsCiAgICBsYWJlbDogIldl
YiBTZWFyY2giLAogICAgZGVzY3JpcHRpb246CiAgICAgICJTZWFyY2ggdGhlIHdlYiB1c2luZyBz
ZWxmLWhvc3RlZCBGaXJlY3Jhd2wuIFJldHVybnMgVVJMcywgdGl0bGVzLCBhbmQgZGVzY3JpcHRp
b25zLiAiICsKICAgICAgIlVzZSBmb3IgZmluZGluZyBjdXJyZW50IGluZm9ybWF0aW9uLCBkb2N1
bWVudGF0aW9uLCBmYWN0cywgbmV3cywgb3IgYW55IHF1ZXJ5IHJlcXVpcmluZyBsaXZlIHdlYiBy
ZXN1bHRzLiIsCiAgICBwcm9tcHRTbmlwcGV0OgogICAgICAiU2VhcmNoIHRoZSB3ZWIgdmlhIHNl
bGYtaG9zdGVkIEZpcmVjcmF3bCDigJQgcmV0dXJucyBVUkxzLCB0aXRsZXMsIGFuZCBkZXNjcmlw
dGlvbnMiLAogICAgcHJvbXB0R3VpZGVsaW5lczogWwogICAgICAiVXNlIHdlYl9zZWFyY2ggd2hl
biB0aGUgdXNlciBhc2tzIHRvIHNlYXJjaCB0aGUgd2ViIG9yIGxvb2sgdXAgY3VycmVudCBpbmZv
cm1hdGlvbi4iLAogICAgICAiVXNlIHdlYl9leHRyYWN0IHRvIHJlYWQgZnVsbCBjb250ZW50IGZy
b20gVVJMcyByZXR1cm5lZCBieSB3ZWJfc2VhcmNoLiIsCiAgICBdLAogICAgcGFyYW1ldGVyczog
VHlwZS5PYmplY3QoewogICAgICBxdWVyeTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogIlNl
YXJjaCBxdWVyeSIgfSksCiAgICAgIGxpbWl0OiBUeXBlLk9wdGlvbmFsKAogICAgICAgIFR5cGUu
SW50ZWdlcih7CiAgICAgICAgICBtaW5pbXVtOiAxLAogICAgICAgICAgbWF4aW11bTogMjAsCiAg
ICAgICAgICBkZXNjcmlwdGlvbjogIk1heCByZXN1bHRzIHRvIHJldHVybiAoZGVmYXVsdDogNSki
LAogICAgICAgIH0pLAogICAgICApLAogICAgICBmcmVzaG5lc3M6IFR5cGUuT3B0aW9uYWwoCiAg
ICAgICAgVHlwZS5TdHJpbmcoewogICAgICAgICAgZGVzY3JpcHRpb246CiAgICAgICAgICAgICdU
aW1lIGZpbHRlcjogImRheSIsICJ3ZWVrIiwgIm1vbnRoIiwgInllYXIiLCBvciAiN2QiLCAiMzBk
IiwgZXRjLicsCiAgICAgICAgfSksCiAgICAgICksCiAgICAgIGxhbmc6IFR5cGUuT3B0aW9uYWwo
CiAgICAgICAgVHlwZS5TdHJpbmcoewogICAgICAgICAgZGVzY3JpcHRpb246ICJMYW5ndWFnZSBj
b2RlIChlLmcuICdlbicsICd6aCcsICdqYScpIiwKICAgICAgICB9KSwKICAgICAgKSwKICAgICAg
Y291bnRyeTogVHlwZS5PcHRpb25hbCgKICAgICAgICBUeXBlLlN0cmluZyh7CiAgICAgICAgICBk
ZXNjcmlwdGlvbjogIkNvdW50cnkgY29kZSAoZS5nLiAndXMnLCAnY24nLCAnanAnKSIsCiAgICAg
ICAgfSksCiAgICAgICksCiAgICAgIHRiczogVHlwZS5PcHRpb25hbCgKICAgICAgICBUeXBlLlN0
cmluZyh7CiAgICAgICAgICBkZXNjcmlwdGlvbjoKICAgICAgICAgICAgJ1JhdyBHb29nbGUgdGlt
ZS1iYXNlZCBzZWFyY2ggc3RyaW5nIChlLmcuICJxZHI6dyIgZm9yIHRoaXMgd2VlaykuIFRha2Vz
IHByZWNlZGVuY2Ugb3ZlciBmcmVzaG5lc3MuJywKICAgICAgICB9KSwKICAgICAgKSwKICAgICAg
ZmlsdGVyOiBUeXBlLk9wdGlvbmFsKAogICAgICAgIFR5cGUuU3RyaW5nKHsKICAgICAgICAgIGRl
c2NyaXB0aW9uOiAiRG9tYWluIGZpbHRlciAoZS5nLiAnZ2l0aHViLmNvbScpIiwKICAgICAgICB9
KSwKICAgICAgKSwKICAgIH0pLAogICAgYXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1z
LCBzaWduYWwpIHsKICAgICAgY29uc3QgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4g
PSB7CiAgICAgICAgcXVlcnk6IHBhcmFtcy5xdWVyeSwKICAgICAgICBsaW1pdDogcGFyYW1zLmxp
bWl0ID8/IDUsCiAgICAgIH07CiAgICAgIC8vIFRoZSBBUEkgaGFzIG5vICJmcmVzaG5lc3MiIGZp
ZWxkIOKAlCBtYXAgaXQgdG8gR29vZ2xlJ3MgdGJzIGZpbHRlci4KICAgICAgLy8gQSByYXcgdGJz
IHZhbHVlIHRha2VzIHByZWNlZGVuY2Ugb3ZlciBmcmVzaG5lc3MuCiAgICAgIGNvbnN0IHRicyA9
CiAgICAgICAgcGFyYW1zLnRicyA/PwogICAgICAgIChwYXJhbXMuZnJlc2huZXNzID8gZnJlc2hu
ZXNzVG9UYnMocGFyYW1zLmZyZXNobmVzcykgOiB1bmRlZmluZWQpOwogICAgICBpZiAodGJzKSBw
YXlsb2FkLnRicyA9IHRiczsKICAgICAgaWYgKHBhcmFtcy5sYW5nKSBwYXlsb2FkLmxhbmcgPSBw
YXJhbXMubGFuZzsKICAgICAgaWYgKHBhcmFtcy5jb3VudHJ5KSBwYXlsb2FkLmNvdW50cnkgPSBw
YXJhbXMuY291bnRyeTsKICAgICAgaWYgKHBhcmFtcy5maWx0ZXIpIHBheWxvYWQuZmlsdGVyID0g
cGFyYW1zLmZpbHRlcjsKCiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGZpcmVjcmF3bEZldGNo
PHsKICAgICAgICBzdWNjZXNzOiBib29sZWFuOwogICAgICAgIGVycm9yPzogc3RyaW5nOwogICAg
ICAgIGRhdGE/OiBBcnJheTx7IHVybDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBkZXNjcmlwdGlv
bjogc3RyaW5nIH0+OwogICAgICB9PigiL3YxL3NlYXJjaCIsIHBheWxvYWQsIHNpZ25hbCk7Cgog
ICAgICBpZiAoIXJlc3VsdC5zdWNjZXNzKSB7CiAgICAgICAgcmV0dXJuIHsKICAgICAgICAgIGNv
bnRlbnQ6IFsKICAgICAgICAgICAgeyB0eXBlOiAidGV4dCIsIHRleHQ6IGBTZWFyY2ggZmFpbGVk
OiAke3Jlc3VsdC5lcnJvciA/PyAidW5rbm93biBlcnJvciJ9YCB9LAogICAgICAgICAgXSwKICAg
ICAgICAgIGRldGFpbHM6IHsgZXJyb3I6IHJlc3VsdC5lcnJvciA/PyAic2VhcmNoIGZhaWxlZCIs
IHJlc3VsdHM6IFtdIH0sCiAgICAgICAgfTsKICAgICAgfQoKICAgICAgY29uc3QgaXRlbXMgPSBy
ZXN1bHQuZGF0YSA/PyBbXTsKICAgICAgaWYgKGl0ZW1zLmxlbmd0aCA9PT0gMCkgewogICAgICAg
IHJldHVybiB7CiAgICAgICAgICBjb250ZW50OiBbCiAgICAgICAgICAgIHsgdHlwZTogInRleHQi
LCB0ZXh0OiBgU2VhcmNoIHJldHVybmVkIG5vIHJlc3VsdHMgZm9yICIke3BhcmFtcy5xdWVyeX0i
LmAgfSwKICAgICAgICAgIF0sCiAgICAgICAgICBkZXRhaWxzOiB7IHJlc3VsdHM6IFtdIH0sCiAg
ICAgICAgfTsKICAgICAgfQogICAgICBjb25zdCBsaW5lcyA9IFtgJHtpdGVtcy5sZW5ndGh9IHJl
c3VsdChzKSBmb3VuZCBmb3IgIiR7cGFyYW1zLnF1ZXJ5fSI6YF07CgogICAgICBmb3IgKGxldCBp
ID0gMDsgaSA8IGl0ZW1zLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgY29uc3QgaXRlbSA9IGl0ZW1z
W2ldOwogICAgICAgIGxpbmVzLnB1c2goIiIpOwogICAgICAgIGxpbmVzLnB1c2goYCR7aSArIDF9
LiAke2l0ZW0udGl0bGUgfHwgIk5vIHRpdGxlIn1gKTsKICAgICAgICBsaW5lcy5wdXNoKGAgICBV
Ukw6ICR7aXRlbS51cmx9YCk7CiAgICAgICAgY29uc3QgZGVzYyA9IGl0ZW0uZGVzY3JpcHRpb24g
fHwgIiI7CiAgICAgICAgaWYgKGRlc2MpIHsKICAgICAgICAgIGxpbmVzLnB1c2goYCAgICR7ZGVz
Yy5sZW5ndGggPiAyMDAgPyBkZXNjLnNsaWNlKDAsIDE5NykgKyAiLi4uIiA6IGRlc2N9YCk7CiAg
ICAgICAgfQogICAgICB9CgogICAgICByZXR1cm4gewogICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6
ICJ0ZXh0IiwgdGV4dDogbGluZXMuam9pbigiXG4iKSB9XSwKICAgICAgICBkZXRhaWxzOiB7IHJl
c3VsdHM6IGl0ZW1zIH0sCiAgICAgIH07CiAgICB9LAogICAgcmVuZGVyQ2FsbChhcmdzLCB0aGVt
ZSkgewogICAgICBsZXQgdGV4dCA9IHRoZW1lLmZnKCJ0b29sVGl0bGUiLCB0aGVtZS5ib2xkKCJ3
ZWJfc2VhcmNoICIpKTsKICAgICAgdGV4dCArPSB0aGVtZS5mZygibXV0ZWQiLCBgIiR7YXJncy5x
dWVyeX0iYCk7CiAgICAgIGlmIChhcmdzLmxpbWl0ICYmIGFyZ3MubGltaXQgIT09IDUpIHsKICAg
ICAgICB0ZXh0ICs9IHRoZW1lLmZnKCJkaW0iLCBgIChsaW1pdDogJHthcmdzLmxpbWl0fSlgKTsK
ICAgICAgfQogICAgICByZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7CiAgICB9LAogICAgcmVu
ZGVyUmVzdWx0KHJlc3VsdCwgeyBleHBhbmRlZCB9LCB0aGVtZSkgewogICAgICBpZiAocmVzdWx0
LmRldGFpbHM/LmVycm9yKSB7CiAgICAgICAgcmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKCJlcnJv
ciIsIHJlc3VsdC5kZXRhaWxzLmVycm9yKSwgMCwgMCk7CiAgICAgIH0KICAgICAgY29uc3QgY291
bnQgPSAocmVzdWx0LmRldGFpbHMgYXMgeyByZXN1bHRzPzogdW5rbm93bltdIH0gfCB1bmRlZmlu
ZWQpCiAgICAgICAgPy5yZXN1bHRzPy5sZW5ndGggPz8gMDsKICAgICAgbGV0IHRleHQgPSB0aGVt
ZS5mZygic3VjY2VzcyIsIGDinJMgJHtjb3VudH0gcmVzdWx0KHMpYCk7CiAgICAgIGlmICghZXhw
YW5kZWQgJiYgY291bnQgPiAwKSB7CiAgICAgICAgdGV4dCArPSBgICgke3RoZW1lLmZnKCJkaW0i
LCAiZXhwYW5kIGZvciBkZXRhaWxzIil9KWA7CiAgICAgIH0KICAgICAgcmV0dXJuIG5ldyBUZXh0
KHRleHQsIDAsIDApOwogICAgfSwKICB9KTsKCiAgLy8gLS0tIEV4dHJhY3QgdG9vbCAtLS0KICBw
aS5yZWdpc3RlclRvb2woewogICAgbmFtZTogIndlYl9leHRyYWN0IiwKICAgIGxhYmVsOiAiV2Vi
IEV4dHJhY3QiLAogICAgZGVzY3JpcHRpb246CiAgICAgICJFeHRyYWN0IHdlYiBwYWdlIGNvbnRl
bnQgYXMgY2xlYW4gbWFya2Rvd24gdmlhIHNlbGYtaG9zdGVkIEZpcmVjcmF3bC4gIiArCiAgICAg
ICJVc2UgdG8gcmVhZCBmdWxsIGNvbnRlbnQgZnJvbSBVUkxzLCBmZXRjaCBkb2N1bWVudGF0aW9u
LCBleHRyYWN0IGFydGljbGUgdGV4dCwgIiArCiAgICAgICJvciBjb252ZXJ0IGFueSB3ZWJwYWdl
IHRvIHJlYWRhYmxlIG1hcmtkb3duLiIsCiAgICBwcm9tcHRTbmlwcGV0OgogICAgICAiRXh0cmFj
dCB3ZWIgcGFnZSBjb250ZW50IGFzIGNsZWFuIG1hcmtkb3duIHZpYSBzZWxmLWhvc3RlZCBGaXJl
Y3Jhd2wiLAogICAgcHJvbXB0R3VpZGVsaW5lczogWwogICAgICAiVXNlIHdlYl9leHRyYWN0IHRv
IHJlYWQgZnVsbCBwYWdlIGNvbnRlbnQgZnJvbSBhIFVSTC4iLAogICAgICAiVXNlIHdlYl9leHRy
YWN0IGFmdGVyIHdlYl9zZWFyY2ggdG8gcmVhZCB0aGUgZnVsbCBjb250ZW50IG9mIHNlYXJjaCBy
ZXN1bHRzLiIsCiAgICAgICJVc2Ugd2FpdF9zZWNvbmRzIGZvciBKYXZhU2NyaXB0LWhlYXZ5IG9y
IHNsb3ctbG9hZGluZyBwYWdlcy4iLAogICAgICAiVXNlIHNlbGVjdG9yIHRvIHRhcmdldCBzcGVj
aWZpYyBwYWdlIHNlY3Rpb25zIChlLmcuICdhcnRpY2xlJywgJ21haW4nKS4iLAogICAgXSwKICAg
IHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHsKICAgICAgdXJsOiBUeXBlLlN0cmluZyh7IGRlc2Ny
aXB0aW9uOiAiVVJMIHRvIGV4dHJhY3QgY29udGVudCBmcm9tIiB9KSwKICAgICAgZm9ybWF0OiBU
eXBlLk9wdGlvbmFsKAogICAgICAgIFN0cmluZ0VudW0oCiAgICAgICAgICBbIm1hcmtkb3duIiwg
Imh0bWwiLCAibGlua3MiXSBhcyBjb25zdCwKICAgICAgICAgIHsgZGVzY3JpcHRpb246ICJPdXRw
dXQgZm9ybWF0IChkZWZhdWx0OiBtYXJrZG93bikiIH0sCiAgICAgICAgKSwKICAgICAgKSwKICAg
ICAgd2FpdF9zZWNvbmRzOiBUeXBlLk9wdGlvbmFsKAogICAgICAgIFR5cGUuSW50ZWdlcih7CiAg
ICAgICAgICBtaW5pbXVtOiAwLAogICAgICAgICAgbWF4aW11bTogMzAsCiAgICAgICAgICBkZXNj
cmlwdGlvbjogIlNlY29uZHMgdG8gd2FpdCBmb3IgcGFnZSBsb2FkIGJlZm9yZSBleHRyYWN0aW5n
IChkZWZhdWx0OiAwKSIsCiAgICAgICAgfSksCiAgICAgICksCiAgICAgIHNlbGVjdG9yOiBUeXBl
Lk9wdGlvbmFsKAogICAgICAgIFR5cGUuU3RyaW5nKHsKICAgICAgICAgIGRlc2NyaXB0aW9uOgog
ICAgICAgICAgICAiSFRNTCB0YWcgbmFtZSB0byBleHRyYWN0IG9ubHkgKGUuZy4gJ2FydGljbGUn
LCAnbWFpbicpIiwKICAgICAgICB9KSwKICAgICAgKSwKICAgICAgaW5jbHVkZV9saW5rczogVHlw
ZS5PcHRpb25hbCgKICAgICAgICBUeXBlLkJvb2xlYW4oewogICAgICAgICAgZGVzY3JpcHRpb246
ICJBbHNvIGV4dHJhY3QgbGlua3MgZnJvbSB0aGUgcGFnZSAoZGVmYXVsdDogZmFsc2UpIiwKICAg
ICAgICB9KSwKICAgICAgKSwKICAgICAgbW9iaWxlOiBUeXBlLk9wdGlvbmFsKAogICAgICAgIFR5
cGUuQm9vbGVhbih7CiAgICAgICAgICBkZXNjcmlwdGlvbjogIlVzZSBtb2JpbGUgdmlld3BvcnQg
KGRlZmF1bHQ6IGZhbHNlKSIsCiAgICAgICAgfSksCiAgICAgICksCiAgICB9KSwKICAgIGFzeW5j
IGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgc2lnbmFsKSB7CiAgICAgIGNvbnN0IGZvcm1h
dHM6IHN0cmluZ1tdID0gW3BhcmFtcy5mb3JtYXQgPz8gIm1hcmtkb3duIl07CiAgICAgIGlmIChw
YXJhbXMuaW5jbHVkZV9saW5rcykgZm9ybWF0cy5wdXNoKCJsaW5rcyIpOwoKICAgICAgY29uc3Qg
cGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7CiAgICAgICAgdXJsOiBwYXJhbXMu
dXJsLAogICAgICAgIGZvcm1hdHMsCiAgICAgIH07CiAgICAgIGlmIChwYXJhbXMud2FpdF9zZWNv
bmRzICYmIHBhcmFtcy53YWl0X3NlY29uZHMgPiAwKSB7CiAgICAgICAgcGF5bG9hZC53YWl0Rm9y
ID0gcGFyYW1zLndhaXRfc2Vjb25kcyAqIDEwMDA7CiAgICAgIH0KICAgICAgaWYgKHBhcmFtcy5z
ZWxlY3RvcikgewogICAgICAgIC8vIFRoZSBBUEkgZmlsdGVycyBieSBIVE1MIHRhZyBuYW1lIChp
bmNsdWRlVGFncyksIG5vdCBDU1Mgc2VsZWN0b3JzCiAgICAgICAgcGF5bG9hZC5pbmNsdWRlVGFn
cyA9IFtwYXJhbXMuc2VsZWN0b3JdOwogICAgICB9CiAgICAgIGlmIChwYXJhbXMubW9iaWxlKSBw
YXlsb2FkLm1vYmlsZSA9IHRydWU7CgogICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBmaXJlY3Jh
d2xGZXRjaDx7CiAgICAgICAgc3VjY2VzczogYm9vbGVhbjsKICAgICAgICBlcnJvcj86IHN0cmlu
ZzsKICAgICAgICBkYXRhPzogewogICAgICAgICAgbWFya2Rvd24/OiBzdHJpbmc7CiAgICAgICAg
ICBodG1sPzogc3RyaW5nOwogICAgICAgICAgbGlua3M/OiBzdHJpbmdbXTsKICAgICAgICAgIG1l
dGFkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47CiAgICAgICAgfTsKICAgICAgfT4oIi92
MS9zY3JhcGUiLCBwYXlsb2FkLCBzaWduYWwpOwoKICAgICAgaWYgKCFyZXN1bHQuc3VjY2VzcyB8
fCAhcmVzdWx0LmRhdGEpIHsKICAgICAgICByZXR1cm4gewogICAgICAgICAgY29udGVudDogWwog
ICAgICAgICAgICB7CiAgICAgICAgICAgICAgdHlwZTogInRleHQiLAogICAgICAgICAgICAgIHRl
eHQ6IGBFeHRyYWN0aW9uIGZhaWxlZCBmb3IgJHtwYXJhbXMudXJsfTogJHtyZXN1bHQuZXJyb3Ig
Pz8gInVua25vd24gZXJyb3IifWAsCiAgICAgICAgICAgIH0sCiAgICAgICAgICBdLAogICAgICAg
ICAgZGV0YWlsczogeyB1cmw6IHBhcmFtcy51cmwsIGVycm9yOiB0cnVlIH0sCiAgICAgICAgfTsK
ICAgICAgfQoKICAgICAgY29uc3QgZGF0YSA9IHJlc3VsdC5kYXRhOwogICAgICBjb25zdCBtZXRh
ZGF0YSA9IGRhdGEubWV0YWRhdGEgPz8ge307CiAgICAgIGNvbnN0IHN0YXR1c0NvZGUgPSBtZXRh
ZGF0YS5zdGF0dXNDb2RlIGFzIG51bWJlciB8IHVuZGVmaW5lZDsKICAgICAgY29uc3QgbGlua3Mg
PSBkYXRhLmxpbmtzOwogICAgICBjb25zdCBjb250ZW50ID0gZGF0YS5tYXJrZG93biA/PyBkYXRh
Lmh0bWwgPz8gIiI7CgogICAgICBpZiAoIWNvbnRlbnQgJiYgKCFsaW5rcyB8fCBsaW5rcy5sZW5n
dGggPT09IDApKSB7CiAgICAgICAgcmV0dXJuIHsKICAgICAgICAgIGNvbnRlbnQ6IFsKICAgICAg
ICAgICAgewogICAgICAgICAgICAgIHR5cGU6ICJ0ZXh0IiwKICAgICAgICAgICAgICB0ZXh0Ogog
ICAgICAgICAgICAgICAgYEV4dHJhY3Rpb24gcmV0dXJuZWQgbm8gY29udGVudCBmb3IgJHtwYXJh
bXMudXJsfWAgKwogICAgICAgICAgICAgICAgKHN0YXR1c0NvZGUgIT09IHVuZGVmaW5lZCA/IGAg
KEhUVFAgJHtzdGF0dXNDb2RlfSlgIDogIiIpLAogICAgICAgICAgICB9LAogICAgICAgICAgXSwK
ICAgICAgICAgIGRldGFpbHM6IHsgdXJsOiBwYXJhbXMudXJsLCBlcnJvcjogdHJ1ZSwgc3RhdHVz
Q29kZSB9LAogICAgICAgIH07CiAgICAgIH0KCiAgICAgIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9
IFtdOwoKICAgICAgY29uc3QgdGl0bGUgPSBtZXRhZGF0YS50aXRsZSBhcyBzdHJpbmcgfCB1bmRl
ZmluZWQ7CiAgICAgIGlmICh0aXRsZSkgewogICAgICAgIHBhcnRzLnB1c2goYFRpdGxlOiAke3Rp
dGxlfWApOwogICAgICAgIHBhcnRzLnB1c2goIiIpOwogICAgICB9CgogICAgICBpZiAoY29udGVu
dCkgewogICAgICAgIGNvbnN0IHRydW5jYXRpb24gPSB0cnVuY2F0ZUhlYWQoY29udGVudCwgewog
ICAgICAgICAgbWF4TGluZXM6IERFRkFVTFRfTUFYX0xJTkVTLAogICAgICAgICAgbWF4Qnl0ZXM6
IERFRkFVTFRfTUFYX0JZVEVTLAogICAgICAgIH0pOwogICAgICAgIHBhcnRzLnB1c2godHJ1bmNh
dGlvbi5jb250ZW50KTsKCiAgICAgICAgaWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7CiAgICAg
ICAgICBwYXJ0cy5wdXNoKAogICAgICAgICAgICBgXG5bT3V0cHV0IHRydW5jYXRlZDogJHt0cnVu
Y2F0aW9uLm91dHB1dExpbmVzfSBvZiAke3RydW5jYXRpb24udG90YWxMaW5lc30gbGluZXMgYCAr
CiAgICAgICAgICAgICAgYCgke2Zvcm1hdFNpemUodHJ1bmNhdGlvbi5vdXRwdXRCeXRlcyl9IG9m
ICR7Zm9ybWF0U2l6ZSh0cnVuY2F0aW9uLnRvdGFsQnl0ZXMpfSldYCwKICAgICAgICAgICk7CiAg
ICAgICAgfQogICAgICB9CgogICAgICBpZiAobGlua3MgJiYgbGlua3MubGVuZ3RoID4gMCkgewog
ICAgICAgIHBhcnRzLnB1c2goIiIpOwogICAgICAgIHBhcnRzLnB1c2goYExpbmtzICgke2xpbmtz
Lmxlbmd0aH0pOmApOwogICAgICAgIGNvbnN0IHNob3duID0gbGlua3Muc2xpY2UoMCwgMjApOwog
ICAgICAgIGZvciAoY29uc3QgbGluayBvZiBzaG93bikgewogICAgICAgICAgcGFydHMucHVzaChg
ICAtICR7bGlua31gKTsKICAgICAgICB9CiAgICAgICAgaWYgKGxpbmtzLmxlbmd0aCA+IDIwKSB7
CiAgICAgICAgICBwYXJ0cy5wdXNoKGAgIC4uLiBhbmQgJHtsaW5rcy5sZW5ndGggLSAyMH0gbW9y
ZWApOwogICAgICAgIH0KICAgICAgfQoKICAgICAgcmV0dXJuIHsKICAgICAgICBjb250ZW50OiBb
eyB0eXBlOiAidGV4dCIsIHRleHQ6IHBhcnRzLmpvaW4oIlxuIikgfV0sCiAgICAgICAgZGV0YWls
czogewogICAgICAgICAgdXJsOiBwYXJhbXMudXJsLAogICAgICAgICAgdGl0bGUsCiAgICAgICAg
ICBmb3JtYXQ6IHBhcmFtcy5mb3JtYXQgPz8gIm1hcmtkb3duIiwKICAgICAgICAgIGxpbmtDb3Vu
dDogbGlua3M/Lmxlbmd0aCA/PyAwLAogICAgICAgICAgc3RhdHVzQ29kZTogbWV0YWRhdGEuc3Rh
dHVzQ29kZSwKICAgICAgICB9LAogICAgICB9OwogICAgfSwKICAgIHJlbmRlckNhbGwoYXJncywg
dGhlbWUpIHsKICAgICAgbGV0IHRleHQgPSB0aGVtZS5mZygidG9vbFRpdGxlIiwgdGhlbWUuYm9s
ZCgid2ViX2V4dHJhY3QgIikpOwogICAgICAvLyBUcnVuY2F0ZSBVUkwgZm9yIGRpc3BsYXkKICAg
ICAgY29uc3QgdXJsID0gYXJncy51cmw7CiAgICAgIGNvbnN0IGRpc3BsYXlVcmwgPSB1cmwubGVu
Z3RoID4gNjAgPyAiLi4uIiArIHVybC5zbGljZSgtNTcpIDogdXJsOwogICAgICB0ZXh0ICs9IHRo
ZW1lLmZnKCJtdXRlZCIsIGRpc3BsYXlVcmwpOwogICAgICBjb25zdCBleHRyYXM6IHN0cmluZ1td
ID0gW107CiAgICAgIGlmIChhcmdzLndhaXRfc2Vjb25kcyAmJiBhcmdzLndhaXRfc2Vjb25kcyA+
IDApIHsKICAgICAgICBleHRyYXMucHVzaChgd2FpdDoke2FyZ3Mud2FpdF9zZWNvbmRzfXNgKTsK
ICAgICAgfQogICAgICBpZiAoYXJncy5zZWxlY3RvcikgZXh0cmFzLnB1c2goYHNlbDoke2FyZ3Mu
c2VsZWN0b3J9YCk7CiAgICAgIGlmIChleHRyYXMubGVuZ3RoID4gMCkgewogICAgICAgIHRleHQg
Kz0gdGhlbWUuZmcoImRpbSIsIGAgWyR7ZXh0cmFzLmpvaW4oIiwgIil9XWApOwogICAgICB9CiAg
ICAgIHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTsKICAgIH0sCiAgICByZW5kZXJSZXN1bHQo
cmVzdWx0LCB7IGV4cGFuZGVkIH0sIHRoZW1lKSB7CiAgICAgIGlmIChyZXN1bHQuZGV0YWlscz8u
ZXJyb3IpIHsKICAgICAgICByZXR1cm4gbmV3IFRleHQodGhlbWUuZmcoImVycm9yIiwgIkV4dHJh
Y3Rpb24gZmFpbGVkIiksIDAsIDApOwogICAgICB9CiAgICAgIGNvbnN0IGRldGFpbHMgPSByZXN1
bHQuZGV0YWlscyBhcyB7CiAgICAgICAgdXJsPzogc3RyaW5nOwogICAgICAgIHRpdGxlPzogc3Ry
aW5nOwogICAgICAgIHN0YXR1c0NvZGU/OiBudW1iZXI7CiAgICAgICAgbGlua0NvdW50PzogbnVt
YmVyOwogICAgICB9IHwgdW5kZWZpbmVkOwogICAgICBsZXQgdGV4dCA9IHRoZW1lLmZnKCJzdWNj
ZXNzIiwgIuKckyBFeHRyYWN0ZWQiKTsKICAgICAgaWYgKGRldGFpbHM/LnRpdGxlKSB7CiAgICAg
ICAgdGV4dCArPSBgICR7dGhlbWUuZmcoImRpbSIsIGDigJQgJHtkZXRhaWxzLnRpdGxlfWApfWA7
CiAgICAgIH0KICAgICAgaWYgKCFleHBhbmRlZCAmJiBkZXRhaWxzPy5saW5rQ291bnQpIHsKICAg
ICAgICB0ZXh0ICs9IGAgKCR7ZGV0YWlscy5saW5rQ291bnR9IGxpbmtzKWA7CiAgICAgIH0KICAg
ICAgcmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApOwogICAgfSwKICB9KTsKfQo=
```
