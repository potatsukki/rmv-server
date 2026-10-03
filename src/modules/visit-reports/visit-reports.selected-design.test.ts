import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppointmentFindById,
  mockVisitReportFind,
  mockVisitReportCreate,
  mockVisitReportDeleteOne,
  mockAuditCreate,
} = vi.hoisted(() => ({
  mockAppointmentFindById: vi.fn(),
  mockVisitReportFind: vi.fn(),
  mockVisitReportCreate: vi.fn(),
  mockVisitReportDeleteOne: vi.fn(),
  mockAuditCreate: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    findById: mockAppointmentFindById,
  },
  VisitReport: {
    find: mockVisitReportFind,
    create: mockVisitReportCreate,
    deleteOne: mockVisitReportDeleteOne,
  },
  Project: {},
  ProjectItem: {},
  User: {},
  AuditLog: {
    create: mockAuditCreate,
  },
  SlotLock: {},
}));

vi.mock('../../models/VisitReport.js', () => ({
  VisitReportStatus: {
    DRAFT: 'draft',
    SUBMITTED: 'submitted',
    RETURNED: 'returned',
    COMPLETED: 'completed',
  },
}));

vi.mock('../../utils/stateMachine.js', () => ({
  visitReportStateMachine: {},
  appointmentStateMachine: {},
}));

vi.mock('../../utils/projectNumber.js', () => ({
  generateProjectNumber: vi.fn(),
}));

vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(),
  notifyRole: vi.fn(),
}));

vi.mock('../appointments/appointments.service.js', () => ({
  resolveOcularVisitData: vi.fn(),
}));

import { autoCreateDraft } from './visit-reports.service.js';
import { ServiceType } from '../../utils/constants.js';

function selectLeanResult<T>(value: T) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(value),
    }),
  };
}

describe('autoCreateDraft selected design', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('seeds the booked design snapshot into the matching consultation draft', async () => {
    mockAppointmentFindById.mockReturnValueOnce(selectLeanResult({
      serviceTypes: [ServiceType.RAILINGS],
      selectedDesignTemplateId: 'railings-commercial-guardrail',
      selectedDesignTemplateName: 'Commercial Stainless Guardrail',
      selectedDesignTemplateImageUrl: '/landing/services/railings/guardrail.png',
    }));
    mockVisitReportFind.mockReturnValueOnce({
      sort: vi.fn().mockResolvedValue([]),
    });
    mockVisitReportCreate.mockImplementationOnce(async (payload) => ({
      _id: 'report-new',
      ...payload,
    }));
    mockAuditCreate.mockResolvedValueOnce({});

    await autoCreateDraft(
      'appointment-1',
      'customer-1',
      'sales-1',
      'consultation',
      undefined,
      [ServiceType.RAILINGS],
    );

    expect(mockVisitReportCreate).toHaveBeenCalledWith(expect.objectContaining({
      appointmentId: 'appointment-1',
      serviceType: ServiceType.RAILINGS,
      selectedDesignTemplateId: 'railings-commercial-guardrail',
      selectedDesignTemplateName: 'Commercial Stainless Guardrail',
      selectedDesignTemplateImageUrl: '/landing/services/railings/guardrail.png',
    }));
  });

  it('fills empty fields without replacing sales staff edits when site details arrive late', async () => {
    const existingDraft = {
      status: 'draft',
      serviceType: ServiceType.RAILINGS,
      materials: 'Staff-confirmed stainless steel',
      finishes: undefined,
      preferredDesign: undefined,
      customerRequirements: undefined,
      notes: 'Staff measured the east wall already.',
      measurementUnit: 'mm',
      lineItems: [],
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };

    mockAppointmentFindById.mockReturnValueOnce(selectLeanResult({
      serviceTypes: [ServiceType.RAILINGS],
    }));
    mockVisitReportFind.mockReturnValueOnce({
      sort: vi.fn().mockResolvedValue([existingDraft]),
    });

    await autoCreateDraft(
      'appointment-1',
      'customer-1',
      'sales-1',
      'consultation',
      {
        serviceTypes: [ServiceType.RAILINGS],
        materials: 'Customer-requested aluminum',
        finishes: 'Matte black',
        preferredDesign: 'Horizontal slats',
        customerRequirements: 'Child-safe spacing',
        notes: 'Customer note',
        measurementUnit: 'cm',
      },
      [ServiceType.RAILINGS],
    );

    expect(existingDraft).toMatchObject({
      materials: 'Staff-confirmed stainless steel',
      finishes: 'Matte black',
      preferredDesign: 'Horizontal slats',
      customerRequirements: 'Child-safe spacing',
      notes: 'Staff measured the east wall already.',
      measurementUnit: 'mm',
    });
    expect(existingDraft.save).toHaveBeenCalledOnce();
    expect(mockVisitReportCreate).not.toHaveBeenCalled();
  });

  it('replaces the untouched default unit with the customer measurement unit', async () => {
    const untouchedDraft = {
      status: 'draft',
      serviceType: ServiceType.RAILINGS,
      measurementUnit: 'cm',
      lineItems: [],
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };

    mockAppointmentFindById.mockReturnValueOnce(selectLeanResult({
      serviceTypes: [ServiceType.RAILINGS],
    }));
    mockVisitReportFind.mockReturnValueOnce({
      sort: vi.fn().mockResolvedValue([untouchedDraft]),
    });

    await autoCreateDraft(
      'appointment-1',
      'customer-1',
      'sales-1',
      'consultation',
      {
        serviceTypes: [ServiceType.RAILINGS],
        measurementUnit: 'mm',
      },
      [ServiceType.RAILINGS],
    );

    expect(untouchedDraft.measurementUnit).toBe('mm');
    expect(untouchedDraft.save).toHaveBeenCalledOnce();
  });

  it('repairs stale draft ownership from the current appointment assignee', async () => {
    const existingDraft = {
      status: 'draft',
      serviceType: ServiceType.RAILINGS,
      salesStaffId: 'sales-old',
      lineItems: [],
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };

    mockAppointmentFindById.mockReturnValueOnce(selectLeanResult({
      serviceTypes: [ServiceType.RAILINGS],
    }));
    mockVisitReportFind.mockReturnValueOnce({
      sort: vi.fn().mockResolvedValue([existingDraft]),
    });

    await autoCreateDraft(
      'appointment-1',
      'customer-1',
      'sales-current',
      'consultation',
      undefined,
      [ServiceType.RAILINGS],
    );

    expect(existingDraft.salesStaffId).toBe('sales-current');
    expect(existingDraft.save).toHaveBeenCalledOnce();
    expect(mockVisitReportCreate).not.toHaveBeenCalled();
  });

  it('collapses duplicate drafts for the same booked service into one item', async () => {
    const emptyDuplicate = {
      _id: 'report-empty',
      status: 'draft',
      visitType: 'consultation',
      serviceType: ServiceType.KITCHEN_COUNTER,
      salesStaffId: 'sales-1',
      lineItems: [],
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      createdAt: new Date('2026-09-29T10:00:00Z'),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const filledDraft = {
      _id: 'report-filled',
      status: 'draft',
      visitType: 'consultation',
      serviceType: ServiceType.KITCHEN_COUNTER,
      salesStaffId: 'sales-1',
      notes: 'Keep the customer measurements on this item.',
      lineItems: [],
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      createdAt: new Date('2026-09-29T10:01:00Z'),
      save: vi.fn().mockResolvedValue(undefined),
    };

    mockAppointmentFindById.mockReturnValueOnce(selectLeanResult({
      serviceTypes: [ServiceType.KITCHEN_COUNTER],
    }));
    mockVisitReportFind.mockReturnValueOnce({
      sort: vi.fn().mockResolvedValue([emptyDuplicate, filledDraft]),
    });
    mockVisitReportDeleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    mockAuditCreate.mockResolvedValueOnce({});

    await autoCreateDraft(
      'appointment-1',
      'customer-1',
      'sales-1',
      'consultation',
      undefined,
      [ServiceType.KITCHEN_COUNTER],
    );

    expect(mockVisitReportDeleteOne).toHaveBeenCalledWith({ _id: 'report-empty' });
    expect(filledDraft.save).toHaveBeenCalledOnce();
    expect(mockVisitReportCreate).not.toHaveBeenCalled();
  });
});
