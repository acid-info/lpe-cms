export default {
  routes: [
    {
      method: "GET",
      path: "/admin/migrations/ghost",
      handler: "migration.runGhost",
      config: {
        policies: [],
      },
    },
  ],
};

