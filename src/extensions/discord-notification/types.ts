import { Attribute, Common } from "@strapi/strapi";

export type DataType<
  U extends Common.UID.CollectionType = Common.UID.CollectionType
> = {
  uid: U;
  enabled: boolean;
  titleField: string;
  ignoreFields?: string[];

  getUrl?: (
    data: Attribute.GetValues<U>
  ) => string | null | Promise<string | null>;

  getPreviewUrl?: (
    data: Attribute.GetValues<U>
  ) => string | null | Promise<string | null>;
};

export type DiscordNotificationConfig = {
  webhookUrl: string;
  username: string;
  avatarUrl?: string;

  dataTypes: DataType[];
};
