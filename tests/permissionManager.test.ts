import { describe, it, expect } from 'vitest';
import { PermissionManager, permissionRequest, riskLevelFor } from '../src/main/permissions/PermissionManager';

describe('risk levels', () => {
  it('classifies read-only and additive actions as safe', () => {
    for (const action of ['open_application', 'find_file', 'read_file', 'web_search', 'create_folder', 'copy_file'] as const) {
      expect(riskLevelFor(action), action).toBe('safe');
    }
  });

  it('classifies destructive actions as confirm or worse', () => {
    expect(riskLevelFor('delete_file')).toBe('confirm');
    expect(riskLevelFor('overwrite_file')).toBe('confirm');
    expect(riskLevelFor('delete_folder')).toBe('high_risk');
  });

  it('has no action classified as blocked yet except the explicitly unsupported ones', () => {
    expect(riskLevelFor('financial_transaction')).toBe('blocked');
  });
});

describe('permissionRequest', () => {
  it('builds the structured question a tool hands back', () => {
    const req = permissionRequest('delete_file', 'report.pdf', 'This permanently removes the file.');
    expect(req).toEqual({
      status: 'permission_required',
      action: 'delete_file',
      target: 'report.pdf',
      reason: 'This permanently removes the file.',
      options: ['approve', 'deny'],
    });
  });
});

describe('PermissionManager', () => {
  it('allows safe actions without any grant', async () => {
    const pm = new PermissionManager();
    expect(await pm.checkAction('find_file')).toBe(true);
  });

  it('denies a confirm-level action until granted, and forgets it once revoked', async () => {
    const pm = new PermissionManager();
    expect(await pm.checkAction('delete_file')).toBe(false);
    pm.grantForSession('delete_file');
    expect(await pm.checkAction('delete_file')).toBe(true);
    pm.revoke('delete_file');
    expect(await pm.checkAction('delete_file')).toBe(false);
  });

  it('never allows a blocked action, even with a grant', async () => {
    const pm = new PermissionManager();
    pm.grantForSession('financial_transaction');
    expect(await pm.checkAction('financial_transaction')).toBe(false);
    expect(pm.isBlocked('financial_transaction')).toBe(true);
  });
});
