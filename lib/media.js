/**
 * Restoring the images and files an exported Session log references, and
 * rewriting the log's references to whatever the attachment store returns.
 *
 * The archive stores attachments content-addressed under the id the log
 * references, so a faithful round trip normally reproduces the same id. Images
 * are re-normalized on save, which can legitimately mint a different id; every
 * reference is therefore rewritten from the stored result instead of assumed
 * equal.
 * @module dsh-session-restore/media
 */
import { createHash } from 'node:crypto';
import { attachmentBlocksOfEvent } from './archive.js';

/** One attachment entry scheduled for restore. */
/**
 * @typedef {object} PlannedAttachment
 * @property {string} zipPath - archive entry path.
 * @property {string} attachmentId - id the archive recorded.
 * @property {string} fileName - entry basename.
 * @property {import('./zip.js').ZipEntry} entry - entry to read.
 * @property {string} [mediaType] - image media type.
 * @property {string} [name] - file display name.
 */

/**
 * Decide which attachments to restore and which references the archive cannot
 * satisfy.
 * @param {object} archive - archive model from `readSessionArchive`.
 * @param {{ images: Set<string>, files: Set<string> }} referenced - ids the logs reference.
 * @returns {{ images: PlannedAttachment[], files: PlannedAttachment[], missingImages: string[], missingFiles: string[], unreferencedImages: number, unreferencedFiles: number }} the plan.
 */
export function planAttachments(archive, referenced) {
  const images = [];
  const files = [];
  const missingImages = [];
  const missingFiles = [];
  let unreferencedImages = 0;
  let unreferencedFiles = 0;
  const byId = new Set();
  for (const item of archive.media) {
    byId.add(item.attachmentId);
    if (!referenced.images.has(item.attachmentId)) {
      unreferencedImages += 1;
      continue;
    }
    images.push({
      zipPath: item.entry.name,
      attachmentId: item.attachmentId,
      fileName: item.fileName,
      entry: item.entry,
      mediaType: item.mediaType,
    });
  }
  const filesById = new Map();
  for (const item of archive.files) {
    const id = `sha256:${String(item.digest).replace(/^sha256:/u, '')}`;
    filesById.set(id, item);
    if (!referenced.files.has(id)) {
      unreferencedFiles += 1;
      continue;
    }
    files.push({
      zipPath: item.entry.name,
      attachmentId: id,
      fileName: item.fileName,
      entry: item.entry,
      name: item.fileName,
    });
  }
  for (const id of referenced.images) if (!byId.has(id)) missingImages.push(id);
  for (const id of referenced.files) if (!filesById.has(id)) missingFiles.push(id);
  return { images, files, missingImages, missingFiles, unreferencedImages, unreferencedFiles };
}

/**
 * Restore every planned attachment through the attachment seam.
 * @param {object} attachments - the mounted `attachments` service.
 * @param {import('./zip.js').ZipFile} zip - opened archive.
 * @param {ReturnType<typeof planAttachments>} plan - attachment plan.
 * @param {{ maxEntryBytes?: number, signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options] - read limits and progress.
 * @returns {Promise<{ images: Map<string, object>, files: Map<string, object>, warnings: string[], restored: number }>} id rewrites per media kind.
 */
export async function restoreAttachments(attachments, zip, plan, options = {}) {
  const { maxEntryBytes = 256 * 1024 * 1024, signal, onProgress } = options;
  const images = new Map();
  const files = new Map();
  const warnings = [];
  const total = plan.images.length + plan.files.length;
  let done = 0;
  for (const item of plan.images) {
    signal?.throwIfAborted();
    const bytes = await zip.read(item.entry, { maxBytes: maxEntryBytes });
    try {
      const ref = await attachments.saveImage({ data: bytes, mediaType: item.mediaType, name: item.fileName });
      images.set(item.attachmentId, ref);
      if (ref.attachmentId !== item.attachmentId) {
        warnings.push(`image ${item.attachmentId} was re-normalized to ${ref.attachmentId}`);
      }
    } catch (error) {
      warnings.push(`image ${item.attachmentId} could not be stored (${describe(error)}); its references stay unresolved`);
    }
    done += 1;
    onProgress?.(done, total);
  }
  for (const item of plan.files) {
    signal?.throwIfAborted();
    const bytes = await zip.read(item.entry, { maxBytes: maxEntryBytes });
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== item.attachmentId) {
      warnings.push(`file ${item.fileName} does not match its recorded digest ${item.attachmentId}`);
    }
    try {
      const ref = await attachments.saveFileStream({ data: singleChunk(bytes), name: item.name, signal });
      files.set(item.attachmentId, ref);
      if (ref.attachmentId !== digest) warnings.push(`file ${item.fileName} was stored as ${ref.attachmentId}`);
    } catch (error) {
      warnings.push(`file ${item.fileName} could not be stored (${describe(error)}); its references stay unresolved`);
    }
    done += 1;
    onProgress?.(done, total);
  }
  return { images, files, warnings, restored: images.size + files.size };
}

/**
 * Rewrite every attachment reference a log carries to the stored reference.
 * @param {object[]} logs - parsed logs (mutated in place).
 * @param {{ images: Map<string, object>, files: Map<string, object> }} maps - stored references by archive id.
 * @returns {{ rewritten: number, unresolved: number }} rewrite counts.
 */
export function remapAttachmentRefs(logs, maps) {
  let rewritten = 0;
  let unresolved = 0;
  for (const log of logs) {
    for (const event of log.events) {
      for (const block of attachmentBlocksOfEvent(event)) {
        const map = block.type === 'image' ? maps.images : maps.files;
        const stored = map.get(block.attachment.attachmentId);
        if (stored === undefined) {
          unresolved += 1;
          continue;
        }
        if (stored.attachmentId === block.attachment.attachmentId) continue;
        block.attachment = { ...stored };
        rewritten += 1;
      }
    }
  }
  return { rewritten, unresolved };
}

/**
 * An async iterable yielding one buffer, for APIs that require a chunk stream.
 * @param {Uint8Array} bytes - the bytes to yield.
 * @returns {AsyncGenerator<Uint8Array>} the single-chunk stream.
 */
async function* singleChunk(bytes) {
  yield bytes;
}

/**
 * A one-line description of a caught value.
 * @param {unknown} error - caught value.
 * @returns {string} the description.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
