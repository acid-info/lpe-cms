import type { Event } from "@strapi/database/dist/lifecycles";
import { generateOgImageForPost } from "../../services/og-image";

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
    const result =
      (event as unknown as { result?: { id: number; publishedAt?: unknown } })
        .result ?? null;
    if (!result?.id) return;
    // Only publish-ready posts get an OG image. Drafts will pick one up
    // when they're eventually published.
    if (!result.publishedAt) return;
    scheduleOgGeneration(result.id, "afterCreate");
  },

  async afterUpdate(event: Event) {
    const result =
      (event as unknown as { result?: { id: number; publishedAt?: unknown } })
        .result ?? null;
    if (!result?.id) return;
    if (!result.publishedAt) return;

    const data = (event.params.data || {}) as Record<string, unknown>;

    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0] === "og_image") return;

    const isPublishTransition =
      "publishedAt" in data && data.publishedAt != null;
    if (isPublishTransition) {
      const post = (await strapi.entityService.findOne(
        "api::post.post",
        result.id,
        { populate: { og_image: true } }
      )) as { og_image?: { id: number } | null } | null;
      if (!post?.og_image) {
        scheduleOgGeneration(result.id, "afterUpdate:publish");
        return;
      }
    }

    if (!didInvalidatingFieldChange(data)) return;
    scheduleOgGeneration(result.id, "afterUpdate");
  },
};
