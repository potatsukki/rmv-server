import { describe, expect, it } from 'vitest';
import { Project } from '../../models/Project.js';
import { ProjectItem } from '../../models/ProjectItem.js';
import { createProjectSchema, scheduleProjectOcularSchema } from './projects.validation.js';
import { DeliveryType } from '../../utils/constants.js';

const customerId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const appointmentId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const details = {
  title: 'Kitchen counter',
  serviceType: 'countertops',
  description: 'Counter with two shelves',
  siteAddress: '123 Project Street',
  contractFileKey: 'contracts/signed-contract.pdf',
};

describe('createProjectSchema', () => {
  it('allows sales to create a project before the fabricator supplies its site address', () => {
    const { siteAddress: _siteAddress, ...withoutAddress } = details;
    const parsed = createProjectSchema.parse({ ...withoutAddress, customerId });
    expect(parsed.siteAddress).toBeUndefined();
    const project = new Project({ ...parsed, projectNumber: 'RMV-2026-0002', salesStaffId: 'cccccccccccccccccccccccc' });
    expect(project.validateSync()).toBeUndefined();
  });

  it('accepts an independent project without an appointment', () => {
    const result = createProjectSchema.parse({ ...details, customerId });
    expect(result.customerId).toBe(customerId);
    expect(result.appointmentId).toBeUndefined();
    expect(result.quantity).toBe(1);
  });

  it('accepts a project without a description', () => {
    const { description: _description, ...withoutDescription } = details;
    const result = createProjectSchema.parse({ ...withoutDescription, customerId });

    expect(result.description).toBeUndefined();
  });

  it('accepts only supported delivery types', () => {
    expect(createProjectSchema.safeParse({ ...details, customerId, deliveryType: DeliveryType.SHOP_FABRICATED }).success).toBe(true);
    expect(createProjectSchema.safeParse({ ...details, customerId, deliveryType: DeliveryType.ON_SITE_INSTALLATION }).success).toBe(true);
    expect(createProjectSchema.safeParse({ ...details, customerId, deliveryType: 'courier' }).success).toBe(false);
  });

  it('accepts an optional appointment link and the legacy appointment-only customer reference', () => {
    expect(createProjectSchema.safeParse({ ...details, customerId, appointmentId }).success).toBe(true);
    expect(createProjectSchema.safeParse({ ...details, appointmentId }).success).toBe(true);
  });

  it('accepts an ocular visit schedule from either project entry point', () => {
    const ocularVisit = { date: '2026-10-08', slotCode: '09:00', customerLocation: { lat: 14.6, lng: 121 } };

    expect(createProjectSchema.safeParse({ ...details, customerId, appointmentId, ocularVisit }).success).toBe(true);
    expect(createProjectSchema.safeParse({ ...details, customerId, ocularVisit }).success).toBe(true);
    expect(createProjectSchema.safeParse({
      ...details,
      customerId,
      appointmentId,
      ocularVisit: { ...ocularVisit, slotCode: '12:30' },
    }).success).toBe(false);
  });

  it.each([undefined, appointmentId])('saves Pending Ocular without final project details, but with its contract (appointment: %s)', (sourceAppointmentId) => {
    const parsed = createProjectSchema.parse({
      customerId,
      appointmentId: sourceAppointmentId,
      contractFileKey: details.contractFileKey,
      ocularVisit: { date: '2026-10-08', slotCode: '09:00', customerLocation: { lat: 14.6, lng: 121 } },
    });
    expect(parsed.contractFileKey).toBe(details.contractFileKey);
    expect(parsed.serviceType).toBeUndefined();
  });

  it.each(['title', 'serviceType'])('allows a For Ocular project without %s (filled in later)', (field) => {
    const input = { ...details, customerId, [field]: undefined };
    expect(createProjectSchema.safeParse(input).success).toBe(true);
  });

  it('rejects a project without a signed contract, with or without an ocular visit', () => {
    const { contractFileKey: _contractFileKey, ...withoutContract } = details;
    const ocularVisit = { date: '2026-10-08', slotCode: '09:00', customerLocation: { lat: 14.6, lng: 121 } };
    for (const input of [{ ...withoutContract, customerId }, { customerId, ocularVisit }, { ...details, customerId, contractFileKey: '' }]) {
      const result = createProjectSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === 'contractFileKey')).toBe(true);
    }
  });

  it('accepts only a PDF, JPG, JPEG, or PNG signed contract', () => {
    for (const key of ['contracts/signed.pdf', 'contracts/signed.JPG', 'contracts/signed.jpeg', 'contracts/signed.png']) {
      expect(createProjectSchema.safeParse({ ...details, customerId, contractFileKey: key }).success).toBe(true);
    }
    expect(createProjectSchema.safeParse({ ...details, customerId, contractFileKey: 'contracts/signed.docx' }).success).toBe(false);
  });

  it('preserves every moved project field through validation and model serialization', () => {
    const movedFields = {
      serviceTypeCustom: 'Custom fabrication',
      measurementUnit: 'cm',
      lineItems: [{ label: 'Left panel', length: 120, width: 40, quantity: 2, notes: 'Corner mounting' }],
      specifications: { measurements: { height: 120 }, materialsDesign: { steelGrade: '304' }, additional: { notes: 'Rounded edges' } },
      preferredDesign: 'Minimalist', customerRequirements: 'Child safe edges',
      initialDesignKeys: ['projects/initial-design/sketch.pdf'], initialDesignNotes: 'Use the attached sketch',
      selectedDesignTemplateId: 'template-1', selectedDesignTemplateName: 'Steel gate', selectedDesignTemplateImageUrl: '/landing/services/gates/sample.jpg',
      photoKeys: ['visit-photos/site.jpg'], videoKeys: ['visit-videos/site.mp4'],
      sketchKeys: ['visit-sketches/sketch.pdf'], referenceImageKeys: ['visit-references/reference.jpg'],
    };
    const parsed = createProjectSchema.parse({ ...details, customerId, ...movedFields });
    expect(parsed).toMatchObject(movedFields);
    const project = new Project({ ...parsed, projectNumber: 'RMV-2026-0002', salesStaffId: 'cccccccccccccccccccccccc' });
    expect(project.validateSync()).toBeUndefined();
    expect(project.toObject()).toMatchObject(movedFields);
  });

  it('requires a customer reference when there is no appointment', () => {
    const result = createProjectSchema.safeParse(details);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['customerId']);
  });

  it('requires a provided signed contract to be uploaded to the contracts folder', () => {
    expect(createProjectSchema.safeParse({ ...details, customerId, contractFileKey: 'projects/contract.pdf' }).success).toBe(false);
  });

  it('validates the Schedule Ocular Visit payload', () => {
    const visit = { date: '2026-11-12', slotCode: '09:00', customerLocation: { lat: 14.6, lng: 121.0 } };
    expect(scheduleProjectOcularSchema.safeParse(visit).success).toBe(true);
    expect(scheduleProjectOcularSchema.safeParse({ ...visit, date: '11/12/2026' }).success).toBe(false);
    expect(scheduleProjectOcularSchema.safeParse({ ...visit, customerLocation: undefined }).success).toBe(false);
  });

  it.each(['customerId', 'appointmentId'])('rejects a malformed %s', (field) => {
    expect(createProjectSchema.safeParse({ ...details, customerId, [field]: 'invalid-id' }).success).toBe(false);
  });

  it.each(['title', 'serviceType', 'siteAddress'])('rejects a blank project %s', (field) => {
    expect(createProjectSchema.safeParse({ ...details, customerId, [field]: '   ' }).success).toBe(false);
  });
});

describe('standalone project persistence validation', () => {
  it('validates a Project without an appointment reference', () => {
    const project = new Project({
      ...details,
      projectNumber: 'RMV-2026-0001',
      customerId,
      salesStaffId: 'cccccccccccccccccccccccc',
    });
    expect(project.validateSync()).toBeUndefined();
    expect(project.appointmentId).toBeUndefined();
  });

  it('validates a ProjectItem without an appointment reference', () => {
    const item = new ProjectItem({
      projectId: 'dddddddddddddddddddddddd',
      title: details.title,
      serviceType: details.serviceType,
    });
    expect(item.validateSync()).toBeUndefined();
    expect(item.appointmentId).toBeUndefined();
  });
});
