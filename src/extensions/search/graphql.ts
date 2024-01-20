import { Strapi } from "@strapi/strapi";
import { sanitize } from "@strapi/utils";
import { searchConfig } from "./config";
import { search } from "./search";
import { BuildersService, Nexus, SearchConfig, UtilsService } from "./types";

const extendTypes = (strapi: Strapi, nexus: Nexus, config: SearchConfig) => {
  const graphql = strapi.plugin("graphql");
  const { naming, attributes, mappers } = graphql.service(
    "utils"
  ) as UtilsService;
  const { utils } = graphql.service("builders") as BuildersService;

  const types = [];

  types.push(
    nexus.extendType({
      type: "Query",
      definition: (t) => {
        t.field("search", {
          type: "SearchResult",
          args: {
            query: nexus.nonNull(
              nexus.stringArg({ description: "Search query" })
            ),
          },
          resolve: async (source, args, ctx) => {
            const { query } = args;
            const { auth } = ctx.state;

            return {
              query,
              auth,
            };
          },
        });
      },
    })
  );

  config.contentTypes.forEach((_contentType) => {
    const contentType = strapi.contentTypes[_contentType.uid];

    types.push(
      nexus.extendType({
        type: naming.getEntityName(contentType),
        definition: (t) => {
          t.float("score");
        },
      })
    );

    types.push(
      nexus.extendType({
        type: "SearchResult",
        definition: (t) => {
          t.field(naming.getFindQueryName(contentType), {
            type: naming.getEntityResponseCollectionName(contentType),
            args: {
              pagination: nexus.arg({ type: "PaginationArg" }),
              filters: nexus.arg({
                type: naming.getFiltersInputTypeName(contentType),
              }),
            },

            resolve: async (source, args, ctx, auth) => {
              const { query } = source;
              const { pagination, filters } = args;

              const transformedArgs = utils.transformArgs(
                { pagination, filters },
                {
                  contentType,
                  usePagination: true,
                }
              );

              const { result } = await search({
                contentType,
                query,
                where: transformedArgs.filters,
                pagination: {
                  start: transformedArgs.start ?? 0,
                  limit: transformedArgs.limit ?? 10,
                },
                config: _contentType,
              });

              const { toEntityResponseCollection } =
                graphql.service("format").returnTypes;

              const results = await Promise.all(
                result.map((row) =>
                  sanitize.contentAPI.output(row, contentType)
                )
              );

              return toEntityResponseCollection(results, {
                args: {},
                resourceUID: contentType.uid,
              });
            },
          });
        },
      })
    );
  });

  return types;
};

export const registerGraphqlSearch = async (strapi: Strapi) => {
  strapi
    .plugin("graphql")
    .service("extension")
    .use(({ nexus }: { nexus: Nexus }) => ({
      types: extendTypes(strapi, nexus, searchConfig),
      resolversConfig: {
        "Query.search": {
          auth: {
            scope: "api::post.post.search",
          },
        },
      },
    }));
};
