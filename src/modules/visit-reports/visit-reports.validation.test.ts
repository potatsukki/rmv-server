import { describe, expect, it } from 'vitest';

import { updateVisitReportSchema } from './visit-reports.validation.js';

describe('updateVisitReportSchema selected design image', () => {
  it('accepts catalog-owned local image paths', () => {
    const result = updateVisitReportSchema.parse({
      selectedDesignTemplateImageUrl: '/landing/services/gates/sample.png',
    });

    expect(result.selectedDesignTemplateImageUrl).toBe('/landing/services/gates/sample.png');
  });

  it.each([
    'https://tracker.example/design.png',
    '//tracker.example/design.png',
    '/\\tracker.example/design.png',
    '/uploads/customer-supplied.png',
  ])('rejects non-local design image path %s', (imageUrl) => {
    expect(() => updateVisitReportSchema.parse({
      selectedDesignTemplateImageUrl: imageUrl,
    })).toThrow('Selected design image must use a local catalog path');
  });
});
