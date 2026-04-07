import type { Event } from "@strapi/database/dist/lifecycles";
import { generateOgImageForPost } from "../../services/og-image";

/**
 * Fields whose changes should invalidate the pre-generated og_image
 * and cause it to be re-rendered on the next save.
 */
const OG_INVALIDATING_FIELDS = [
  "title",
  "cover_image",
  "authors",
  "publish_date",
  "type",
  "slug",
] as const;

function didInvalidatingFieldChange(data: Record<string, unknown>): boolean {
  return OG_INVALIDATING_FIELDS.some((key) => key in data);
}

/**
 * Kick off OG image generation without blocking the lifecycle. Runs in a
 * detached promise so the user's save returns immediately; failures are
 * logged but never bubble up to the editor.
 */
function scheduleOgGeneration(postId: number, reason: string) {
  // Fire-and-forget by design.
  void (async () => {
    try {
      await generateOgImageForPost(postId, { replacePrevious: true });
    } catch (e) {
      strapi.log.error(
        `[og-image] Generation failed for post id=${postId} (${reason}): ${
          (e as Error).stack || (e as Error).message
        }`
      );
    }
  })();
}

export default {
  async beforeUpdate(event: Event) {
    if (event.params.data.publishedAt && !event.params.data.publish_date) {
      const post = await strapi.entityService.findOne(
        "api::post.post",
        event.params.where.id,
        {
          fields: ["publish_date"],
        }
      );

      if (!post.publish_date)
        event.params.data.publish_date = event.params.data.publishedAt;
    }
  },

  async afterCreate(event: Event) {
    const result = (event as unknown as { result?: { id: number; publishedAt?: unknown } }).result ?? null;
    if (!result?.id) return;
    // Only publish-ready posts get an OG image. Drafts will pick one up
    // when they're eventually published.
    if (!result.publishedAt) return;
    scheduleOgGeneration(result.id, "afterCreate");
  },

  async afterUpdate(event: Event) {
    const result = (event as unknown as { result?: { id: number; publishedAt?: unknown } }).result ?? null;
    if (!result?.id) return;
    if (!result.publishedAt) return;

    const data = (event.params.data || {}) as Record<string, unknown>;

    // PRIMARY recursion guard.
    //
    // The og-image service persists the generated file via
    // `strapi.db.query("api::post.post").update({ data: { og_image } })`.
    // `db.query.update` DOES fire lifecycle hooks (it calls
    // `db.lifecycles.run("afterUpdate", ...)` internally — verified in
    // node_modules/@strapi/database/dist/index.js), so without this
    // guard every persist would re-enter this hook and recurse until
    // we run out of stack.
    //
    // The og-image service is careful to pass EXACTLY `{ og_image: id }`
    // and nothing else, so we can safely identify the service-originated
    // write by inspecting the param keys.
    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0] === "og_image") return;

    if (!didInvalidatingFieldChange(data)) return;
    scheduleOgGeneration(result.id, "afterUpdate");
  },
};
