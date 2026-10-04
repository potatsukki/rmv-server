import { afterEach, describe, expect, it, vi } from 'vitest';
import { r2Client } from '../../config/r2.js';
import { generateDownloadUrl, generateUploadUrl, validatePaymentImage } from './upload.service.js';

afterEach(() => vi.restoreAllMocks());

describe('payment image metadata validation', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'])('accepts %s within the 5 MB limit', async (ContentType) => {
    vi.spyOn(r2Client, 'send').mockResolvedValue({ ContentType, ContentLength: 5 * 1024 * 1024 } as never);
    expect(await validatePaymentImage('payment-proofs/customer/proof.png')).toBe(true);
  });

  it.each([
    { ContentType: 'application/pdf', ContentLength: 100 },
    { ContentType: 'image/svg+xml', ContentLength: 100 },
    { ContentType: 'image/png', ContentLength: 0 },
    { ContentType: 'image/png', ContentLength: 5 * 1024 * 1024 + 1 },
    { ContentLength: 100 },
    { ContentType: 'image/png' },
  ])('rejects unsupported, missing or oversized metadata: %j', async (metadata) => {
    vi.spyOn(r2Client, 'send').mockResolvedValue(metadata as never);
    expect(await validatePaymentImage('payment-proofs/customer/proof.png')).toBe(false);
  });

  it('rejects an object that storage cannot read', async () => {
    vi.spyOn(r2Client, 'send').mockRejectedValue(new Error('Object unavailable'));
    expect(await validatePaymentImage('missing.png')).toBe(false);
  });
});

describe('storage URL signing', () => {
  it('signs a sanitized upload key for 15 minutes without contacting storage', async () => {
    const send = vi.spyOn(r2Client, 'send');
    const result = await generateUploadUrl('payment-proofs/customer', '../../receipt photo.png', 'image/png');
    expect(result.key).toMatch(/^payment-proofs\/customer\/[a-f0-9-]+-_+receipt_photo\.png$/);
    expect(new URL(result.uploadUrl).searchParams.get('X-Amz-Expires')).toBe('900');
    expect(new URL(result.uploadUrl).protocol).toBe('https:');
    expect(send).not.toHaveBeenCalled();
  });

  it('signs a download URL for one hour', async () => {
    const url = await generateDownloadUrl('payment-proofs/customer/proof.png');
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  it('rejects an executable upload filename before signing', async () => {
    await expect(generateUploadUrl('payment-proofs/customer', 'proof.exe', 'application/octet-stream'))
      .rejects.toThrow('File type not allowed');
  });
});
