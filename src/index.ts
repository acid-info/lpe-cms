import { Strapi } from "@strapi/strapi";
import { discordNotificationExtension } from "./extensions/discord-notification";
import { searchExtension } from "./extensions/search";

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  async register({ strapi }) {
    await searchExtension.register({ strapi });
    await discordNotificationExtension.register({ strapi });
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }: { strapi: Strapi }) {
    await searchExtension.bootstrap({ strapi });
    await discordNotificationExtension.bootstrap({ strapi });
  },
};
