import { SearchConfig } from "./types";

export const searchConfig: SearchConfig = {
  contentTypes: [
    {
      uid: "api::post.post",
      model: "post",
      fields: [
        {
          name: "title",
          weight: 10,
        },
        {
          name: "summary",
          weight: 50,
        },
        {
          name: "body",
          weight: 100,
        },
      ],
    },
  ],
};
