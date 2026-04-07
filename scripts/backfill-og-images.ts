/* eslint-disable no-console */
/**
 * Backfill script — generates og_image for every published post that
 * doesn't already have one.
 *
 * Usage:
 *   yarn ts-node --transpile-only scripts/backfill-og-images.ts
 *   yarn ts-node --transpile-only scripts/backfill-og-images.ts --force
 *   yarn ts-node --transpile-only scripts/backfill-og-images.ts --dry-run
 *
 * Notes:
 *   - Must be run from the Strapi project root so the CMS env/config loads.
 *   - Requires FRONTEND_URL (or NEXT_PUBLIC_BASE_URL) in env so the script
 *     can reach the Next.js /api/og?format=jpg endpoint.
 *   - `--force` regenerates even posts that already have an og_image.
 *   - `--dry-run` lists targets and exits without generating.
 */

import strapiFactory from "@strapi/strapi";
import { generateOgImageForPost } from "../src/api/post/services/og-image";

type PostRow = {
  id: number;
  slug?: string | null;
  title?: string | null;
  og_image?: { id: number } | null;
};

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  console.log(
    `[backfill-og] starting (force=${force}, dryRun=${dryRun})`
  );

  // Boot Strapi headlessly.
  const app = await (strapiFactory as any)().load();

  try {
    const posts = (await app.entityService.findMany("api::post.post", {
      filters: { publishedAt: { $notNull: true } },
      populate: { og_image: true },
      fields: ["id", "slug", "title"],
      pagination: { limit: -1 },
    })) as PostRow[];

    const targets = force
      ? posts
      : posts.filter((p) => !p.og_image);

    console.log(
      `[backfill-og] ${targets.length} target(s) out of ${posts.length} total published posts`
    );

    if (dryRun) {
      for (const p of targets) {
        console.log(`  - id=${p.id} slug=${p.slug} title="${p.title}"`);
      }
      return;
    }

    let ok = 0;
    let failed = 0;
    for (const [index, p] of targets.entries()) {
      const label = `[${index + 1}/${targets.length}] id=${p.id} slug=${p.slug}`;
      try {
        await generateOgImageForPost(p.id, {
          replacePrevious: true,
        });
        ok++;
        console.log(`${label} OK`);
      } catch (e) {
        failed++;
        console.error(`${label} FAILED: ${(e as Error).message}`);
      }
    }

    console.log(
      `[backfill-og] done. success=${ok} failed=${failed} total=${targets.length}`
    );
  } finally {
    await app.destroy();
  }
}

main().catch((e) => {
  console.error("[backfill-og] fatal", e);
  process.exit(1);
});
