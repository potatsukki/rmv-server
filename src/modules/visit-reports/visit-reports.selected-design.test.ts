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

  it.each(['submitted', 'completed', 'returned'])('preserves an existing ocular report status %s when ensuring reports again', async (status) => {
    const report = {
      _id: 'ocular-report', appointmentId: 'ocular-1', visitType: 'ocular', status,
      serviceType: ServiceType.RAILINGS, salesStaffId: 'sales-1',
      materials: 'Verified stainless steel', lineItems: [], photoKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAppointmentFindById.mockReturnValue(selectLeanResult({ serviceTypes: [ServiceType.RAILINGS] }));
    mockVisitReportFind.mockImplementation((filter) => ({
      sort: vi.fn().mockResolvedValue(filter.visitType === 'consultation' ? [] : [report]),
    }));

    for (let read = 0; read < 2; read++) {
      await autoCreateDraft('ocular-1', 'customer-1', 'sales-1', 'ocular', undefined, [ServiceType.RAILINGS]);
      expect(report.status).toBe(status);
    }
    expect(report.save).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
    expect(mockVisitReportCreate).not.toHaveBeenCalled();
  });

  it('starts a promoted consultation report as an ocular draft only on its first transition', async () => {
    const report = {
      _id: 'source-report', appointmentId: 'consultation-1', visitType: 'consultation', status: 'submitted',
      serviceType: ServiceType.RAILINGS, salesStaffId: 'sales-1',
      notes: 'Customer reference', lineItems: [], photoKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAppointmentFindById.mockImplementation((id) => selectLeanResult({
      serviceTypes: [ServiceType.RAILINGS],
      ...(id === 'ocular-1' && { sourceConsultationAppointmentId: 'consultation-1' }),
    }));
    mockVisitReportFind.mockImplementation((filter) => ({
      sort: vi.fn().mockImplementation(async () => (
        filter.appointmentId === report.appointmentId && (!filter.visitType || filter.visitType === report.visitType)
          ? [report] : []
      )),
    }));

    await autoCreateDraft('ocular-1', 'customer-1', 'sales-1', 'ocular', undefined, [ServiceType.RAILINGS]);
    expect(report).toMatchObject({ appointmentId: 'ocular-1', visitType: 'ocular', status: 'draft' });
    report.status = 'submitted';
    await autoCreateDraft('ocular-1', 'customer-1', 'sales-1', 'ocular', undefined, [ServiceType.RAILINGS]);
    expect(report.status).toBe('submitted');
    expect(report.save).toHaveBeenCalledOnce();
  });
});

describe('autoCreateDraft with several booked designs (QA: 4 designs, 2 items)', () => {
  const designs = [
    { id: 'gates-double-swing-gate', name: 'Double Swing Gate', imageUrl: '/g.png', serviceId: 'gates', serviceLabel: 'Gates', serviceType: ServiceType.GATES },
    { id: 'custom-stainless-storage-cabinet', name: 'Stainless Storage Cabinet', imageUrl: '/c1.png', serviceId: 'custom', serviceLabel: 'Custom Fabrication', serviceType: ServiceType.CUSTOM },
    { id: 'custom-food-cart-kiosk-frame', name: 'Food Cart Kiosk Frame', imageUrl: '/c2.png', serviceId: 'custom', serviceLabel: 'Custom Fabrication', serviceType: ServiceType.CUSTOM },
    { id: 'custom-utility-frame', name: 'Utility Frame', imageUrl: '/c3.png', serviceId: 'custom', serviceLabel: 'Custom Fabrication', serviceType: ServiceType.CUSTOM },
  ];
  const serviceTypes = [ServiceType.GATES, ServiceType.CUSTOM];

  function draft(overrides: Record<string, unknown>) {
    return {
      _id: `report-${Math.random()}`,
      status: 'draft',
      visitType: 'consultation',
      createdAt: new Date('2026-11-04T09:00:00Z'),
      lineItems: [],
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function bookAppointment() {
    mockAppointmentFindById.mockReturnValueOnce(selectLeanResult({
      serviceTypes,
      selectedDesignTemplateId: designs[0]!.id,
      selectedDesignTemplateName: designs[0]!.name,
      selectedDesignTemplateImageUrl: designs[0]!.imageUrl,
      selectedDesignTemplates: designs,
    }));
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates one draft item per selected design', async () => {
    bookAppointment();
    mockVisitReportFind.mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([]) });
    mockVisitReportCreate.mockImplementation(async (payload) => ({ _id: `report-${payload.selectedDesignTemplateId}`, ...payload }));

    await autoCreateDraft('appointment-1', 'customer-1', 'sales-1', 'consultation', undefined, serviceTypes);

    expect(mockVisitReportCreate).toHaveBeenCalledTimes(4);
    expect(mockVisitReportCreate.mock.calls.map(([payload]) => payload.selectedDesignTemplateId)).toEqual(designs.map((design) => design.id));
    expect(mockVisitReportCreate).toHaveBeenCalledWith(expect.objectContaining({
      serviceType: ServiceType.CUSTOM,
      serviceTypeCustom: 'Custom Fabrication',
      selectedDesignTemplateName: 'Food Cart Kiosk Frame',
    }));
  });

  it('splits an older merged Custom draft without losing its notes', async () => {
    const gates = draft({ serviceType: ServiceType.GATES });
    const mergedCustom = draft({ serviceType: ServiceType.CUSTOM, notes: 'Measured the cart frame' });
    bookAppointment();
    mockVisitReportFind.mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([gates, mergedCustom]) });
    mockVisitReportCreate.mockImplementation(async (payload) => ({ _id: `report-${payload.selectedDesignTemplateId}`, ...payload }));

    await autoCreateDraft('appointment-1', 'customer-1', 'sales-1', 'consultation', undefined, serviceTypes);

    expect(gates).toMatchObject({ selectedDesignTemplateId: 'gates-double-swing-gate' });
    expect(mergedCustom).toMatchObject({
      selectedDesignTemplateId: 'custom-stainless-storage-cabinet',
      notes: 'Measured the cart frame',
    });
    expect(mockVisitReportCreate.mock.calls.map(([payload]) => payload.selectedDesignTemplateId)).toEqual([
      'custom-food-cart-kiosk-frame',
      'custom-utility-frame',
    ]);
    expect(mockVisitReportDeleteOne).not.toHaveBeenCalled();
  });

  it('does nothing more once every design has its own item', async () => {
    const reports = designs.map((design, index) => draft({
      _id: `report-${index}`,
      serviceType: design.serviceType,
      serviceTypeCustom: design.serviceType === ServiceType.CUSTOM ? 'Custom Fabrication' : undefined,
      selectedDesignTemplateId: design.id,
      selectedDesignTemplateName: design.name,
    }));
    bookAppointment();
    mockVisitReportFind.mockReturnValueOnce({ sort: vi.fn().mockResolvedValue(reports) });

    await autoCreateDraft('appointment-1', 'customer-1', 'sales-1', 'consultation', undefined, serviceTypes);

    expect(mockVisitReportCreate).not.toHaveBeenCalled();
    expect(mockVisitReportDeleteOne).not.toHaveBeenCalled();
  });

  it('keeps every custom design item when the consultation is promoted to the ocular visit', async () => {
    const consultationReports = designs.slice(1).map((design, index) => draft({
      _id: `consultation-${index}`,
      appointmentId: 'consultation-1',
      serviceType: ServiceType.CUSTOM,
      serviceTypeCustom: 'Custom Fabrication',
      selectedDesignTemplateId: design.id,
      selectedDesignTemplateName: design.name,
      notes: `Notes for ${design.name}`,
    }));
    mockAppointmentFindById.mockImplementation((id) => selectLeanResult(id === 'ocular-1'
      ? { serviceTypes: [ServiceType.CUSTOM], sourceConsultationAppointmentId: 'consultation-1' }
      : { serviceTypes: [ServiceType.CUSTOM], selectedDesignTemplates: designs.slice(1) }));
    mockVisitReportFind.mockImplementation((filter) => ({
      sort: vi.fn().mockImplementation(async () => {
        if (filter.visitType === 'consultation') return consultationReports;
        if (filter.visitType === 'ocular') return [];
        return consultationReports.filter((report) => report.appointmentId === filter.appointmentId);
      }),
    }));

    await autoCreateDraft('ocular-1', 'customer-1', 'sales-1', 'ocular', undefined, [ServiceType.CUSTOM]);

    expect(mockVisitReportDeleteOne).not.toHaveBeenCalled();
    expect(consultationReports.map((report) => report.appointmentId)).toEqual(['ocular-1', 'ocular-1', 'ocular-1']);
    expect(consultationReports.map((report) => report.notes)).toEqual(designs.slice(1).map((design) => `Notes for ${design.name}`));
    expect(mockVisitReportCreate).not.toHaveBeenCalled();
  });

  it('never splits a report that is already submitted or linked to a project', async () => {
    const gates = draft({ serviceType: ServiceType.GATES, selectedDesignTemplateId: designs[0]!.id });
    const submittedCustom = draft({ serviceType: ServiceType.CUSTOM, status: 'submitted' });
    bookAppointment();
    mockVisitReportFind.mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([gates, submittedCustom]) });

    await autoCreateDraft('appointment-1', 'customer-1', 'sales-1', 'consultation', undefined, serviceTypes);

    expect(mockVisitReportCreate).not.toHaveBeenCalled();
    expect(submittedCustom.save).not.toHaveBeenCalled();
  });
});
