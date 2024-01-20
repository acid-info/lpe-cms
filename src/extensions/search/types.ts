import _buildersService from "@strapi/plugin-graphql/dist/server/services/builders";
import _formatService from "@strapi/plugin-graphql/dist/server/services/format";
import _utilsService from "@strapi/plugin-graphql/dist/server/services/utils";
import _nexus from "nexus";

export type Nexus = typeof _nexus;
export type UtilsService = ReturnType<typeof _utilsService>;
export type BuildersService = ReturnType<typeof _buildersService>;
export type FormatService = ReturnType<typeof _formatService>;

export type SearchConfig = {
  contentTypes: {
    uid: string;
    model: string;
    fields: {
      name: string;
      weight: number;
    }[];
  }[];
};
