/**
 * Notify extension -- desktop notifications + sound when the agent needs your input.
 *
 * Hooks into pi's lifecycle events to send OS-level notifications:
 *   - turn_end       -> notification when the agent finishes a turn
 *   - agent_settled  -> notification when the agent is fully done
 *
 * Delivery channels (OS-native first, terminal fallback when unavailable):
 *   Linux   -- notify-send (libnotify, only when DESKTOP_SESSION is set) + paplay / canberra-gtk-play
 *   macOS   -- osascript (Notification Center) + afplay
 *   Windows -- Windows Terminal toast (WT_SESSION) or PowerShell MessageBox + SystemSounds
 *   Terminal -- OSC 99 (kitty) / OSC 777 (kitty format, e.g. Ghostty) escape sequences,
 *              used when the OS channel is unavailable or fails (headless/SSH setups)
 *
 * Env config:
 *   PI_NOTIFY_ENABLED=false, PI_NOTIFY_SOUND=false, PI_NOTIFY_DESKTOP=false,
 *   PI_NOTIFY_TUI=false, PI_NOTIFY_TURN_END=true, PI_NOTIFY_AGENT_SETTLED=false,
 *   PI_NOTIFY_QUIET_MINUTES=2, PI_NOTIFY_TERMINAL=auto|off, PI_NOTIFY_DEDUP=quiet|run
 *
 * Dedup modes (PI_NOTIFY_DEDUP):
 *   quiet (default) -- at most one notification per quiet window
 *   run             -- at most one notification per agent run (reset on agent_start)
 */

import { execFile } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { platform } from "node:os";
import { promisify } from "util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// --- Terminal escape sequences (headless/SSH and terminal-only setups) ---

function writeRawToTerminal(data: Buffer): boolean {
  try {
    const ttyFd = openSync("/dev/tty", "w");
    try {
      writeSync(ttyFd, data);
    } finally {
      closeSync(ttyFd);
    }
    return true;
  } catch {
    try {
      writeSync(2, data);
      return true;
    } catch {
      return false;
    }
  }
}

function notifyOSC777(title: string, body: string): boolean {
  // kitty-format notification -- supported by kitty and Ghostty
  return writeRawToTerminal(Buffer.from(`\x1b]777;notify;${title};${body}\x07`));
}

function notifyOSC99(title: string, body: string): boolean {
  // xterm-extended notification (title then body payload)
  if (!writeRawToTerminal(Buffer.from(`\x1b]99;i=1;d=0;${title}\x1b\\`))) return false;
  return writeRawToTerminal(Buffer.from(`\x1b]99;i=1:p=body;${body}\x1b\\`));
}

/**
 * Terminal fallback. Picks OSC 99 in kitty (KITTY_WINDOW_ID), OSC 777
 * otherwise (works in Ghostty and kitty).
 */
function notifyTerminal(title: string, body: string): boolean {
  if (process.env.KITTY_WINDOW_ID) return notifyOSC99(title, body);
  return notifyOSC777(title, body);
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
    // No desktop session (headless/SSH) -- let the caller fall back to the
    // terminal instead of handing the notification to a daemon nobody sees.
    if (!process.env.DESKTOP_SESSION) return false;
    try {
      // execFile passes argv directly (no shell) -- no escaping needed.
      // -a groups it under the "Pi" app, the sound hint lets the DE play a
      // notification sound even without paplay/canberra available.
      await execAsync("notify-send", [
        "-u", "normal",
        "-h", "string:sound-name:message",
        "-a", "Pi",
        title,
        body,
      ], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  if (platform === "windows") {
    // Windows Terminal: native toast (better than a blocking MessageBox)
    if (process.env.WT_SESSION) {
      try {
        const escapedTitle = title.replace(/'/g, "''");
        const escapedBody = body.replace(/'/g, "''");
        const toastScript = [
          `$t=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]`,
          `$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText01)`,
          `$x.GetElementsByTagName('text')[0].AppendChild($x.CreateTextNode('${escapedBody}'))>$null`,
          `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${escapedTitle}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
        ].join("; ");
        await execAsync(
          "powershell.exe",
          ["-NoProfile", "-Command", toastScript],
          { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 },
        );
        return true;
      } catch {
        return false;
      }
    }
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
  quietAfterMinutes: number; // don't notify again within this window (dedup=quiet)
  terminal: "auto" | "off"; // terminal escape fallback when OS-native didn't deliver
  dedup: "quiet" | "run"; // quiet window, or one notification per agent run
}

const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
  sound: true,
  desktop: true,
  tui: true,
  onTurnEnd: false, // too noisy, default off
  onAgentSettled: true, // best default
  quietAfterMinutes: 2,
  terminal: "auto",
  dedup: "quiet",
};

let lastNotifyTime = 0;
let notifiedThisRun = false;

function shouldNotify(config: NotifyConfig): boolean {
  if (!config.enabled) return false;
  if (config.dedup === "run") return !notifiedThisRun;
  const now = Date.now();
  const quietMs = config.quietAfterMinutes * 60 * 1000;
  if (now - lastNotifyTime < quietMs) return false;
  return true;
}

function markNotified() {
  lastNotifyTime = Date.now();
  notifiedThisRun = true;
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

  // OS-native desktop notification first
  let osDelivered = false;
  if (config.desktop) {
    osDelivered = await sendNotification(title, body).catch(() => false);
  }

  // Terminal escape fallback (headless/SSH, missing daemon, ...)
  let terminalDelivered = false;
  if (config.terminal === "auto" && !osDelivered) {
    terminalDelivered = notifyTerminal(title, body);
  }

  let tuiDelivered = false;
  if (config.tui && ctx.ui?.notify) {
    ctx.ui.notify(`${title}: ${body}`, "info");
    tuiDelivered = true;
  }

  const results = await Promise.all(tasks);
  const delivered = tuiDelivered || osDelivered || terminalDelivered || results.some(Boolean);
  // Only consume the dedup slot when something actually went out
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
    terminal: process.env.PI_NOTIFY_TERMINAL === "off" ? "off" : "auto",
    dedup: process.env.PI_NOTIFY_DEDUP === "run" ? "run" : "quiet",
  };

  // Reset the once-per-run dedup flag whenever a new agent run begins
  pi.on("agent_start", () => {
    notifiedThisRun = false;
  });

  // --- Agent settled: agent is fully done, waiting for user ---
  if (config.onAgentSettled) {
    pi.on("agent_settled", async (_event, ctx) => {
      await notify(
        ctx,
        config,
        "Pi Ready",
        "Agent finished -- your input is needed",
      );
    });
  }

  // --- Turn end: agent finished a turn (may still be iterating) ---
  if (config.onTurnEnd) {
    pi.on("turn_end", async (_event, ctx) => {
      await notify(ctx, config, "Pi Turn Done", "Agent turn completed");
    });
  }
}
