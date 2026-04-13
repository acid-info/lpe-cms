import fs from "fs/promises";
import os from "os";
import path from "path";

const FRONTEND_BASE_URL =
  process.env.OG_FRONTEND_URL || "https://press.logos.co";

const CMS_PUBLIC_URL =
  process.env.OG_CMS_PUBLIC_URL || "https://cms-press.logos.co";

type AuthorLike = { name?: string | null } | null | undefined;

type PostLike = {
  id: number;
  slug?: string | null;
  title?: string | null;
  publish_date?: string | Date | null;
  createdAt?: string | Date | null;
  type?: string | null;
  cover_image?: { url?: string | null } | null;
  og_image?: { id: number } | null;
  authors?: AuthorLike[] | null;
};

/**
 * Mirrors press.logos.co/src/utils/og.utils.ts getOpenGraphImageUrl().
 * Keep in sync.
 */
function buildOgUrl(params: {
  frontendBase: string;
  title?: string | null;
  imageUrl?: string | null;
  imagePath?: string | null;
  contentType?: string | null;
  date?: string | null;
  pagePath?: string | null;
  authors?: string[] | null;
}): string {
  const { frontendBase } = params;
  const url = new URL("/api/og", frontendBase);

  const searchParams = new URLSearchParams();
  if (params.title) searchParams.set("title", params.title);
  if (params.imageUrl) searchParams.set("image", params.imageUrl);
  if (params.imagePath) searchParams.set("imagePath", params.imagePath);
  if (params.contentType) searchParams.set("contentType", params.contentType);
  if (params.date) searchParams.set("date", params.date);
  if (params.pagePath) searchParams.set("pagePath", params.pagePath);
  if (params.authors && params.authors.length)
    searchParams.set("authors", params.authors.join(", "));

  // Match frontend: inner query string is URI-encoded into a single `q` param.
  url.searchParams.set("q", encodeURIComponent(searchParams.toString()));
  url.searchParams.set("format", "jpg");
  return url.toString();
}

function toAbsoluteCoverImage(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  // Strapi stores uploaded files with relative paths like /uploads/xxx.png.
  // The Next.js /api/og endpoint requires an absolute URL on an allowlisted
  // host, so rewrite to the public CMS origin here.
  return new URL(url, CMS_PUBLIC_URL).toString();
}

function toCoverImagePath(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/uploads/")) return url;

  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/uploads/")) {
      return parsed.pathname;
    }
  } catch {
    return null;
  }

  return null;
}

function mapContentType(postType: string | null | undefined): string | null {
  // Frontend uses lower-case ids: 'article', 'podcast', 'episode'.
  // Strapi post.type enum is ['Article', 'Episode'].
  if (!postType) return null;
  const normalized = postType.toLowerCase();
  if (normalized === "article") return "article";
  if (normalized === "episode") return "podcast";
  return normalized;
}

function mapPagePath(post: PostLike): string {
  const slug = post.slug || "";
  return mapContentType(post.type) === "podcast"
    ? `/podcasts/${slug}`
    : `/article/${slug}`;
}

function toIsoDate(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  try {
    return new Date(v).toISOString();
  } catch {
    return null;
  }
}

const FETCH_TIMEOUT_MS = 30_000;

async function fetchOgJpeg(ogUrl: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ogUrl, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(
        `[og-image] Upstream /api/og responded ${res.status} ${res.statusText}`
      );
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(
        `[og-image] Upstream /api/og timed out after ${FETCH_TIMEOUT_MS}ms`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getOrCreateOgFolder(): Promise<number | null> {
  try {
    const existing = await strapi.db
      .query("plugin::upload.folder")
      .findOne({ where: { name: "thumbnails", parent: null } });
    if (existing) return existing.id as number;

    const created = await strapi
      .plugin("upload")
      .service("folder")
      .create({ name: "thumbnails", parent: null });
    return created.id as number;
  } catch (e) {
    strapi.log.warn(
      `[og-image] Could not get/create thumbnails folder: ${
        (e as Error).message
      }. Uploading to root.`
    );
    return null;
  }
}

async function uploadJpegToStrapi(params: {
  buffer: Buffer;
  fileName: string;
  folderId?: number | null;
}): Promise<{ id: number }> {
  const { buffer, fileName } = params;

  // Strapi v4.16 upload service consumes formidable-v1 shaped file
  // objects (verified against
  // node_modules/@strapi/plugin-upload/server/services/upload.js
  // `enhanceAndValidateFile`):
  //   file.name   → used as filename for extension + slug
  //   file.type   → used as mime
  //   file.size   → used for size-in-KB
  //   file.path   → opened via fs.createReadStream
  // Using modern `originalFilename`/`mimetype`/`filepath` WOULD silently
  // produce undefined and crash inside path.extname. Keep this shape.
  //
  // The upload service also mutates the file object to attach
  // `tmpWorkingDirectory`, and rimrafs that directory at the end — it is
  // NOT the same as our temp file, so our cleanup below is still needed.
  const tmpPath = path.join(
    os.tmpdir(),
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${fileName}`
  );
  await fs.writeFile(tmpPath, buffer as unknown as Uint8Array);

  try {
    const uploaded = await strapi
      .plugin("upload")
      .service("upload")
      .upload({
        data: {
          fileInfo: {
            name: fileName,
            alternativeText: fileName,
            caption: "",
            ...(params.folderId != null ? { folder: params.folderId } : {}),
          },
        },
        files: {
          path: tmpPath,
          name: fileName,
          type: "image/jpeg",
          size: buffer.length,
        } as any,
      });

    const first = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (!first || typeof first.id !== "number") {
      throw new Error("[og-image] Upload plugin returned no file id");
    }
    return { id: first.id };
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

async function deleteStrapiFile(id: number): Promise<void> {
  try {
    const existing = await strapi
      .plugin("upload")
      .service("upload")
      .findOne(id);
    if (existing) {
      await strapi.plugin("upload").service("upload").remove(existing);
    }
  } catch (e) {
    strapi.log.warn(
      `[og-image] Failed to delete previous og_image id=${id}: ${
        (e as Error).message
      }`
    );
  }
}

export interface GenerateOptions {
  replacePrevious?: boolean;
}

export async function generateOgImageForPost(
  postId: number,
  options: GenerateOptions = {}
): Promise<{ fileId: number } | null> {
  const post = (await strapi.entityService.findOne("api::post.post", postId, {
    populate: {
      cover_image: true,
      og_image: true,
      authors: { fields: ["name"] },
    },
  })) as PostLike | null;

  if (!post) {
    strapi.log.warn(`[og-image] Post ${postId} not found, skipping`);
    return null;
  }

  const contentType = mapContentType(post.type);
  const pagePath = mapPagePath(post);
  const date =
    toIsoDate(post.publish_date) || toIsoDate(post.createdAt) || null;
  const authors = (post.authors || [])
    .map((a) => (a && a.name ? a.name : null))
    .filter((n): n is string => !!n);

  const ogUrl = buildOgUrl({
    frontendBase: FRONTEND_BASE_URL,
    title: post.title,
    imageUrl: toAbsoluteCoverImage(post.cover_image?.url),
    imagePath: toCoverImagePath(post.cover_image?.url),
    contentType,
    date,
    pagePath,
    authors,
  });

  strapi.log.info(
    `[og-image] Generating for post id=${post.id} slug=${post.slug}`
  );

  const buffer = await fetchOgJpeg(ogUrl);
  const fileName = `og-${post.slug || post.id}.jpg`;

  const previousId = post.og_image?.id ?? null;
  const folderId = await getOrCreateOgFolder();
  const { id: fileId } = await uploadJpegToStrapi({
    buffer,
    fileName,
    folderId,
  });

  await strapi.db.query("api::post.post").update({
    where: { id: post.id },
    data: { og_image: fileId },
  });

  // Delete the previous og_image if it's different from the new one.
  if (options.replacePrevious && previousId && previousId !== fileId) {
    await deleteStrapiFile(previousId);
  }

  const orphans = (await strapi.db.query("plugin::upload.file").findMany({
    where: { name: fileName, id: { $ne: fileId } },
  })) as Array<{ id: number }>;
  for (const orphan of orphans) {
    await deleteStrapiFile(orphan.id);
  }

  strapi.log.info(
    `[og-image] Attached file id=${fileId} to post id=${post.id}`
  );

  return { fileId };
}
