import { v4 as uuidv4 } from 'uuid';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client } from '../../config/r2.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/appError.js';
import { getFileExtension, isAllowedFileType, MAX_FILE_SIZE } from '../../utils/helpers.js';
import { logger } from '../../utils/logger.js';

const BUCKET = env.R2_BUCKET_NAME;
const UPLOAD_EXPIRY = 15 * 60; // 15 minutes
const DOWNLOAD_EXPIRY = 60 * 60; // 1 hour

// ── Generate Upload Signed URL ──

export async function generateUploadUrl(
  folder: string,
  filename: string,
  contentType: string,
  maxSize: number = MAX_FILE_SIZE,
): Promise<{ uploadUrl: string; key: string }> {
  if (!isAllowedFileType(filename)) {
    throw AppError.badRequest('File type not allowed');
  }

  const ext = getFileExtension(filename);
  const key = `${folder}/${uuidv4()}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(r2Client, command, {
    expiresIn: UPLOAD_EXPIRY,
  });

  return { uploadUrl, key };
}

// ── Generate Download Signed URL ──

export async function generateDownloadUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });

  return getSignedUrl(r2Client, command, {
    expiresIn: DOWNLOAD_EXPIRY,
  });
}

// ── Verify File Exists (HEAD) ──

export async function verifyFileExists(key: string): Promise<boolean> {
  try {
    await r2Client.send(new HeadObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }));
    return true;
  } catch {
    return false;
  }
}

// ── Delete File ──

export async function deleteFile(key: string): Promise<void> {
  try {
    await r2Client.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }));
  } catch (error) {
    logger.error(`Failed to delete R2 object: ${key}`, error);
  }
}

// ── Delete Multiple Files ──

export async function deleteFiles(keys: string[]): Promise<void> {
  await Promise.allSettled(keys.map(key => deleteFile(key)));
}

// ── Folder Helpers ──

export const R2Folders = {
  BLUEPRINTS: 'blueprints',
  COSTINGS: 'costings',
  PAYMENT_PROOFS: 'payment-proofs',
  PAYMENT_QR: 'payment-qr',
  RECEIPTS: 'receipts',
  FABRICATION: 'fabrication',
  PROJECT_MEDIA: 'project-media',
  REVISION_REFS: 'revision-refs',
  CASH_PHOTOS: 'cash-photos',
  PROFILE: 'profile',
} as const;
