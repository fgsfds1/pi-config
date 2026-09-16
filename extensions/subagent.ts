/**
 * Subagent extension — delegate tasks to specialized subagents with isolated context.
 *
 * Bundles built-in agents (scout, planner, reviewer, worker) and discovers
 * user-defined agents from ~/.pi/agent/agents/*.md.
 *
 * Modes:
 *   single   — { agent, task } — one agent, one task
 *   parallel — { tasks: [...] } — multiple agents run concurrently
 *   chain    — { chain: [...] } — sequential with {previous} placeholder
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  getMarkdownTheme,
  parseFrontmatter,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// --- Constants ---
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

// --- Built-in agents ---
const BUILTIN_AGENTS: Array<{
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
}> = [
  {
    name: "scout",
    description:
      "Fast codebase recon that returns compressed context for handoff to other agents",
    tools: ["read", "grep", "find", "ls", "bash"],
    model: undefined, // inherits parent model
    systemPrompt: `You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.

Your output will be passed to an agent who has NOT seen the files you explored.

Strategy:
1. grep/find to locate relevant code
2. Read key sections (not entire files)
3. Identify types, interfaces, key functions
4. Note dependencies between files

Output format:

## Files Retrieved
List with exact line ranges:
1. \`path/to/file.ts\` (lines 10-50) - Description
2. ...

## Key Code
Critical types, interfaces, or functions (verbatim from files).

## Architecture
Brief explanation of how the pieces connect.

## Start Here
Which file to look at first and why.`,
  },
  {
    name: "planner",
    description:
      "Creates detailed implementation plans from context provided by scouts or direct requests",
    tools: ["read", "grep", "find", "ls"],
    model: undefined, // inherits parent model
    systemPrompt: `You are a planner. Create detailed, actionable implementation plans.

Given context from a scout (or direct request), produce a step-by-step plan that a worker agent can execute without ambiguity.

Output format:

## Summary
One-line description of what will be done.

## Changes
Numbered steps. Each step:
- What file(s) to modify/create
- What exactly to change (add function, modify signature, etc.)
- Any dependencies on prior steps

## Testing
How to verify the changes work.

## Risks
Potential issues or edge cases to watch for.`,
  },
  {
    name: "reviewer",
    description:
      "Code review — checks for bugs, style issues, performance problems, and security concerns",
    tools: ["read", "grep", "find", "ls", "bash"],
    model: undefined, // inherits parent model
    systemPrompt: `You are a code reviewer. Review code changes and provide thorough feedback.

Focus on:
1. Correctness — bugs, logic errors, edge cases
2. Security — injection, auth, data leaks
3. Performance — unnecessary allocations, N+1 queries, blocking
4. Style — consistency, readability, naming
5. Testing — coverage gaps, missing edge cases

Output format:

## Critical
Issues that must be fixed before merge.

## Suggestions
Improvements worth making.

## Notes
Observations, questions, or minor style notes.

Keep feedback specific and actionable. Quote the problematic code and suggest the fix.`,
  },
  {
    name: "worker",
    description:
      "General-purpose agent with full capabilities for implementation and debugging",
    model: undefined, // inherits parent model
    systemPrompt: `You are a worker. Execute tasks thoroughly using all available tools.

Focus on producing working, clean code. Read files before editing. Test your changes. Explain what you did.`,
  },
];

// --- Types ---
export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "builtin" | "user" | "project";
  filePath?: string;
}

// --- Agent discovery ---
function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(
      content,
    );
    if (!frontmatter.name || !frontmatter.description) continue;
    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not a dir
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
  const builtinAgents = BUILTIN_AGENTS.map((a) => ({
    ...a,
    source: "builtin" as const,
  }));

  const userDir = path.join(getAgentDir(), "agents");
  const projectDir = findNearestProjectAgentsDir(cwd);

  const userAgents =
    scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents =
    scope === "user" || !projectDir ? [] : loadAgentsFromDir(projectDir, "project");

  // Merge: builtins → user → project (later overrides earlier)
  const map = new Map<string, AgentConfig>();
  for (const a of builtinAgents) map.set(a.name, a);
  if (scope !== "project") {
    for (const a of userAgents) map.set(a.name, a);
  }
  if (scope !== "user" && projectDir) {
    for (const a of projectAgents) map.set(a.name, a);
  }
  return Array.from(map.values());
}

// --- Helpers ---
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: string, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = ((args.command as string) || "...").slice(0, 60);
      return themeFg("muted", "$ ") + themeFg("toolOutput", command);
    }
    case "read": {
      const filePath = shortenPath(
        ((args.file_path || args.path || "...") as string),
      );
      return themeFg("muted", "read ") + themeFg("accent", filePath);
    }
    case "write": {
      return (
        themeFg("muted", "write ") +
        themeFg("accent", shortenPath((args.file_path || args.path || "...") as string))
      );
    }
    case "edit": {
      return (
        themeFg("muted", "edit ") +
        themeFg("accent", shortenPath((args.file_path || args.path || "...") as string))
      );
    }
    case "grep": {
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${(args.pattern || "") as string}/`) +
        themeFg("dim", ` in ${shortenPath((args.path || ".") as string)}`)
      );
    }
    default: {
      return themeFg("accent", toolName);
    }
  }
}

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function isFailedResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

function getDisplayItems(messages: Message[]): Array<{
  type: "text" | "toolCall";
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
}> {
  const items: Array<{
    type: "text" | "toolCall";
    text?: string;
    name?: string;
    args?: Record<string, unknown>;
  }> = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text")
          items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function getPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    // Compiled single-file binary: argv[1] is the executable itself, so
    // re-invoking must not duplicate it as the first argument.
    const isExecutable = currentScript === process.execPath;
    return {
      command: process.execPath,
      args: isExecutable ? args : [currentScript, ...args],
    };
  }
  return { command: "pi", args };
}

type OnUpdateCallback = (partial: {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
}) => void;

interface DispatchDefaults {
  model?: string;
  thinkingLevel?: string;
}

async function runSingleAgent(
  defaultCwd: string,
  dispatchDefaults: DispatchDefaults,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available: ${available}.`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const model = agent.model ?? dispatchDefaults.model;
  if (model) args.push("--model", model);
  // The session's thinking level always applies — agent frontmatter can
  // override the model but not the thinking level.
  if (dispatchDefaults.thinkingLevel) {
    args.push("--thinking", dispatchDefaults.thinkingLevel);
  }
  if (agent.tools && agent.tools.length > 0)
    args.push("--tools", agent.tools.join(","));

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [
          {
            type: "text",
            text: getFinalOutput(currentResult.messages) || "(running...)",
          },
        ],
        details: makeDetails([currentResult]),
      });
    }
  };

  let tmpPath: string | null = null;

  try {
    if (agent.systemPrompt.trim()) {
      const tmpDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-subagent-"),
      );
      const safeName = agentName.replace(/[^\w.-]+/g, "_");
      tmpPath = path.join(tmpDir, `prompt-${safeName}.md`);
      await fs.promises.writeFile(tmpPath, agent.systemPrompt, {
        encoding: "utf-8",
        mode: 0o600,
      });
      args.push("--append-system-prompt", tmpPath);
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        const evt = event as {
          type?: string;
          message?: Message;
        };

        if (evt.type === "message_end" && evt.message) {
          const msg = evt.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage as
              | {
                  input?: number;
                  output?: number;
                  cacheRead?: number;
                  cacheWrite?: number;
                  cost?: { total?: number };
                  totalTokens?: number;
                }
              | undefined;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && (msg.model as string | undefined))
              currentResult.model = msg.model as string;
            if ((msg as unknown as { stopReason?: string }).stopReason)
              currentResult.stopReason = (
                msg as unknown as { stopReason?: string }
              ).stopReason;
            if ((msg as unknown as { errorMessage?: string }).errorMessage)
              currentResult.errorMessage = (
                msg as unknown as { errorMessage?: string }
              ).errorMessage;
          }
          emitUpdate();
        }

        if (evt.type === "tool_result_end" && evt.message) {
          currentResult.messages.push(evt.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        // null means killed by a signal — treat as failure, not success
        resolve(code ?? 1);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      try {
        const dir = path.dirname(tmpPath);
        fs.rmdirSync(dir);
      } catch {
        /* ignore */
      }
    }
  }
}

// --- Tool schemas ---
const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process" }),
  ),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({
    description:
      "Task with optional {previous} placeholder for prior step output",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process" }),
  ),
});

// --- Extension ---
export default function (pi: ExtensionAPI) {
  // --- list_agents tool ---
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description:
      "List all available subagents (built-in and user-defined) with their descriptions.",
    promptSnippet: "List available subagents",
    promptGuidelines: [
      "Use list_agents to see what agents are available before delegating tasks.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const agents = discoverAgents(ctx.cwd, "both");
      const lines = [`Available agents (${agents.length}):`];
      for (const agent of agents) {
        lines.push(
          `  ${agent.name} [${agent.source}] — ${agent.description}`,
        );
        if (agent.model) lines.push(`    Model: ${agent.model}`);
        if (agent.tools) lines.push(`    Tools: ${agent.tools.join(", ")}`);
      }
      lines.push("");
      lines.push("Modes:");
      lines.push('  single   — { agent, task }');
      lines.push('  parallel — { tasks: [{ agent, task }, ...] }');
      lines.push(
        '  chain    — { chain: [{ agent, task }, ...] } (use {previous} for prior output)',
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { agents: agents.map((a) => a.name) },
      };
    },
    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("list_agents")),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const agents = (result.details as { agents?: string[] } | undefined)
        ?.agents ?? [];
      return new Text(
        theme.fg("success", `✓ ${agents.length} agent(s) available`),
        0,
        0,
      );
    },
  });

  // --- subagent tool ---
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to specialized subagents with isolated context. " +
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous}). " +
      "Built-in agents: scout (fast recon), planner (implementation plans), reviewer (code review), worker (general).",
    promptSnippet:
      "Delegate tasks to subagents — supports single, parallel, and chain modes",
    promptGuidelines: [
      "Use list_agents to see available agents and their capabilities.",
      "Use subagent with single mode for focused tasks (e.g. scout to explore code).",
      "Use subagent with parallel mode when tasks are independent.",
      "Use subagent with chain mode for multi-step workflows (scout → planner → worker).",
      "Use {previous} placeholder in chain tasks to pass output between steps.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({
          description: "Name of the agent to invoke (for single mode)",
        }),
      ),
      task: Type.Optional(
        Type.String({
          description: "Task to delegate (for single mode)",
        }),
      ),
      tasks: Type.Optional(
        Type.Array(TaskItem, {
          description: "Array of {agent, task} for parallel execution",
        }),
      ),
      chain: Type.Optional(
        Type.Array(ChainItem, {
          description:
            "Array of {agent, task} for sequential execution (use {previous})",
        }),
      ),
      agentScope: Type.Optional(
        Type.String({
          description:
            'Agent scope: "user", "project", or "both". Default: "both".',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory for the agent process (single mode)",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope = (params.agentScope ?? "both") as AgentScope;
      const dispatchDefaults: DispatchDefaults = {
        model: ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : undefined,
        thinkingLevel: ctx.thinkingLevel as string,
      };
      const agents = discoverAgents(ctx.cwd, agentScope);

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount =
        Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          results,
        });

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      // --- Chain mode ---
      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(
            /\{previous\}/g,
            previousOutput,
          );

          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const currentResult = partial.details?.results[0];
                if (currentResult) {
                  const allResults = [...results, currentResult];
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")(allResults),
                  });
                }
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);

          if (isFailedResult(result)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${i + 1} (${step.agent}): ${result.errorMessage || result.stderr || getFinalOutput(result.messages)}`,
                },
              ],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [
            {
              type: "text",
              text:
                getFinalOutput(results[results.length - 1].messages) ||
                "(no output)",
            },
          ],
          details: makeDetails("chain")(results),
        };
      }

      // --- Parallel mode ---
      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };

        const allResults: SingleResult[] = new Array(params.tasks.length);
        for (let i = 0; i < params.tasks.length; i++) {
          allResults[i] = {
            agent: params.tasks[i].agent,
            agentSource: "unknown",
            task: params.tasks[i].task,
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          };
        }

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const running = allResults.filter((r) => r.exitCode === -1).length;
            const done = allResults.filter((r) => r.exitCode !== -1).length;
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
                },
              ],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(
          params.tasks,
          MAX_CONCURRENCY,
          async (t, index) => {
            const result = await runSingleAgent(
              ctx.cwd,
              dispatchDefaults,
              agents,
              t.agent,
              t.task,
              t.cwd,
              undefined,
              signal,
              (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = partial.details.results[0];
                  emitParallelUpdate();
                }
              },
              makeDetails("parallel"),
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          },
        );

        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
          let output =
            isFailedResult(r)
              ? r.errorMessage || r.stderr || getFinalOutput(r.messages)
              : getFinalOutput(r.messages);
          const byteLength = Buffer.byteLength(output, "utf8");
          if (byteLength > PER_TASK_OUTPUT_CAP) {
            output = output.slice(0, PER_TASK_OUTPUT_CAP);
            output += `\n\n[Output truncated: ${byteLength - PER_TASK_OUTPUT_CAP} bytes omitted.]`;
          }
          const status = isFailedResult(r)
            ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
            : "completed";
          return `### [${r.agent}] ${status}\n\n${output}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      // --- Single mode ---
      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          dispatchDefaults,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
        );
        if (isFailedResult(result)) {
          return {
            content: [
              {
                type: "text",
                text: `Agent ${result.stopReason || "failed"}: ${result.errorMessage || result.stderr || getFinalOutput(result.messages)}`,
              },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                getFinalOutput(result.messages) || "(no output)",
            },
          ],
          details: makeDetails("single")([result]),
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Invalid parameters. Available agents: ${available}`,
          },
        ],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme) {
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview =
            cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg("accent", step.agent) +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview =
            t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || "...";
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }

      const mdTheme = getMarkdownTheme();

      const renderDisplayItems = (
        items: ReturnType<typeof getDisplayItems>,
        limit?: number,
      ) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded
              ? item.text
              : item.text!.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name!, item.args!, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      // --- Single ---
      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError = isFailedResult(r);
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
          if (isError && r.stopReason)
            header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          } else {
            for (const item of displayItems) {
              if (item.type === "toolCall")
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(item.name!, item.args!, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }
          }
          const usageStr = formatUsageStats(r.usage, r.model);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason)
          text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage)
          text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0)
          text += `\n${theme.fg("muted", "(no output)")}`;
        else {
          text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT)
            text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
      }

      // --- Aggregate usage ---
      const aggregateUsage = (results: SingleResult[]) => {
        const total = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
        };
        for (const r of results) {
          total.input += r.usage.input;
          total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite;
          total.cost += r.usage.cost;
          total.turns += r.usage.turns;
        }
        return total;
      };

      // --- Chain ---
      if (details.mode === "chain") {
        const successCount = details.results.filter((r) => r.exitCode === 0)
          .length;
        const icon =
          successCount === details.results.length
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");

        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              icon +
                " " +
                theme.fg("toolTitle", theme.bold("chain ")) +
                theme.fg("accent", `${successCount}/${details.results.length} steps`),
              0,
              0,
            ),
          );
          for (const r of details.results) {
            const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
                0,
                0,
              ),
            );
            container.addChild(
              new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
            );
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(item.name!, item.args!, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
              }
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }
            const stepUsage = formatUsageStats(r.usage, r.model);
            if (stepUsage)
              container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
          }
          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
          }
          return container;
        }

        // Collapsed
        let text =
          icon +
          " " +
          theme.fg("toolTitle", theme.bold("chain ")) +
          theme.fg("accent", `${successCount}/${details.results.length} steps`);
        for (const r of details.results) {
          const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
          if (displayItems.length === 0)
            text += `\n${theme.fg("muted", "(no output)")}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      // --- Parallel ---
      if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const successCount = details.results.filter(
          (r) => r.exitCode !== -1 && !isFailedResult(r),
        ).length;
        const failCount = details.results.filter(
          (r) => r.exitCode !== -1 && isFailedResult(r),
        ).length;
        const isRunning = running > 0;
        const icon = isRunning
          ? theme.fg("warning", "⏳")
          : failCount > 0
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;

        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
              0,
              0,
            ),
          );
          for (const r of details.results) {
            const rIcon = isFailedResult(r)
              ? theme.fg("error", "✗")
              : theme.fg("success", "✓");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
                0,
                0,
              ),
            );
            container.addChild(
              new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
            );
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(item.name!, item.args!, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
              }
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }
            const taskUsage = formatUsageStats(r.usage, r.model);
            if (taskUsage)
              container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
          }
          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
          }
          return container;
        }

        // Collapsed (or still running)
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const r of details.results) {
          const rIcon =
            r.exitCode === -1
              ? theme.fg("warning", "⏳")
              : isFailedResult(r)
                ? theme.fg("error", "✗")
                : theme.fg("success", "✓");
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
          if (displayItems.length === 0)
            text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        if (!isRunning) {
          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
        }
        if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    },
  });
}
