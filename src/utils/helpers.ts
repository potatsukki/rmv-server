import crypto from 'crypto';

/**
 * Generate a numeric OTP of specified length.
 */
export function generateOtp(length = 6): string {
  const digits = '0123456789';
  let otp = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    otp += digits[bytes[i] % 10];
  }
  return otp;
}

/**
 * Format Philippine Peso currency
 */
export function formatCurrency(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Generate receipt number: RMV-YYYY-NNNNN
 */
export function generateReceiptNumber(year: number, seq: number): string {
  return `RMV-${year}-${String(seq).padStart(5, '0')}`;
}

/**
 * Validate Philippine mobile number (+63 9XX format)
 */
export function isValidPHMobile(phone: string): boolean {
  return /^\+639\d{9}$/.test(phone);
}

/**
 * Allowed upload file extensions
 */
export const ALLOWED_FILE_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'] as const;
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
export const MAX_COMPRESSED_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB target after compression

/**
 * Get file extension from filename
 */
export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Validate file type
 */
export function isAllowedFileType(filename: string): boolean {
  const ext = getFileExtension(filename);
  return (ALLOWED_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Validate file type is PDF only
 */
export function isPdf(filename: string): boolean {
  return getFileExtension(filename) === 'pdf';
}
