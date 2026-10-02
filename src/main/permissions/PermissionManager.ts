/**
 * Central risk classification for actions a tool might take.
 *
 * Actual gating for the file-operation tools happens where the risk is
 * precise and conditional (e.g. copying only needs confirmation when it
 * would overwrite something) — see `tools/impl/fileOpsTools.ts`, which asks
 * the question via a normal tool result and only proceeds once the model
 * calls again with `confirm: true` after the user has agreed. This registry
 * exists so every action's risk is declared in one place instead of scattered
 * `if` statements, and so a future settings UI (a "trusted mode" toggle, for
 * instance) has one thing to consult rather than many.
 */
export type RiskLevel = 'safe' | 'confirm' | 'high_risk' | 'blocked';

export type SensitiveAction =
  | 'open_application'
  | 'close_application'
  | 'find_file'
  | 'read_file'
  | 'analyze_document'
  | 'web_search'
  | 'open_file'
  | 'open_folder'
  | 'open_url'
  | 'create_folder'
  | 'copy_file'
  | 'move_file'
  | 'rename_file'
  | 'delete_file'
  | 'delete_folder'
  | 'overwrite_file'
  | 'clipboard_read'
  | 'clipboard_write'
  | 'send_message'
  | 'send_email'
  | 'install_software'
  | 'execute_download'
  | 'change_security_settings'
  | 'financial_transaction'
  | 'upload_private_file'
  | 'permanently_delete_recycle_bin_item'
  | 'empty_recycle_bin'
  | 'lock_screen'
  | 'restart_computer'
  | 'shutdown_computer'
  | 'open_website'
  | 'inspect_page'
  | 'click_on_page'
  | 'fill_on_page'
  | 'go_back'
  | 'go_forward'
  | 'reload_page'
  | 'scroll_page'
  | 'close_browser_tab'
  | 'browser_status'
  | 'wait_for_user_in_browser'
  | 'find_on_page'
  | 'read_page'
  | 'list_browser_tabs'
  | 'switch_browser_tab'
  | 'connect_chrome'
  | 'take_screenshot'
  | 'browser_sensitive_click';

const RISK_LEVELS: Readonly<Record<SensitiveAction, RiskLevel>> = {
  open_application: 'safe',
  close_application: 'safe',
  find_file: 'safe',
  read_file: 'safe',
  analyze_document: 'safe',
  web_search: 'safe',
  open_file: 'safe',
  open_folder: 'safe',
  open_url: 'safe',
  create_folder: 'safe',
  copy_file: 'safe', // becomes 'confirm' at the moment it would overwrite something
  move_file: 'safe', // becomes 'confirm' at the moment it would overwrite something
  rename_file: 'safe', // becomes 'confirm' at the moment it would overwrite something
  delete_file: 'confirm',
  delete_folder: 'high_risk',
  overwrite_file: 'confirm',
  clipboard_read: 'safe',
  clipboard_write: 'safe',
  send_message: 'confirm',
  send_email: 'confirm',
  install_software: 'high_risk',
  execute_download: 'confirm',
  change_security_settings: 'high_risk',
  financial_transaction: 'blocked',
  upload_private_file: 'confirm',
  // Already in the Recycle Bin, not reintroducing anything — a lower bar than delete_folder.
  permanently_delete_recycle_bin_item: 'confirm',
  // Removes everything in the bin at once, not just one item the user named.
  empty_recycle_bin: 'high_risk',
  // Reversible with the user's own password, and inherently low-consequence — no confirmation needed.
  lock_screen: 'safe',
  // Interrupts every other running application on the machine, not just Eya.
  restart_computer: 'high_risk',
  shutdown_computer: 'high_risk',
  // Reading and clicking around a page a human could see and click themselves.
  open_website: 'safe',
  inspect_page: 'safe',
  click_on_page: 'safe',
  // Typing into a visible field, not submitting anything destructive by itself.
  fill_on_page: 'safe',
  go_back: 'safe',
  go_forward: 'safe',
  reload_page: 'safe',
  scroll_page: 'safe',
  // Closing a tab the user opened can lose their work in it: asked first. A tab Eya opened herself needs no question.
  close_browser_tab: 'confirm',
  browser_status: 'safe',
  // Only watches the page the user is dealing with; does nothing to it.
  wait_for_user_in_browser: 'safe',
  // Looking through, and reading, the page that is already open.
  find_on_page: 'safe',
  read_page: 'safe',
  // Titles of the user's open tabs reach the assistant only when it asks for them while carrying out a request.
  list_browser_tabs: 'safe',
  switch_browser_tab: 'safe',
  // Starts a short, user-initiated pairing window; nothing connects without the extension the user installed.
  connect_chrome: 'safe',
  // Saves a NEW image of the page the user asked for into their own Desktop; never overwrites, and the picture is never shown to the assistant.
  take_screenshot: 'safe',
  // A click that would buy, send, delete or change an account setting for real, in the user's own signed-in browser.
  browser_sensitive_click: 'confirm',
};

export interface PermissionRequest {
  readonly status: 'permission_required';
  readonly action: SensitiveAction;
  /** What the action would affect, e.g. a file name — never a raw path read aloud. */
  readonly target: string;
  readonly reason: string;
  /** What the user can say to answer, e.g. ['approve', 'deny'] or ['recycle', 'permanent']. */
  readonly options: readonly string[];
  // Structurally compatible with ToolResult['data'], so a tool can return this directly.
  readonly [key: string]: unknown;
}

/** A question for the user, in the exact shape a tool hands back as its result data. */
export function permissionRequest(
  action: SensitiveAction,
  target: string,
  reason: string,
  options: readonly string[] = ['approve', 'deny'],
): PermissionRequest {
  return { status: 'permission_required', action, target, reason, options };
}

export function riskLevelFor(action: SensitiveAction): RiskLevel {
  return RISK_LEVELS[action];
}

export interface PermissionGrant {
  readonly action: SensitiveAction;
  readonly scope: 'once' | 'session';
  readonly grantedAt: number;
}

export class PermissionManager {
  private readonly sessionGrants = new Set<SensitiveAction>();

  riskLevel(action: SensitiveAction): RiskLevel {
    return riskLevelFor(action);
  }

  /** True for anything hard-blocked regardless of confirmation (there is no way to grant this). */
  isBlocked(action: SensitiveAction): boolean {
    return this.riskLevel(action) === 'blocked';
  }

  /** A session-wide grant, e.g. "session" scope for a repeated safe-ish action. Never used to bypass a `blocked` action. */
  async checkAction(action: SensitiveAction): Promise<boolean> {
    if (this.isBlocked(action)) return false;
    if (this.riskLevel(action) === 'safe') return true;
    return this.sessionGrants.has(action);
  }

  grantForSession(action: SensitiveAction): PermissionGrant {
    this.sessionGrants.add(action);
    return { action, scope: 'session', grantedAt: Date.now() };
  }

  revoke(action: SensitiveAction): void {
    this.sessionGrants.delete(action);
  }
}
