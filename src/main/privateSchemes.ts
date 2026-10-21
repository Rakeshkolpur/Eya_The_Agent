import { protocol } from 'electron';
import { APP_SCHEME_PRIVILEGES } from './windows/appProtocol';
import { MODEL_SCHEME_PRIVILEGES } from './models/modelProtocol';

/**
 * Declares Eya's private web addresses (eya-app:// for her page, eya-models:// for the speech models). Electron takes this declaration
 * ONCE, before the app is ready, and a second call replaces the first — so they are declared together here, never one at a time (doing
 * it one at a time silently dropped the first, and the speech worker then could not fetch its model).
 */
export function registerPrivateSchemes(): void {
  protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES, MODEL_SCHEME_PRIVILEGES]);
}
