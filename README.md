# cms-press.logos.co

Requires Node 20, as Strapi v4 depends on it.

```bash
cp .env.example .env
```

## Environment variables

After copying `.env.example` to `.env`, update the variables to match your local or production database configuration.

| Variable             | Description                                      | Example                         | Required | Notes                                           |
| -------------------- | ------------------------------------------------ | -------------------------------- | -------- | ----------------------------------------------- |
| `DATABASE_CLIENT`    | Database client/driver used by Strapi           | `postgres`, `mysql`, `sqlite`   | Yes      | Use `sqlite` for simple local dev if supported. |
| `DATABASE_HOST`      | Database server host                            | `localhost`, `db.example.com`   | Yes      | For Docker, this may be the service name.       |
| `DATABASE_PORT`      | Port on which the database listens              | `5432`, `3306`                  | Yes      | Must match your database configuration.         |
| `DATABASE_NAME`      | Name of the application database                | `cms_press`                     | Yes      | Create this DB before running migrations.       |
| `DATABASE_USERNAME`  | Database user with access to `DATABASE_NAME`    | `cms_user`                      | Yes      | Should have permission to create/alter tables.  |
| `DATABASE_PASSWORD`  | Password for `DATABASE_USERNAME`                | `super-secure-password`         | Yes      | Use a strong secret in production.              |
| `DATABASE_SSL`       | Whether SSL is required for DB connections      | `false` (local), `true` (prod)  | Optional | Typically `false` for local dev, `true` in prod |

For local development, you can usually point to a local database instance (e.g., `localhost` with `DATABASE_SSL=false`). In production, you should use your managed database host, secure credentials, and enable SSL if your provider requires it.
### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```
npm run develop
# or
yarn develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```
npm run start
# or
yarn start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```
npm run build
# or
yarn build
```

## ⚙️ Deployment

Strapi gives you many possible deployment options for your project including [Strapi Cloud](https://cloud.strapi.io). Browse the [deployment section of the documentation](https://docs.strapi.io/dev-docs/deployment) to find the best solution for your use case.

## 📚 Learn more

- [Resource center](https://strapi.io/resource-center) - Strapi resource center.
- [Strapi documentation](https://docs.strapi.io) - Official Strapi documentation.
- [Strapi tutorials](https://strapi.io/tutorials) - List of tutorials made by the core team and the community.
- [Strapi blog](https://strapi.io/blog) - Official Strapi blog containing articles made by the Strapi team and the community.
- [Changelog](https://strapi.io/changelog) - Find out about the Strapi product updates, new features and general improvements.

Feel free to check out the [Strapi GitHub repository](https://github.com/strapi/strapi). Your feedback and contributions are welcome!

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team.
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members.
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi.

---

<sub>🤫 Psst! [Strapi is hiring](https://strapi.io/careers).</sub>
