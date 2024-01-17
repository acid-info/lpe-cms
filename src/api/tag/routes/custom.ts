export default {
  routes: [
    {
      method: "GET",
      path: "/tags/getAll",
      handler: "tag.getAll",
      config: {
        policies: [],
      },
    },
  ],
};
