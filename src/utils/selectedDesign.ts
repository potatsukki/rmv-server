export function isSafeLocalCatalogImagePath(value: string): boolean {
  if (/[\\\u0000-\u001F\u007F]/.test(value)) return false;
  return value.startsWith('/landing/') && !value.startsWith('//');
}
