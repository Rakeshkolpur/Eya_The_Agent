import { WHATSAPP_PLUGIN } from './builtin/whatsapp';
import type { CatalogEntry, CatalogSource, PluginManifest } from './types';

/**
 * The plugins that ship with Eya, offered from this PC. There is no remote catalogue and none is pretended: `remote` is false, and the Plugins page says
 * so. A remote catalogue would be another `CatalogSource` (returning manifests it has checked), added where the manager is built — nothing else changes.
 */
export class LocalCatalog implements CatalogSource {
  readonly name = 'Built in to Eya';
  readonly remote = false;

  constructor(private readonly manifests: readonly PluginManifest[] = BUILT_IN_PLUGINS) {}

  entries(): readonly CatalogEntry[] {
    return this.manifests.map((manifest) => ({ manifest, trust: 'built-in' as const }));
  }
}

/** WhatsApp is the first, and the only one with real actions behind it today: the others are added when they work, never as empty names. */
export const BUILT_IN_PLUGINS: readonly PluginManifest[] = [WHATSAPP_PLUGIN];
