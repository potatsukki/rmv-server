import { Request, Response } from 'express';
import * as UploadService from './upload.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const getSignedUploadUrl = asyncHandler(async (req: Request, res: Response) => {
  const { folder, filename, contentType } = req.body;
  const result = await UploadService.generateUploadUrl(folder, filename, contentType);
  res.json({ success: true, data: result });
});

export const getSignedDownloadUrl = asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.body;
  const downloadUrl = await UploadService.generateDownloadUrl(key);
  res.json({ success: true, data: { downloadUrl } });
});

export const verifyUpload = asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.body;
  const exists = await UploadService.verifyFileExists(key);
  res.json({ success: true, data: { exists } });
});

export const viewFile = asyncHandler(async (req: Request, res: Response) => {
  const key = req.query.key as string;
  const downloadUrl = await UploadService.generateDownloadUrl(key);
  res.redirect(downloadUrl);
});
