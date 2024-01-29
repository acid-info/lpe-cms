import { Strapi } from "@strapi/strapi";
import { settleSync } from "../../utils/async.utils";
import { discordNotificationConfig } from "./config";
import { DiscordNotification } from "./discord-notification";

export * from "./discord-notification";

const register = async ({ strapi }: { strapi: Strapi }) => {};

const bootstrap = async ({ strapi }: { strapi: Strapi }) => {
  const discordNotification = new DiscordNotification(
    strapi,
    discordNotificationConfig
  );

  const [_r, err] = settleSync(() => discordNotification.init());
  if (err) {
    strapi.log.error(err);
    strapi.log.warn("Failed to initialize Discord notification extension.");
  }
};

export const discordNotificationExtension = {
  register,
  bootstrap,
};
