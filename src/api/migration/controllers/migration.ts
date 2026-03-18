import { factories } from "@strapi/strapi";
import { runGhostMigration } from "../../../migrations/ghost/migrate";

const IS_VERCEL = process.env.VERCEL === "1";
const TOKEN = process.env.MIGRATION_RUNNER_TOKEN || "";

const globalState = globalThis as any;
if (!globalState.__lpeMigrationLocks) globalState.__lpeMigrationLocks = {};

export default factories.createCoreController(
  "api::migration.migration" as any,
  ({ strapi }) => ({
    async runGhost(ctx) {
      if (IS_VERCEL) {
        ctx.status = 404;
        ctx.body = { message: "Not found" };
        return;
      }

      const token = String(ctx.query?.token || "");
      if (!TOKEN || token !== TOKEN) {
        ctx.status = 401;
        ctx.body = { message: "Invalid token" };
        return;
      }

      const modeRaw = String(ctx.query?.mode || "all");
      const mode =
        modeRaw === "posts" || modeRaw === "images" || modeRaw === "all"
          ? modeRaw
          : "all";

      const locks = globalState.__lpeMigrationLocks as Record<string, boolean>;
      const lockKey = `ghost:${mode}`;
      if (locks[lockKey]) {
        ctx.status = 409;
        ctx.body = { message: "Already running" };
        return;
      }

      locks[lockKey] = true;
      const startedAt = Date.now();
      try {
        const data = await runGhostMigration({ strapi, mode });
        ctx.status = 200;
        ctx.body = { ok: true, durationMs: Date.now() - startedAt, data };
      } catch (e: any) {
        ctx.status = 500;
        ctx.body = {
          ok: false,
          durationMs: Date.now() - startedAt,
          error: e?.message || String(e),
        };
      } finally {
        locks[lockKey] = false;
      }
    },
  })
);

