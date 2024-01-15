import type { Event } from "@strapi/database/dist/lifecycles";

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
};
