import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "child_process";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";

/**
 * In-memory store for spawned (async) processes.
 * Maps session ID → { id, command, exitCode, stdout, stderr, done }
 */
interface SpawnRecord {
  id: string;
  command: string[];
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  done: boolean;
  pid: number;
  createdAt: Date;
}

const spawnedProcesses = new Map<string, Map<string, SpawnRecord>>();

function getSessionMap(sessionId: string) {
  if (!spawnedProcesses.has(sessionId)) {
    spawnedProcesses.set(sessionId, new Map());
  }
  return spawnedProcesses.get(sessionId)!;
}

/**
 * Subprocess extension — spawn commands in the background and manage them.
 *
 * Tools:
 *   subprocess_spawn — start a command in the background, returns a process ID
 *   subprocess_status — check status of a spawned process
 *   subprocess_kill   — kill a spawned process
 */
export default function (pi: ExtensionAPI) {
  // --- Async spawn tool ---
  pi.registerTool({
    name: "subprocess_spawn",
    label: "Subprocess Spawn",
    description:
      "Start a command in the background without waiting for it to complete. " +
      "Returns a process ID for later status checks or killing. " +
      "Use for long-running processes like servers, watchers, or daemons.",
    promptSnippet:
      "Spawn a subprocess asynchronously — starts in background, returns process ID",
    promptGuidelines: [
      "Use subprocess_spawn for long-running processes (servers, watchers, daemons).",
      "Use subprocess_status to check on spawned processes.",
      "Use subprocess_kill to stop spawned processes.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description:
          "Command to run (e.g. 'npm run dev', 'python server.py', 'tail -f log.txt')",
      }),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory (default: current working directory)",
        }),
      ),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Additional environment variables as key-value pairs",
        }),
      ),
      shell: Type.Optional(
        Type.Boolean({
          description:
            "Use shell execution for pipes/redirections (default: true)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const processId = randomUUID().slice(0, 8);
      const cwd = params.cwd ?? process.cwd();
      const env = params.env
        ? { ...process.env, ...params.env }
        : process.env;
      const useShell = params.shell !== false; // default true

      const options: Record<string, unknown> = {
        cwd,
        env,
        stdio: "pipe",
        // Own process group on Unix so subprocess_kill can kill the whole tree
        detached: process.platform !== "win32",
      };
      if (useShell) {
        options.shell = true;
      }

      const child = spawn(params.command, [], options);
      const record: SpawnRecord = {
        id: processId,
        command: [params.command],
        cwd,
        exitCode: null,
        stdout: "",
        stderr: "",
        done: false,
        pid: child.pid ?? 0,
        createdAt: new Date(),
      };

      child.stdout?.on("data", (data: Buffer) => {
        record.stdout += data.toString();
        if (record.stdout.length > DEFAULT_MAX_BYTES * 4) {
          record.stdout = record.stdout.slice(-DEFAULT_MAX_BYTES * 2);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        record.stderr += data.toString();
        if (record.stderr.length > DEFAULT_MAX_BYTES * 4) {
          record.stderr = record.stderr.slice(-DEFAULT_MAX_BYTES * 2);
        }
      });

      child.on("exit", (code) => {
        // code is null when killed by a signal — keep any code we recorded (e.g. -1 from subprocess_kill)
        record.exitCode = code ?? record.exitCode ?? -1;
        record.done = true;
      });

      child.on("error", (err) => {
        record.stderr = err.message;
        record.done = true;
      });

      getSessionMap(sessionId).set(processId, record);

      // Cleanup old entries (keep last 50 per session)
      const map = getSessionMap(sessionId);
      if (map.size > 50) {
        const keys = Array.from(map.keys());
        for (const key of keys.slice(0, keys.length - 50)) {
          map.delete(key);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Process spawned: ${processId} (PID ${child.pid})\nCommand: ${params.command}\nWorking directory: ${cwd}`,
          },
        ],
        details: {
          processId,
          pid: child.pid,
          command: params.command,
          cwd,
        },
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("subprocess_spawn "));
      text += theme.fg("muted", args.command);
      if (args.cwd) {
        text += theme.fg("dim", ` (cwd: ${args.cwd})`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, _opts, theme) {
      const details = result.details as {
        processId?: string;
        pid?: number;
      } | undefined;
      return new Text(
        theme.fg("success", `✓ Spawned ${details?.processId ?? "?"} (PID ${details?.pid ?? "?"})`),
        0,
        0,
      );
    },
  });

  // --- Status tool ---
  pi.registerTool({
    name: "subprocess_status",
    label: "Subprocess Status",
    description:
      "Check the status of a previously spawned process. Shows exit code (if done) " +
      "and recent stdout/stderr output.",
    promptSnippet:
      "Check status of a spawned subprocess — shows exit code and recent output",
    promptGuidelines: [
      "Use subprocess_status to check on processes started with subprocess_spawn.",
      "Pass the process ID returned by subprocess_spawn.",
    ],
    parameters: Type.Object({
      process_id: Type.String({
        description: "Process ID returned by subprocess_spawn",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const map = getSessionMap(sessionId);
      const record = map.get(params.process_id);

      if (!record) {
        // Try all session maps
        for (const [_, sessionMap] of spawnedProcesses) {
          if (sessionMap.has(params.process_id)) {
            return formatSpawnStatus(sessionMap.get(params.process_id)!);
          }
        }
        return {
          content: [{ type: "text", text: `Unknown process: ${params.process_id}` }],
          details: { error: true },
        };
      }

      return formatSpawnStatus(record);
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("subprocess_status ")) +
          theme.fg("muted", args.process_id),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const details = result.details as { done?: boolean; exitCode?: number | null } | undefined;
      if (details?.done !== undefined) {
        if (details.done && details.exitCode === 0) {
          return new Text(theme.fg("success", "✓ Process exited (code 0)"), 0, 0);
        }
        if (details.done) {
          return new Text(
            theme.fg("error", `✗ Process exited (code ${details.exitCode})`),
            0,
            0,
          );
        }
        return new Text(theme.fg("warning", "⟳ Process running"), 0, 0);
      }
      return new Text(theme.fg("muted", "Process status"), 0, 0);
    },
  });

  // --- Kill tool ---
  pi.registerTool({
    name: "subprocess_kill",
    label: "Subprocess Kill",
    description:
      "Kill a previously spawned process by its process ID.",
    promptSnippet:
      "Kill a spawned subprocess by process ID",
    promptGuidelines: [
      "Use subprocess_kill to stop processes started with subprocess_spawn.",
    ],
    parameters: Type.Object({
      process_id: Type.String({
        description: "Process ID returned by subprocess_spawn",
      }),
      signal: Type.Optional(
        Type.String({
          description: "Signal to send (default: SIGTERM, or SIGKILL)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      let record: SpawnRecord | undefined;
      let map: Map<string, SpawnRecord> | undefined;

      // Search in session map
      map = getSessionMap(sessionId);
      record = map.get(params.process_id);

      // Try all session maps
      if (!record) {
        for (const [_, sessionMap] of spawnedProcesses) {
          if (sessionMap.has(params.process_id)) {
            record = sessionMap.get(params.process_id)!;
            map = sessionMap;
            break;
          }
        }
      }

      if (!record) {
        return {
          content: [{ type: "text", text: `Unknown process: ${params.process_id}` }],
          details: { error: true },
        };
      }

      if (record.done) {
        return {
          content: [
            {
              type: "text",
              text: `Process ${params.process_id} already exited (code: ${record.exitCode})`,
            },
          ],
          details: { alreadyDone: true },
        };
      }

      try {
        killProcessTree(record.pid, params.signal ?? "SIGTERM");
        record.done = true;
        record.exitCode = -1;
        return {
          content: [
            {
              type: "text",
              text: `Sent ${params.signal ?? "SIGTERM"} to process ${params.process_id} (PID ${record.pid})`,
            },
          ],
          details: { killed: true, pid: record.pid },
        };
      } catch (err: unknown) {
        const error = err as { code?: string; message?: string };
        return {
          content: [
            {
              type: "text",
              text: `Failed to kill process: ${error.message ?? error.code ?? "unknown error"}`,
            },
          ],
          details: { error: true },
        };
      }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("subprocess_kill ")) +
          theme.fg("muted", args.process_id) +
          (args.signal ? theme.fg("dim", ` (${args.signal})`) : ""),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const details = result.details as { killed?: boolean; error?: boolean } | undefined;
      if (details?.killed) {
        return new Text(theme.fg("success", "✓ Process killed"), 0, 0);
      }
      if (details?.error) {
        return new Text(theme.fg("error", "✗ Kill failed"), 0, 0);
      }
      return new Text(theme.fg("muted", "Kill result"), 0, 0);
    },
  });
}

/**
 * Kill a process and all its children: process-group kill on Unix,
 * taskkill /T on Windows. Falls back to killing the child alone.
 */
function killProcessTree(pid: number, signal: string) {
  if (process.platform === "win32") {
    // /T kills the whole tree; /F forces (SIGKILL equivalent)
    try {
      const killer = spawn(
        "taskkill",
        signal === "SIGKILL"
          ? ["/F", "/T", "/PID", String(pid)]
          : ["/T", "/PID", String(pid)],
        { stdio: "ignore", detached: true, windowsHide: true },
      );
      killer.on("error", () => { /* fall through */ });
      return;
    } catch {
      /* fall through to plain kill */
    }
  } else {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* fall through to plain kill */
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // process already gone
  }
}

function formatSpawnStatus(record: SpawnRecord) {
  const parts: string[] = [];
  parts.push(`Process: ${record.id} (PID ${record.pid})`);
  parts.push(`Command: ${record.command.join(" ")}`);
  parts.push(`Status: ${record.done ? `exited (code ${record.exitCode})` : "running"}`);

  if (record.stdout) {
    const trunc = truncateHead(record.stdout, {
      maxLines: Math.min(DEFAULT_MAX_LINES, 100),
      maxBytes: DEFAULT_MAX_BYTES,
    });
    parts.push(`\n--- stdout (last ${trunc.outputLines} lines) ---\n${trunc.content}`);
  }
  if (record.stderr) {
    const trunc = truncateHead(record.stderr, {
      maxLines: Math.min(DEFAULT_MAX_LINES, 100),
      maxBytes: DEFAULT_MAX_BYTES,
    });
    parts.push(`\n--- stderr (last ${trunc.outputLines} lines) ---\n${trunc.content}`);
  }

  return {
    content: [{ type: "text", text: parts.join("\n") }],
    details: {
      processId: record.id,
      pid: record.pid,
      done: record.done,
      exitCode: record.exitCode,
      stdoutLines: record.stdout.split("\n").length,
      stderrLines: record.stderr.split("\n").length,
    },
  };
}
