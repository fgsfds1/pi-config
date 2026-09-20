/**
 * Pi Web Search Extension — unified web_search / web_extract
 *
 * Registers two tools with one file and two backends, selected per call:
 *
 *   web_search  — search the web (titles, URLs, snippets)
 *   web_extract — fetch a page as clean markdown / raw html / links
 *
 * Backends:
 *   api    — a self-hosted Firecrawl instance (POST /v1/search, /v1/scrape).
 *            Used when PI_FIRECRAWL_URL is set and the circuit breaker is not
 *            tripped. web_extract via the api renders JavaScript.
 *   local  — web_search scrapes public search engines (brave, google,
 *            duckduckgo, bing) in a chain with bot-challenge retries;
 *            web_extract does a plain-HTTP fetch (no JS rendering, clearly
 *            labeled). Zero dependencies, zero credentials.
 *
 * Routing (per call, `backend` parameter):
 *   auto   (default) — api when configured and healthy, else the local path.
 *           A clean api empty triggers a local "second opinion"; an api
 *           failure falls back to local with an annotation.
 *   api    — force the api backend; errors instead of falling back.
 *   local  — force the local path.
 *
 * Configuration (environment variables):
 *   PI_FIRECRAWL_URL      Origin (scheme + host + port) of the Firecrawl
 *                         instance, no /v1. Unset or empty -> api backend
 *                         disabled (local paths only).
 *   PI_FIRECRAWL_DISABLE  "true" forces the api backend off even when
 *                         PI_FIRECRAWL_URL is set.
 *   WEB_SEARCH_ENGINES    Comma-separated local search chain (subset/reorder
 *                         of brave,google,duckduckgo,bing).
 *
 * The local search chain is built for restrictive firewalls: engines are
 * tried in order with retries on bot-challenge pages.
 *   brave       search.brave.com — primary; ~1/3 of requests hit an anti-bot
 *               challenge page (and 429s under rapid use), so requests are
 *               retried with a different user agent
 *   google      google.com/search?gbv=1 (non-JS version) — often works on
 *               normal networks, blocked on some corporate egress
 *   duckduckgo  lite.duckduckgo.com — works with compressed requests;
 *               challenged from some datacenter IPs
 *   bing        bing.com/search — parseable HTML, but from flagged IPs it can
 *               serve irrelevant "decoy" result sets, so it is last in the
 *               chain
 *
 * Several engines (Bing, DuckDuckGo-lite from datacenter IPs) never report
 * "no results": for an unmatched query they silently return a relaxed or
 * decoy result set that shares no words with the query. There is no reliable
 * engine-side marker for this, so the tool checks *coverage* itself: whether
 * the query's own quoted phrases and significant tokens appear in any result
 * title/snippet/URL. When they don't, a ⚠️ coverage warning is appended.
 *
 * Note: api.duckduckgo.com (Instant Answer API) returns stripped/empty
 * content for general queries, so it is not used as a search source.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { matchesKey, Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EngineName = "brave" | "google" | "duckduckgo" | "bing";

interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
}

interface WebSearchDetails {
	/** Which backend produced the results. */
	backend: "api" | "local";
	/** Engine that produced local results (undefined for the api). */
	engine?: EngineName;
	query: string;
	results: SearchResult[];
	failures?: string[];
	/** Set on partial (in-flight) results only */
	stage?: string;
}

// ---------------------------------------------------------------------------
// Configuration + circuit breaker
// ---------------------------------------------------------------------------

/**
 * Firecrawl instance origin, configurable per-device via PI_FIRECRAWL_URL.
 * Unset or empty -> no api backend (local paths only). Trailing slashes are
 * trimmed; the client appends /v1/search and /v1/scrape itself.
 */
const FIRECRAWL_URL = (process.env.PI_FIRECRAWL_URL ?? "").trim().replace(/\/+$/, "");
/** PI_FIRECRAWL_DISABLE=true forces the api backend off even when a URL is set. */
const FIRECRAWL_DISABLE = process.env.PI_FIRECRAWL_DISABLE === "true";

function apiConfigured(): boolean {
	return FIRECRAWL_URL !== "" && !FIRECRAWL_DISABLE;
}

/**
 * Circuit breaker (module-level, per pi process; no persistence). Trips on
 * definitive or repeated api failures so a dead instance does not cost a
 * call's latency per query. Headless invocations start fresh, which is the
 * correct conservative default.
 */
type BreakerKind = "auth" | "rate" | "other";
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
const breaker: { trippedUntil: number; lastError: string; failStreak: number } = {
	trippedUntil: 0,
	lastError: "",
	failStreak: 0,
};

function breakerTripped(): boolean {
	return Date.now() < breaker.trippedUntil;
}

function breakerNote(kind: BreakerKind, reason: string): void {
	const now = Date.now();
	if (kind === "auth") {
		// A bad credential/configuration will not fix itself within a session.
		breaker.trippedUntil = Infinity;
		breaker.lastError = "HTTP 401/403";
	} else if (kind === "rate") {
		breaker.trippedUntil = now + BREAKER_COOLDOWN_MS;
		breaker.lastError = "HTTP 429";
	} else {
		breaker.failStreak++;
		breaker.lastError = reason;
		if (breaker.failStreak >= 2) breaker.trippedUntil = now + BREAKER_COOLDOWN_MS;
	}
}

function breakerReset(): void {
	breaker.failStreak = 0;
}

/** Evaluated per call: configured, not disabled, and the breaker is not tripped. */
function apiAvailable(): boolean {
	return apiConfigured() && !breakerTripped();
}

// ---------------------------------------------------------------------------
// Api client (self-hosted Firecrawl)
// ---------------------------------------------------------------------------

// 70 s: must stay above the self-hosted v1 scrape deadline (45 s after the
// fork's timeout prefault bump) so the api's own 408 fires first and the
// local fallback path is driven by a definitive api answer, not by this
// ceiling. See REPORT-408-fixes.md §7/§9.
const API_TIMEOUT_MS = 70_000;

/** An api failure carrying its reason string (section 5.2) and breaker kind. */
class ApiError extends Error {
	reason: string;
	kind: BreakerKind;
	status?: number;
	constructor(reason: string, kind: BreakerKind, status?: number) {
		super(reason);
		this.reason = reason;
		this.kind = kind;
		this.status = status;
	}
}

/** Map a thrown error to a breaker kind (401/403, 429, everything else). */
function classifyApiError(err: unknown): BreakerKind {
	if (err instanceof ApiError) return err.kind;
	return "other";
}

/** The human-readable failure reason for a thrown error. */
function apiReason(err: unknown): string {
	if (err instanceof ApiError) return err.reason;
	return (err as Error).message ?? String(err);
}

/**
 * Map a model-friendly freshness value to Google's tbs time filter
 * (the API has no "freshness" field — it rejects unknown keys with 400):
 *   "day" → "qdr:d", "week" → "qdr:w", "7d" → "qdr:7d", "qdr:m" → passthrough
 */
function freshnessToTbs(freshness: string): string {
	const f = freshness.trim().toLowerCase();
	if (/^qdr:[a-z0-9]+$/i.test(f)) return f;
	const named: Record<string, string> = {
		hour: "qdr:h",
		day: "qdr:d",
		week: "qdr:w",
		month: "qdr:m",
		year: "qdr:y",
	};
	if (named[f]) return named[f];
	const m = f.match(/^(\d+)([dhmy])$/);
	if (m) return `qdr:${m[1]}${m[2]}`;
	throw new Error(
		`Invalid freshness "${freshness}". Use "day", "week", "month", "year", "7d", "30d", or a raw tbs value like "qdr:w".`,
	);
}

/**
 * Resolve the tbs filter from the tbs/freshness params (tbs takes precedence).
 * Both go through freshnessToTbs, which throws a descriptive error for
 * invalid values — an input error, not a backend failure.
 */
function resolveTbs(tbs: string | undefined, freshness: string | undefined): string | undefined {
	if (tbs) return freshnessToTbs(tbs);
	if (freshness) return freshnessToTbs(freshness);
	return undefined;
}

/**
 * POST to the Firecrawl instance and validate the response envelope.
 * Throws ApiError carrying the 5.2 reason string on any failure. No
 * Authorization header (keyless deployment on a trusted network).
 */
async function firecrawlFetch<T>(
	path: string,
	payload: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<T> {
	const t = withTimeout(signal, API_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`${FIRECRAWL_URL}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: t.signal,
		});
	} catch (err) {
		if (signal?.aborted) throw err;
		if (t.signal.aborted) throw new ApiError("timed out after 70s", "other");
		throw new ApiError(`unreachable (${(err as Error).message})`, "other");
	} finally {
		t.cancel();
	}
	if (!response.ok) {
		const status = response.status;
		const kind: BreakerKind = status === 401 || status === 403 ? "auth" : status === 429 ? "rate" : "other";
		throw new ApiError(`HTTP ${status}`, kind, status);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new ApiError("malformed response", "other");
	}
	const env = body as { success?: boolean; error?: string; data?: unknown } | null;
	if (typeof env !== "object" || env === null || typeof env.success !== "boolean") {
		throw new ApiError("malformed response", "other");
	}
	if (!env.success) {
		throw new ApiError(env.error || "api reported failure", "other");
	}
	if (env.data === undefined || env.data === null) {
		throw new ApiError("malformed response (missing data)", "other");
	}
	return body as T;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const USER_AGENTS = [
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];

/**
 * Honest non-browser UA for the challenge-fallback lane. Many WAFs apply a
 * higher bar to browser UAs (JS/fingerprint checks) and let self-identifying
 * bots through: Anubis's default policy challenges only UAs containing
 * "Mozilla", and several CF/403 cases (danbooru, codeberg, gitlab.gnome,
 * atwiki) passed with a plain UA. Tried ONLY after a challenge is detected
 * on the normal (Mozilla) attempt, so normal requests are unaffected.
 */
const PLAIN_USER_AGENT = "pi-fetch/1.0";

/** Status codes that indicate a bot challenge / block page. */
const CHALLENGE_STATUSES = new Set([403, 406, 429, 498, 503]);

/**
 * Challenge-page markers (lowercased, checked in the first 3 KB of the body).
 * Deliberately conservative: generic words ("robot", "captcha") false-positive
 * on real content. A wrong retry is cheap (best-result logic keeps the first
 * clean result); a wrong skip is not.
 */
const CHALLENGE_MARKERS = [
	"anubis",
	"making sure you're not a bot",
	"just a moment",
	"cf-chl",
	"please enable cookies",
	"fab_chlg",
	"recaptcha",
	"проверк",
	"доступ ограничен",
];

function looksChallenged(statusCode: number | undefined, body: string): boolean {
	if (statusCode !== undefined && CHALLENGE_STATUSES.has(statusCode)) return true;
	const head = body.slice(0, 3000).toLowerCase();
	return CHALLENGE_MARKERS.some((m) => head.includes(m));
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

/** Minimal shape of pi.exec (so the core can be tested without pi). */
export interface ExecFn {
	(
		command: string,
		args: string[],
		options?: { signal?: AbortSignal; timeout?: number },
	): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
}

/** Set once when the curl binary turns out to be unavailable. */
let curlUnavailable = false;

export function resetCurlState(): void {
	curlUnavailable = false;
}

/**
 * Fetch a page over HTTPS.
 *
 * Prefers `curl` via exec: curl uses the system CA store, which is what makes
 * this work behind corporate TLS-intercepting proxies (Node's bundled CA store
 * rejects the corporate MITM certificates, and NODE_EXTRA_CA_CERTS only takes
 * effect at Node startup, so it cannot be set from an extension). Falls back
 * to global fetch when exec/curl is not available.
 */
async function fetchHtml(opts: { url: string; timeoutMs: number; signal: AbortSignal | undefined; userAgent: string; exec?: ExecFn }): Promise<{ status: number; html: string }> {
	const { url, timeoutMs, signal, userAgent, exec } = opts;

	if (exec && !curlUnavailable) {
		const r = await exec("curl", [
			"-sS",
			"-L",
			"--compressed",
			"--max-time",
			String(Math.max(5, Math.ceil(timeoutMs / 1000))),
			"-A",
			userAgent,
			"-H",
			"Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"-H",
			"Accept-Language: en-US,en;q=0.9",
			"-w",
			"\n__WS_STATUS__:%{http_code}",
			"--",
			url,
		], { signal, timeout: timeoutMs + 5000 });

		if (r.code === 0) {
			const m = r.stdout.match(/\n__WS_STATUS__:(\d{3})$/);
			return { status: m ? parseInt(m[1]!, 10) : 0, html: m ? r.stdout.slice(0, m.index!) : r.stdout };
		}
		if (r.killed) throw new Error(`timed out after ${Math.ceil(timeoutMs / 1000)}s`);
		const stderr = r.stderr.trim().split("\n").filter(Boolean).pop() ?? `curl exit ${r.code}`;
		if (r.code === 127 || /no such file|command not found/i.test(stderr)) {
			curlUnavailable = true;
		} else {
			throw new Error(stderr.replace(/^curl:\s*/, ""));
		}
	}

	// Fallback: global fetch (works where Node's CA store is trusted, e.g. no MITM).
	const res = await fetch(url, {
		headers: {
			"User-Agent": userAgent,
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
		redirect: "follow",
		signal: signal ?? AbortSignal.timeout(opts.timeoutMs),
	});
	const html = await res.text();
	return { status: res.status, html };
}

/** Combine an optional external abort signal with a timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
	timer.unref?.();
	return {
		signal: controller.signal,
		cancel: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		function onAbort() {
			done();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
	return s.replace(/<[^>]*>/g, " ");
}

function cleanText(s: string): string {
	return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Engine parsers
// ---------------------------------------------------------------------------

function parseBrave(html: string, count: number): SearchResult[] {
	const results: SearchResult[] = [];
	const chunks = html.split(/<div[^>]*data-type="web"/).slice(1);
	for (const chunk of chunks) {
		const link = chunk.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
		if (!link) continue;
		const titleMatch =
			chunk.match(/<div class="title[^"]*"[^>]*title="([^"]+)"/) ??
			chunk.match(/<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
		const snippetMatch = chunk.match(/<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
		const snippet = snippetMatch ? cleanText(snippetMatch[1]) : "";
		results.push({
			url: decodeEntities(link[1]),
			title: titleMatch ? cleanText(titleMatch[1]) : decodeEntities(link[1]),
			snippet: snippet ? snippet.slice(0, 300) : undefined,
		});
		if (results.length >= count) break;
	}
	return results;
}

function parseBing(html: string, count: number): SearchResult[] {
	const results: SearchResult[] = [];
	const chunks = html.split(/<li class="b_algo"/).slice(1);
	for (const chunk of chunks) {
		const link = chunk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
		if (!link) continue;
		let url = decodeEntities(link[1]);
		if (url.startsWith("//")) url = `https:${url}`;
		// Bing wraps result URLs in a /ck/a redirect; the real URL is base64 in u=a1...
		const u = url.match(/[?&]u=a1([A-Za-z0-9+/=_-]+)/);
		if (u) {
			let b64 = u[1].replace(/-/g, "+").replace(/_/g, "/");
			b64 += "=".repeat((4 - (b64.length % 4)) % 4);
			try {
				const decoded = Buffer.from(b64, "base64").toString("utf8");
				if (decoded.startsWith("http")) url = decoded;
			} catch {
				// keep the redirect URL
			}
		}
		const snippetMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
		const snippet = snippetMatch ? cleanText(snippetMatch[1]) : "";
		results.push({
			url,
			title: cleanText(link[2]),
			snippet: snippet ? snippet.slice(0, 300) : undefined,
		});
		if (results.length >= count) break;
	}
	return results;
}

function parseGoogle(html: string, count: number): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const chunks = html.split(/<div class="g"/).slice(1);
	for (const chunk of chunks) {
		const link = chunk.match(/<a[^>]*href="\/url\?q=([^&"<>]+)[^"]*"/);
		if (!link) continue;
		const url = decodeEntities(link[1]).replace(/%26/g, "&");
		if (!/^https?:\/\//i.test(url)) continue;
		if (seen.has(url)) continue;
		seen.add(url);
		const titleMatch = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
		const h3End = titleMatch ? chunk.indexOf("</h3>") : -1;
		const tail = h3End >= 0 ? chunk.slice(h3End) : "";
		const snippetMatch = tail.match(/<span[^>]*>([\s\S]{30,600}?)<\/span>/);
		const snippet = snippetMatch ? cleanText(snippetMatch[1]) : "";
		results.push({
			url,
			title: titleMatch ? cleanText(titleMatch[1]) : url,
			snippet: snippet ? snippet.slice(0, 300) : undefined,
		});
		if (results.length >= count) break;
	}
	return results;
}

/** Unwrap protocol-relative URLs and DuckDuckGo's /l/?uddg= redirect links. */
function unwrapDuckDuckGoUrl(url: string): string {
	let u = url.startsWith("//") ? `https:${url}` : url;
	try {
		if (/^https?:\/\/(www\.)?duckduckgo\.com\/l\//i.test(u)) {
			const uddg = new URL(u).searchParams.get("uddg");
			if (uddg) return uddg;
		}
	} catch {
		// keep as-is
	}
	return u;
}

function parseDuckDuckGo(html: string, count: number): SearchResult[] {
	const results: SearchResult[] = [];
	const re =
		/<a[^>]*class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>|<a[^>]*href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
	for (const m of html.matchAll(re)) {
		const rawUrl = m[1] ?? m[3];
		const title = m[2] ?? m[4];
		const url = unwrapDuckDuckGoUrl(decodeEntities(rawUrl ?? ""));
		if (!/^https?:\/\//i.test(url)) continue;
		// The snippet cell (result-snippet) follows the link cell in the same row.
		const start = (m.index ?? 0) + m[0].length;
		const nextLink = html.indexOf("result-link", start);
		const end = nextLink === -1 ? Math.min(start + 4000, html.length) : Math.min(start + 4000, nextLink);
		const sm = html.slice(start, end).match(/result-snippet['"][^>]*>([\s\S]*?)<\/td>/);
		const snippet = sm ? cleanText(sm[1]) : "";
		results.push({
			url,
			title: cleanText(title),
			snippet: snippet ? snippet.slice(0, 300) : undefined,
		});
		if (results.length >= count) break;
	}
	return results;
}

interface Engine {
	name: EngineName;
	url: (query: string, count: number) => string;
	parse: (html: string, count: number) => SearchResult[];
	/** True when the response is a bot-challenge / error page rather than results. */
	isBlocked: (status: number, html: string) => boolean;
}

const ENGINES: Record<EngineName, Engine> = {
	brave: {
		name: "brave",
		url: (q, _n) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
		parse: parseBrave,
		isBlocked: (status, html) => status !== 200 || !html.includes('data-type="web"'),
	},
	google: {
		name: "google",
		url: (q, n) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=${n}&hl=en&gl=us&gbv=1`,
		parse: parseGoogle,
		isBlocked: (status, html) =>
			status !== 200 || /enablejs|httpservice|\/sorry\/|unusual traffic/i.test(html) || !html.includes("/url?q="),
	},
	duckduckgo: {
		name: "duckduckgo",
		url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
		parse: parseDuckDuckGo,
		isBlocked: (status, html) => status !== 200 || !html.includes("result-link"),
	},
	bing: {
		name: "bing",
		url: (q, n) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${n}&setlang=en&cc=us`,
		parse: parseBing,
		isBlocked: (status, html) => status !== 200 || !html.includes("b_algo"),
	},
};

const DEFAULT_CHAIN: EngineName[] = ["brave", "google", "duckduckgo", "bing"];

function autoEngineOrder(): EngineName[] {
	const raw = process.env.WEB_SEARCH_ENGINES ?? DEFAULT_CHAIN.join(",");
	const names = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s): s is EngineName => s in ENGINES);
	return names.length > 0 ? names : [...DEFAULT_CHAIN];
}

// ---------------------------------------------------------------------------
// Search orchestration
// ---------------------------------------------------------------------------

interface EngineOutcome {
	results: SearchResult[];
	/** Set when the engine was blocked/unreachable (as opposed to a clean "no results"). */
	error?: string;
}

async function runEngine(
	name: EngineName,
	query: string,
	count: number,
	signal?: AbortSignal,
	exec?: ExecFn,
): Promise<EngineOutcome> {
	const engine = ENGINES[name];
	let lastError = "unknown error";

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) return { results: [], error: "cancelled" };
		const t = withTimeout(signal, REQUEST_TIMEOUT_MS);
		try {
			const { status, html } = await fetchHtml({
				url: engine.url(query, count),
				timeoutMs: REQUEST_TIMEOUT_MS,
				signal: t.signal,
				userAgent: USER_AGENTS[(attempt - 1) % USER_AGENTS.length]!,
				exec,
			});
			if (engine.isBlocked(status, html)) {
				lastError = `blocked (HTTP ${status}, bot challenge page)`;
			} else {
				return { results: engine.parse(html, count) };
			}
		} catch (err) {
			const e = err as { name?: string; message?: string; cause?: { message?: string } };
			let msg = e?.message ?? String(err);
			if (msg === "fetch failed" && e?.cause?.message) msg = `fetch failed (${e.cause.message})`;
			lastError = signal?.aborted || t.signal.aborted
				? "cancelled or timed out"
				: msg;
		} finally {
			t.cancel();
		}
		if (attempt < MAX_ATTEMPTS) await sleep(1000 * attempt, signal);
	}

	return { results: [], error: lastError };
}

interface WebSearchOutcome {
	engine: EngineName;
	results: SearchResult[];
	failures: string[];
	/** At least one engine answered cleanly with zero results. */
	cleanEmpty: boolean;
}

export interface SearchOptions {
	engine?: "auto" | EngineName;
	count?: number;
	signal?: AbortSignal;
	exec?: ExecFn;
}

export async function searchWeb(query: string, opts: SearchOptions = {}): Promise<WebSearchOutcome> {
	const engine = opts.engine ?? "auto";
	const count = Math.min(15, Math.max(1, opts.count ?? 5));
	const chain = engine === "auto" ? autoEngineOrder() : [engine];
	const failures: string[] = [];
	let cleanEmpty = false;

	for (const name of chain) {
		if (opts.signal?.aborted) return { engine: chain[0]!, results: [], failures, cleanEmpty };
		const outcome = await runEngine(name, query, count, opts.signal, opts.exec);
		if (outcome.results.length > 0) {
			return { engine: name, results: outcome.results, failures, cleanEmpty };
		}
		if (outcome.error) failures.push(`${name}: ${outcome.error}`);
		else cleanEmpty = true;
	}

	return { engine: chain[0]!, results: [], failures, cleanEmpty };
}

// ---------------------------------------------------------------------------
// Query-fragment coverage check
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
	"a","an","the","and","or","but","if","then","else","of","to","in","on","for","with","by","at","as",
	"is","are","was","were","be","been","being","am","do","does","did","done","have","has","had",
	"this","that","these","those","it","its","his","her","their","our","your","my","me","we","you","i",
	"vs","versus","how","what","which","who","whom","whose","when","where","why","can","could","should",
	"would","will","shall","may","might","must","not","no","nor","so","than","too","very","just","only",
	"also","about","into","over","under","again","here","there","all","any","both","each","few","more",
	"most","other","some","such","own","same","up","out","off","per","via",
]);

/** Quoted phrases ("..." or '...') in a query, trimmed and deduped. */
function quotedPhrases(query: string): string[] {
	const out: string[] = [];
	for (const m of query.matchAll(/"([^"]+)"|'([^']+)'/g)) {
		const p = (m[1] ?? m[2] ?? "").trim();
		if (p.length >= 3) out.push(p);
	}
	return [...new Set(out)];
}

/**
 * Meaningful standalone tokens: alphanumeric, >= 4 chars, not a stopword.
 * Quoted phrases are stripped first so their words don't double-count here.
 */
function significantTokens(query: string): string[] {
	const stripped = query.replace(/"([^"]*)"|'([^']*)'/g, " ");
	const out: string[] = [];
	for (const m of stripped.matchAll(/[a-z0-9][a-z0-9_.+\-]*/gi)) {
		const t = m[0].toLowerCase();
		if (t.length >= 4 && !STOPWORDS.has(t)) out.push(t);
	}
	return [...new Set(out)];
}

function haystackOf(r: SearchResult): string {
	return `${r.title} ${r.snippet ?? ""} ${r.url}`.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Compare the query's own fragments against the returned results and return
 * human-readable warnings (empty array = no problem detected).
 *
 * - Missing quoted phrase: no result's title/snippet/URL contains the phrase.
 * - No token coverage: no result contains ANY significant query token — the
 *   strongest decoy signal (e.g. Bing serving unrelated listings for a
 *   nonsense query).
 */
export function coverageWarning(query: string, results: SearchResult[]): string[] {
	if (results.length === 0) return [];
	const hays = results.map(haystackOf);

	const missingPhrases = quotedPhrases(query).filter(
		(p) => !hays.some((h) => h.includes(p.toLowerCase().replace(/\s+/g, " "))),
	);

	const tokens = significantTokens(query);
	const noTokenCoverage =
		tokens.length >= 2 && !hays.some((h) => tokens.some((t) => h.includes(t)));

	const lines: string[] = [];
	if (noTokenCoverage) {
		lines.push(
			"⚠️ coverage: no result's title/snippet/URL contains any significant word of the query — the engine likely relaxed the query or returned decoy results; treat this set with caution (try another engine or a narrower query)",
		);
	}
	if (missingPhrases.length > 0) {
		lines.push(
			`⚠️ coverage: no result mentions ${missingPhrases.map((p) => `"${p}"`).join(", ")} — the engine may have dropped that constraint (snippets are truncated, so the pages themselves could still contain it; verify against the source)`,
		);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

export function formatResults(query: string, engine: EngineName | "api", results: SearchResult[], tbs?: string): string {
	const lines: string[] = [`Web search results for "${query}" (via ${engine}, ${results.length}):`, ""];
	results.forEach((r, i) => {
		lines.push(`${i + 1}. ${r.title}`);
		lines.push(`   ${r.url}`);
		if (r.snippet) lines.push(`   ${r.snippet}`);
		lines.push("");
	});
	const hosts = new Set(results.map((r) => hostOf(r.url)).filter(Boolean));
	if (results.length >= 3 && hosts.size === 1) {
		lines.push(`(note: all results come from a single host (${[...hosts][0]}) - treat with caution)`);
	}
	lines.push(...coverageWarning(query, results));
	if (engine === "api" && tbs) {
		// The api backend applies time filters only where its search engines
		// support them (and not at all for values without an equivalent, e.g.
		// qdr:7d) — so "fresh" is a request, not a guarantee.
		lines.push(
			`(time filter "${tbs}" is best-effort: most of the api's search engines apply it, but not all - verify recency before relying on it)`,
		);
	}
	return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Overlay for /websearch
// ---------------------------------------------------------------------------

class SearchResultsOverlay {
	readonly width = 86;
	focused = false;

	private readonly lines: string[];

	constructor(
		private theme: Theme,
		lines: string[],
		private done: (result?: never) => void,
	) {
		this.lines = lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q" || data === "Q") {
			this.done();
		}
	}

	render(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const pad = (s: string) => {
			const w = visibleWidth(s);
			return w >= innerW ? s.slice(0, innerW) : s + " ".repeat(innerW - w);
		};
		const row = (content: string) => th.fg("border", "│") + pad(content) + th.fg("border", "│");

		const out: string[] = [
			th.fg("border", `╭${"─".repeat(innerW)}╮`),
			row(` ${th.fg("accent", th.bold("web_search results"))}`),
			row(""),
		];
		for (const line of this.lines) out.push(row(` ${line}`));
		out.push(row(""));
		out.push(row(` ${th.fg("dim", "Esc / Enter / q to close")}`));
		out.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return out;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ---------------------------------------------------------------------------
// URL guard
// ---------------------------------------------------------------------------

/**
 * String-based guard against fetching private/loopback URLs (no DNS
 * resolution — a public hostname that resolves to an internal IP is NOT
 * caught). It is a guardrail against accidental or model-driven probing, not
 * a security boundary. Throws a clean tool error for blocked URLs.
 */
export function assertPublicUrl(url: string): void {
	const block: () => never = () => {
		throw new Error(`blocked non-public URL: ${url}`);
	};
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		block();
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") block();
	let host = u.hostname.toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

	if (host === "localhost" || host.endsWith(".local")) block();

	// IPv4: 127.*, 0.*, 10.*, 169.254.*, 172.16.*-172.31.*, 192.168.*
	const blockPrivateV4 = (a: number, b: number): void => {
		if (a === 127 || a === 0 || a === 10) block();
		if (a === 169 && b === 254) block();
		if (a === 172 && b >= 16 && b <= 31) block();
		if (a === 192 && b === 168) block();
	};

	if (host.includes(":")) {
		// IPv6: ::1, fc00::/7 (unique-local), fe80::/10 (link-local)
		if (host === "::1") block();
		if (/^f[cd]/.test(host)) block();
		if (/^fe[89ab]/.test(host)) block();
		// IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:h1h2:h3h4): the mapped
		// 32 bits get the same IPv4 rules, otherwise loopback/private
		// addresses slip through in mapped notation.
		const mapped = host.match(/^::ffff:(.+)$/);
		if (mapped) {
			const dotted = mapped[1].match(/^(\d{1,3})\.(\d{1,3})\./);
			const hex = mapped[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
			if (dotted) {
				blockPrivateV4(Number(dotted[1]), Number(dotted[2]));
			} else if (hex) {
				// The first 16-bit group holds octets 1-2 (high byte = octet 1).
				const hi = parseInt(hex[1]!, 16);
				blockPrivateV4((hi >> 8) & 0xff, hi & 0xff);
			}
		}
		return;
	}

	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) blockPrivateV4(Number(m[1]), Number(m[2]));
}

// ---------------------------------------------------------------------------
// Local (plain-HTTP) fetch for web_extract
// ---------------------------------------------------------------------------

interface WebExtractDetails {
	url: string;
	title?: string;
	format: string;
	backend: "api" | "local" | "jina";
	linkCount?: number;
	statusCode?: number;
	truncated?: boolean;
}

const LOCAL_FETCH_TIMEOUT_MS = 20_000;
const LOCAL_FETCH_MAX_BYTES = 2 * 1024 * 1024; // 2 MB body cap
const LOCAL_FETCH_MAX_CHARS = 100_000; // markdown/html text cap
const LOCAL_FETCH_MAX_REDIRECTS = 10;

interface LocalExtractOutcome {
	/** Assembled content (without the label / annotation lines). */
	text: string;
	details: WebExtractDetails;
	/** Whether the fetch produced meaningful page content. */
	hasContent: boolean;
}

/**
 * Plain-HTTP fetch of a public page (the "local" backend of web_extract). No
 * JS rendering. Redirects are followed manually so that every redirect
 * target passes assertPublicUrl (global fetch would follow blindly, leaving
 * redirect-based SSRF open).
 */
async function localFetchPage(
	url: string,
	signal: AbortSignal | undefined,
	opts?: { userAgent?: string },
): Promise<{ html: string; finalUrl: string; status: number }> {
	assertPublicUrl(url);
	let current = url;
	const userAgent = opts?.userAgent ?? USER_AGENTS[0]!;
	const t = withTimeout(signal, LOCAL_FETCH_TIMEOUT_MS);
	// Minimal per-call cookie jar: some sites gate content behind a
	// redirect+Set-Cookie handshake (307 -> /?rr=1 + cookie; cookieless
	// clients loop forever). undici's fetch has no cookie jar, so follow the
	// handshake manually. Scope: this call only, host-scoped, first-list-wins
	// per name+host.
	const jar: Array<{ name: string; value: string; host: string }> = [];
	try {
		for (let hop = 0; hop <= LOCAL_FETCH_MAX_REDIRECTS; hop++) {
			const host = new URL(current).hostname;
			const headers: Record<string, string> = {
				"User-Agent": userAgent,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
			};
			const forHost = jar.filter((c) => host === c.host || host.endsWith(`.${c.host}`));
			if (forHost.length > 0) {
				headers["Cookie"] = forHost.map((c) => `${c.name}=${c.value}`).join("; ");
			}
			const res = await fetch(current, {
				headers,
				redirect: "manual",
				signal: t.signal,
			});
			const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
			for (const sc of setCookies) {
				const pair = sc.split(";")[0] ?? "";
				const eq = pair.indexOf("=");
				if (eq <= 0) continue;
				const name = pair.slice(0, eq).trim();
				const value = pair.slice(eq + 1).trim();
				const i = jar.findIndex((c) => c.name === name && c.host === host);
				if (i >= 0) jar[i] = { name, value, host };
				else jar.push({ name, value, host });
			}
			if (res.status >= 300 && res.status < 400) {
				const loc = res.headers.get("location");
				if (!loc) throw new Error(`redirect without Location header (HTTP ${res.status})`);
				current = new URL(loc, current).toString();
				assertPublicUrl(current);
				continue;
			}
			const html = await res.text();
			if (html.length > LOCAL_FETCH_MAX_BYTES) {
				throw new Error("page too large for local fetch");
			}
			return { html, finalUrl: current, status: res.status };
		}
		throw new Error(`too many redirects (>${LOCAL_FETCH_MAX_REDIRECTS})`);
	} finally {
		t.cancel();
	}
}

/**
 * Convert fetched HTML to readable text (the degraded "markdown"): remove
 * non-content elements, break at block-level tag boundaries, strip the
 * remaining tags, decode entities, and normalize whitespace.
 */
function htmlToText(html: string): { text: string; title?: string } {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? cleanText(titleMatch[1]) : undefined;

	let s = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
		.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, "")
		.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");

	// Newline at each block-level tag boundary.
	const blockTags = "p|div|br|hr|li|h1|h2|h3|h4|h5|h6|tr|table|section|article|header|footer|blockquote|pre";
	s = s.replace(new RegExp(`</?(?:${blockTags})\\b[^>]*>`, "gi"), "\n");

	// Strip all remaining tags, then decode entities (so escaped tags like
	// &lt;div&gt; survive as text), then normalize whitespace.
	s = s.replace(/<[^>]*>/g, "");
	s = decodeEntities(s);
	s = s
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return { text: s, title };
}

/**
 * Extract all <a href> targets: absolute URLs kept, relative URLs resolved
 * against the request URL, protocol-relative (//host/...) unwrapped to
 * https. Deduped, capped at 200.
 */
function extractLinks(html: string, baseUrl: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
		let u = decodeEntities(m[1]).trim();
		if (!u) continue;
		if (u.startsWith("//")) u = `https:${u}`;
		let parsed: URL;
		try {
			parsed = new URL(u, baseUrl);
		} catch {
			continue;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
		u = parsed.toString();
		if (seen.has(u)) continue;
		seen.add(u);
		out.push(u);
		if (out.length >= 200) break;
	}
	return out;
}

/**
 * The degraded plain fetch. `url` is re-validated (assertPublicUrl) because
 * this path fetches directly from the user's machine.
 */
async function runLocalExtract(
	url: string,
	format: string,
	signal: AbortSignal | undefined,
	opts?: { userAgent?: string },
): Promise<LocalExtractOutcome> {
	const userAgent = opts?.userAgent ?? USER_AGENTS[0]!;
	let { html, finalUrl, status } = await localFetchPage(url, signal, { userAgent });
	// Challenge-gated plain-UA retry (see PLAIN_USER_AGENT): only when the
	// first attempt used the browser UA. Best-result: keep the first attempt
	// if the retry is still challenged or fails.
	if (userAgent === USER_AGENTS[0]! && looksChallenged(status, html)) {
		try {
			const retry = await localFetchPage(url, signal, { userAgent: PLAIN_USER_AGENT });
			if (!looksChallenged(retry.status, retry.html)) {
				({ html, finalUrl, status } = retry);
			}
		} catch {
			// keep the first attempt's result
		}
	}

	if (format === "links") {
		const links = extractLinks(html, finalUrl);
		const text =
			links.length > 0 ? `Links (${links.length}):\n${links.map((l) => `  - ${l}`).join("\n")}` : "";
		return {
			text,
			details: { url, format, backend: "local", linkCount: links.length, statusCode: status },
			hasContent: links.length > 0,
		};
	}

	if (format === "html") {
		let text = html;
		let truncated = false;
		if (text.length > LOCAL_FETCH_MAX_CHARS) {
			text = text.slice(0, LOCAL_FETCH_MAX_CHARS) + " [truncated]";
			truncated = true;
		}
		return {
			text,
			details: { url, format, backend: "local", statusCode: status, truncated },
			hasContent: true,
		};
	}

	// markdown (default): the html-to-text pipeline.
	const { text: body, title } = htmlToText(html);
	let text = body;
	let truncated = false;
	if (text.length > LOCAL_FETCH_MAX_CHARS) {
		text = text.slice(0, LOCAL_FETCH_MAX_CHARS) + " [truncated]";
		truncated = true;
	}
	if (title) text = `Title: ${title}\n\n${text}`;
	// JavaScript-app heuristic: little visible text but a large, script-heavy
	// HTML body — the static fetch cannot see the rendered content.
	if (text.length < 200 && html.length > 5000) {
		text +=
			"\n(page appears to be a JavaScript application - the static fetch returned little content; " +
			"the api backend renders JS and would be needed for full content)";
	}
	return {
		text,
		details: { url, title, format, backend: "local", statusCode: status, truncated },
		hasContent: body.trim().length > 0,
	};
}

// ---------------------------------------------------------------------------
// Jina Reader fallback (last rung of the web_extract ladder)
// ---------------------------------------------------------------------------

const JINA_READER_PREFIX = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 25_000;

/**
 * Jina Reader (r.jina.ai) — a third-party scraping service that renders JS
 * and clears bot challenges. Measured (REPORT-antibot.md step 3): it clears
 * the CF-hard class (economist/producthunt/substack/ycombinator) in 1-2 s
 * where the local browser is challenged. Used as the LAST rung (auto mode
 * only, detection-gated): it sends the URL to a third party, so it is a
 * fallback, not the default. An optional PI_JINA_KEY raises the rate limit
 * (~20 RPM without a key, ~200 RPM with).
 */
async function jinaFetch(
	url: string,
	signal: AbortSignal | undefined,
): Promise<{ text: string; title?: string; statusCode: number }> {
	assertPublicUrl(url);
	const t = withTimeout(signal, JINA_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = { Accept: "text/plain" };
		const key = process.env.PI_JINA_KEY;
		if (key) headers["Authorization"] = `Bearer ${key}`;
		const res = await fetch(JINA_READER_PREFIX + url, {
			headers,
			signal: t.signal,
		});
		if (!res.ok) throw new Error(`Jina Reader HTTP ${res.status}`);
		const raw = await res.text();
		// Jina returns a header (Title / URL Source / ... / Markdown Content:).
		const titleMatch = raw.match(/^Title:\s*(.+)$/m);
		const title = titleMatch ? cleanText(titleMatch[1]) : undefined;
		const contentIdx = raw.indexOf("Markdown Content:");
		const text =
			contentIdx >= 0
				? raw.slice(contentIdx + "Markdown Content:".length).trim()
				: raw.trim();
		return { text, title, statusCode: res.status };
	} finally {
		t.cancel();
	}
}

// ---------------------------------------------------------------------------
// Unified routing
// ---------------------------------------------------------------------------

interface UnifiedSearchResult {
	backend: "api" | "local";
	engine?: EngineName;
	results: SearchResult[];
	failures?: string[];
	/** Prepend as the first line when the local path answered in auto mode. */
	annotation?: string;
	/** Which "no results" line to emit (only when results is empty). */
	emptyKind?: "local" | "api" | "both";
}

interface ApiSearchItem {
	url: string;
	title: string;
	description: string;
}

/**
 * Search via the api backend. Returns normalized SearchResults — snippets are
 * capped at 300 chars to match the local backend, and titles fall back to
 * "No title". The results then go through the unified formatting (coverage
 * warning and single-host note apply to api results as well).
 */
async function apiSearch(
	query: string,
	count: number,
	tbs: string | undefined,
	params: WebSearchToolInput,
	signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
	const payload: Record<string, unknown> = { query, limit: count };
	if (tbs) payload.tbs = tbs;
	if (params.lang) payload.lang = params.lang;
	if (params.country) payload.country = params.country;
	if (params.filter) payload.filter = params.filter;
	const result = await firecrawlFetch<{ success: boolean; error?: string; data: ApiSearchItem[] | null }>(
		"/v1/search",
		payload,
		signal,
	);
	if (!Array.isArray(result.data)) {
		throw new ApiError("malformed response (missing data)", "other");
	}
	return result.data.map((item) => ({
		title: item.title || "No title",
		url: item.url,
		snippet: item.description ? item.description.slice(0, 300) : undefined,
	}));
}

interface ApiScrapeData {
	markdown?: string;
	html?: string;
	links?: string[];
	metadata?: Record<string, unknown>;
}

/**
 * Scrape via the api backend. Output assembly is unchanged from the old
 * firecrawl extension (Title line, truncateHead content, Links section).
 * Throws ApiError on any failure; hasContent is false when the api returned
 * success but no markdown/html/links.
 */
async function apiScrape(
	url: string,
	format: string,
	params: WebExtractToolInput,
	signal: AbortSignal | undefined,
	userAgent?: string,
): Promise<{ text: string; content: string; details: WebExtractDetails; hasContent: boolean }> {
	const formats: string[] = [format];
	if (params.include_links) formats.push("links");

	const payload: Record<string, unknown> = { url, formats };
	if (userAgent) {
		// The api forwards `headers` to the browser service, which uses a
		// user-agent header there as the context UA override.
		payload.headers = { "user-agent": userAgent };
	}
	if (params.wait_seconds && params.wait_seconds > 0) {
		payload.waitFor = params.wait_seconds * 1000;
	}
	if (params.selector) {
		// The API filters by HTML tag name (includeTags), not CSS selectors
		payload.includeTags = [params.selector];
	}
	if (params.mobile) payload.mobile = true;

	const result = await firecrawlFetch<{ success: boolean; error?: string; data: ApiScrapeData }>(
		"/v1/scrape",
		payload,
		signal,
	);

	const data = result.data;
	const metadata = data.metadata ?? {};
	const statusCode = metadata.statusCode as number | undefined;
	const links = data.links;
	const content = data.markdown ?? data.html ?? "";

	const parts: string[] = [];

	const title = metadata.title as string | undefined;
	if (title) {
		parts.push(`Title: ${title}`);
		parts.push("");
	}

	if (content) {
		const truncation = truncateHead(content, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		parts.push(truncation.content);

		if (truncation.truncated) {
			parts.push(
				`\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
					`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`,
			);
		}
	}

	if (links && links.length > 0) {
		parts.push("");
		parts.push(`Links (${links.length}):`);
		const shown = links.slice(0, 20);
		for (const link of shown) {
			parts.push(`  - ${link}`);
		}
		if (links.length > 20) {
			parts.push(`  ... and ${links.length - 20} more`);
		}
	}

	return {
		text: parts.join("\n"),
		content,
		details: {
			url,
			title,
			format,
			backend: "api",
			linkCount: links?.length ?? 0,
			statusCode,
		},
		hasContent: Boolean(content) || (links !== undefined && links.length > 0),
	};
}

/**
 * web_search routing (section 5.1). `onStage` receives (backend, stage) for
 * partial updates; pass undefined to skip them.
 */
async function runUnifiedSearch(
	query: string,
	params: WebSearchToolInput,
	signal: AbortSignal | undefined,
	exec: ExecFn | undefined,
	onStage?: (backend: "api" | "local", stage: string) => void,
): Promise<UnifiedSearchResult> {
	const count = Math.min(15, Math.max(1, params.count ?? 5));
	const engine = params.engine ?? "auto";
	const backend = params.backend ?? "auto";

	// Explicit api: require the api, with distinct errors for "not configured"
	// and "cooling down".
	if (backend === "api") {
		if (!apiConfigured()) {
			throw new Error('api backend unavailable (set PI_FIRECRAWL_URL and ensure PI_FIRECRAWL_DISABLE is not "true")');
		}
		if (breakerTripped()) {
			throw new Error(`api backend cooling down after: ${breaker.lastError}`);
		}
	}

	// The api path runs when explicitly requested, or in auto mode when the
	// api is available.
	const useApi = backend === "api" || (backend === "auto" && apiAvailable());

	// Validate tbs/freshness before any api call, only when the api will be
	// used (5.2 item 7: an input error, thrown with no fallback).
	const tbs = useApi ? resolveTbs(params.tbs, params.freshness) : undefined;

	if (!useApi) {
		// Pure local path — byte-identical to the standalone local extension:
		// no annotation, no wasted api call, no breaker interaction.
		onStage?.("local", "trying engines…");
		const outcome = await searchWeb(query, { engine, count, signal, exec });
		if (outcome.results.length > 0) {
			return {
				backend: "local",
				engine: outcome.engine,
				results: outcome.results,
				failures: outcome.failures.length > 0 ? outcome.failures : undefined,
			};
		}
		if (outcome.cleanEmpty) {
			return {
				backend: "local",
				results: [],
				emptyKind: "local",
				failures: outcome.failures.length > 0 ? outcome.failures : undefined,
			};
		}
		throw new Error(`web_search failed for "${query}": ${outcome.failures.join(" | ")}`);
	}

	// Api path.
	onStage?.("api", "trying api backend...");
	let apiResults: SearchResult[];
	try {
		apiResults = await apiSearch(query, count, tbs, params, signal);
	} catch (err) {
		if (signal?.aborted) throw err;
		if (backend === "api") throw err; // explicit api: no fallback, ever
		const reason = apiReason(err);
		breakerNote(classifyApiError(err), reason);
		onStage?.("local", `api backend failed (${reason}), trying local engines...`);
		const outcome = await searchWeb(query, { engine, count, signal, exec });
		if (outcome.results.length > 0) {
			return {
				backend: "local",
				engine: outcome.engine,
				results: outcome.results,
				failures: outcome.failures.length > 0 ? outcome.failures : undefined,
				annotation: `(api backend unavailable: ${reason} - results from local search)`,
			};
		}
		if (outcome.cleanEmpty) {
			throw new Error(`web_search failed for "${query}": api: ${reason} | local: clean empty`);
		}
		throw new Error(`web_search failed for "${query}": api: ${reason} | local: ${outcome.failures.join(" | ")}`);
	}
	breakerReset();

	if (apiResults.length > 0) {
		return { backend: "api", results: apiResults };
	}

	// Clean api empty (success, data === []).
	if (backend === "api") {
		return { backend: "api", results: [], emptyKind: "api" };
	}

	// auto: a clean api empty gets a second opinion from the local chain —
	// the fix for an instance whose search provider is misconfigured and
	// answers success + zero results where results demonstrably exist.
	const outcome = await searchWeb(query, { engine, count, signal, exec });
	if (outcome.results.length > 0) {
		return {
			backend: "local",
			engine: outcome.engine,
			results: outcome.results,
			failures: outcome.failures.length > 0 ? outcome.failures : undefined,
			annotation: "api backend returned no results for this query - results from local search",
		};
	}
	if (outcome.cleanEmpty) {
		return {
			backend: "local",
			results: [],
			emptyKind: "both",
			failures: outcome.failures.length > 0 ? outcome.failures : undefined,
		};
	}
	throw new Error(`web_search failed for "${query}": api: no results | local: ${outcome.failures.join(" | ")}`);
}

/**
 * web_extract routing (section 6.1).
 */
async function runUnifiedExtract(
	url: string,
	params: WebExtractToolInput,
	signal: AbortSignal | undefined,
): Promise<{ text: string; details: WebExtractDetails }> {
	const format = params.format ?? "markdown";
	const backend = params.backend ?? "auto";

	// Explicit api: require the api, with distinct errors for "not configured"
	// and "cooling down".
	if (backend === "api") {
		if (!apiConfigured()) {
			throw new Error('api backend unavailable (set PI_FIRECRAWL_URL and ensure PI_FIRECRAWL_DISABLE is not "true")');
		}
		if (breakerTripped()) {
			throw new Error(`api backend cooling down after: ${breaker.lastError}`);
		}
	}

	const useApi = backend === "api" || (backend === "auto" && apiAvailable());

	if (!useApi) {
		// Degraded plain fetch — no api was attempted, so no annotation.
		const local = await runLocalExtract(url, format, signal);
		return {
			text: `[local fetch - no JS rendering]\n${local.text}`,
			details: local.details,
		};
	}

	// Api scrape — rung 1 (normal browser UA).
	let api: { text: string; content: string; details: WebExtractDetails; hasContent: boolean };
	try {
		api = await apiScrape(url, format, params, signal);
	} catch (err) {
		if (signal?.aborted) throw err;
		if (backend === "api") throw err; // explicit api: no fallback, ever
		const reason = apiReason(err);
		breakerNote(classifyApiError(err), reason);
		try {
			const local = await runLocalExtract(url, format, signal);
			return {
				text: `[local fetch - no JS rendering]\n(api backend unavailable: ${reason})\n${local.text}`,
				details: local.details,
			};
		} catch (localErr) {
			throw new Error(`web_extract failed for ${url}: api: ${reason} | local: ${apiReason(localErr)}`);
		}
	}
	breakerReset();

	if (api.hasContent && !looksChallenged(api.details.statusCode, api.content)) {
		return { text: api.text, details: api.details };
	}
	const apiChallenged = looksChallenged(api.details.statusCode, api.content);
	const reason = apiChallenged ? "challenge" : "no content";
	// First rung that produced any content — returned if no rung comes back
	// clean (a challenge page beats an error).
	let fallback: { text: string; details: WebExtractDetails } | undefined;
	if (api.hasContent) fallback = { text: api.text, details: api.details };

	// Rung 2: plain-UA browser retry (detection-gated — only after a
	// challenge or an empty result on the normal attempt).
	if (useApi) {
		try {
			const r2 = await apiScrape(url, format, params, signal, PLAIN_USER_AGENT);
			if (r2.hasContent) {
				if (!looksChallenged(r2.details.statusCode, r2.content)) {
					return {
						text: `[plain-UA api retry after ${reason}]\n${r2.text}`,
						details: r2.details,
					};
				}
				fallback ??= { text: r2.text, details: r2.details };
			}
		} catch (err) {
			if (signal?.aborted) throw err;
			breakerNote(classifyApiError(err), apiReason(err));
		}
	}

	// Rung 3: local fetch with the plain UA (auto mode only — explicit api
	// never falls back to local).
	if (backend !== "api") {
		try {
			const local = await runLocalExtract(url, format, signal, { userAgent: PLAIN_USER_AGENT });
			if (local.hasContent) {
				if (!looksChallenged(local.details.statusCode, local.text)) {
					return {
						text: `[local fetch - no JS rendering - plain UA]\n${local.text}`,
						details: local.details,
					};
				}
				fallback ??= { text: local.text, details: local.details };
			}
		} catch {
			// The plain fetch failed — fall through to the fallback/error.
		}
	}

	// Rung 4: Jina Reader (auto mode only, markdown format, detection-gated).
	// A third-party renderer that clears the CF-hard class the local browser
	// can't (REPORT-antibot.md step 3). Last resort: it sends the URL to a
	// third party, so only reached when every local rung was challenged/empty.
	if (backend !== "api" && format === "markdown") {
		try {
			const jina = await jinaFetch(url, signal);
			if (jina.text.trim().length > 0 && !looksChallenged(jina.statusCode, jina.text)) {
				const title = jina.title ? `Title: ${jina.title}\n\n` : "";
				return {
					text: `[Jina Reader fallback after ${reason}]\n${title}${jina.text}`,
					details: {
						url,
						title: jina.title,
						format,
						backend: "jina",
						statusCode: jina.statusCode,
					},
				};
			}
		} catch {
			// Jina failed (rate limit / network) — fall through to fallback/error.
		}
	}

	// No clean result — return the first rung that produced any content.
	if (fallback) {
		return {
			text: `${fallback.text}\n[${apiChallenged ? "challenge detected" : "no clean content"} - retries did not improve]`,
			details: fallback.details,
		};
	}
	if (backend === "api") {
		throw new Error(`Extraction returned no content for ${url} (api)`);
	}
	throw new Error(`Extraction returned no content for ${url} (api and local)`);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 15, description: "Number of results to return (default 5)" }),
	),
	backend: Type.Optional(
		StringEnum(["auto", "api", "local"] as const, {
			description:
				"'auto' (default): api backend if configured and healthy, else the local search engine chain -- including as a second opinion when the api returns no results. 'api': force the api backend; errors instead of falling back. 'local': force the local chain.",
		}),
	),
	engine: Type.Optional(
		StringEnum(["auto", "brave", "google", "duckduckgo", "bing"] as const, {
			description:
				"Constrains the local chain to one engine (applies whenever the local path runs; ignored otherwise). 'auto' (default) tries the chain in order.",
		}),
	),
	freshness: Type.Optional(
		Type.String({
			description:
				"api backend only: time filter, e.g. 'day', 'week', 'month', 'year', '7d', '30d', or a raw tbs value like 'qdr:w'. Best-effort: most of the api's search engines apply it, but not all (a note is appended to the results). Ignored by the local backend.",
		}),
	),
	tbs: Type.Optional(
		Type.String({
			description:
				"api backend only: raw Google time-based search string (e.g. 'qdr:w'). Takes precedence over freshness. Best-effort: most of the api's search engines apply it, but not all (a note is appended to the results). Ignored by the local backend.",
		}),
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
});

export type WebSearchToolInput = {
	query: string;
	count?: number;
	backend?: "auto" | "api" | "local";
	engine?: "auto" | EngineName;
	freshness?: string;
	tbs?: string;
	lang?: string;
	country?: string;
	filter?: string;
};

const webExtractSchema = Type.Object({
	url: Type.String({ description: "URL to extract content from (public http/https URLs only)" }),
	format: Type.Optional(
		StringEnum(["markdown", "html", "links"] as const, { description: "Output format (default: markdown)" }),
	),
	backend: Type.Optional(
		StringEnum(["auto", "api", "local"] as const, {
			description:
				"'auto' (default): api backend if configured and healthy (renders JavaScript), else a plain-HTTP fetch that is clearly labeled as not rendering JS. 'api': force the api backend; errors instead of falling back. 'local': force the plain fetch.",
		}),
	),
	wait_seconds: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 30,
			description:
				"api backend only: seconds to wait for page load before extracting (default: 0). Ignored by the local backend.",
		}),
	),
	selector: Type.Optional(
		Type.String({
			description: "api backend only: HTML tag name to extract only (e.g. 'article', 'main'). Ignored by the local backend.",
		}),
	),
	include_links: Type.Optional(
		Type.Boolean({ description: "Also extract links from the page (default: false). Works on both backends." }),
	),
	mobile: Type.Optional(
		Type.Boolean({ description: "api backend only: use mobile viewport (default: false). Ignored by the local backend." }),
	),
});

export type WebExtractToolInput = {
	url: string;
	format?: "markdown" | "html" | "links";
	backend?: "auto" | "api" | "local";
	wait_seconds?: number;
	selector?: string;
	include_links?: boolean;
	mobile?: boolean;
};

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return top results as title, URL, and snippet. Backend: 'auto' (default) uses the " +
			"Firecrawl api backend when PI_FIRECRAWL_URL is set and healthy, falling back to the local search engine " +
			"chain (brave, google, duckduckgo, bing) when the api is unavailable, fails, or returns no results; 'api' " +
			"forces the api backend (error instead of falling back); 'local' forces the local chain. The local chain " +
			"is built for restrictive firewalls: engines are tried in order with retries on bot-challenge pages. " +
			"freshness/tbs/lang/country/filter apply only to the api backend and are ignored by the local chain. " +
			"Results are best-effort and may occasionally be incomplete or off; when no result title/snippet/URL " +
			"contains a quoted query phrase or any significant query word, a coverage warning is appended -- verify " +
			"such results against the source.",
		promptSnippet: "Search the web; returns titles, URLs and snippets from top results",
		promptGuidelines: [
			"Use web_search for information that is not in the local workspace: documentation, API references, " +
				"library versions, recent events, or anything the user expects to be verified online.",
			"Use web_extract to read full content from URLs returned by web_search.",
		],
		parameters: webSearchSchema,

		async execute(_toolCallId, params: WebSearchToolInput, signal, onUpdate) {
			const query = params.query.trim();
			if (!query) throw new Error("query must not be empty");

			const result = await runUnifiedSearch(
				query,
				params,
				signal,
				(...a) => pi.exec(...a),
				(backend, stage) => {
					onUpdate?.({
						content: [{ type: "text", text: "" }],
						details: { backend, query, results: [], stage } satisfies WebSearchDetails,
					});
				},
			);

			if (result.results.length > 0) {
				const token: EngineName | "api" = result.backend === "api" ? "api" : (result.engine as EngineName);
				// tbs note only for api results (the local chain ignores tbs by
				// contract). If the result came from the api, resolveTbs already
				// succeeded inside runUnifiedSearch with the same params, so this
				// cannot throw.
				const tbs = result.backend === "api" ? resolveTbs(params.tbs, params.freshness) : undefined;
				const formatted = formatResults(query, token, result.results, tbs);
				const text = result.annotation ? `${result.annotation}\n${formatted}` : formatted;
				return {
					content: [{ type: "text", text }],
					details: {
						backend: result.backend,
						engine: result.engine,
						query,
						results: result.results,
						failures: result.failures,
					} satisfies WebSearchDetails,
				};
			}

			// Empty result — provenance is always explicit.
			const text =
				result.emptyKind === "api"
					? `No results found for "${query}". (api backend)`
					: result.emptyKind === "both"
						? `No results found for "${query}". (api backend: no results; local engines: no results)`
						: `No results found for "${query}".`;
			return {
				content: [{ type: "text", text }],
				details: {
					backend: result.backend,
					engine: result.engine,
					query,
					results: [],
					failures: result.failures,
				} satisfies WebSearchDetails,
			};
		},

		renderCall(args: WebSearchToolInput, theme) {
			const q = args.query.length > 60 ? `${args.query.slice(0, 57)}...` : args.query;
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			text += theme.fg("accent", `"${q}"`);
			if (args.backend && args.backend !== "auto") text += theme.fg("dim", ` [${args.backend}]`);
			if (args.engine && args.engine !== "auto") text += theme.fg("dim", ` [${args.engine}]`);
			if (args.count) text += theme.fg("dim", ` (${args.count})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as WebSearchDetails | undefined;
			if (isPartial) {
				const stage = details?.stage ?? "";
				return new Text(theme.fg("warning", `Searching…${stage ? ` ${stage}` : ""}`), 0, 0);
			}

			const results = details?.results ?? [];
			if (results.length === 0) {
				const firstLine =
					result.content?.[0]?.type === "text"
						? result.content[0].text.split("\n")[0]
						: "No results";
				return new Text(theme.fg("muted", firstLine), 0, 0);
			}

			// The token is the engine for local results and "api" for api results.
			const token = details?.backend === "api" ? "api" : (details?.engine ?? "?");
			let text = theme.fg("success", `✓ ${results.length} results via ${token}`);
			if (details && coverageWarning(details.query, results).length > 0) {
				text += theme.fg("warning", " ⚠ coverage");
			}
			if (!expanded) {
				text += theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`);
			} else {
				results.forEach((r, i) => {
					text += `\n${i + 1}. ${theme.fg("accent", r.title)}`;
					text += `\n   ${theme.fg("dim", r.url)}`;
					if (r.snippet) text += `\n   ${theme.fg("muted", r.snippet.length > 140 ? `${r.snippet.slice(0, 137)}...` : r.snippet)}`;
				});
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_extract",
		label: "Web Extract",
		description:
			"Extract web page content as clean markdown (or raw html, or the page's links). Backend: 'auto' " +
			"(default) uses the Firecrawl api backend when PI_FIRECRAWL_URL is set and healthy (renders JavaScript), " +
			"falling back to a plain-HTTP fetch -- no JS rendering, clearly labeled -- when the api is unavailable or " +
			"fails; 'api' forces the api backend; 'local' forces the plain fetch. wait_seconds, selector, and mobile " +
			"apply only to the api backend. JavaScript-heavy pages may return little content from the local backend.",
		promptSnippet: "Extract web page content as markdown/html/links (api renders JS; local is a plain fetch)",
		promptGuidelines: [
			"Use web_extract to read full page content from a URL.",
			"Use web_extract after web_search to read the full content of search results.",
			"Use wait_seconds for JavaScript-heavy or slow-loading pages (api backend).",
		],
		parameters: webExtractSchema,

		async execute(_toolCallId, params: WebExtractToolInput, signal) {
			const url = params.url.trim();
			if (!url) throw new Error("url must not be empty");
			const result = await runUnifiedExtract(url, params, signal);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},

		renderCall(args: WebExtractToolInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_extract "));
			// Truncate URL for display
			const url = args.url;
			const displayUrl = url.length > 60 ? "..." + url.slice(-57) : url;
			text += theme.fg("muted", displayUrl);
			const extras: string[] = [];
			if (args.backend && args.backend !== "auto") extras.push(args.backend);
			if (args.wait_seconds && args.wait_seconds > 0) {
				extras.push(`wait:${args.wait_seconds}s`);
			}
			if (args.selector) extras.push(`sel:${args.selector}`);
			if (extras.length > 0) {
				text += theme.fg("dim", ` [${extras.join(", ")}]`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			// Errors are thrown (not returned as details.error), so pi's
			// standard error rendering applies; no error branch here.
			const details = result.details as WebExtractDetails | undefined;
			let text =
				details?.backend === "local"
					? theme.fg("success", "✓ checked via local fetch")
					: details?.backend === "jina"
						? theme.fg("success", "✓ via Jina Reader (third-party)")
						: theme.fg("success", "✓ Extracted");
			if (details?.title) {
				text += ` ${theme.fg("dim", `— ${details.title}`)}`;
			}
			if (!expanded && details?.linkCount) {
				text += ` (${details.linkCount} links)`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("websearch", {
		description: "Run a web search and show results in an overlay: /websearch <query>",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const query = (args ?? "").trim();
			if (!query) {
				ctx.ui.notify("Usage: /websearch <query>", "warning");
				return;
			}
			if (!ctx.hasUI) return;

			let result: UnifiedSearchResult;
			try {
				result = await runUnifiedSearch(query, { query, engine: "auto", count: 5 }, undefined, (...a) => pi.exec(...a));
			} catch (e) {
				ctx.ui.notify((e as Error).message, "error");
				return;
			}
			const token = result.backend === "api" ? "api" : (result.engine ?? "?");

			if (ctx.mode === "tui") {
				await ctx.ui.custom((_tui, theme, _kb, done) => {
					const lines: string[] = [];
					if (result.results.length === 0) {
						lines.push(theme.fg("muted", `No results for "${query}"`));
						for (const f of result.failures ?? []) lines.push(theme.fg("dim", `  ${f}`));
					} else {
						lines.push(theme.fg("dim", `"${query}" via ${token}`));
						result.results.forEach((r, i) => {
							lines.push(`${i + 1}. ${theme.fg("accent", r.title)}`);
							lines.push(theme.fg("dim", `   ${r.url}`));
							if (r.snippet) lines.push(theme.fg("muted", `   ${r.snippet}`));
						});
						for (const w of coverageWarning(query, result.results)) {
							lines.push(theme.fg("warning", `  ${w}`));
						}
					}
					return new SearchResultsOverlay(theme, lines, done);
				}, { overlay: true });
			} else {
				const summary =
					result.results.length > 0
						? result.results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join("\n")
						: `No results. ${(result.failures ?? []).join("; ") || "clean empty"}`;
				ctx.ui.notify(summary, "info");
			}
		},
	});
}
