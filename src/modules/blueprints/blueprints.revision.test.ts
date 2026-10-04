import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  blueprintFindById: vi.fn(), blueprintFindOne: vi.fn(), blueprintFind: vi.fn(), blueprintCreate: vi.fn(),
  projectFindById: vi.fn(), draftFindOne: vi.fn(), draftUpdate: vi.fn(), draftFindById: vi.fn(),
  auditCreate: vi.fn(), auditFindOne: vi.fn(), userFindById: vi.fn(), notifyRole: vi.fn(), deleteFile: vi.fn(),
}));
vi.mock('../../models/index.js', () => ({
  Blueprint: { findById: mocks.blueprintFindById, findOne: mocks.blueprintFindOne, find: mocks.blueprintFind, create: mocks.blueprintCreate },
  BlueprintDraft: { findOne: mocks.draftFindOne, findOneAndUpdate: mocks.draftUpdate, findById: mocks.draftFindById },
  Project: { findById: mocks.projectFindById }, ProjectItem: { countDocuments: async () => 0 }, PaymentPlan: {},
  User: { findById: mocks.userFindById }, AuditLog: { create: mocks.auditCreate, findOne: mocks.auditFindOne },
}));
vi.mock('../notifications/socket.service.js', () => ({ createAndSendNotification: vi.fn(), notifyRole: mocks.notifyRole }));
vi.mock('../notifications/email.service.js', () => ({ sendBlueprintUploadedEmail: vi.fn() }));
vi.mock('../uploads/upload.service.js', () => ({ deleteFile: mocks.deleteFile }));
vi.mock('../config/config.service.js', () => ({ getInstallmentConfig: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { approveComponent, finalizeBlueprintDraft, getLatestBlueprint, listBlueprintsByProject, requestRevision, uploadRevision, upsertBlueprintDraft } from './blueprints.service.js';
import { requestRevisionSchema, revisionUploadSchema } from './blueprints.validation.js';
import { AuditAction, BlueprintComponent, BlueprintStatus, ProjectStatus, Role } from '../../utils/constants.js';

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
    mocks.auditFindOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) });
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

  it('restores the released costing when a legacy blueprint revision reset its status to draft', async () => {
    const bp = { ...source(), quotationReviewStatus: 'draft', quotationSentAt: undefined };
    mocks.blueprintFindById.mockResolvedValue(bp);
    const sentAt = new Date('2026-10-01');
    mocks.auditFindOne.mockReturnValue({ sort: async () => ({ createdAt: sentAt }) });
    const result = await uploadRevision('bp-1', revisionUploadSchema.parse({ blueprintKey: 'revised.pdf' }), 'engineer-1');
    expect(result).toMatchObject({ quotation: bp.quotation, quotationReviewStatus: 'sent_to_customer', quotationSentAt: sentAt });
    expect(mocks.auditFindOne).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'bp-1', action: AuditAction.QUOTATION_SENT_TO_CUSTOMER, 'details.total': 3000,
    }));
    expect(mocks.notifyRole).not.toHaveBeenCalled();
  });

  it('customer billing approval accepts a previously released quotation whose legacy status was reset', async () => {
    const bp = { ...source(), status: BlueprintStatus.UPLOADED, blueprintApproved: false, costingApproved: false, quotationReviewStatus: 'draft' };
    mocks.blueprintFindById.mockResolvedValue(bp);
    mocks.auditFindOne.mockReturnValue({ sort: async () => ({ createdAt: new Date('2026-10-01') }) });
    expect(await approveComponent('bp-1', { component: BlueprintComponent.COSTING }, 'customer-1'))
      .toMatchObject({ costingApproved: true, quotationReviewStatus: 'sent_to_customer' });
    expect(bp.save).toHaveBeenCalled();
  });
});

describe('customer visibility of inherited costing', () => {
  const latest = () => ({ ...source(), _id: 'bp-3', version: 3, status: BlueprintStatus.UPLOADED, quotationReviewStatus: 'draft' });
  const query = (value: unknown) => ({ sort: vi.fn().mockReturnThis(), populate: vi.fn().mockResolvedValue(value) });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.projectFindById.mockImplementation(projectQuery);
    mocks.auditFindOne.mockImplementation((filter) => ({
      sort: async () => filter.action === AuditAction.QUOTATION_SENT_TO_CUSTOMER
        ? (filter.targetId === 'bp-1' ? { createdAt: new Date('2026-10-01') } : null)
        : { details: { previousId: filter.targetId === 'bp-3' ? 'bp-2' : 'bp-1' } },
    }));
    mocks.blueprintFindById.mockImplementation(async (id) => ({
      ...source(), _id: id, version: id === 'bp-2' ? 2 : 1, quotationReviewStatus: 'draft',
    }));
  });

  it('shows the unchanged quotation inherited across two blueprint revisions', async () => {
    const bp = latest();
    mocks.blueprintFindOne.mockReturnValue(query(bp));
    expect(await getLatestBlueprint('project-1', 'customer-1', [Role.CUSTOMER]))
      .toMatchObject({ quotation: { total: 3000 }, quotationReviewStatus: 'sent_to_customer' });
    expect(bp.save).not.toHaveBeenCalled();
  });

  it('normalizes history responses so the summary remains visible in the customer costing tab', async () => {
    const bp = latest();
    mocks.blueprintFind.mockReturnValue({ populate: () => ({ sort: async () => [bp] }) });
    expect(await listBlueprintsByProject('project-1', 'customer-1', [Role.CUSTOMER]))
      .toEqual([expect.objectContaining({ quotationReviewStatus: 'sent_to_customer' })]);
  });

  it('keeps a real unsent quotation hidden when no release is recorded', async () => {
    mocks.auditFindOne.mockReturnValue({ sort: async () => null });
    mocks.blueprintFindOne.mockReturnValue(query(latest()));
    expect(await getLatestBlueprint('project-1', 'customer-1', [Role.CUSTOMER]))
      .toMatchObject({ quotationReviewStatus: 'draft' });
  });

  it('does not inherit release status if the pricing changed despite the same total', async () => {
    const bp = latest();
    mocks.blueprintFindOne.mockReturnValue(query(bp));
    mocks.blueprintFindById.mockResolvedValue({ ...source(), _id: 'bp-2', version: 2, quotation: { ...bp.quotation, discount: 0 } });
    expect(await getLatestBlueprint('project-1', 'customer-1', [Role.CUSTOMER]))
      .toMatchObject({ quotationReviewStatus: 'draft' });
  });

  it('does not restore the old release during a costing revision', async () => {
    const bp = { ...latest(), status: BlueprintStatus.REVISION_REQUESTED, revisionComponent: 'costing' as const };
    mocks.blueprintFindOne.mockReturnValue(query(bp));
    expect(await getLatestBlueprint('project-1', 'customer-1', [Role.CUSTOMER]))
      .toMatchObject({ quotationReviewStatus: 'draft' });
    expect(mocks.auditFindOne).not.toHaveBeenCalled();
  });

  it('does not inherit a quotation from a different project', async () => {
    mocks.blueprintFindOne.mockReturnValue(query(latest()));
    mocks.blueprintFindById.mockResolvedValue({ ...source(), _id: 'bp-2', version: 2, projectId: 'other-project' });
    expect(await getLatestBlueprint('project-1', 'customer-1', [Role.CUSTOMER]))
      .toMatchObject({ quotationReviewStatus: 'draft' });
  });

  it('does not inherit a quotation from another project item', async () => {
    mocks.blueprintFindOne.mockReturnValue(query({ ...latest(), projectItemId: 'item-1' }));
    mocks.blueprintFindById.mockResolvedValue({ ...source(), _id: 'bp-2', version: 2, projectItemId: 'item-2' });
    expect(await getLatestBlueprint('project-1', 'customer-1', [Role.CUSTOMER], 'item-1'))
      .toMatchObject({ quotationReviewStatus: 'draft' });
  });

  it('does not inherit the old release from a costing revision without a new quotation', async () => {
    mocks.blueprintFindOne.mockReturnValue(query(latest()));
    mocks.blueprintFindById.mockResolvedValue({ ...source('costing'), _id: 'bp-2', version: 2 });
    expect(await getLatestBlueprint('project-1', 'customer-1', [Role.CUSTOMER]))
      .toMatchObject({ quotationReviewStatus: 'draft' });
  });

  it('recognizes unchanged line items even when Mongoose assigns new subdocument IDs', async () => {
    const quotation = { total: 3000, lineItems: [{ _id: 'new-id', label: 'Steel', quantity: 1, materials: 3000, labor: 0, amount: 3000 }] };
    mocks.blueprintFindOne.mockReturnValue(query({ ...latest(), quotation }));
    mocks.blueprintFindById.mockImplementation(async (id) => ({
      ...source(), _id: id, version: id === 'bp-2' ? 2 : 1,
      quotation: { ...quotation, lineItems: [{ ...quotation.lineItems[0], _id: 'old-id' }] },
    }));
    expect(await getLatestBlueprint('project-1', 'customer-1', [Role.CUSTOMER]))
      .toMatchObject({ quotationReviewStatus: 'sent_to_customer' });
  });
});
