import { Strapi } from "@strapi/strapi";
import { registerGraphqlSearch } from "./graphql";

export { registerGraphqlSearch } from "./graphql";

const register = async ({ strapi }: { strapi: Strapi }) => {
  await registerGraphqlSearch(strapi);
};

const bootstrap = async ({ strapi }: { strapi: Strapi }) => {
  await strapi.db.connection.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
};

export const searchExtension = {
  register,
  bootstrap,
};
