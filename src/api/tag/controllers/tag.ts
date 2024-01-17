/**
 * tag controller
 */

import { factories } from "@strapi/strapi";

export default factories.createCoreController("api::tag.tag", ({ strapi }) => ({
  async getAll(ctx) {
    const tags = await strapi.entityService.findMany("api::tag.tag", {
      populate: {
        posts: {
          count: true,
        } as any,
      },
      fields: "id,name",
      limit: 1000,
      sort: "name:asc",
    });

    return tags;
  },
}));
