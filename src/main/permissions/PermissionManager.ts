/**
 * Central permission checker. Milestone 1: allow-listed intents only.
 * Sensitive actions (delete file, send email, install software, etc.)
 * must go through checkAction() and receive an explicit user grant.
 *
 * The prompt UI is not yet wired up; the interface exists so tools written
 * from day one route through it instead of side-stepping later.
 */
export type SensitiveAction =
  | 'delete_file'
  | 'send_message'
  | 'send_email'
  | 'install_software'
  | 'execute_download'
  | 'change_security_settings'
  | 'financial_transaction'
  | 'upload_private_file';

export interface PermissionGrant {
  readonly action: SensitiveAction;
  readonly scope: 'once' | 'session';
  readonly grantedAt: number;
}

export class PermissionManager {
  private readonly sessionGrants = new Set<SensitiveAction>();

  /** Milestone 1 stub: everything sensitive is denied until UI lands. */
  async checkAction(action: SensitiveAction): Promise<boolean> {
    if (this.sessionGrants.has(action)) return true;
    return false;
  }

  grantForSession(action: SensitiveAction): PermissionGrant {
    this.sessionGrants.add(action);
    return { action, scope: 'session', grantedAt: Date.now() };
  }

  revoke(action: SensitiveAction): void {
    this.sessionGrants.delete(action);
  }
}
