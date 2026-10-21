import type { MemoryService } from '@main/memory/MemoryService';
import { describeSteps } from '@main/memory/MemoryService';
import { SkillRejected } from '@main/memory/SkillStore';
import { permissionRequest } from '@main/permissions/PermissionManager';
import type { Tool, ToolArgs, ToolResult } from '../types';

/**
 * What the model can do about memory. The user's own words for managing memory ("what do you remember", "forget this routine") are
 * caught earlier, locally, by MemoryService; these tools are for the model — in a live conversation, where it hears the user rather
 * than being handed text, and anywhere it decides a saved routine is what the user means.
 *
 * None of them can widen what Eya may do: a routine runs through the same tools with the same confirmation rules, so a routine can
 * never confirm a send, a delete or a purchase for the user.
 */

const text = (args: ToolArgs, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

function refuse(summary: string, error: string): ToolResult {
  return { ok: false, summary, error };
}

function routineNotFound(service: MemoryService, wanted: string): ToolResult {
  const names = service.skills.list().map((s) => s.name.replace(/_/g, ' '));
  return refuse('no such routine', `I have no saved routine called "${wanted}".${names.length > 0 ? ` My routines are: ${names.slice(0, 10).join(', ')}.` : ' I have no saved routines yet.'}`);
}

export function createMemoryTools(service: MemoryService): Tool[] {
  const remember: Tool = {
    schema: {
      name: 'remember',
      status: 'Remembering that…',
      description:
        'Keep something the user asked you to remember: a preference ("always save downloaded PDFs to the Desktop") or a fact ("Ravi is my brother\'s contact"). ' +
        'Call it only when the user asks you to remember something (or says "remember that…" / "from now on…"). Never store passwords, PINs, card numbers or other secrets. ' +
        'Say it again later and it updates the old one.',
      args: {
        text: { type: 'string', required: true, description: 'The thing to remember, as one plain sentence in the user\'s words.' },
        kind: { type: 'string', enum: ['preference', 'fact'], description: 'preference = how the user wants things done; fact = information about the user\'s world. Leave out if unsure.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const kind = text(args, 'kind');
      const r = service.rememberStatement(text(args, 'text'), kind === 'preference' || kind === 'fact' ? kind : undefined);
      return r.ok ? { ok: true, summary: 'remembered' } : refuse('not remembered', r.spoken);
    },
  };

  const forgetMemory: Tool = {
    schema: {
      name: 'forget_memory',
      status: 'Forgetting that…',
      description: 'Forget one thing you were asked to remember, when the user says to forget it. Name it by a few of its words ("Ravi", "downloaded PDFs"). To forget a saved routine use delete_routine instead.',
      args: { what: { type: 'string', required: true, description: 'A few words that name the memory to forget.' } },
    },
    async execute(args): Promise<ToolResult> {
      const spoken = service.forgetMemory(text(args, 'what'));
      return spoken === null ? refuse('nothing to forget', `I am not remembering anything about "${text(args, 'what')}".`) : { ok: true, summary: 'forgotten' };
    },
  };

  const listMemories: Tool = {
    schema: {
      name: 'list_memories',
      status: 'Checking what I remember…',
      description: 'List what the user has asked you to remember (preferences and facts). Use when asked "what do you remember?". Give a short spoken summary, not a reading of every item.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const all = service.memories.list();
      return {
        ok: true,
        summary: all.length === 0 ? 'nothing remembered' : `${all.length} remembered`,
        data: { count: all.length, memories: all.slice(0, 40).map((m) => ({ type: m.type, text: m.value })) },
      };
    },
  };

  const listRoutines: Tool = {
    schema: {
      name: 'list_routines',
      status: 'Checking my saved routines…',
      description: 'List the saved routines (tasks the user taught you by repeating them): name, what to say to run each one, and whether it is on. Use when asked "what routines do I have?".',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const all = service.skills.listDetails();
      return {
        ok: true,
        summary: all.length === 0 ? 'no routines' : `${all.length} routine${all.length === 1 ? '' : 's'}`,
        data: {
          count: all.length,
          routines: all.map((r) => ({ name: r.name, enabled: r.enabled, phrases: r.triggers, steps: describeSteps(r.steps), timesRun: r.useCount, worked: r.successCount, failed: r.failureCount })),
        },
      };
    },
  };

  const runRoutine: Tool = {
    schema: {
      name: 'run_routine',
      status: 'Running your saved routine…',
      description:
        'Run a saved routine at once, exactly as it was saved — far quicker than doing the task step by step. Call it FIRST whenever the user asks for something that is, or is close to, one of the saved routines listed in your instructions. ' +
        'It does the whole task and checks each step. If it stops (a page changed, or it needs the user\'s say-so) it tells you where; carry on from there with your normal tools. A routine never confirms a send, a delete or a purchase for the user.',
      args: { routine: { type: 'string', required: true, description: 'The routine\'s name, or the words the user said to ask for it.' } },
    },
    async execute(args): Promise<ToolResult> {
      const wanted = text(args, 'routine');
      const skill = service.findRoutine(wanted);
      if (skill === undefined) return routineNotFound(service, wanted);
      const outcome = await service.runSkill(skill);
      if (outcome.kind === 'answered') {
        return outcome.ok
          ? { ok: true, summary: 'routine done', data: { routine: skill.name, routineStatus: 'done', skillId: skill.id, say: outcome.spoken } }
          : { ok: false, summary: 'routine not run', error: outcome.spoken, data: { routine: skill.name, routineStatus: 'not_run', skillId: skill.id } };
      }
      return {
        ok: false,
        summary: 'routine stopped',
        error: outcome.hint,
        data: { routine: skill.name, routineStatus: outcome.replacing !== undefined ? 'failed' : 'needs_user', skillId: skill.id },
      };
    },
  };

  const saveRoutine: Tool = {
    schema: {
      name: 'save_routine',
      status: 'Saving that as a routine…',
      description:
        'Save the task you just finished as a routine the user can run again by saying the same thing, when the user says to ("save this as a routine", "yes, save it"). ' +
        'Only works for a browser/app task you just did successfully. Ask the user before saving; never save on your own.',
      args: { name: { type: 'string', description: 'A short name for the routine, if the user gave one.' } },
    },
    async execute(args): Promise<ToolResult> {
      const name = text(args, 'name');
      const r = service.saveLastTask(name === '' ? {} : { name });
      return r.ok ? { ok: true, summary: 'routine saved', data: { say: r.spoken, ...(r.routine !== undefined ? { routine: r.routine } : {}) } } : refuse('not saved', r.spoken);
    },
  };

  const answerSuggestion: Tool = {
    schema: {
      name: 'answer_routine_suggestion',
      status: 'Okay…',
      description:
        'Pass on the user\'s answer to your own question "You\'ve done this several times. Would you like me to save it as a routine?" (or the offer to update a routine). ' +
        'yes saves it; no turns it down for good. Use only right after you asked that question and the user answered.',
      args: { answer: { type: 'string', required: true, enum: ['yes', 'no'], description: 'The user\'s answer.' } },
    },
    async execute(args): Promise<ToolResult> {
      if (!service.hasPendingSuggestion()) return refuse('nothing pending', 'I had not offered to save anything just now.');
      const r = text(args, 'answer') === 'yes' ? service.acceptSuggestion() : service.declineSuggestion();
      return r.ok ? { ok: true, summary: text(args, 'answer') === 'yes' ? 'routine saved' : 'declined', data: { say: r.spoken } } : refuse('not saved', r.spoken);
    },
  };

  const updateRoutine: Tool = {
    schema: {
      name: 'update_routine',
      status: 'Updating the routine…',
      description: 'Change a saved routine: switch it on or off, rename it, or add or remove a phrase that runs it. A routine that is off is never run.',
      args: {
        routine: { type: 'string', required: true, description: 'The routine\'s name or one of its phrases.' },
        enabled: { type: 'boolean', description: 'true to switch it on, false to switch it off.' },
        name: { type: 'string', description: 'A new name.' },
        add_phrase: { type: 'string', description: 'A new phrase that should run it.' },
        remove_phrase: { type: 'string', description: 'A phrase that should no longer run it.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const skill = service.skills.find(text(args, 'routine'));
      if (skill === undefined) return routineNotFound(service, text(args, 'routine'));
      try {
        if (typeof args['enabled'] === 'boolean') service.skills.setEnabled(skill.id, args['enabled']);
        if (text(args, 'name') !== '') service.skills.rename(skill.id, text(args, 'name'));
        if (text(args, 'add_phrase') !== '') service.skills.addTrigger(skill.id, text(args, 'add_phrase'));
        if (text(args, 'remove_phrase') !== '') service.skills.removeTrigger(skill.id, text(args, 'remove_phrase'));
      } catch (err) {
        if (err instanceof SkillRejected) return refuse('not changed', err.message);
        throw err;
      }
      const now = service.skills.detail(skill.id);
      return { ok: true, summary: 'routine updated', data: { routine: now?.name ?? skill.name, enabled: now?.enabled ?? true, phrases: now?.triggers ?? [] } };
    },
  };

  const deleteRoutine: Tool = {
    schema: {
      name: 'delete_routine',
      status: 'Deleting the routine…',
      description:
        'Delete a saved routine for good. ALWAYS ask first: a call without confirm deletes nothing and returns the question to ask. ' +
        'Only call again with confirm=true once the user has clearly said yes. Never set confirm=true on the first call.',
      args: {
        routine: { type: 'string', required: true, description: 'The routine\'s name or one of its phrases.' },
        confirm: { type: 'boolean', description: 'Set true only after the user has explicitly said yes to deleting it.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const skill = service.skills.find(text(args, 'routine'));
      if (skill === undefined) return routineNotFound(service, text(args, 'routine'));
      const label = skill.name.replace(/_/g, ' ');
      if (args['confirm'] !== true) {
        return {
          ok: false,
          summary: 'needs confirmation',
          error: `Do you want me to delete the routine "${label}"? This cannot be undone.`,
          data: permissionRequest('delete_routine', label, 'This permanently removes the saved routine.'),
        };
      }
      service.skills.delete(skill.id);
      return { ok: true, summary: 'routine deleted', data: { routine: skill.name } };
    },
  };

  return [remember, forgetMemory, listMemories, listRoutines, runRoutine, saveRoutine, answerSuggestion, updateRoutine, deleteRoutine];
}
