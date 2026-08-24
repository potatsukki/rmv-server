import { describe, expect, it } from 'vitest';

import { activeProjectStatusesForRoles } from './projects.list-policy.js';
import { ProjectStatus, Role } from '../../utils/constants.js';

describe('activeProjectStatusesForRoles', () => {
  it('keeps fabrication staff active queue fabrication-only', () => {
    expect(activeProjectStatusesForRoles([Role.FABRICATION_STAFF])).toEqual([
      ProjectStatus.FABRICATION,
    ]);
  });

  it('keeps engineer active queue out of draft and payment-pending work', () => {
    expect(activeProjectStatusesForRoles([Role.ENGINEER])).toEqual([
      ProjectStatus.SUBMITTED,
      ProjectStatus.BLUEPRINT,
      ProjectStatus.FABRICATION,
    ]);
  });

  it('includes contract-required draft work in the sales active queue', () => {
    expect(activeProjectStatusesForRoles([Role.SALES_STAFF])).toEqual([
      ProjectStatus.DRAFT,
      ProjectStatus.SUBMITTED,
      ProjectStatus.BLUEPRINT,
      ProjectStatus.APPROVED,
      ProjectStatus.FABRICATION,
    ]);
  });
});
