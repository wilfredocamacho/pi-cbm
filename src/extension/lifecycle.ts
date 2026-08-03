import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CbmServices } from "../pi-tools/definitions.js";
import { CODEBASE_MEMORY_PROMPT } from "./prompt.js";

const AUTO_REFRESH_INTERVAL_MS = 60_000;

export function registerLifecycle(pi: ExtensionAPI, services: CbmServices) {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  // Monotonically increasing session generation. Bumped synchronously on every
  // session start and shutdown so that interval callbacks already queued or
  // still awaiting from a previous session can bail out before touching a stale
  // ctx (whose accessors throw after session replacement/reload).
  let sessionGeneration = 0;
  // The session generation that currently owns an in-flight index, used to keep
  // a single active index per session without leaking state across sessions.
  let inFlightGeneration: number | undefined;

  async function indexCurrentRepo(ctx: ExtensionContext, generation: number) {
    if (generation !== sessionGeneration) return; // stale session: skip
    if (inFlightGeneration === generation || ctx.signal?.aborted) return;

    inFlightGeneration = generation;
    try {
      const result = await services.projects.indexCurrentRepo(ctx.cwd, ctx.signal);
      if (generation !== sessionGeneration) return; // session changed mid-run
      if (result.status === "skipped") {
        ctx.ui.setStatus("codebase-memory", `cbm skipped: ${result.reason}`);
        return;
      }

      const nodes = typeof result.nodes === "number" ? ` · ${result.nodes} nodes` : "";
      const edges = typeof result.edges === "number" ? ` · ${result.edges} edges` : "";
      ctx.ui.setStatus("codebase-memory", `cbm ${result.project}${nodes}${edges}`);
    } catch (error) {
      if (generation !== sessionGeneration) return;
      const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
      ctx.ui.setStatus("codebase-memory", `cbm index failed${reason}`);
    } finally {
      if (inFlightGeneration === generation) inFlightGeneration = undefined;
    }
  }

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + CODEBASE_MEMORY_PROMPT,
  }));

  pi.on("session_start", (_event, ctx) => {
    services.settings.reload();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;

    const generation = sessionGeneration + 1;
    sessionGeneration = generation;

    void indexCurrentRepo(ctx, generation);
    refreshTimer = setInterval(() => {
      void indexCurrentRepo(ctx, generation);
    }, AUTO_REFRESH_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    // Invalidate synchronously so already-queued/running callbacks from this
    // session give up instead of touching the now-stale ctx.
    sessionGeneration += 1;
  });
}
