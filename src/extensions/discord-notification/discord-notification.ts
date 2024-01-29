import { Event } from "@strapi/database/dist/lifecycles/types";
import { Common, Strapi } from "@strapi/strapi";
import { WebhookClient } from "discord.js";
import ejs from "ejs";
import { isEqual } from "lodash";
import { settle } from "../../utils/async.utils";
import { DataType, DiscordNotificationConfig } from "./types";

const template = ejs.compile(`
<% if (action === "deleted") { -%>
:x: **<%- singularName %> deleted**
<% } -%>
<% if (action === "created") { -%>
:white_check_mark: **New <%- singularName.toLowerCase() %> created**
<% } -%>
<% if (action === "updated") { -%>
:pencil: **<%- singularName %> updated**
<% } -%>
<% if (action === "published") { -%>
:fire: **<%- singularName %> published**
<% } -%>
<% if (action === "unpublished") { -%>
:bangbang: **<%- singularName %> unpublished**
<% } -%>

**[Info]**
*Title:* <%- title -%>
<% if (action === "updated" || action === "created") { %>
*Publication status:* <%= isPublished ? "published" : "draft" -%>
<% } %>

<% if (changes) { -%>
**[Changes]**
<%- changes -%>
<% } %>

<% if (url && isPublished) { -%>
You can visit the <%- singularName.toLowerCase() %> here: <%- url -%>
<% } else if (url && !isPublished) { -%>
You can visit the preview of the <%- singularName.toLowerCase() %> here: <%- url -%>
<% } -%>
`);

export class DiscordNotification {
  private client: WebhookClient;

  constructor(
    private readonly strapi: Strapi,
    private readonly config: DiscordNotificationConfig
  ) {}

  init = () => {
    this.client = new WebhookClient({
      url: this.config.webhookUrl,
    });

    this.config.dataTypes.forEach((dataType) => {
      this.register(dataType);
    });
  };

  private register = (dataType: DataType) => {
    const { strapi } = this;

    strapi.db.lifecycles.subscribe({
      models: [dataType.uid],
      afterCreate: async (event) => this.onEvent(event, dataType),
      afterUpdate: async (event) => this.onEvent(event, dataType),
      afterDelete: async (event) => this.onEvent(event, dataType),
      beforeUpdate: async (event) => this.onEvent(event, dataType),
      beforeUpdateMany: async (event) => {
        const { strapi } = this;

        const records = await strapi.query(dataType.uid).findMany({
          where: event.params.where,
          populate: true,
        });

        event.state = {
          ...event.state,
          prev: records,
        };
      },
      afterUpdateMany: async (event) =>
        void (await Promise.all(
          (event.params.where?.id?.["$in"] || [])
            .filter((id) => !!id)
            .map((id) =>
              this.onEvent(
                {
                  ...event,
                  params: { ...event.params, where: { id: id } },
                  action: "afterUpdate",
                  state: {
                    ...event.state,
                    prev: ((event.state?.prev || []) as any[]).find(
                      (record: any) => record.id === id
                    ),
                  },
                },
                dataType
              )
            )
        )),
    });
  };

  onEvent = async (event: Event, dataType: DataType) => {
    const [_r, err] = await settle(() => this.handleEvent(event, dataType));
    if (err) {
      this.strapi.log.error(err);
      this.strapi.log.warn(
        `Failed to send Discord notification for ${event.model.uid} ${event.action} event`
      );
    }
  };

  handleEvent = async (event: Event, dataType: DataType) => {
    const { strapi, config } = this;

    if (
      !["afterCreate", "afterUpdate", "afterDelete", "beforeUpdate"].includes(
        event.action
      )
    )
      return;

    const postId =
      event.action === "afterCreate"
        ? (event as any).result.id
        : event.params.where.id;

    if (event.model.uid !== dataType.uid) return;

    if (event.action === "beforeUpdate") {
      const record = await this.getRecord(dataType.uid, postId);

      event.state = {
        ...event.state,
        prev: record,
      };

      return;
    }

    const record = await this.getRecord(dataType.uid, postId);

    const isPublished = record?.publishedAt !== null;
    let action: "created" | "updated" | "deleted" | "published" | "unpublished";

    if (event.action === "afterCreate") {
      action = "created";
    } else if (event.action === "afterUpdate") {
      action = "updated";

      if (!isPublished && !!(event.state.prev as any)?.publishedAt) {
        action = "unpublished";
      } else if (isPublished && !(event.state.prev as any)?.publishedAt) {
        action = "published";
      }
    } else if (event.action === "afterDelete") {
      action = "deleted";
    }

    const url =
      action === "deleted"
        ? null
        : isPublished
        ? await dataType.getUrl?.(record)
        : await dataType.getPreviewUrl?.(record);

    const changes =
      event.action === "afterUpdate"
        ? this.findChanges(
            dataType,
            event.model,
            event.state?.prev || {},
            record || {}
          )
        : [];

    const title =
      event.params.data?.[dataType.titleField] ??
      (record?.title || "") ??
      (event as any).result.title;

    const singularName =
      event.model.singularName.charAt(0).toUpperCase() +
      event.model.singularName.slice(1);

    const msg = template({
      title,
      singularName,
      isPublished,
      changes: this.changesToString(changes),
      url,
      action,
    });

    this.client.send({
      content: msg,
      avatarURL: this.config.avatarUrl,
      username: this.config.username || "Discord",
    });
  };

  changesToString = (
    changes: {
      attribute: string;
      previous: any;
      current: any;
      include?: boolean;
    }[]
  ) => {
    let str = changes
      .filter((change) => change.include)
      .map((change) => {
        let name = change.attribute.replace("_", " ");
        name = name.charAt(0).toUpperCase() + name.slice(1);

        let res = `*${name}:* `;

        if (Array.isArray(change.previous) && Array.isArray(change.current)) {
          const removed = change.previous.filter(
            (item) => !change.current.includes(item)
          );

          removed.forEach((item, index) => {
            res += `\n- ~~${item}~~`;
          });

          change.current.forEach((item) => {
            res += `\n- ${item}`;
          });

          return res;
        }

        if (change.previous && change.previous.length > 0)
          res += `~~${change.previous}~~ -> `;

        if (change.current && change.current.length > 0)
          res += `\`${change.current}\``;
        else res += `\`[empty]\``;

        return res;
      })
      .join("\n");

    const excluded = changes.filter((change) => !change.include);
    if (excluded.length > 0)
      str += `\n\nother fields changed: ${excluded
        .map((change) => `\`${change.attribute}\``)
        .join(", ")}`;

    return str;
  };

  findChanges = (
    dataType: DataType,
    model: Event["model"],
    previous: any,
    current: any
  ) => {
    const changes: {
      attribute: string;
      previous: any;
      current: any;
      include?: boolean;
    }[] = [];

    const updated = { ...current };

    const getChangedField = (val: any, key?: string) => {
      if (Array.isArray(val)) {
        return val.filter((v) => !!v).map((v) => getChangedField(v, key));
      }

      if (val === null) return "";
      if (typeof val === "undefined") return "";

      if (typeof val === "object") {
        return (key && val[key]) || val[Object.keys(val)[0]] || "";
      }

      return `${val}`;
    };

    Object.keys(updated).forEach((key) => {
      const attr = model.attributes[key];

      if (!attr) return;

      if (isEqual(updated[key], previous[key])) {
        return;
      }

      const isRelation = attr.type === "relation";
      const target = isRelation && (attr as any).target;
      const conf = this.getConfigByUid(target);

      const oldValue = getChangedField(previous[key], conf?.titleField);
      const newValue = getChangedField(updated[key], conf?.titleField);

      changes.push({
        attribute: key,
        previous: oldValue,
        current: newValue,
        include: !(dataType.ignoreFields || []).includes(key),
      });
    });

    return changes;
  };

  getRecord = async (uid: Common.UID.ContentType, id: string) => {
    const relations = this.getRelations(uid);
    return this.strapi.query(uid).findOne({
      where: { id },
      populate: Object.fromEntries(
        (await relations).map((rel) => [rel.key, true])
      ),
    });
  };

  getRelations = async (uid: Common.UID.ContentType) => {
    const model = this.strapi.contentTypes[uid];

    const relations = Object.entries(model.attributes)
      .filter(
        ([key, attr]) => attr.type === "relation" || attr.type === "media"
      )
      .map(([key, attr]) => {
        const target =
          attr.type === "media" ? "plugin::upload.file" : (attr as any).target;

        return {
          key,
          target,
          field: this.getConfigByUid(target)?.titleField || "id",
        };
      });

    return relations;
  };

  getConfigByUid = (uid: Common.UID.ContentType) => {
    return this.config.dataTypes.find((dataType) => dataType.uid === uid);
  };
}
