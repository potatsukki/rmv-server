import { beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ upload: vi.fn(), download: vi.fn(), exists: vi.fn() }));
vi.mock('./upload.service.js', () => ({ generateUploadUrl: storage.upload, generateDownloadUrl: storage.download, verifyFileExists: storage.exists }));
import { getSignedUploadUrl, getSignedDownloadUrl, viewFile } from './upload.controller.js';
import { Role } from '../../utils/constants.js';
const owner = '111111111111111111111111';
const other = '222222222222222222222222';
beforeEach(() => {
  vi.resetAllMocks(); storage.upload.mockResolvedValue({ uploadUrl: 'signed-upload', key: 'image-key' }); storage.download.mockResolvedValue('signed-download');
});
async function invoke(handler: typeof getSignedUploadUrl, userId: string, roles: Role[], body = {}, query = {}) {
  const next = vi.fn(); const res = { json: vi.fn(), redirect: vi.fn() };
  handler({ userId, userRoles: roles, body, query } as never, res as never, next);
  await vi.waitFor(() => expect(next.mock.calls.length + res.json.mock.calls.length + res.redirect.mock.calls.length).toBeGreaterThan(0));
  return { next, res };
}
describe('GCash screenshot and QR access', () => {
  it('places customer uploads inside their own proof folder', async () => {
    await invoke(getSignedUploadUrl, owner, [Role.CUSTOMER], { folder: 'payment-proofs', filename: 'proof.png', contentType: 'image/png' });
    expect(storage.upload).toHaveBeenCalledWith(`payment-proofs/${owner}`, 'proof.png', 'image/png');
  });
  it('refuses uploads into another customer proof folder', async () => {
    const result = await invoke(getSignedUploadUrl, other, [Role.CUSTOMER], { folder: `payment-proofs/${owner}`, filename: 'proof.png', contentType: 'image/png' });
    expect(result.next.mock.calls[0]?.[0]?.statusCode).toBe(403); expect(storage.upload).not.toHaveBeenCalled();
  });
  it.each([[Role.CUSTOMER], [Role.ADMIN], [Role.SALES_STAFF]])('blocks non-owner proof reads for %s', async (...roles) => {
    const result = await invoke(getSignedDownloadUrl, other, roles as Role[], { key: `payment-proofs/${owner}/proof.png` });
    expect(result.next.mock.calls[0]?.[0]?.statusCode).toBe(403); expect(storage.download).not.toHaveBeenCalled();
  });
  it('permits the owner and cashier to read proof', async () => {
    await invoke(getSignedDownloadUrl, owner, [Role.CUSTOMER], { key: `payment-proofs/${owner}/proof.png` });
    await invoke(getSignedDownloadUrl, other, [Role.CASHIER], { key: `payment-proofs/${owner}/proof.png` });
    expect(storage.download).toHaveBeenCalledTimes(2);
  });
  it('blocks access through the image redirect endpoint as well', async () => {
    const result = await invoke(viewFile, other, [Role.CUSTOMER], {}, { key: `payment-proofs/${owner}/proof.png` });
    expect(result.next.mock.calls[0]?.[0]?.statusCode).toBe(403); expect(result.res.redirect).not.toHaveBeenCalled();
  });
  it('allows QR upload only for administrators and only for images', async () => {
    const rejected = await invoke(getSignedUploadUrl, owner, [Role.CUSTOMER], { folder: 'gcash-qr', filename: 'qr.png', contentType: 'image/png' });
    expect(rejected.next.mock.calls[0]?.[0]?.statusCode).toBe(403);
    await invoke(getSignedUploadUrl, owner, [Role.ADMIN], { folder: 'gcash-qr', filename: 'qr.png', contentType: 'image/png' });
    expect(storage.upload).toHaveBeenCalledWith('gcash-qr', 'qr.png', 'image/png');
    const invalid = await invoke(getSignedUploadUrl, owner, [Role.ADMIN], { folder: 'gcash-qr', filename: 'qr.svg', contentType: 'image/svg+xml' });
    expect(invalid.next.mock.calls[0]?.[0]?.statusCode).toBe(400);
  });
});
