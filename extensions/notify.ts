/**
 * Notify extension — desktop notifications + sound when the agent needs your input.
 *
 * Hooks into pi's lifecycle events to send OS-level notifications:
 *   - turn_end       → notification when the agent finishes a turn
 *   - agent_settled  → notification when the agent is fully done
 *
 * Platform support:
 *   Linux  — notify-send (libnotify) + canberra-gtk-play / paplay
 *   macOS  — osascript (Notification Center) + afplay
 *   Windows — PowerShell [System.Windows.Forms]
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execAsync = promisify(execFile);

type Platform = "macos" | "linux" | "windows" | "unknown";

function detectPlatform(): Platform {
  if (platform() === "darwin") return "macos";
  if (platform() === "win32") return "windows";
  return "linux";
}

// --- Sound ---
async function playSound(): Promise<void> {
  const platform = detectPlatform();

  if (platform === "macos") {
    // macOS system sounds
    const sounds = [
      "/System/Library/Sounds/Glass.aiff",
      "/System/Library/Sounds/Bottle.aiff",
      "/System/Library/Sounds/Submarine.aiff",
    ];
    for (const sound of sounds) {
      try {
        await execAsync("afplay", [sound], {
          stdio: ["ignore", "ignore", "ignore"],
          timeout: 3000,
        });
        return;
      } catch {
        continue;
      }
    }
  }

  if (platform === "linux") {
    const players = [
      ["paplay", ["/usr/share/sounds/freedesktop/stereo/message.oga"]],
      ["paplay", ["/usr/share/sounds/freedesktop/stereo/bell.oga"]],
      ["paplay", ["/usr/share/sounds/freedesktop/stereo/complete.oga"]],
      ["canberra-gtk-play", ["-i", "message-new-instant"]],
    ];
    for (const [cmd, args] of players) {
      try {
        // Await exit so a missing binary or sound file falls through to the
        // next player. (spawn + unref without an 'error' listener would throw
        // an uncaught ENOENT in the parent process.)
        await execAsync(cmd, args, { stdio: "ignore", timeout: 5000 });
        return;
      } catch {
        continue;
      }
    }
  }

  if (platform === "windows") {
    try {
      await execAsync(
        "powershell.exe",
        [
          "-Command",
          "[System.Media.SystemSounds]::Asterisk.Play()",
        ],
        { stdio: ["ignore", "ignore", "ignore"], timeout: 3000 },
      );
    } catch {
      // ignore
    }
  }
}

// --- Desktop notification ---
async function sendNotification(
  title: string,
  body: string,
): Promise<boolean> {
  const platform = detectPlatform();

  if (platform === "macos") {
    try {
      const escapedTitle = title.replace(/"/g, '\\"');
      const escapedBody = body.replace(/"/g, '\\"');
      await execAsync(
        "osascript",
        [
          "-e",
          `display notification "${escapedBody}" with title "${escapedTitle}"`,
        ],
        { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  if (platform === "linux") {
    try {
      // execFile passes argv directly (no shell) — no escaping needed
      await execAsync("notify-send", [title, body], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  if (platform === "windows") {
    try {
      const escapedTitle = title.replace(/'/g, "''");
      const escapedBody = body.replace(/'/g, "''");
      await execAsync(
        "powershell.exe",
        [
          "-Command",
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show("${escapedBody}", "${escapedTitle}")`,
        ],
        { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

// --- Extension config ---
interface NotifyConfig {
  enabled: boolean;
  sound: boolean;
  desktop: boolean;
  tui: boolean;
  onTurnEnd: boolean;
  onAgentSettled: boolean;
  quietAfterMinutes: number; // don't notify again within this window
}

const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
  sound: true,
  desktop: true,
  tui: true,
  onTurnEnd: false, // too noisy, default off
  onAgentSettled: true, // best default
  quietAfterMinutes: 2,
};

let lastNotifyTime = 0;

function shouldNotify(config: NotifyConfig): boolean {
  if (!config.enabled) return false;
  const now = Date.now();
  const quietMs = config.quietAfterMinutes * 60 * 1000;
  if (now - lastNotifyTime < quietMs) return false;
  return true;
}

function markNotified() {
  lastNotifyTime = Date.now();
}

async function notify(
  ctx: { ui?: { notify?: (msg: string, type: string) => void } },
  config: NotifyConfig,
  title: string,
  body: string,
): Promise<boolean> {
  if (!shouldNotify(config)) return false;

  const tasks: Promise<boolean>[] = [];

  if (config.sound) {
    tasks.push(playSound().then(() => true).catch(() => false));
  }

  if (config.desktop) {
    tasks.push(sendNotification(title, body).catch(() => false));
  }

  let tuiDelivered = false;
  if (config.tui && ctx.ui?.notify) {
    ctx.ui.notify(`${title}: ${body}`, "info");
    tuiDelivered = true;
  }

  const results = await Promise.all(tasks);
  const delivered = tuiDelivered || results.some(Boolean);
  // Only consume the quiet window when something actually went out
  if (delivered) markNotified();
  return delivered;
}

// --- Extension ---
export default function (pi: ExtensionAPI) {
  // Read config from environment or use defaults
  const config: NotifyConfig = {
    ...DEFAULT_CONFIG,
    enabled: process.env.PI_NOTIFY_ENABLED !== "false",
    sound: process.env.PI_NOTIFY_SOUND !== "false",
    desktop: process.env.PI_NOTIFY_DESKTOP !== "false",
    tui: process.env.PI_NOTIFY_TUI !== "false",
    onTurnEnd: process.env.PI_NOTIFY_TURN_END === "true",
    onAgentSettled: process.env.PI_NOTIFY_AGENT_SETTLED !== "false",
    quietAfterMinutes: parseInt(
      process.env.PI_NOTIFY_QUIET_MINUTES ?? "2",
      10,
    ) || 2,
  };

  // --- Agent settled: agent is fully done, waiting for user ---
  if (config.onAgentSettled) {
    pi.on("agent_settled", async (_event, ctx) => {
      await notify(
        ctx,
        config,
        "Pi Ready",
        "Agent finished — your input is needed",
      );
    });
  }

  // --- Turn end: agent finished a turn (may still be iterating) ---
  if (config.onTurnEnd) {
    pi.on("turn_end", async (_event, ctx) => {
      await notify(ctx, config, "Pi Turn Done", "Agent turn completed");
    });
  }

  // --- Register a manual tool for on-demand notifications ---
  pi.registerTool({
    name: "notify",
    label: "Notify",
    description:
      "Send a desktop notification with optional sound. " +
      "Use to alert the user when long tasks complete or when their attention is needed.",
    promptSnippet: "Send desktop notification with optional sound",
    promptGuidelines: [
      "Use notify to alert the user when long-running tasks complete.",
      "Use notify when the user explicitly asks for a notification.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description: "Notification title",
      }),
      message: Type.String({
        description: "Notification body text",
      }),
      sound: Type.Optional(
        Type.Boolean({
          description: "Play a sound (default: true)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adHocConfig: NotifyConfig = {
        ...config,
        sound: params.sound !== false,
        enabled: true, // always allow manual notify
        quietAfterMinutes: 0, // manual notifications bypass the quiet window
      };

      const delivered = await notify(ctx, adHocConfig, params.title, params.message);

      return {
        content: [
          {
            type: "text",
            text: delivered
              ? `Notification sent: ${params.title}`
              : `Notification not delivered (desktop and sound backends unavailable): ${params.title}`,
          },
        ],
        details: { title: params.title, message: params.message, delivered },
      };
    },
  });
}
