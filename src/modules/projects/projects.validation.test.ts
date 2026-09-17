import { describe, expect, it } from 'vitest';
import { Project } from '../../models/Project.js';
import { ProjectItem } from '../../models/ProjectItem.js';
import { createProjectSchema } from './projects.validation.js';

const customerId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const appointmentId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const details = {
  title: 'Kitchen counter',
  serviceType: 'countertops',
  description: 'Counter with two shelves',
  siteAddress: '123 Project Street',
};

describe('createProjectSchema', () => {
  it('accepts an independent project without an appointment', () => {
    const result = createProjectSchema.parse({ ...details, customerId });
    expect(result.customerId).toBe(customerId);
    expect(result.appointmentId).toBeUndefined();
    expect(result.quantity).toBe(1);
  });

  it('accepts an optional appointment link and the legacy appointment-only customer reference', () => {
    expect(createProjectSchema.safeParse({ ...details, customerId, appointmentId }).success).toBe(true);
    expect(createProjectSchema.safeParse({ ...details, appointmentId }).success).toBe(true);
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

  it.each(['customerId', 'appointmentId'])('rejects a malformed %s', (field) => {
    expect(createProjectSchema.safeParse({ ...details, customerId, [field]: 'invalid-id' }).success).toBe(false);
  });

  it.each(['title', 'serviceType', 'description', 'siteAddress'])('rejects a blank project %s', (field) => {
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
