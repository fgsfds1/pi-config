import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Firecrawl instance URL, configurable per-device via PI_FIRECRAWL_URL:
 *   unset          → http://localhost:3002 (local instance)
 *   any URL        → use that instance
 *   "off" or ""    → disable the extension (no tools registered)
 */
const rawFirecrawlUrl = process.env.PI_FIRECRAWL_URL;
const FIRECRAWL_URL = (
  rawFirecrawlUrl === undefined ? "http://localhost:3002" : rawFirecrawlUrl.trim()
).replace(/\/+$/, "");
const FIRECRAWL_ENABLED = FIRECRAWL_URL !== "" && FIRECRAWL_URL !== "off";
const FIRECRAWL_KEY = process.env.PI_FIRECRAWL_API_KEY?.trim() || undefined;

/**
 * Firecrawl extension — web search and page extraction via self-hosted Firecrawl.
 *
 * Tools:
 *   web_search  — search the web (POST /v1/search)
 *   web_extract — extract page content as markdown (POST /v1/scrape)
 */

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

async function firecrawlFetch<T>(
  path: string,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (FIRECRAWL_KEY) headers.Authorization = `Bearer ${FIRECRAWL_KEY}`;
  let response: Response;
  try {
    response = await fetch(`${FIRECRAWL_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(
      `Firecrawl unreachable at ${FIRECRAWL_URL}: ${(err as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Firecrawl ${path} failed: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as T;
}
export default function (pi: ExtensionAPI) {
  if (!FIRECRAWL_ENABLED) return;

  // --- Search tool ---
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using self-hosted Firecrawl. Returns URLs, titles, and descriptions. " +
      "Use for finding current information, documentation, facts, news, or any query requiring live web results.",
    promptSnippet:
      "Search the web via self-hosted Firecrawl — returns URLs, titles, and descriptions",
    promptGuidelines: [
      "Use web_search when the user asks to search the web or look up current information.",
      "Use web_extract to read full content from URLs returned by web_search.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: "Max results to return (default: 5)",
        }),
      ),
      freshness: Type.Optional(
        Type.String({
          description:
            'Time filter: "day", "week", "month", "year", or "7d", "30d", etc.',
        }),
      ),
      lang: Type.Optional(
        Type.String({
          description: "Language code (e.g. 'en', 'zh', 'ja')",
        }),
      ),
      country: Type.Optional(
        Type.String({
          description: "Country code (e.g. 'us', 'cn', 'jp')",
        }),
      ),
      tbs: Type.Optional(
        Type.String({
          description:
            'Raw Google time-based search string (e.g. "qdr:w" for this week). Takes precedence over freshness.',
        }),
      ),
      filter: Type.Optional(
        Type.String({
          description: "Domain filter (e.g. 'github.com')",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const payload: Record<string, unknown> = {
        query: params.query,
        limit: params.limit ?? 5,
      };
      // The API has no "freshness" field — map it to Google's tbs filter.
      // A raw tbs value takes precedence over freshness.
      const tbs =
        params.tbs ??
        (params.freshness ? freshnessToTbs(params.freshness) : undefined);
      if (tbs) payload.tbs = tbs;
      if (params.lang) payload.lang = params.lang;
      if (params.country) payload.country = params.country;
      if (params.filter) payload.filter = params.filter;

      const result = await firecrawlFetch<{
        success: boolean;
        error?: string;
        data?: Array<{ url: string; title: string; description: string }>;
      }>("/v1/search", payload, signal);

      if (!result.success) {
        return {
          content: [
            { type: "text", text: `Search failed: ${result.error ?? "unknown error"}` },
          ],
          details: { error: result.error ?? "search failed", results: [] },
        };
      }

      const items = result.data ?? [];
      if (items.length === 0) {
        return {
          content: [
            { type: "text", text: `Search returned no results for "${params.query}".` },
          ],
          details: { results: [] },
        };
      }
      const lines = [`${items.length} result(s) found for "${params.query}":`];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        lines.push("");
        lines.push(`${i + 1}. ${item.title || "No title"}`);
        lines.push(`   URL: ${item.url}`);
        const desc = item.description || "";
        if (desc) {
          lines.push(`   ${desc.length > 200 ? desc.slice(0, 197) + "..." : desc}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { results: items },
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_search "));
      text += theme.fg("muted", `"${args.query}"`);
      if (args.limit && args.limit !== 5) {
        text += theme.fg("dim", ` (limit: ${args.limit})`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      if (result.details?.error) {
        return new Text(theme.fg("error", result.details.error), 0, 0);
      }
      const count = (result.details as { results?: unknown[] } | undefined)
        ?.results?.length ?? 0;
      let text = theme.fg("success", `✓ ${count} result(s)`);
      if (!expanded && count > 0) {
        text += ` (${theme.fg("dim", "expand for details")})`;
      }
      return new Text(text, 0, 0);
    },
  });

  // --- Extract tool ---
  pi.registerTool({
    name: "web_extract",
    label: "Web Extract",
    description:
      "Extract web page content as clean markdown via self-hosted Firecrawl. " +
      "Use to read full content from URLs, fetch documentation, extract article text, " +
      "or convert any webpage to readable markdown.",
    promptSnippet:
      "Extract web page content as clean markdown via self-hosted Firecrawl",
    promptGuidelines: [
      "Use web_extract to read full page content from a URL.",
      "Use web_extract after web_search to read the full content of search results.",
      "Use wait_seconds for JavaScript-heavy or slow-loading pages.",
      "Use selector to target specific page sections (e.g. 'article', 'main').",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to extract content from" }),
      format: Type.Optional(
        StringEnum(
          ["markdown", "html", "links"] as const,
          { description: "Output format (default: markdown)" },
        ),
      ),
      wait_seconds: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 30,
          description: "Seconds to wait for page load before extracting (default: 0)",
        }),
      ),
      selector: Type.Optional(
        Type.String({
          description:
            "HTML tag name to extract only (e.g. 'article', 'main')",
        }),
      ),
      include_links: Type.Optional(
        Type.Boolean({
          description: "Also extract links from the page (default: false)",
        }),
      ),
      mobile: Type.Optional(
        Type.Boolean({
          description: "Use mobile viewport (default: false)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const formats: string[] = [params.format ?? "markdown"];
      if (params.include_links) formats.push("links");

      const payload: Record<string, unknown> = {
        url: params.url,
        formats,
      };
      if (params.wait_seconds && params.wait_seconds > 0) {
        payload.waitFor = params.wait_seconds * 1000;
      }
      if (params.selector) {
        // The API filters by HTML tag name (includeTags), not CSS selectors
        payload.includeTags = [params.selector];
      }
      if (params.mobile) payload.mobile = true;

      const result = await firecrawlFetch<{
        success: boolean;
        error?: string;
        data?: {
          markdown?: string;
          html?: string;
          links?: string[];
          metadata?: Record<string, unknown>;
        };
      }>("/v1/scrape", payload, signal);

      if (!result.success || !result.data) {
        return {
          content: [
            {
              type: "text",
              text: `Extraction failed for ${params.url}: ${result.error ?? "unknown error"}`,
            },
          ],
          details: { url: params.url, error: true },
        };
      }

      const data = result.data;
      const metadata = data.metadata ?? {};
      const statusCode = metadata.statusCode as number | undefined;
      const links = data.links;
      const content = data.markdown ?? data.html ?? "";

      if (!content && (!links || links.length === 0)) {
        return {
          content: [
            {
              type: "text",
              text:
                `Extraction returned no content for ${params.url}` +
                (statusCode !== undefined ? ` (HTTP ${statusCode})` : ""),
            },
          ],
          details: { url: params.url, error: true, statusCode },
        };
      }

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
        content: [{ type: "text", text: parts.join("\n") }],
        details: {
          url: params.url,
          title,
          format: params.format ?? "markdown",
          linkCount: links?.length ?? 0,
          statusCode: metadata.statusCode,
        },
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_extract "));
      // Truncate URL for display
      const url = args.url;
      const displayUrl = url.length > 60 ? "..." + url.slice(-57) : url;
      text += theme.fg("muted", displayUrl);
      const extras: string[] = [];
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
      if (result.details?.error) {
        return new Text(theme.fg("error", "Extraction failed"), 0, 0);
      }
      const details = result.details as {
        url?: string;
        title?: string;
        statusCode?: number;
        linkCount?: number;
      } | undefined;
      let text = theme.fg("success", "✓ Extracted");
      if (details?.title) {
        text += ` ${theme.fg("dim", `— ${details.title}`)}`;
      }
      if (!expanded && details?.linkCount) {
        text += ` (${details.linkCount} links)`;
      }
      return new Text(text, 0, 0);
    },
  });
}
