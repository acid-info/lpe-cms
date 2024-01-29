import { Attribute } from "@strapi/strapi";
import { DiscordNotificationConfig } from "./types";

const DISCORD_NOTIFICATION_USERNAME =
  process.env.DISCORD_NOTIFICATION_USERNAME || "Logos Press Engine";
const DISCORD_NOTIFICATION_AVATAR_URL =
  process.env.DISCORD_NOTIFICATION_AVATAR_URL ||
  "https://press.logos.co/logo.png";
const DISCORD_NOTIFICATION_WEBHOOK_URL =
  process.env.DISCORD_NOTIFICATION_WEBHOOK_URL || "";
const LPE_WEBSITE_URL = process.env.LPE_WEBSITE_URL || "https://press.logos.co";

export const discordNotificationConfig: DiscordNotificationConfig = {
  username: DISCORD_NOTIFICATION_USERNAME,
  avatarUrl: DISCORD_NOTIFICATION_AVATAR_URL,
  webhookUrl: DISCORD_NOTIFICATION_WEBHOOK_URL,
  dataTypes: [
    {
      uid: "api::post.post",
      enabled: true,
      titleField: "title",
      ignoreFields: ["summary", "body", "channels", "credits", "updatedAt"],
      getUrl: (data: Attribute.GetValues<"api::post.post">) =>
        data.type === "Article"
          ? `${LPE_WEBSITE_URL}/articles/${data.slug}`
          : `${LPE_WEBSITE_URL}/podcasts/${data.podcast_show?.slug}/${data.slug}`,
      getPreviewUrl: (data: Attribute.GetValues<"api::post.post">) =>
        `${LPE_WEBSITE_URL}/preview/post/${data.slug}`,
    },
    {
      uid: "api::author.author",
      enabled: false,
      titleField: "name",
    },
    {
      uid: "api::podcast-show.podcast-show",
      enabled: true,
      titleField: "name",
      getUrl: (data: Attribute.GetValues<"api::podcast-show.podcast-show">) =>
        `${LPE_WEBSITE_URL}/podcasts/${data.slug}`,
      ignoreFields: ["description"],
    },
    {
      uid: "api::page.page",
      enabled: true,
      titleField: "title",
      ignoreFields: ["body", "updatedAt"],
      getUrl: (data: Attribute.GetValues<"api::page.page">) =>
        `${LPE_WEBSITE_URL}/${data.slug}`,
      getPreviewUrl: (data: Attribute.GetValues<"api::page.page">) =>
        `${LPE_WEBSITE_URL}/preview/page/${data.slug}`,
    },
    {
      uid: "api::tag.tag",
      enabled: false,
      titleField: "name",
    },
    {
      uid: "admin::user",
      enabled: false,
      titleField: "username",
    },
    {
      uid: "plugin::upload.file",
      enabled: false,
      titleField: "name",
    },
  ],
};
