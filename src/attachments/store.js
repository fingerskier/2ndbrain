import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Map of common MIME types to file extensions.
 * Falls back to the MIME subtype or "bin" for unknown types.
 */
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/octet-stream': 'bin',
};

/**
 * Derive a file extension from a MIME type string.
 *
 * @param {string|undefined} mimeType
 * @returns {string} File extension without leading dot.
 */
function extFromMime(mimeType) {
  if (!mimeType) return 'bin';
  return MIME_TO_EXT[mimeType] || mimeType.split('/').pop() || 'bin';
}

/**
 * Attachment store -- downloads Telegram file attachments, saves them to
 * a date-organized directory tree under $DATA_DIR/attachments/, and records
 * metadata in the attachments database table (spec section 8).
 */
class AttachmentStore {
  /**
   * @param {object} deps
   * @param {object} deps.db     - Database query interface ({ query(sql, params) }).
   * @param {object} deps.bot    - Telegram bot adapter ({ downloadFile(fileId): Promise<Buffer> }).
   * @param {object} deps.config - Application configuration (needs DATA_DIR).
   * @param {object} deps.logger - Logger instance.
   */
  constructor({ db, bot, config, logger }) {
    this.db = db;
    this.bot = bot;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Download a Telegram attachment, persist it to disk, and insert a
   * database record.
   *
   * Storage path: $DATA_DIR/attachments/YYYY/MM/DD/{uuid}.{ext}
   *
   * @param {object} attachment - Telegram attachment metadata.
   * @param {string} attachment.file_id       - Telegram file identifier.
   * @param {string} [attachment.mime_type]    - MIME type of the file.
   * @param {number} [attachment.file_size]    - File size in bytes.
   * @param {number} messageId - ID of the parent conversation_messages row.
   * @returns {Promise<{ id: number, filePath: string, mimeType: string|null, fileSize: number }>}
   */
  async save(attachment, messageId) {
    const { file_id: fileId, mime_type: mimeType, file_size: fileSize } = attachment;

    // 1. Download the file from Telegram
    const fileBuffer = await this.bot.downloadFile(fileId);

    // 2. Build the date-organized storage path
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const ext = extFromMime(mimeType);
    const filename = `${crypto.randomUUID()}.${ext}`;

    const relativeDir = path.join('attachments', year, month, day);
    const absoluteDir = path.join(this.config.DATA_DIR, relativeDir);
    const relativePath = path.join(relativeDir, filename);
    const absolutePath = path.join(absoluteDir, filename);

    // 3. Create directory structure if needed
    fs.mkdirSync(absoluteDir, { recursive: true });

    // 4. Save the file to disk
    fs.writeFileSync(absolutePath, fileBuffer);

    const actualSize = fileSize ?? fileBuffer.length;

    // 5. Insert record into the attachments table
    const result = await this.db.query(
      `INSERT INTO attachments (message_id, telegram_file_id, mime_type, file_path, file_size)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [messageId, fileId, mimeType || null, relativePath, actualSize],
    );

    const record = {
      id: result.rows[0].id,
      filePath: relativePath,
      mimeType: mimeType || null,
      fileSize: actualSize,
    };

    this.logger.info(
      'attachments',
      `Saved attachment ${record.id}: ${relativePath} (${actualSize} bytes)`,
    );

    // 6. Return the attachment record
    return record;
  }

  /**
   * Retrieve all attachment records associated with a conversation message.
   *
   * @param {number} messageId - ID of the conversation_messages row.
   * @returns {Promise<Array<{
   *   id: number,
   *   filePath: string,
   *   mimeType: string|null,
   *   fileSize: number,
   *   telegramFileId: string|null,
   *   createdAt: Date
   * }>>}
   */
  async getByMessageId(messageId) {
    const result = await this.db.query(
      `SELECT id, file_path, mime_type, file_size, telegram_file_id, created_at
       FROM attachments
       WHERE message_id = $1
       ORDER BY created_at ASC`,
      [messageId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      filePath: row.file_path,
      mimeType: row.mime_type,
      fileSize: row.file_size,
      telegramFileId: row.telegram_file_id,
      createdAt: row.created_at,
    }));
  }
}

export { AttachmentStore };
export default AttachmentStore;
