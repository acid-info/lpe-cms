import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type Mode = "posts" | "images" | "all" | "repair" | "scan" | "rehydrate";

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

const extractImgSrcs = (html: string): string[] => {
  const out: string[] = [];
  if (!html) return out;
  const re = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = (m[1] || "").trim();
    if (src) out.push(src);
  }
  return Array.from(new Set(out));
};

const normalizeGhostImageUrl = (src: string): string | null => {
  if (!src) return null;
  if (src.startsWith("data:")) return null;
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  if (src.startsWith("//")) return `https:${src}`;
  if (src.startsWith("/")) return `${GHOST_API_URL}${src}`;
  return null;
};

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

  const ensureUploadsDir = async () => {
    const uploadsDir = getUploadsDir();
    await fs.mkdir(uploadsDir, { recursive: true });
    return uploadsDir;
  };

  const getGhostUrlFromProviderMetadata = (providerMetadata: any): string | null => {
    if (!providerMetadata) return null;
    if (typeof providerMetadata === "string") {
      try {
        return JSON.parse(providerMetadata)?.ghost_url ?? null;
      } catch {
        return null;
      }
    }
    return providerMetadata?.ghost_url ?? null;
  };

  const fileExistsForUploadsUrl = async (uploadsUrl: string): Promise<boolean> => {
    const abs = path.resolve(process.cwd(), "public", uploadsUrl.replace(/^\//, ""));
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  };

  const createDownloader = async () => {
    const uploadsDir = await ensureUploadsDir();

    const downloadAndRegisterImage = async (
      imageUrl: string
    ): Promise<{ id: number; url: string } | null> => {
      const existing = await knex("files")
        .select("id", "url")
        .whereRaw(`provider_metadata->>'ghost_url' = ?`, [imageUrl])
        .first();

      if (existing?.id && existing?.url) {
        const existingPath = path.resolve(
          process.cwd(),
          "public",
          existing.url.replace(/^\//, "")
        );
        try {
          await fs.access(existingPath);
          return { id: existing.id, url: existing.url };
        } catch {
          const res = await fetch(imageUrl);
          if (!res.ok) return null;

          const urlPath = new URL(imageUrl).pathname;
          const originalName = path.basename(urlPath);
          const ext =
            path.extname(existing.url).toLowerCase() ||
            path.extname(originalName).toLowerCase();

          const arrayBuf = await res.arrayBuffer();
          const bytes = new Uint8Array(arrayBuf);
          await fs.writeFile(existingPath, bytes);

          const sizeKB = Number((bytes.byteLength / 1024).toFixed(2));
          const mime = MIME_MAP[ext] || "application/octet-stream";
          const now = new Date().toISOString();

          await knex("files")
            .where({ id: existing.id })
            .update({
              name: originalName,
              ext,
              mime,
              size: sizeKB,
              provider: "local",
              provider_metadata: JSON.stringify({ ghost_url: imageUrl }),
              folder_path: "/",
              updated_at: now,
              updated_by_id: 1,
            });

          return { id: existing.id, url: existing.url };
        }
      }

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

      const targetUrl = `/uploads/${fileName}`;
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
          url: targetUrl,
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

      const id = rows?.[0]?.id ?? rows?.[0] ?? null;
      if (!id) return null;
      return { id, url: targetUrl };
    };

    return { uploadsDir, downloadAndRegisterImage };
  };

  if (mode === "repair") {
    const uploadsDir = await ensureUploadsDir();

    const downloadAndRegisterImage = async (
      imageUrl: string
    ): Promise<{ id: number; url: string } | null> => {
      const existing = await knex("files")
        .select("id", "url")
        .whereRaw(`provider_metadata->>'ghost_url' = ?`, [imageUrl])
        .first();

      if (existing?.id && existing?.url) {
        const existingPath = path.resolve(
          process.cwd(),
          "public",
          existing.url.replace(/^\//, "")
        );
        try {
          await fs.access(existingPath);
          return { id: existing.id, url: existing.url };
        } catch {
          const res = await fetch(imageUrl);
          if (!res.ok) return null;

          const urlPath = new URL(imageUrl).pathname;
          const originalName = path.basename(urlPath);
          const ext =
            path.extname(existing.url).toLowerCase() ||
            path.extname(originalName).toLowerCase();

          const arrayBuf = await res.arrayBuffer();
          const bytes = new Uint8Array(arrayBuf);
          await fs.writeFile(existingPath, bytes);

          const sizeKB = Number((bytes.byteLength / 1024).toFixed(2));
          const mime = MIME_MAP[ext] || "application/octet-stream";
          const now = new Date().toISOString();

          await knex("files")
            .where({ id: existing.id })
            .update({
              name: originalName,
              ext,
              mime,
              size: sizeKB,
              provider: "local",
              provider_metadata: JSON.stringify({ ghost_url: imageUrl }),
              folder_path: "/",
              updated_at: now,
              updated_by_id: 1,
            });

          return { id: existing.id, url: existing.url };
        }
      }

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

      const targetUrl = `/uploads/${fileName}`;
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
          url: targetUrl,
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

      const id = rows?.[0]?.id ?? rows?.[0] ?? null;
      if (!id) return null;
      return { id, url: targetUrl };
    };

    const ghostFiles = (await knex("files")
      .select("id", "url", "provider_metadata")
      .whereRaw(`provider_metadata->>'ghost_url' is not null`)) as Array<{
      id: number;
      url: string;
      provider_metadata: any;
    }>;

    let checked = 0;
    let repaired = 0;
    let stillMissing = 0;

    for (const f of ghostFiles) {
      checked++;
      const filePath = path.resolve(
        process.cwd(),
        "public",
        String(f.url || "").replace(/^\//, "")
      );
      try {
        await fs.access(filePath);
        continue;
      } catch {}

      const ghostUrl =
        typeof f.provider_metadata === "string"
          ? (() => {
              try {
                return JSON.parse(f.provider_metadata)?.ghost_url;
              } catch {
                return null;
              }
            })()
          : f.provider_metadata?.ghost_url;

      if (typeof ghostUrl !== "string" || ghostUrl.length === 0) {
        stillMissing++;
        continue;
      }

      const updated = await downloadAndRegisterImage(ghostUrl);
      if (updated?.id) repaired++;
      else stillMissing++;
    }

    result.images = { checked, repaired, stillMissing };
    return result;
  }

  if (mode === "scan") {
    const { downloadAndRegisterImage } = await createDownloader();

    const uploadUrlRe = /\/uploads\/[a-zA-Z0-9._-]+\.(?:png|jpg|jpeg|gif|webp|svg)/g;
    const postRows = (await knex("posts").select("id", "slug", "body")) as Array<{
      id: number;
      slug: string;
      body: string | null;
    }>;

    const urlToPosts = new Map<string, Array<{ id: number; slug: string }>>();
    for (const p of postRows) {
      const body = String(p.body || "");
      const matches = body.match(uploadUrlRe) || [];
      for (const u of matches) {
        const list = urlToPosts.get(u) || [];
        list.push({ id: p.id, slug: p.slug });
        urlToPosts.set(u, list);
      }
    }

    const allUrls = Array.from(urlToPosts.keys());
    const filesByUrl = new Map<string, { id: number; provider_metadata: any }>();

    const chunkSize = 200;
    for (let i = 0; i < allUrls.length; i += chunkSize) {
      const chunk = allUrls.slice(i, i + chunkSize);
      const rows = (await knex("files")
        .select("id", "url", "provider_metadata")
        .whereIn("url", chunk)) as Array<{
        id: number;
        url: string;
        provider_metadata: any;
      }>;
      for (const r of rows) filesByUrl.set(r.url, { id: r.id, provider_metadata: r.provider_metadata });
    }

    const missingOnDisk: string[] = [];
    const missingInFilesTable: string[] = [];
    const missingGhostMapping: string[] = [];
    let repaired = 0;

    for (const u of allUrls) {
      const exists = await fileExistsForUploadsUrl(u);
      if (exists) continue;

      missingOnDisk.push(u);
      const fileRow = filesByUrl.get(u);
      if (!fileRow) {
        missingInFilesTable.push(u);
        continue;
      }

      const ghostUrl = getGhostUrlFromProviderMetadata(fileRow.provider_metadata);
      if (!ghostUrl) {
        missingGhostMapping.push(u);
        continue;
      }

      const ok = await downloadAndRegisterImage(ghostUrl);
      if (ok?.id) repaired++;
    }

    result.images = {
      totalPosts: postRows.length,
      totalUniqueUploadsUrlsInBodies: allUrls.length,
      missingOnDiskCount: missingOnDisk.length,
      missingInFilesTableCount: missingInFilesTable.length,
      missingGhostMappingCount: missingGhostMapping.length,
      repairedCount: repaired,
      missingOnDisk: missingOnDisk.slice(0, 200),
      missingInFilesTable: missingInFilesTable.slice(0, 200),
      missingGhostMapping: missingGhostMapping.slice(0, 200),
      examples: allUrls.slice(0, 50).map((u) => ({
        url: u,
        posts: (urlToPosts.get(u) || []).slice(0, 5),
      })),
    };

    return result;
  }

  if (mode === "rehydrate") {
    const { downloadAndRegisterImage } = await createDownloader();
    const postRows = (await knex("posts").select("id", "slug", "body")) as Array<{
      id: number;
      slug: string;
      body: string | null;
    }>;

    let updatedPosts = 0;
    let downloaded = 0;
    let htmlFileUnlinked = 0;

    for (const p of postRows) {
      const html = String(p.body || "");
      if (!html) continue;

      const srcs = extractImgSrcs(html);
      const urlMatches =
        html.match(/https?:\/\/blog\.nomos\.tech\/content\/images\/[^"'\\s>]+/g) ||
        [];
      const candidates = Array.from(new Set([...srcs, ...urlMatches]));
      if (candidates.length === 0) continue;

      let newHtml = html;
      let changed = false;
      for (const src of candidates) {
        const abs = normalizeGhostImageUrl(src);
        if (!abs) continue;
        let absPath = "";
        try {
          absPath = new URL(abs).pathname;
        } catch {}
        if (
          !abs.includes("/content/images/") &&
          !(absPath && absPath.includes("/content/images/"))
        ) {
          continue;
        }
        const file = await downloadAndRegisterImage(abs);
        if (!file?.url) continue;
        const before = newHtml;
        if (src && newHtml.includes(src)) newHtml = newHtml.split(src).join(file.url);
        if (newHtml.includes(abs)) newHtml = newHtml.split(abs).join(file.url);
        if (absPath && newHtml.includes(absPath))
          newHtml = newHtml.split(absPath).join(file.url);
        if (newHtml !== before) {
          changed = true;
          downloaded++;
        }
      }

      if (changed) {
        const now = new Date().toISOString();
        await knex("posts")
          .where({ id: p.id })
          .update({ body: newHtml, updated_at: now });

        const removed = await knex("files_related_morphs")
          .where({
            related_id: p.id,
            related_type: "api::post.post",
            field: "html_file",
          })
          .del();
        if (removed > 0) htmlFileUnlinked += removed;

        updatedPosts++;
      }
    }

    result.images = {
      updatedPosts,
      downloaded,
      htmlFileUnlinked,
      totalPosts: postRows.length,
    };
    return result;
  }

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

    const downloadAndRegisterImage = async (
      imageUrl: string
    ): Promise<{ id: number; url: string } | null> => {
      const existing = await knex("files")
        .select("id", "url")
        .whereRaw(`provider_metadata->>'ghost_url' = ?`, [imageUrl])
        .first();

      if (existing?.id && existing?.url) {
        const existingPath = path.resolve(
          process.cwd(),
          "public",
          existing.url.replace(/^\//, "")
        );
        try {
          await fs.access(existingPath);
          return { id: existing.id, url: existing.url };
        } catch {
          const res = await fetch(imageUrl);
          if (!res.ok) return null;

          const urlPath = new URL(imageUrl).pathname;
          const originalName = path.basename(urlPath);
          const ext =
            path.extname(existing.url).toLowerCase() ||
            path.extname(originalName).toLowerCase();

          const arrayBuf = await res.arrayBuffer();
          const bytes = new Uint8Array(arrayBuf);
          await fs.writeFile(existingPath, bytes);

          const sizeKB = Number((bytes.byteLength / 1024).toFixed(2));
          const mime = MIME_MAP[ext] || "application/octet-stream";
          const now = new Date().toISOString();

          await knex("files")
            .where({ id: existing.id })
            .update({
              name: originalName,
              ext,
              mime,
              size: sizeKB,
              provider: "local",
              provider_metadata: JSON.stringify({ ghost_url: imageUrl }),
              folder_path: "/",
              updated_at: now,
              updated_by_id: 1,
            });

          return { id: existing.id, url: existing.url };
        }
      }

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

      const targetUrl = `/uploads/${fileName}`;

      if (existing?.id) {
        await knex("files")
          .where({ id: existing.id })
          .update({
            name: originalName,
            hash,
            ext,
            mime,
            size: sizeKB,
            url: targetUrl,
            provider: "local",
            provider_metadata: JSON.stringify({ ghost_url: imageUrl }),
            folder_path: "/",
            updated_at: now,
            updated_by_id: 1,
          });
        return { id: existing.id, url: targetUrl };
      }

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
          url: targetUrl,
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

      const id = rows?.[0]?.id ?? rows?.[0] ?? null;
      if (!id) return null;
      return { id, url: targetUrl };
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
    let bodyUpdated = 0;
    let bodyImagesLinked = 0;
    let recoveredMissing = 0;

    for (const gp of ghostPosts) {
      const row = await knex("posts")
        .select("id", "body")
        .where({ slug: gp.slug })
        .first();
      if (!row?.id) continue;

      const now = new Date().toISOString();

      if (!gp.feature_image) {
        noImage++;
      } else {
        try {
          const cover = await downloadAndRegisterImage(gp.feature_image);
          if (cover?.id) {
            await linkCoverImage(row.id, cover.id);
            linked++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }

      const html = String(row.body || gp.html || "");
      const srcs = extractImgSrcs(html);
      if (srcs.length > 0) {
        let newHtml = html;
        let changed = false;

        for (const src of srcs) {
          const abs = normalizeGhostImageUrl(src);
          if (!abs) continue;
          if (src.includes("/uploads/")) continue;
          const file = await downloadAndRegisterImage(abs);
          if (!file?.url) continue;
          if (newHtml.includes(src)) {
            newHtml = newHtml.split(src).join(file.url);
            changed = true;
            bodyImagesLinked++;
          }
        }

        if (changed) {
          await knex("posts")
            .where({ id: row.id })
            .update({ body: newHtml, updated_at: now });
          bodyUpdated++;
        }
      }
    }

    const ghostFiles = (await knex("files")
      .select("id", "url", "provider_metadata")
      .whereRaw(`provider_metadata->>'ghost_url' is not null`)) as Array<{
      id: number;
      url: string;
      provider_metadata: any;
    }>;

    for (const f of ghostFiles) {
      const filePath = path.resolve(
        process.cwd(),
        "public",
        String(f.url || "").replace(/^\//, "")
      );
      try {
        await fs.access(filePath);
        continue;
      } catch {}

      const ghostUrl =
        typeof f.provider_metadata === "string"
          ? (() => {
              try {
                return JSON.parse(f.provider_metadata)?.ghost_url;
              } catch {
                return null;
              }
            })()
          : f.provider_metadata?.ghost_url;

      if (typeof ghostUrl !== "string" || ghostUrl.length === 0) continue;
      const updated = await downloadAndRegisterImage(ghostUrl);
      if (updated?.id) recoveredMissing++;
    }

    result.images = {
      linked,
      noImage,
      failed,
      totalGhost: ghostPosts.length,
      bodyUpdated,
      bodyImagesLinked,
      recoveredMissing,
    };
  }

  return result;
};

