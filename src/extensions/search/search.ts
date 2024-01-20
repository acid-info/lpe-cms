import { Schema } from "@strapi/strapi";
import { convertQueryParams } from "@strapi/utils";
import { SearchConfig } from "./types";

const getSimilarity = (
  query: string,
  config: SearchConfig["contentTypes"][number]
) => {
  let q = "(";
  const bindings: Record<string, unknown> = {};

  config.fields.forEach(({ name, weight }, index) => {
    q += `SIMILARITY(:field${index}:, :q) * :w${index}`;

    bindings[`field${index}`] = name;
    bindings[`w${index}`] = weight ?? 1;

    if (index < config.fields.length - 1) q += " + ";
  });

  q += ") / :x";
  bindings.q = query;
  bindings.x = config.fields.reduce(
    (acc, { weight }) => acc + (weight ?? 1),
    0
  );

  return [q, bindings];
};

export const search = async ({
  contentType,
  query,
  where,
  pagination,
  config,
}: {
  contentType: Schema.ContentType;
  query: string;
  where: any;
  pagination: {
    start: number;
    limit: number;
  };
  config: SearchConfig["contentTypes"][number];
}) => {
  const similarity = getSimilarity(query, config);

  const qb = strapi.db.entityManager.createQueryBuilder(contentType.uid).init({
    start: pagination.start ?? 0,
    limit: pagination.limit ?? 15,
    where: convertQueryParams.convertFiltersQueryParams(where, contentType),
  });

  const rawQuery = qb
    .getKnexQuery()
    .select([
      strapi.db.connection.raw(`${similarity[0]} AS "score"`, similarity[1]),
    ])
    .orderByRaw(`score DESC`)
    .toQuery();

  const result = await strapi.db.queryBuilder(contentType.uid).raw(rawQuery);

  return {
    result: result.rows,
  };
};
