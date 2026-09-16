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
const REPO = "fgfsfds1/pi-config";
const SYNC_DIR =
  process.env.PI_SYNC_DIR ??
  join(homedir(), ".pi", "agent", "git", "github.com", REPO);

/**
 * Sync extension — keep this pi config in sync with GitHub.
 *
 * Commands:
 *   /sync          — pull latest from GitHub and reload
 *   /sync-up [msg] — commit changes in the clone, push, and reload
 */
export default function (pi: ExtensionAPI) {
  const git = async (args: string[]): Promise<string> => {
    const result = await pi.exec("git", args, { cwd: SYNC_DIR, timeout: 60_000 });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
    }
    return result.stdout.trim();
  };

  type Ctx = {
    ui?: { notify: (m: string, t?: "info" | "warning" | "error") => void };
    reload: () => Promise<void>;
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
        await git(["pull", "--rebase", "--autostash"]);
        const head = await git(["rev-parse", "--short", "HEAD"]);
        await (ctx as Ctx).reload();
        ctx.ui?.notify(`✓ Synced pi config to ${head}`, "info");
      } catch (err) {
        ctx.ui?.notify(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, "error");
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
        if (!status) {
          ctx.ui?.notify("Nothing to sync — no changes", "info");
          return;
        }
        const message =
          args.trim() || `sync: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
        await git(["commit", "-m", message]);
        await git(["push"]);
        const head = await git(["rev-parse", "--short", "HEAD"]);
        await (ctx as Ctx).reload();
        ctx.ui?.notify(`✓ Pushed ${head} and reloaded`, "info");
      } catch (err) {
        ctx.ui?.notify(`Sync-up failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
