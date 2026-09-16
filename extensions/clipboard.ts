/**
 * Clipboard extension — read and write system clipboard.
 *
 * Auto-detects platform:
 *   macOS   — pbpaste / pbcopy
 *   Linux    — wl-paste / wl-copy (Wayland) or xclip (X11)
 *   Windows  — Get-Clipboard / clip (PowerShell)
 *
 * Tools:
 *   clipboard_read  — read current clipboard text
 *   clipboard_write — write text to clipboard
 */

import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const execAsync = promisify(execFile);

// Clipboard contents can be large (whole files); the read tool truncates
// its output anyway, so read generously and let truncation handle display.
const READ_MAX_BUFFER = 10 * 1024 * 1024;

type Platform = "macos" | "linux-wayland" | "linux-x11" | "windows" | "unknown";

function detectPlatform(): Platform {
  if (platform() === "darwin") return "macos";
  if (platform() === "win32") return "windows";
  // Linux — check for Wayland first, then X11
  const { env } = process;
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") {
    return "linux-wayland";
  }
  if (env.DISPLAY) return "linux-x11";
  // Fallback: try wl-paste, then xclip
  return "linux-wayland"; // try wayland first
}

function getClipboardCommands(platform: Platform): {
  read: [string, string[]];
  write: [string, string[]];
} {
  switch (platform) {
    case "macos":
      return {
        read: ["pbpaste", []],
        write: ["pbcopy", []],
      };
    case "linux-wayland":
      return {
        read: ["wl-paste", ["--no-newline"]],
        write: ["wl-copy", ["--trim-newline"]],
      };
    case "linux-x11":
      return {
        read: ["xclip", ["-selection", "clipboard", "-o"]],
        write: ["xclip", ["-selection", "clipboard", "-i"]],
      };
    case "windows":
      return {
        read: ["powershell.exe", ["-Command", "Get-Clipboard -Raw"]],
        write: ["clip", []],
      };
    default:
      return {
        read: ["echo", ["(unknown platform)"]],
        write: ["cat", []],
      };
  }
}

async function tryCommand(
  cmd: [string, string[]],
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    const { stdout, stderr } = await execAsync(cmd[0], cmd[1], {
      maxBuffer: READ_MAX_BUFFER,
      timeout: 5000,
    });
    return { stdout: stdout || "", stderr, success: true };
  } catch (err: unknown) {
    const error = err as { code?: string; stderr?: string };
    return {
      stdout: "",
      stderr: error.stderr?.toString() || error.code || "command failed",
      success: false,
    };
  }
}

async function readClipboard(): Promise<{
  text: string;
  platform: Platform;
  error?: string;
}> {
  const platform = detectPlatform();
  const commands = getClipboardCommands(platform);

  // Cross-tool fallback: a Wayland session may still have xclip, and vice versa.
  const fallbacks: Array<[string, string[]]> = [];
  if (platform === "linux-wayland") {
    fallbacks.push(["xclip", ["-selection", "clipboard", "-o"]]);
  } else if (platform === "linux-x11") {
    fallbacks.push(["wl-paste", ["--no-newline"]]);
  }

  let lastError = "";
  for (const attempt of [commands.read, ...fallbacks]) {
    const result = await tryCommand(attempt);
    if (result.success) {
      // Success with empty output means the clipboard is empty — not a failure
      return { text: result.stdout, platform };
    }
    lastError = result.stderr;
  }

  return {
    text: "",
    platform,
    error: lastError || "No clipboard tool found. Install wl-clipboard or xclip.",
  };
}

/**
 * Spawn a clipboard writer that reads its input from stdin.
 *
 * Text goes through stdin (not argv) so arbitrarily large content works —
 * a single argv element over ~128KB fails with E2BIG.
 *
 * stdout/stderr are ignored (not piped): clipboard tools fork a daemon to
 * serve the selection, and a piped stdout inherited by that daemon would
 * keep the child's 'close' event pending forever.
 *
 * A safety timer resolves with success if the parent hasn't exited within
 * `timeoutMs` — by then the selection is set and the daemon holds it.
 */
function spawnWrite(
  cmd: string,
  args: string[],
  text: string,
  platform: Platform,
  options?: { shell?: boolean; timeoutMs?: number },
): Promise<{ success: boolean; platform: Platform; error?: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (success: boolean, error?: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ success, platform, error });
    };
    const child = spawn(cmd, args, {
      stdio: ["pipe", "ignore", "ignore"],
      shell: options?.shell,
    });
    const timer = setTimeout(
      () => {
        try {
          child.kill("SIGKILL");
        } catch {}
        done(true); // assume OK — the selection was set before the hang
      },
      options?.timeoutMs ?? 2000,
    );
    child.on("error", (err: Error) => done(false, err.message || "spawn failed"));
    child.on("close", (code: number | null) =>
      done(
        code === 0 || code === null,
        code ? `${cmd} exited with code ${code}` : undefined,
      ),
    );
    child.stdin.on("error", () => {}); // EPIPE if the writer dies early
    child.stdin.write(text);
    child.stdin.end();
  });
}

async function writeClipboard(text: string): Promise<{
  success: boolean;
  platform: Platform;
  error?: string;
}> {
  const platform = detectPlatform();

  if (platform === "macos") {
    return spawnWrite("pbcopy", [], text, platform);
  }

  if (platform === "windows") {
    return spawnWrite("clip", [], text, platform, { shell: true });
  }

  const commands = getClipboardCommands(platform);
  const [cmd, baseArgs] = commands.write;

  if (cmd === "wl-copy") {
    const result = await spawnWrite(cmd, baseArgs, text, platform);
    if (result.success) return result;
    // wl-copy missing or failed — fall back to xclip if available
    const fb = await spawnWrite(
      "xclip",
      ["-selection", "clipboard", "-i"],
      text,
      platform,
    );
    if (fb.success) return fb;
    return { success: false, platform, error: result.error };
  }

  if (cmd === "xclip") {
    return spawnWrite(cmd, baseArgs, text, platform);
  }

  return { success: false, platform, error: "Unknown clipboard command" };
}

// --- Extension ---
export default function (pi: ExtensionAPI) {
  // --- Read tool ---
  pi.registerTool({
    name: "clipboard_read",
    label: "Clipboard Read",
    description:
      "Read the current system clipboard content. " +
      "Use to paste code snippets, URLs, or text into the session.",
    promptSnippet: "Read current clipboard content",
    promptGuidelines: [
      "Use clipboard_read when the user wants to paste something from the clipboard.",
      "Use clipboard_write to copy text to the clipboard.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const result = await readClipboard();

      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: `Clipboard read failed: ${result.error}`,
            },
          ],
          details: { error: true, platform: result.platform },
        };
      }

      const text = result.text;
      if (!text) {
        return {
          content: [
            { type: "text", text: "Clipboard is empty." },
          ],
          details: { empty: true },
        };
      }

      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let output = truncation.content;
      if (truncation.truncated) {
        output += `\n\n[Truncated: ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          lines: truncation.totalLines,
          bytes: truncation.totalBytes,
          truncated: truncation.truncated,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("clipboard_read")),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        error?: boolean;
        empty?: boolean;
        lines?: number;
        bytes?: number;
      } | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", "✗ Clipboard read failed"), 0, 0);
      }
      if (details?.empty) {
        return new Text(theme.fg("muted", "Clipboard empty"), 0, 0);
      }
      let text = theme.fg("success", "✓ Clipboard");
      if (details?.lines) {
        text += theme.fg("dim", ` (${details.lines} line${details.lines > 1 ? "s" : ""})`);
      }
      return new Text(text, 0, 0);
    },
  });

  // --- Write tool ---
  pi.registerTool({
    name: "clipboard_write",
    label: "Clipboard Write",
    description:
      "Write text to the system clipboard. " +
      "Use to copy code, URLs, or results for pasting elsewhere.",
    promptSnippet: "Write text to clipboard",
    promptGuidelines: [
      "Use clipboard_write when the user wants to copy something to the clipboard.",
      "Use clipboard_read to read from the clipboard.",
    ],
    parameters: Type.Object({
      text: Type.String({
        description: "Text to write to the clipboard",
      }),
    }),
    async execute(_toolCallId, params) {
      const result = await writeClipboard(params.text);

      if (!result.success) {
        return {
          content: [
            {
              type: "text",
              text: `Clipboard write failed: ${result.error}`,
            },
          ],
          details: { error: true, platform: result.platform },
        };
      }

      const lines = params.text.split("\n").length;
      const bytes = Buffer.byteLength(params.text, "utf8");

      return {
        content: [
          {
            type: "text",
            text: `Copied to clipboard: ${lines} line${lines > 1 ? "s" : ""}, ${bytes} bytes`,
          },
        ],
        details: { lines, bytes },
      };
    },
    renderCall(args, theme) {
      const preview =
        args.text.length > 60
          ? `${args.text.slice(0, 60).replace(/\n/g, " ")}...`
          : args.text.replace(/\n/g, " ");
      return new Text(
        theme.fg("toolTitle", theme.bold("clipboard_write ")) +
          theme.fg("muted", preview),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const details = result.details as {
        error?: boolean;
        lines?: number;
      } | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", "✗ Write failed"), 0, 0);
      }
      return new Text(
        theme.fg("success", `✓ Copied ${details?.lines ?? 0} line${(details?.lines ?? 0) > 1 ? "s" : ""}`),
        0,
        0,
      );
    },
  });
}
