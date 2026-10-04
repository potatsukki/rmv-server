import { Request, Response } from 'express';
import * as UploadService from './upload.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { Role } from '../../utils/constants.js';
import { AppError } from '../../utils/appError.js';

async function assertGcashFileAccess(key: string, userId: string, roles: Role[]) {
  const owner = /^payment-proofs\/([a-f\d]{24})\//i.exec(key)?.[1];
  if (owner && owner !== userId && !roles.includes(Role.CASHIER)) throw AppError.forbidden('Payment proof access denied');
}

export const getSignedUploadUrl = asyncHandler(async (req: Request, res: Response) => {
  const { folder, filename, contentType } = req.body;
  let scopedFolder = folder;
  if (folder.startsWith('payment-proofs')) {
    if (!req.userRoles!.includes(Role.CUSTOMER) || !['payment-proofs', `payment-proofs/${req.userId}`].includes(folder)) throw AppError.forbidden('Payment proof upload denied');
    scopedFolder = `payment-proofs/${req.userId}`;
  }
  if (folder.startsWith('gcash-qr')) {
    if (folder !== 'gcash-qr' || !req.userRoles!.includes(Role.ADMIN)) throw AppError.forbidden('Only administrators can upload the GCash QR');
  }
  if ((folder.startsWith('payment-proofs') || folder.startsWith('gcash-qr')) &&
      (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType) || !/\.(png|jpe?g|webp)$/i.test(filename))) throw AppError.badRequest('Upload a PNG, JPEG, or WebP image');
  const result = await UploadService.generateUploadUrl(scopedFolder, filename, contentType);
  res.json({ success: true, data: result });
});

export const getSignedDownloadUrl = asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.body;
  await assertGcashFileAccess(key, req.userId!, req.userRoles!);
  const downloadUrl = await UploadService.generateDownloadUrl(key);
  res.json({ success: true, data: { downloadUrl } });
});

export const verifyUpload = asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.body;
  await assertGcashFileAccess(key, req.userId!, req.userRoles!);
  const exists = await UploadService.verifyFileExists(key);
  res.json({ success: true, data: { exists } });
});

export const viewFile = asyncHandler(async (req: Request, res: Response) => {
  const key = req.query.key as string;
  await assertGcashFileAccess(key, req.userId!, req.userRoles!);
  const downloadUrl = await UploadService.generateDownloadUrl(key);
  res.redirect(downloadUrl);
});
