import type { MemoryAction, MemoryActionResult, MemorySnapshot } from '@shared/ipcContract';
import { COMMUNICATION_APPS } from '@main/privacy/communicationAccess';
import { describeSteps } from './MemoryService';
import type { MemoryService } from './MemoryService';
import { MemoryRejected } from './MemoryStore';
import { SkillRejected } from './SkillStore';

/**
 * What the Memory panel shows and what it may ask for. Kept free of Electron so it can be tested: the IPC layer only carries these
 * across. The panel is the user's own control surface, so it can do what the model's tools deliberately cannot (delete a routine
 * with no spoken yes: the panel asks for its own click first).
 */

export const MEMORY_UNAVAILABLE: MemorySnapshot = { available: false, memories: [], routines: [], chatNames: { learning: 'unasked', names: [] }, suggestion: null };

/** "whatsapp" -> "WhatsApp": how the user knows the app. */
const appName = (id: string): string => COMMUNICATION_APPS.find((a) => a.id === id)?.name ?? id;

export function snapshotOf(service: MemoryService | null): MemorySnapshot {
  if (service === null) return MEMORY_UNAVAILABLE;
  return {
    available: true,
    chatNames: {
      learning: service.contacts.learning(),
      names: service.contacts.list().map((c) => ({ id: c.id, app: appName(c.app), name: c.name, aliases: c.aliases, uses: c.useCount })),
    },
    memories: service.memories.list().map((m) => ({ id: m.id, type: m.type, value: m.value })),
    routines: service.skills.listDetails().map((d) => ({
      id: d.id,
      name: d.name,
      enabled: d.enabled,
      triggers: d.triggers,
      steps: describeSteps(d.steps).split('\n'),
      useCount: d.useCount,
      successCount: d.successCount,
      failureCount: d.failureCount,
      lastUsedAt: d.lastUsedAt,
    })),
    suggestion: service.currentSuggestion(),
  };
}

const isId = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
const isText = (s: unknown): s is string => typeof s === 'string';

/** Carries out one request from the panel. Anything malformed changes nothing; a refusal says why in plain words. */
export function applyPanelAction(service: MemoryService | null, raw: unknown): MemoryActionResult {
  const done = (ok: boolean, message?: string): MemoryActionResult => ({ ok, ...(message !== undefined ? { message } : {}), snapshot: snapshotOf(service) });
  if (service === null) return done(false, 'Memory is not available right now.');
  if (typeof raw !== 'object' || raw === null) return done(false);
  const a = raw as Partial<Record<string, unknown>> & { kind?: unknown };
  try {
    switch (a.kind as MemoryAction['kind']) {
      case 'add_memory': {
        if (!isText(a['text']) || (a['type'] !== 'preference' && a['type'] !== 'fact')) return done(false);
        const r = service.rememberStatement(a['text'], a['type']);
        return done(r.ok, r.ok ? undefined : r.spoken);
      }
      case 'edit_memory': {
        if (!isId(a['id']) || !isText(a['text'])) return done(false);
        return service.memories.update(a['id'], { value: a['text'] }) === undefined ? done(false, 'That memory is gone.') : done(true);
      }
      case 'delete_memory':
        return isId(a['id']) && service.memories.delete(a['id']) ? done(true) : done(false, 'That memory is gone.');
      case 'set_enabled': {
        if (!isId(a['id']) || typeof a['enabled'] !== 'boolean') return done(false);
        service.skills.setEnabled(a['id'], a['enabled']);
        return done(true);
      }
      case 'rename_routine': {
        if (!isId(a['id']) || !isText(a['name'])) return done(false);
        service.skills.rename(a['id'], a['name']);
        return done(true);
      }
      case 'add_phrase': {
        if (!isId(a['id']) || !isText(a['text'])) return done(false);
        service.skills.addTrigger(a['id'], a['text']);
        return done(true);
      }
      case 'remove_phrase': {
        if (!isId(a['id']) || !isText(a['text'])) return done(false);
        service.skills.removeTrigger(a['id'], a['text']);
        return done(true);
      }
      case 'delete_routine':
        return isId(a['id']) && service.skills.delete(a['id']) ? done(true) : done(false, 'That routine is gone.');
      case 'forget_chat_name':
        return isId(a['id']) && service.contacts.forget(a['id']) ? done(true) : done(false, 'That name is already gone.');
      case 'forget_chat_names':
        service.contacts.forgetAll();
        return done(true);
      case 'set_chat_names': {
        if (typeof a['on'] !== 'boolean') return done(false);
        service.contacts.setLearning(a['on'] ? 'on' : 'off'); // the user's own click is the yes; off also forgets every name
        return done(true);
      }
      case 'answer_suggestion': {
        if (a['answer'] !== 'yes' && a['answer'] !== 'no') return done(false);
        const r = a['answer'] === 'yes' ? service.acceptSuggestion() : service.declineSuggestion();
        return done(r.ok, r.spoken);
      }
      default:
        return done(false);
    }
  } catch (err) {
    if (err instanceof SkillRejected || err instanceof MemoryRejected) return done(false, err.message);
    throw err;
  }
}
