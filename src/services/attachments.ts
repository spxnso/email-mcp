/**
 * Outbound attachment preparation — pure, no MCP or SMTP dependency.
 *
 * Stats every file BEFORE anything is read into memory, and enforces the
 * configured cap against the base64-ENCODED size (raw × 4/3), because that is
 * what the SMTP server actually receives; a 20 MB file inside a 25 MB limit
 * still bounces as ~27 MB on the wire. Rejections list every file with its
 * size so the caller can see exactly what to trim instead of decoding an
 * opaque SMTP 552 later.
 *
 * spxnso patch (2026-11-15): an attachment may also be given as inline base64
 * `content` (with a required `filename`). This exists for remote/MCP clients
 * (the server runs in a container, the client elsewhere) that share no
 * filesystem with the server. Base64 entries are decoded once, written to a
 * per-call temp directory, then follow the exact same size-cap and cid /
 * contentType handling as filesystem attachments.
 */

import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { AttachmentMeta } from '../types/index.js';

/**
 * An attachment request: a bare path, a path with inline/cid metadata, or
 * inline base64 content for remote clients without filesystem access.
 */
export interface AttachmentInput {
  /** Local file path — mutually exclusive with `content`. */
  path?: string;
  /**
   * Base64-encoded file content — mutually exclusive with `path`. Lets a
   * remote client attach a file even though it cannot write to the server's
   * filesystem.
   */
  content?: string;
  /**
   * Override the filename shown to the recipient. Required with `content`
   * (there is no path to derive a name from); defaults to the file basename
   * with `path`.
   */
  filename?: string;
  /** Content-ID — the HTML body references the file as src="cid:<cid>". */
  cid?: string;
  /** Explicit MIME type when the file extension would misdetect. */
  contentType?: string;
}

export interface PreparedAttachment {
  filename: string;
  path: string;
  size: number;
  cid?: string;
  contentType?: string;
}

export interface PreparedAttachments {
  attachments: PreparedAttachment[];
  totalBytes: number;
  totalEncodedBytes: number;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render an email's attachment list for a tool response.
 *
 * The part id is the point. `download_attachment` accepts a filename or a
 * partId and tells the caller to read partIds from `get_email`, but nothing
 * ever printed them — and for the case the docs single out, inline `cid:`
 * images, the filename selector cannot work at all: such parts rarely carry a
 * name parameter, so extractAttachments falls back to 'unnamed' and every one
 * of them collides. The cid is shown for the same reason, since that is what
 * an `<img src="cid:…">` in the body refers to.
 */
export function describeAttachments(attachments: AttachmentMeta[]): string {
  return attachments
    .map((a) => {
      const facts = [a.mimeType, formatSize(a.size)];
      if (a.partId !== undefined) facts.push(`partId ${a.partId}`);
      if (a.inline) facts.push(a.contentId ? `inline cid:${a.contentId}` : 'inline');
      else if (a.contentId) facts.push(`cid:${a.contentId}`);
      return `${a.filename} (${facts.join(', ')})`;
    })
    .join(', ');
}

export async function prepareAttachments(
  paths: (string | AttachmentInput)[],
  maxTotalMb: number,
): Promise<PreparedAttachments> {
  const attachments: PreparedAttachment[] = [];
  let tmpDir: string | undefined;

  for (const entry of paths) {
    const spec = typeof entry === 'string' ? { path: entry } : entry;

    // spxnso patch: inline base64 content — decoded once, written to a
    // per-call temp directory, then treated like any other file below.
    if (spec.content !== undefined) {
      if (spec.path !== undefined) {
        throw new Error('Attachment: provide either path or content (base64), not both');
      }
      if (!spec.filename) {
        throw new Error('Attachment: filename is required when content (base64) is used');
      }
      const buffer = Buffer.from(spec.content, 'base64');
      if (buffer.length === 0) {
        throw new Error(`Attachment is empty: ${spec.filename}`);
      }
      tmpDir ??= await mkdtemp(join(tmpdir(), 'email-mcp-attach-'));
      // basename() keeps the temp write inside the temp directory even if the
      // caller tries a name with path separators.
      const tmpPath = join(tmpDir, basename(spec.filename));
      await writeFile(tmpPath, buffer);
      attachments.push({
        filename: spec.filename,
        path: tmpPath,
        size: buffer.length,
        ...(spec.cid ? { cid: spec.cid } : {}),
        ...(spec.contentType ? { contentType: spec.contentType } : {}),
      });
      continue;
    }

    if (spec.path === undefined) {
      throw new Error('Attachment: path or content (base64) is required');
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(spec.path);
    } catch {
      throw new Error(`Attachment not found: ${spec.path}`);
    }
    if (!info.isFile()) {
      throw new Error(`Attachment is not a file: ${spec.path}`);
    }
    attachments.push({
      filename: spec.filename ?? basename(spec.path),
      path: spec.path,
      size: info.size,
      ...(spec.cid ? { cid: spec.cid } : {}),
      ...(spec.contentType ? { contentType: spec.contentType } : {}),
    });
  }

  const totalBytes = attachments.reduce((sum, a) => sum + a.size, 0);
  const totalEncodedBytes = Math.ceil(totalBytes / 3) * 4; // base64 wire size

  const maxBytes = maxTotalMb * 1024 * 1024;
  if (totalEncodedBytes > maxBytes) {
    const table = attachments.map((a) => `  - ${a.filename}: ${formatSize(a.size)}`).join('\n');
    throw new Error(
      `Attachments exceed the ${maxTotalMb} MB send limit: ` +
        `${formatSize(totalBytes)} raw ≈ ${formatSize(totalEncodedBytes)} base64-encoded.\n${table}\n` +
        `Raise [settings.send] max_attachment_mb (or MCP_EMAIL_SEND_MAX_ATTACHMENT_MB in env mode) if the provider allows more.`,
    );
  }

  return { attachments, totalBytes, totalEncodedBytes };
}
