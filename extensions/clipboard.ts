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

import { execFile } from "node:child_process";
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

type Platform = "macos" | "linux-wayland" | "linux-x11" | "windows" | "unknown";

function detectPlatform(): Platform {
  const { platform } = require("node:os");
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
        write: ["wl-copy", ["--trim-newline"]], // text passed as arg, not stdin
      };
    case "linux-x11":
      return {
        read: ["xclip", ["-selection", "clipboard", "-o"]],
        write: ["xclip", ["-selection", "clipboard", "-i"]],
      };
    case "windows":
      return {
        read: ["powershell.exe", ["-Command", "Get-Clipboard"]],
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
  input?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    const { stdout, stderr } = await execAsync(cmd[0], cmd[1], {
      maxBuffer: DEFAULT_MAX_BYTES * 4,
      timeout: 5000,
    });
    // For write commands that read from stdin
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

  // Try primary command
  let result = await tryCommand(commands.read);
  if (result.success && result.stdout) {
    return { text: result.stdout, platform };
  }

  // Fallback: try alternative clipboard tools
  const fallbacks: Array<[string, string[]]> = [];
  if (platform === "linux-wayland") {
    fallbacks.push(["xclip", ["-selection", "clipboard", "-o"]]);
  } else if (platform === "linux-x11") {
    fallbacks.push(["wl-paste", ["--no-newline"]]);
  }

  for (const fallback of fallbacks) {
    result = await tryCommand(fallback);
    if (result.success && result.stdout) {
      return { text: result.stdout, platform };
    }
  }

  return {
    text: "",
    platform,
    error:
      result.stderr ||
      "No clipboard tool found. Install wl-clipboard, xclip, or use macOS.",
  };
}

async function writeClipboard(text: string): Promise<{
  success: boolean;
  platform: Platform;
  error?: string;
}> {
  const platform = detectPlatform();

  // macOS: pbcopy reads from stdin (works fine)
  if (platform === "macos") {
    const { spawn } = require("node:child_process");
    return new Promise((resolve) => {
      const child = spawn("pbcopy", []);
      let error = "";
      child.stderr.on("data", (data: Buffer) => { error += data.toString(); });
      child.on("error", (err: Error) => {
        resolve({ success: false, platform, error: err.message || "spawn failed" });
      });
      child.on("close", (code: number | null) => {
        resolve({
          success: code === 0,
          platform,
          error: code !== 0 ? error || "pbcopy failed" : undefined,
        });
      });
      child.stdin.write(text);
      child.stdin.end();
    });
  }

  // Windows: clip reads from stdin
  if (platform === "windows") {
    const { spawn } = require("node:child_process");
    return new Promise((resolve) => {
      const child = spawn("clip", [], { shell: true });
      let error = "";
      child.stderr.on("data", (data: Buffer) => { error += data.toString(); });
      child.on("error", (err: Error) => {
        resolve({ success: false, platform, error: err.message || "spawn failed" });
      });
      child.on("close", (code: number | null) => {
        resolve({
          success: code === 0,
          platform,
          error: code !== 0 ? error || "clip failed" : undefined,
        });
      });
      child.stdin.write(text);
      child.stdin.end();
    });
  }

  // Linux: pass text as command argument to avoid stdin/tty conflicts
  // wl-copy and xclip both support this
  const commands = getClipboardCommands(platform);
  const [cmd, baseArgs] = commands.write;
  const { spawn } = require("node:child_process");

  // For wl-copy: pass text as positional argument.
  // CRITICAL: wl-copy forks a daemon that inherits stdout/stderr.
  // Using execFile (which captures stdout/stderr via pipes) causes the
  // parent to wait for EOF forever → unkillable hang.
  // Solution: use spawn with stdio ["ignore", "ignore", "ignore"] + timeout.
  if (cmd === "wl-copy") {
    return new Promise((resolve) => {
      const child = spawn(cmd, [...baseArgs, text], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 3000,
      });
      let resolved = false;
      const timers = [
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try { child.kill("SIGKILL"); } catch {}
            resolve({ success: true, platform }); // assume OK if it spawned
          }
        }, 2000),
      ];
      child.on("close", (code: number | null) => {
        if (resolved) return;
        resolved = true;
        timers.forEach(clearTimeout);
        resolve({
          success: code === 0 || code === null,
          platform,
          error: code && code !== 0 ? "wl-copy exited with code " + code : undefined,
        });
      });
      child.on("error", (err: Error) => {
        if (resolved) return;
        resolved = true;
        timers.forEach(clearTimeout);
        // Fallback to xclip
        try {
          const fb = spawn("xclip", ["-selection", "clipboard", "-i"], {
            stdio: ["pipe", "ignore", "ignore"],
          });
          let fbResolved = false;
          fb.on("error", () => {
            if (!fbResolved) {
              fbResolved = true;
              resolve({ success: false, platform, error: "xclip fallback failed" });
            }
          });
          fb.on("close", (fbCode: number | null) => {
            if (!fbResolved) {
              fbResolved = true;
              resolve({ success: fbCode === 0, platform, error: fbCode !== 0 ? "xclip failed" : undefined });
            }
          });
          fb.stdin.write(text);
          fb.stdin.end();
        } catch {
          resolve({ success: false, platform, error: err.message || "spawn failed" });
        }
      });
    });
  }

  // xclip: reads from stdin, no forking issues
  if (cmd === "xclip") {
    return new Promise((resolve) => {
      const child = spawn(cmd, baseArgs, {
        stdio: ["pipe", "ignore", "ignore"],
      });
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { child.kill("SIGKILL"); } catch {}
          resolve({ success: true, platform }); // assume OK
        }
      }, 2000);
      child.on("error", (err: Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ success: false, platform, error: err.message || "spawn failed" });
      });
      child.on("close", (code: number | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({
          success: code === 0,
          platform,
          error: code !== 0 ? "xclip failed" : undefined,
        });
      });
      child.stdin.write(text);
      child.stdin.end();
    });
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
