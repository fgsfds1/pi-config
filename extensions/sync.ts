import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * This repo is installed as a pi git package, so pi keeps a live clone at
 * ~/.pi/agent/git/github.com/<owner>/<repo> and loads resources directly from
 * it. We treat that clone as the working copy: edit there, /sync-up to push,
 * /sync to pull. Override the path with PI_SYNC_DIR.
 *
 * Note: `pi update --extensions` resets the clone to the remote when the
 * remote moved — uncommitted edits are wiped in that case. /sync-up first.
 */
const REPO = "fgsfds1/pi-config";
const SYNC_DIR =
  process.env.PI_SYNC_DIR ??
  join(homedir(), ".pi", "agent", "git", "github.com", REPO);
const GIT_TIMEOUT_MS = 60_000;

/**
 * Sync extension — keep this pi config in sync with GitHub.
 *
 * Commands:
 *   /sync          — pull latest from GitHub and reload
 *   /sync-up [msg] — commit changes in the clone, push, and reload
 */
export default function (pi: ExtensionAPI) {
  const git = async (args: string[]): Promise<string> => {
    const result = await pi.exec("git", args, { cwd: SYNC_DIR, timeout: GIT_TIMEOUT_MS });
    // pi.exec maps a signal-killed exit (code: null) to 0 — a process killed
    // by the timeout must not count as success.
    if (result.code !== 0 || result.killed) {
      throw new Error(
        result.killed && !result.stderr
          ? `git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`
          : result.stderr.trim() || `git ${args[0]} exited with ${result.code}`,
      );
    }
    return result.stdout.trim();
  };

  type Ctx = {
    ui?: { notify: (m: string, t?: "info" | "warning" | "error") => void };
    reload: () => Promise<void>;
  };

  /**
   * Notify, tolerating a stale ctx. After ctx.reload() the old ctx is
   * invalidated, so any use of it (even the ctx.ui getter) throws — if
   * that happens the failure occurred during/after the reload, so log to
   * the console instead of throwing from the catch block.
   */
  const safeNotify = (ctx: Ctx, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui?.notify(message, type);
    } catch {
      console.error(`[sync] ${message}`);
    }
  };

  const rebaseInProgress = (): boolean =>
    existsSync(join(SYNC_DIR, ".git", "rebase-merge")) ||
    existsSync(join(SYNC_DIR, ".git", "rebase-apply"));

  /**
   * Pull with rebase. A failed (or killed) pull can leave the clone
   * mid-rebase, which makes every later git command fail until it is
   * aborted — so abort on failure and say so in the error.
   */
  const pullRebase = async (): Promise<void> => {
    try {
      await git(["pull", "--rebase", "--autostash"]);
    } catch (err) {
      let extra = "";
      if (rebaseInProgress()) {
        try {
          await git(["rebase", "--abort"]);
          extra = " (rebase aborted, local state restored)";
        } catch {
          extra = ` (a rebase is still in progress — run \`git rebase --abort\` in ${SYNC_DIR})`;
        }
      }
      throw new Error(`${err instanceof Error ? err.message : String(err)}${extra}`);
    }
  };

  /** Verify SYNC_DIR is the pi package clone of this repo. */
  const checkDir = async (ctx: Ctx): Promise<boolean> => {
    if (!existsSync(join(SYNC_DIR, ".git"))) {
      ctx.ui?.notify(
        `Pi package clone not found at ${SYNC_DIR}.\n` +
          `Install it first: pi install git:github.com/${REPO}\n` +
          `(or set PI_SYNC_DIR to the clone path)`,
        "warning",
      );
      return false;
    }
    try {
      const origin = await git(["remote", "get-url", "origin"]);
      if (!origin.includes(REPO)) {
        ctx.ui?.notify(
          `${SYNC_DIR} is not a clone of ${REPO} (origin: ${origin}). Set PI_SYNC_DIR to the pi package clone.`,
          "warning",
        );
        return false;
      }
    } catch {
      // not a git repo with origin — existsSync already passed, continue
    }
    return true;
  };

  pi.registerCommand("sync", {
    description: "Pull latest pi config from GitHub and reload",
    async handler(_args, ctx) {
      try {
        if (!(await checkDir(ctx as Ctx))) return;
        await pullRebase();
        const head = await git(["rev-parse", "--short", "HEAD"]);
        // Notify before reload: after await ctx.reload() the ctx is stale
        // and must not be used — treat reload as terminal for this handler.
        ctx.ui?.notify(`✓ Synced pi config to ${head}`, "info");
        await (ctx as Ctx).reload();
        return;
      } catch (err) {
        safeNotify(
          ctx as Ctx,
          `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("sync-up", {
    description: "Commit and push pi config changes (argument = commit message)",
    async handler(args, ctx) {
      try {
        if (!(await checkDir(ctx as Ctx))) return;
        await git(["add", "-A"]);
        const status = await git(["status", "--porcelain"]);
        // @{u} is a cached ref — fetch so the ahead/behind counts are real.
        await git(["fetch"]);
        // Commits left behind when an earlier push died (e.g. timed out
        // mid-transfer) — the tree is clean but HEAD is ahead of origin.
        const unpushed = await git(["rev-list", "--count", "@{u}..HEAD"]).catch(
          () => "0",
        );
        const behind = await git(["rev-list", "--count", "HEAD..@{u}"]).catch(() => "0");
        if (!status && unpushed === "0") {
          ctx.ui?.notify(
            behind !== "0"
              ? `Nothing to push — remote has ${behind} new commit(s), run /sync to pull`
              : "Nothing to sync — no changes",
            "info",
          );
          return;
        }
        const message =
          args.trim() || `sync: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
        if (status) {
          await git(["commit", "-m", message]);
        }
        // The remote may have moved (e.g. edited on another device) — rebase
        // local commits on top so the push is a fast-forward.
        if (behind !== "0") {
          await pullRebase();
        }
        await git(["push"]);
        const head = await git(["rev-parse", "--short", "HEAD"]);
        // Notify before reload: after await ctx.reload() the ctx is stale
        // and must not be used — treat reload as terminal for this handler.
        ctx.ui?.notify(
          status ? `✓ Pushed ${head}` : `✓ Pushed ${unpushed} pending commit(s)`,
          "info",
        );
        await (ctx as Ctx).reload();
        return;
      } catch (err) {
        safeNotify(ctx as Ctx, `Sync-up failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
