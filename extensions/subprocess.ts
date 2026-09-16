import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFile);

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
 * Subprocess extension — run commands synchronously or spawn them in the background.
 *
 * Tools:
 *   subprocess_run   — run a command, wait for output, return stdout/stderr/exit code
 *   subprocess_spawn — start a command in the background, returns a process ID
 *   subprocess_status — check status of a spawned process
 *   subprocess_kill   — kill a spawned process
 */
export default function (pi: ExtensionAPI) {
  // --- Sync run tool ---
  pi.registerTool({
    name: "subprocess_run",
    label: "Subprocess Run",
    description:
      "Run a command synchronously and wait for it to complete. " +
      "Returns stdout, stderr, and exit code. Use for quick commands like git status, ls, cat, etc.",
    promptSnippet:
      "Run a subprocess synchronously — waits for output, returns stdout/stderr/exit code",
    promptGuidelines: [
      "Use subprocess_run for quick commands that complete in under 30 seconds.",
      "Use subprocess_spawn for long-running processes (servers, watchers, daemons).",
      "For shell pipes/redirections, use shell: true with a single command string.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description:
          "Command to run (e.g. 'git status', 'ls -la', 'npm run build')",
      }),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory (default: current working directory)",
        }),
      ),
      timeout: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 300,
          description: "Timeout in seconds (default: 30)",
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
    async execute(_toolCallId, params, signal) {
      const timeoutMs = (params.timeout ?? 30) * 1000;
      const cwd = params.cwd ?? process.cwd();
      const env = params.env
        ? { ...process.env, ...params.env }
        : process.env;
      const useShell = params.shell !== false; // default true

      const options: Record<string, unknown> = {
        cwd,
        env,
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BYTES * 2,
        signal,
      };
      if (useShell) {
        options.shell = true;
      }

      try {
        const { stdout, stderr } = await execFileAsync(
          params.command,
          [],
          options as Parameters<typeof execFileAsync>[2],
        );

        const stdoutTrunc = truncateHead(stdout, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        const stderrTrunc = truncateHead(stderr, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let output = `Exit code: 0\n`;
        if (stdoutTrunc.content) {
          output += `\n--- stdout ---\n${stdoutTrunc.content}`;
          if (stdoutTrunc.truncated) {
            output += `\n[truncated: ${stdoutTrunc.outputLines} of ${stdoutTrunc.totalLines} lines]`;
          }
        }
        if (stderrTrunc.content) {
          output += `\n\n--- stderr ---\n${stderrTrunc.content}`;
          if (stderrTrunc.truncated) {
            output += `\n[truncated: ${stderrTrunc.outputLines} of ${stderrTrunc.totalLines} lines]`;
          }
        }

        return {
          content: [{ type: "text", text: output }],
          details: {
            command: params.command,
            exitCode: 0,
            stdoutLines: stdoutTrunc.totalLines,
            stderrLines: stderrTrunc.totalLines,
            stdoutBytes: stdoutTrunc.totalBytes,
            stderrBytes: stderrTrunc.totalBytes,
          },
        };
      } catch (err: unknown) {
        const error = err as { code?: string; signal?: string; stdout?: string; stderr?: string };
        const exitCode = error.code ?? -1;
        const stdout = error.stdout ?? "";
        const stderr = error.stderr ?? "";

        const stdoutTrunc = truncateHead(stdout, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        const stderrTrunc = truncateHead(stderr, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let output = `Exit code: ${exitCode}`;
        if (error.signal) output += ` (killed by ${error.signal})`;
        output += "\n";

        if (stdoutTrunc.content) {
          output += `\n--- stdout ---\n${stdoutTrunc.content}`;
        }
        if (stderrTrunc.content) {
          output += `\n--- stderr ---\n${stderrTrunc.content}`;
        }

        return {
          content: [{ type: "text", text: output }],
          details: {
            command: params.command,
            exitCode,
            stdoutLines: stdoutTrunc.totalLines,
            stderrLines: stderrTrunc.totalLines,
          },
        };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("subprocess_run "));
      text += theme.fg("muted", args.command);
      if (args.cwd) {
        text += theme.fg("dim", ` (cwd: ${args.cwd})`);
      }
      if (args.timeout && args.timeout !== 30) {
        text += theme.fg("dim", ` timeout:${args.timeout}s`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        exitCode: number;
        stdoutLines?: number;
        stderrLines?: number;
      } | undefined;
      const exitCode = details?.exitCode ?? -1;
      if (exitCode === 0) {
        let text = theme.fg("success", "✓ Exit 0");
        if (!expanded && details?.stdoutLines) {
          text += theme.fg("dim", ` (${details.stdoutLines} lines)`);
        }
        return new Text(text, 0, 0);
      }
      let text = theme.fg("error", `✗ Exit ${exitCode}`);
      if (!expanded && details?.stderrLines) {
        text += theme.fg("dim", ` (${details.stderrLines} stderr lines)`);
      }
      return new Text(text, 0, 0);
    },
  });

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
    async execute(_toolCallId, params, signal) {
      const sessionId = _toolCallId.slice(0, 8);
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
        detached: false,
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
        record.exitCode = code;
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
    async execute(_toolCallId, params) {
      const sessionId = _toolCallId.slice(0, 8);
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
    async execute(_toolCallId, params) {
      const sessionId = _toolCallId.slice(0, 8);
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
        process.kill(record.pid, params.signal ?? "SIGTERM");
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
