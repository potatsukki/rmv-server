import { z } from 'zod';

export const signedUploadUrlSchema = z.object({
  folder: z.string().min(1, 'Folder is required'),
  filename: z.string().min(1, 'Filename is required'),
  contentType: z.string().min(1, 'Content type is required'),
});

export const signedDownloadUrlSchema = z.object({
  key: z.string().min(1, 'Object key is required'),
});

export const verifyUploadSchema = z.object({
  key: z.string().min(1, 'Object key is required'),
});

export const viewFileQuerySchema = z.object({
  key: z.string().min(1, 'Object key is required'),
});
