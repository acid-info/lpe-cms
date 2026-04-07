/**
 * og-image service
 *
 * Generates and stores a pre-rendered Open Graph image for a post by
 * calling the Next.js frontend's /api/og endpoint (which uses
 * @vercel/og + sharp to produce a compact JPEG) and uploading the
 * result into Strapi's media library, then attaching it to the post's
 * `og_image` field.
 *
 * Why pre-generate?
 *   X (Twitterbot) frequently fails to fetch the dynamic /api/og route
 *   because of cold start + WASM init + remote cover_image fetch time
 *   budgets. Storing a static JPEG in the CMS bypasses all of that.
 *
 * The og URL shape MUST match press.logos.co/src/utils/og.utils.ts
 * (source of truth). Keep these two files in sync.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * Infrastructure URLs.
 *
 * The production deployment does not support adding new environment
 * variables, so the defaults are hardcoded production URLs. The service
 * still honors env overrides when present — this exists purely so that
 * `yarn develop` locally can point at a dev Next.js (e.g. localhost:3000)
 * and a dev Strapi (e.g. localhost:1337) without any code change. In
 * production no env vars are set, the hardcoded defaults are used, and
 * behavior is identical to the fully hardcoded version.
 *
 * Both production URLs are mirrored in the frontend allowlist
 * (press.logos.co/src/pages/api/og.tsx ALLOWED_IMAGE_HOSTS). If either
 * domain moves, update this file AND the frontend allowlist together.
 */
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

function mapContentType(
  postType: string | null | undefined
): string | null {
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

async function fetchOgJpeg(ogUrl: string): Promise<Buffer> {
  const res = await fetch(ogUrl);
  if (!res.ok) {
    throw new Error(
      `[og-image] Upstream /api/og responded ${res.status} ${res.statusText}`
    );
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function uploadJpegToStrapi(params: {
  buffer: Buffer;
  fileName: string;
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
  await fs.writeFile(tmpPath, buffer);

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
    const existing = await strapi.plugin("upload").service("upload").findOne(id);
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
  /**
   * When true, removes the previously attached og_image file after
   * successfully attaching the new one. Keeps the media library tidy.
   */
  replacePrevious?: boolean;
}

/**
 * Generate a pre-rendered OG image JPEG for the given post and attach
 * it to the post's og_image field.
 *
 * This function ALWAYS regenerates — it does not skip based on the
 * presence of an existing og_image. Callers are responsible for deciding
 * whether regeneration is needed:
 *   - Lifecycle hooks call this when an invalidating field changed.
 *   - The backfill script filters out posts that already have an og_image
 *     (unless run with --force).
 *
 * Errors are thrown. Callers should wrap in try/catch so a failure
 * never blocks the underlying save operation.
 */
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
  const { id: fileId } = await uploadJpegToStrapi({ buffer, fileName });

  // Persist the og_image relation.
  //
  // IMPORTANT: `strapi.db.query(...).update()` does NOT bypass lifecycle
  // hooks — it re-invokes `beforeUpdate`/`afterUpdate` via
  // `db.lifecycles.run(...)` (verified in
  // node_modules/@strapi/database/dist/index.js update(...)). Recursion
  // is instead prevented by the content-type lifecycle hook in
  // ../content-types/post/lifecycles.ts, which returns early when the
  // only key in `event.params.data` is `og_image`. That guard relies on
  // this service passing EXACTLY `{ og_image: fileId }` — do not add
  // sibling fields to the update payload here.
  //
  // The query engine's `updateRelations` correctly writes to the media
  // morph table (files_related_morphs) for morphOne attributes, so a
  // plain numeric fileId is all that is needed.
  await strapi.db.query("api::post.post").update({
    where: { id: post.id },
    data: { og_image: fileId },
  });

  if (options.replacePrevious && previousId && previousId !== fileId) {
    await deleteStrapiFile(previousId);
  }

  strapi.log.info(
    `[og-image] Attached file id=${fileId} to post id=${post.id}`
  );

  return { fileId };
}
