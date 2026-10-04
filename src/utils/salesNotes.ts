// Keep handwritten text; remove whole paragraphs produced by the old catalog defaults.
export function cleanSalesNotes(value?: string | null): string {
  const catalog = /^.+ selected from the RMV design catalog\. .+ Confirm final measurements, material grade, finish, mounting details, and customer-requested changes before fabrication\.$/;
  const reference = /^.+ selected as starting reference\. Confirm final measurements, material grade, finish, mounting details, and custom changes with the customer\.$/;
  return (value || '').split(/\r?\n/)
    .filter((line) => !catalog.test(line.trim()) && !reference.test(line.trim()))
    .join('\n').trim();
}

export function combineSalesNotes(...values: Array<string | null | undefined>): string {
  return [...new Set(values.map(cleanSalesNotes).filter(Boolean))].join('\n\n');
}
