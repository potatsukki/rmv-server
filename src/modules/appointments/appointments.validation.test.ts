import { describe, expect, it } from 'vitest';
import { appointmentQueueQuerySchema, requestAppointmentSchema } from './appointments.validation.js';

const validAppointmentRequest = {
  type: 'office',
  date: '2026-09-01',
  slotCode: '09:00',
};

describe('requestAppointmentSchema selected design', () => {
  it('accepts a local selected-design image reference', () => {
    const selectedDesignTemplateImageUrl = '/landing/services/railings/sample.png';
    const parsed = requestAppointmentSchema.parse({
      ...validAppointmentRequest,
      selectedDesignTemplateId: 'railings-commercial-guardrail',
      selectedDesignTemplateName: 'Commercial Stainless Guardrail',
      selectedDesignTemplateImageUrl,
    });

    expect(parsed).toMatchObject({
      selectedDesignTemplateId: 'railings-commercial-guardrail',
      selectedDesignTemplateName: 'Commercial Stainless Guardrail',
      selectedDesignTemplateImageUrl,
    });
  });

  it.each([
    '//cdn.example.com/design.png',
    '/landing\\services\\design.png',
    '/landing/services/design.png\nmalicious',
    'https://cdn.example.com/designs/railing.png',
    'http://cdn.example.com/design.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'javascript:alert(1)',
  ])('rejects a non-catalog selected-design image reference: %s', (selectedDesignTemplateImageUrl) => {
    expect(() => requestAppointmentSchema.parse({
      ...validAppointmentRequest,
      selectedDesignTemplateImageUrl,
    })).toThrow('Selected design image must use a local catalog path');
  });

  it('enforces the selected-design identifier and name limits', () => {
    expect(() => requestAppointmentSchema.parse({
      ...validAppointmentRequest,
      selectedDesignTemplateId: 'x'.repeat(101),
    })).toThrow();
    expect(() => requestAppointmentSchema.parse({
      ...validAppointmentRequest,
      selectedDesignTemplateName: 'x'.repeat(201),
    })).toThrow();
  });
});

describe('appointmentQueueQuerySchema', () => {
  it('coerces numeric limit and keeps status/search filters', () => {
    const parsed = appointmentQueueQuerySchema.parse({
      status: 'requested,ready_for_ocular',
      search: 'garcia',
      limit: '50',
    });

    expect(parsed).toEqual({
      status: 'requested,ready_for_ocular',
      search: 'garcia',
      limit: 50,
    });
  });

  it('uses default limit when omitted', () => {
    const parsed = appointmentQueueQuerySchema.parse({});
    expect(parsed.limit).toBe(120);
  });

  it('rejects limits above max', () => {
    expect(() => appointmentQueueQuerySchema.parse({ limit: 201 })).toThrow();
  });
});
