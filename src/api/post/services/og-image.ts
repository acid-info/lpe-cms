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

/**
 * Strapi v4.16 upload service consumes formidable-v1 shaped file objects
 * (verified against
 * node_modules/@strapi/plugin-upload/server/services/upload.js
 * `enhanceAndValidateFile`):
 *   file.name → filename used for extension + slug
 *   file.type → mime
 *   file.size → size-in-KB
 *   file.path → opened via fs.createReadStream
 * Using modern `originalFilename`/`mimetype`/`filepath` WOULD silently produce
 * undefined and crash inside path.extname. Keep this shape.
 *
 * Writes the buffer to a temp file, hands a correctly-shaped payload to `fn`,
 * and always removes the temp file afterwards. (The upload service also creates
 * its own `tmpWorkingDirectory` and rimrafs that separately — it is NOT our
 * temp file, so this cleanup is still required.)
 */
async function withTmpJpeg<T>(
  buffer: Buffer,
  fileName: string,
  fn: (file: {
    path: string;
    name: string;
    type: string;
    size: number;
  }) => Promise<T>
): Promise<T> {
  const tmpPath = path.join(
    os.tmpdir(),
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${fileName}`
  );
  await fs.writeFile(tmpPath, buffer as unknown as Uint8Array);

  try {
    return await fn({
      path: tmpPath,
      name: fileName,
      type: "image/jpeg",
      size: buffer.length,
    });
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

async function uploadJpegToStrapi(params: {
  buffer: Buffer;
  fileName: string;
  folderId?: number | null;
}): Promise<{ id: number }> {
  const { buffer, fileName, folderId } = params;

  return withTmpJpeg(buffer, fileName, async (file) => {
    const uploaded = await strapi
      .plugin("upload")
      .service("upload")
      .upload({
        data: {
          fileInfo: {
            name: fileName,
            alternativeText: fileName,
            caption: "",
            ...(folderId != null ? { folder: folderId } : {}),
          },
        },
        files: file as any,
      });

    const first = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (!first || typeof first.id !== "number") {
      throw new Error("[og-image] Upload plugin returned no file id");
    }
    return { id: first.id };
  });
}

/**
 * Overwrites an existing media-library file in place. Strapi's `replace`
 * deliberately keeps the original hash + extension (see
 * plugin-upload/server/services/upload.js), so the public URL does NOT change.
 * That is what keeps already-shared social cards (X, LinkedIn, Discord, …) and
 * any cached page from breaking whenever an article is re-published.
 * Returns false if the file record no longer exists.
 */
async function replaceJpegInStrapi(
  fileId: number,
  buffer: Buffer,
  fileName: string
): Promise<boolean> {
  const uploadService = strapi.plugin("upload").service("upload");
  const existing = await uploadService.findOne(fileId);
  if (!existing) return false;

  // Preserve the file's existing folder so `replace` doesn't relocate it.
  const folder =
    existing.folder && typeof existing.folder === "object"
      ? (existing.folder as { id?: number }).id
      : (existing.folder as number | null | undefined);

  await withTmpJpeg(buffer, fileName, async (file) => {
    await uploadService.replace(fileId, {
      data: {
        fileInfo: {
          name: fileName,
          alternativeText: fileName,
          caption: "",
          ...(folder != null ? { folder } : {}),
        },
      },
      file: file as any,
    });
  });

  return true;
}

/**
 * Serializes OG generation per post id within this process. A normal Strapi
 * publish fires several updates in quick succession; previously these raced —
 * concurrent runs could delete the very file the post had just been pointed at,
 * leaving `og_image` referencing a deleted file (the "image not found" bug).
 * Queuing per post id makes each run observe the previous run's result.
 */
const inFlightByPost = new Map<number, Promise<unknown>>();

function withPostLock<T>(postId: number, fn: () => Promise<T>): Promise<T> {
  const prev = inFlightByPost.get(postId) ?? Promise.resolve();
  const run = prev.then(() => fn());
  // `tracked` never rejects, so the next queued call always proceeds.
  const tracked = run.then(
    () => undefined,
    () => undefined
  );
  inFlightByPost.set(postId, tracked);
  void tracked.finally(() => {
    if (inFlightByPost.get(postId) === tracked) {
      inFlightByPost.delete(postId);
    }
  });
  return run;
}

// Retained for backward compatibility with existing callers (e.g. the backfill
// script). In-place replacement now keeps the URL stable, so there is no longer
// a previous file to delete — `replacePrevious` is accepted but unused.
export interface GenerateOptions {
  replacePrevious?: boolean;
}

export async function generateOgImageForPost(
  postId: number,
  _options: GenerateOptions = {}
): Promise<{ fileId: number } | null> {
  return withPostLock(postId, () => generateOgImageForPostUnlocked(postId));
}

async function generateOgImageForPostUnlocked(
  postId: number
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
  const existingId = post.og_image?.id ?? null;

  // Reuse the existing media file when possible so the public URL never changes
  // across regenerations. This keeps previously-shared social cards working and
  // means there is no old file to delete (no delete race, no orphan cleanup).
  if (existingId != null) {
    const replaced = await replaceJpegInStrapi(existingId, buffer, fileName);
    if (replaced) {
      strapi.log.info(
        `[og-image] Replaced file id=${existingId} in place for post id=${post.id}`
      );
      return { fileId: existingId };
    }
    strapi.log.warn(
      `[og-image] og_image id=${existingId} no longer exists for post id=${post.id}; creating a fresh file`
    );
  }

  // First-time generation (or the previous record was deleted): create once.
  // From here on, future regenerations overwrite this file in place.
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

  strapi.log.info(
    `[og-image] Attached new file id=${fileId} to post id=${post.id}`
  );

  return { fileId };
}
