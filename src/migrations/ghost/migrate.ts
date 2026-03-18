import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type Mode = "posts" | "images" | "all";

const GHOST_API_URL = "https://blog.nomos.tech";

const envVal = (key: string) => {
  const v = process.env[key];
  return v != null && String(v).length > 0 ? String(v).trim() : undefined;
};

const makeGhostToken = (adminKey: string) => {
  const [id, secret] = adminKey.split(":");
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT", kid: id })
  ).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" })
  ).toString("base64url");
  const key = Uint8Array.from(Buffer.from(secret, "hex"));
  const sig = crypto
    .createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
};

const ghostFetch = async (adminKey: string, endpoint: string): Promise<any> => {
  const token = makeGhostToken(adminKey);
  const url = `${GHOST_API_URL}/ghost/api/admin/${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Ghost ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ghost API ${res.status}: ${text}`);
  }
  return (await res.json()) as any;
};

const fetchAllPosts = async (adminKey: string, formats: string) => {
  let allPosts: any[] = [];
  let page = 1;
  for (;;) {
    const data = (await ghostFetch(
      adminKey,
      `posts/?include=authors,tags&formats=${formats}&limit=50&page=${page}`
    )) as any;
    allPosts = allPosts.concat(data.posts);
    if (!data.meta?.pagination?.next) break;
    page = data.meta.pagination.next;
  }
  return allPosts;
};

const randomHash = () => crypto.randomBytes(5).toString("hex");

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const getUploadsDir = () => path.resolve(process.cwd(), "public", "uploads");

export const runGhostMigration = async ({
  strapi,
  mode = "all",
}: {
  strapi: any;
  mode?: Mode;
}) => {
  const adminKey = envVal("NOMOS_ADMIN_API_KEY");
  if (!adminKey) throw new Error("NOMOS_ADMIN_API_KEY is required");

  const knex = strapi.db.connection;

  const result: any = {
    mode,
    posts: null as any,
    images: null as any,
  };

  if (mode === "posts" || mode === "all") {
    const ghostPosts = await fetchAllPosts(adminKey, "html,mobiledoc");

    const findOrCreateAuthor = async (name: string, email?: string) => {
      if (!name) return null;
      const existing = await knex("authors").select("id").where({ name }).first();
      if (existing?.id) return existing.id;
      const rows = await knex("authors")
        .insert({
          name,
          email_address: email || null,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        })
        .returning("id");
      return rows?.[0]?.id ?? rows?.[0] ?? null;
    };

    const findOrCreateTag = async (name: string) => {
      if (!name) return null;
      const slug = name.toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (!slug) return null;
      const existing = await knex("tags").select("id").where({ name: slug }).first();
      if (existing?.id) return existing.id;
      const rows = await knex("tags")
        .insert({
          name: slug,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        })
        .returning("id");
      return rows?.[0]?.id ?? rows?.[0] ?? null;
    };

    const postExists = async (slug: string) => {
      const row = await knex("posts").select("id").where({ slug }).first();
      return row?.id ?? null;
    };

    let created = 0;
    let skipped = 0;

    for (const gp of ghostPosts) {
      const slug = gp.slug;
      const existingId = await postExists(slug);
      if (existingId) {
        skipped++;
        continue;
      }

      const publishDate = gp.published_at ? gp.published_at.slice(0, 10) : null;
      const now = new Date().toISOString();

      const inserted = await knex("posts")
        .insert({
          title: gp.title || "Untitled",
          subtitle: gp.custom_excerpt || gp.meta_description || null,
          slug,
          type: "Article",
          summary: gp.custom_excerpt || gp.meta_description || null,
          body: gp.html || "",
          publish_date: publishDate,
          featured: gp.featured || false,
          created_at: now,
          updated_at: now,
          published_at: gp.status === "published" ? now : null,
          created_by_id: 1,
          updated_by_id: 1,
        })
        .returning("id");

      const postId = inserted?.[0]?.id ?? inserted?.[0] ?? null;
      if (!postId) continue;

      if (gp.authors?.length) {
        for (let i = 0; i < gp.authors.length; i++) {
          const ga = gp.authors[i];
          const authorId = await findOrCreateAuthor(ga.name, ga.email);
          if (!authorId) continue;
          await knex("posts_authors_links")
            .insert({
              post_id: postId,
              author_id: authorId,
              author_order: i + 1,
            })
            .onConflict()
            .ignore();
        }
      }

      if (gp.tags?.length) {
        for (let i = 0; i < gp.tags.length; i++) {
          const gt = gp.tags[i];
          const tagId = await findOrCreateTag(gt.name);
          if (!tagId) continue;
          await knex("posts_tags_links")
            .insert({
              post_id: postId,
              tag_id: tagId,
              tag_order: i + 1,
            })
            .onConflict()
            .ignore();
        }
      }

      created++;
    }

    result.posts = { created, skipped, totalGhost: ghostPosts.length };
  }

  if (mode === "images" || mode === "all") {
    const ghostPosts = await fetchAllPosts(adminKey, "html");

    const uploadsDir = getUploadsDir();
    await fs.mkdir(uploadsDir, { recursive: true });

    const downloadAndRegisterImage = async (imageUrl: string) => {
      const existing = await knex("files")
        .select("id")
        .whereRaw(`provider_metadata->>'ghost_url' = ?`, [imageUrl])
        .first();
      if (existing?.id) return existing.id;

      const res = await fetch(imageUrl);
      if (!res.ok) return null;

      const urlPath = new URL(imageUrl).pathname;
      const originalName = path.basename(urlPath);
      const ext = path.extname(originalName).toLowerCase();
      const baseName = path.basename(originalName, ext);
      const hash = `${baseName}_${randomHash()}`;
      const fileName = `${hash}${ext}`;
      const filePath = path.join(uploadsDir, fileName);

      const arrayBuf = await res.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      await fs.writeFile(filePath, bytes);

      const sizeKB = Number((bytes.byteLength / 1024).toFixed(2));
      const mime = MIME_MAP[ext] || "application/octet-stream";
      const now = new Date().toISOString();

      const rows = await knex("files")
        .insert({
          name: originalName,
          alternative_text: "",
          caption: "",
          width: 0,
          height: 0,
          formats: null,
          hash,
          ext,
          mime,
          size: sizeKB,
          url: `/uploads/${fileName}`,
          preview_url: null,
          provider: "local",
          provider_metadata: JSON.stringify({ ghost_url: imageUrl }),
          folder_path: "/",
          created_at: now,
          updated_at: now,
          created_by_id: 1,
          updated_by_id: 1,
        })
        .returning("id");

      return rows?.[0]?.id ?? rows?.[0] ?? null;
    };

    const linkCoverImage = async (postId: number, fileId: number) => {
      const existing = await knex("files_related_morphs")
        .select("id")
        .where({
          related_id: postId,
          related_type: "api::post.post",
          field: "cover_image",
        })
        .first();
      if (existing?.id) return;
      await knex("files_related_morphs").insert({
        file_id: fileId,
        related_id: postId,
        related_type: "api::post.post",
        field: "cover_image",
        order: 1,
      });
    };

    let linked = 0;
    let noImage = 0;
    let failed = 0;

    for (const gp of ghostPosts) {
      const row = await knex("posts").select("id").where({ slug: gp.slug }).first();
      if (!row?.id) continue;

      if (!gp.feature_image) {
        noImage++;
        continue;
      }

      try {
        const fileId = await downloadAndRegisterImage(gp.feature_image);
        if (fileId) {
          await linkCoverImage(row.id, fileId);
          linked++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    result.images = { linked, noImage, failed, totalGhost: ghostPosts.length };
  }

  return result;
};

