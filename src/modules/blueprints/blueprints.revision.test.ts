import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  blueprintFindById: vi.fn(), blueprintFindOne: vi.fn(), blueprintCreate: vi.fn(),
  projectFindById: vi.fn(), draftFindOne: vi.fn(), draftUpdate: vi.fn(), draftFindById: vi.fn(),
  auditCreate: vi.fn(), userFindById: vi.fn(), notifyRole: vi.fn(), deleteFile: vi.fn(),
}));
vi.mock('../../models/index.js', () => ({
  Blueprint: { findById: mocks.blueprintFindById, findOne: mocks.blueprintFindOne, create: mocks.blueprintCreate },
  BlueprintDraft: { findOne: mocks.draftFindOne, findOneAndUpdate: mocks.draftUpdate, findById: mocks.draftFindById },
  Project: { findById: mocks.projectFindById }, ProjectItem: { countDocuments: async () => 0 }, PaymentPlan: {},
  User: { findById: mocks.userFindById }, AuditLog: { create: mocks.auditCreate },
}));
vi.mock('../notifications/socket.service.js', () => ({ createAndSendNotification: vi.fn(), notifyRole: mocks.notifyRole }));
vi.mock('../notifications/email.service.js', () => ({ sendBlueprintUploadedEmail: vi.fn() }));
vi.mock('../uploads/upload.service.js', () => ({ deleteFile: mocks.deleteFile }));
vi.mock('../config/config.service.js', () => ({ getInstallmentConfig: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { finalizeBlueprintDraft, requestRevision, uploadRevision, upsertBlueprintDraft } from './blueprints.service.js';
import { requestRevisionSchema, revisionUploadSchema } from './blueprints.validation.js';
import { BlueprintStatus, ProjectStatus } from '../../utils/constants.js';

function source(component?: 'blueprint' | 'costing') {
  return {
    _id: 'bp-1', projectId: 'project-1', version: 1,
    status: BlueprintStatus.REVISION_REQUESTED, revisionComponent: component,
    blueprintKey: 'original-blueprint.pdf', designKey: 'original-design.png', costingKey: 'original-costing.pdf',
    blueprintApproved: component === 'costing', costingApproved: component !== 'costing',
    quotation: { total: 3000, discount: 100, engineerNotes: 'Keep these notes' },
    quotationReviewStatus: 'sent_to_customer', quotationSentAt: new Date('2026-10-01'),
    uploadedBy: 'engineer-1', save: vi.fn(),
  };
}
function projectQuery() {
  const project = { _id: 'project-1', title: 'Railings', customerId: 'customer-1', engineerIds: ['engineer-1'], status: ProjectStatus.BLUEPRINT };
  return Object.assign(Promise.resolve(project), { select: vi.fn().mockResolvedValue(project) });
}

describe('component-scoped blueprint revisions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.projectFindById.mockImplementation(projectQuery);
    mocks.blueprintCreate.mockImplementation(async (value) => ({ _id: 'bp-2', ...value }));
    mocks.userFindById.mockResolvedValue(null);
  });

  it.each(['blueprint', 'costing'] as const)('requesting %s preserves the other approval and resets only the requested part', async (component) => {
    const bp = { ...source(), status: BlueprintStatus.UPLOADED, blueprintApproved: true, costingApproved: true };
    mocks.blueprintFindById.mockResolvedValue(bp);
    await requestRevision('bp-1', requestRevisionSchema.parse({ notes: 'Revise this part', component }), 'customer-1');
    expect(bp).toMatchObject({
      revisionComponent: component,
      blueprintApproved: component === 'costing', costingApproved: component === 'blueprint',
      quotationReviewStatus: component === 'blueprint' ? 'sent_to_customer' : 'draft',
      quotation: { total: 3000 },
    });
  });

  it('a legacy blueprint revision ignores changed costing and retains its approval and quotation metadata', async () => {
    const bp = source();
    mocks.blueprintFindById.mockResolvedValue(bp);
    const result = await uploadRevision('bp-1', revisionUploadSchema.parse({
      blueprintKey: 'revised.pdf', designKey: 'revised.png', costingKey: 'changed.pdf', quotation: { total: 9999 },
    }), 'engineer-1');
    expect(result).toMatchObject({
      blueprintKey: 'revised.pdf', designKey: 'revised.png', costingKey: 'original-costing.pdf',
      blueprintApproved: false, costingApproved: true, quotation: bp.quotation,
      quotationReviewStatus: 'sent_to_customer', quotationSentAt: bp.quotationSentAt,
    });
    expect(mocks.notifyRole).not.toHaveBeenCalled();
  });

  it('costing revision keeps approved blueprint and design even when replacements are submitted', async () => {
    mocks.blueprintFindById.mockResolvedValue(source('costing'));
    const result = await uploadRevision('bp-1', revisionUploadSchema.parse({
      blueprintKey: 'changed.pdf', designKey: 'changed.png', quotation: { total: 4000 },
    }), 'engineer-1');
    expect(result).toMatchObject({
      blueprintKey: 'original-blueprint.pdf', designKey: 'original-design.png',
      blueprintApproved: true, costingApproved: false, quotation: { total: 4000 },
    });
  });

  it('a blueprint draft cannot overwrite locked costing', async () => {
    const bp = source('blueprint');
    mocks.blueprintFindOne.mockReturnValue({ sort: () => ({ select: async () => bp }) });
    mocks.draftFindOne.mockResolvedValue(null);
    mocks.draftUpdate.mockResolvedValue({ _id: 'draft-1', files: {} });
    const populated = { populate: vi.fn().mockReturnThis() };
    mocks.draftFindById.mockReturnValue(populated);
    await upsertBlueprintDraft('project-1', {
      mode: 'revision', files: { costing: null }, quotation: { total: '9999' },
    }, 'engineer-1');
    const set = mocks.draftUpdate.mock.calls[0][1].$set;
    expect(set).not.toHaveProperty('quotation');
    expect(set).not.toHaveProperty('files.costing');
  });

  it('a costing draft cannot overwrite locked blueprint and design files', async () => {
    const bp = source('costing');
    mocks.blueprintFindOne.mockReturnValue({ sort: () => ({ select: async () => bp }) });
    mocks.draftFindOne.mockResolvedValue(null);
    mocks.draftUpdate.mockResolvedValue({ _id: 'draft-1', files: {} });
    mocks.draftFindById.mockReturnValue({ populate: vi.fn().mockReturnThis() });
    await upsertBlueprintDraft('project-1', {
      mode: 'revision', files: { blueprint: null, design: null }, quotation: { total: '4000' },
    }, 'engineer-1');
    const set = mocks.draftUpdate.mock.calls[0][1].$set;
    expect(set).not.toHaveProperty('files.blueprint');
    expect(set).not.toHaveProperty('files.design');
    expect(set.quotation).toMatchObject({ total: '4000' });
  });

  it('finalizes a blueprint revision with a new blueprint only and no costing entry', async () => {
    mocks.blueprintFindById.mockResolvedValue(source('blueprint'));
    const deleteOne = vi.fn();
    mocks.draftFindOne.mockResolvedValue({
      mode: 'revision', sourceBlueprintId: 'bp-1', files: { blueprint: { key: 'revised.pdf' } }, deleteOne,
    });
    const result = await finalizeBlueprintDraft('project-1', 'engineer-1');
    expect(result).toMatchObject({
      blueprintKey: 'revised.pdf', designKey: 'original-design.png', costingKey: 'original-costing.pdf',
      quotation: { total: 3000 }, costingApproved: true,
    });
    expect(deleteOne).toHaveBeenCalled();
  });

  it('finalizes a costing revision without requiring blueprint or design uploads', async () => {
    mocks.blueprintFindById.mockResolvedValue(source('costing'));
    mocks.draftFindOne.mockResolvedValue({
      mode: 'revision', sourceBlueprintId: 'bp-1', files: {}, deleteOne: vi.fn(),
      quotation: { lineItems: [{ label: 'Steel', quantity: 1, materials: '4000', labor: '' }] },
    });
    expect(await finalizeBlueprintDraft('project-1', 'engineer-1')).toMatchObject({
      blueprintKey: 'original-blueprint.pdf', designKey: 'original-design.png',
      quotation: { total: 4000 }, blueprintApproved: true, costingApproved: false,
      quotationReviewStatus: 'sent_to_customer',
    });
  });
});
