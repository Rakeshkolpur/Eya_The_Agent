import type { CommunicationPolicy } from '@main/privacy/communicationAccess';
import type { Tool, ToolResult } from '../types';

/**
 * The only thing Eya can do about Communication Access is READ whether it is on. She has no way to switch it on: that is
 * the user's switch, in Eya's panel, so a conversation (or a web page, or a message) can never talk her into it.
 */
export function createCommunicationStatusTool(policy: CommunicationPolicy): Tool {
  return {
    schema: {
      name: 'communication_access_status',
      status: 'Checking the privacy setting…',
      description:
        'Say whether Communication Access is on — the user\'s privacy switch for whether Eya may look at or use chat apps and sites (WhatsApp, Telegram, Instagram…) — and for which apps. ' +
        'Use it when the user asks about it, or when a result says it is off. You cannot change it: the user turns it on or off with the Chats switch in Eya\'s panel.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const settings = policy.settings();
      const apps = policy
        .apps()
        .filter((a) => a.hosts.length > 0 || a.processes.length > 0)
        .map((a) => ({ app: a.name, allowed: policy.allowed(a) }));
      return {
        ok: true,
        summary: settings.enabled ? 'Communication Access is on' : 'Communication Access is off',
        data: {
          communicationAccess: settings.enabled ? 'on' : 'off',
          apps,
          howToChange: "Only the user can change it, with the Chats switch in Eya's panel. Eya cannot turn it on.",
        },
      };
    },
  };
}
