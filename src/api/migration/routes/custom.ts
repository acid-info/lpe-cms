export default {
  routes: [
    {
      method: "GET",
      path: "/migrations/ghost",
      handler: "migration.runGhost",
      config: {
        policies: [],
      },
    },
  ],
};

