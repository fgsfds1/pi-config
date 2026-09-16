import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Working checkout of this repo (where edits happen). Override with PI_SYNC_DIR.
 * Note: pi loads the *installed package clone* (~/.pi/agent/git/...), not this
 * checkout — so after pulling/pushing we also run `pi update --extensions`
 * and reload to apply changes on this device.
 */
const SYNC_DIR =
  process.env.PI_SYNC_DIR ?? join(homedir(), "projects", "pi-config");

const REPO_SSH = "git@github.com:fgfsfds1/pi-config";

/**
 * Sync extension — keep this pi config in sync with GitHub.
 *
 * Commands:
 *   /sync          — pull latest from GitHub, update installed package, reload
 *   /sync-up [msg] — commit checkout changes, push, apply locally
 */
export default function (pi: ExtensionAPI) {
  const git = async (args: string[]): Promise<string> => {
    const result = await pi.exec("git", args, { cwd: SYNC_DIR, timeout: 60_000 });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
    }
    return result.stdout.trim();
  };

  const missingCheckout = (ctx: { ui?: { notify: (m: string, t?: "info" | "warning" | "error") => void } }) => {
    ctx.ui?.notify(
      `Sync checkout not found at ${SYNC_DIR}.\n` +
        `Clone it first: git clone ${REPO_SSH} ${SYNC_DIR}\n` +
        `(or set PI_SYNC_DIR to your checkout path)`,
      "warning",
    );
  };

  /** Update the pi-managed package clone and reload. Returns true on success. */
  const applyLocally = async (
    ctx: { ui?: { notify: (m: string, t?: "info" | "warning" | "error") => void }; reload: () => Promise<void> },
  ): Promise<boolean> => {
    const update = await pi.exec("pi", ["update", "--extensions"], { timeout: 120_000 });
    if (update.code !== 0) {
      ctx.ui?.notify(
        `'pi update --extensions' failed: ${(update.stderr.trim() || update.stdout.trim()).slice(0, 300)} — run it manually`,
        "warning",
      );
      return false;
    }
    await ctx.reload();
    return true;
  };

  pi.registerCommand("sync", {
    description: "Pull latest pi config from GitHub, update installed package, and reload",
    async handler(_args, ctx) {
      try {
        if (!existsSync(join(SYNC_DIR, ".git"))) {
          missingCheckout(ctx);
          return;
        }
        await git(["pull", "--rebase", "--autostash"]);
        const head = await git(["rev-parse", "--short", "HEAD"]);
        if (await applyLocally(ctx)) {
          ctx.ui?.notify(`✓ Synced pi config to ${head}`, "info");
        }
      } catch (err) {
        ctx.ui?.notify(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("sync-up", {
    description: "Commit and push local pi config changes (argument = commit message)",
    async handler(args, ctx) {
      try {
        if (!existsSync(join(SYNC_DIR, ".git"))) {
          missingCheckout(ctx);
          return;
        }
        await git(["add", "-A"]);
        const status = await git(["status", "--porcelain"]);
        if (!status) {
          ctx.ui?.notify("Nothing to sync — checkout is clean", "info");
          return;
        }
        const message =
          args.trim() || `sync: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
        await git(["commit", "-m", message]);
        await git(["push"]);
        const head = await git(["rev-parse", "--short", "HEAD"]);
        if (await applyLocally(ctx)) {
          ctx.ui?.notify(`✓ Pushed ${head} and applied locally`, "info");
        } else {
          ctx.ui?.notify(`✓ Pushed ${head}`, "info");
        }
      } catch (err) {
        ctx.ui?.notify(`Sync-up failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
