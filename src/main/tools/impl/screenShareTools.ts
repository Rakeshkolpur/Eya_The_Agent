import { permissionRequest } from '@main/permissions/PermissionManager';
import type { ScreenShare } from '@main/screen/screenShare';
import type { Tool, ToolResult } from '../types';

/**
 * Turning screen sharing on and off by voice. Starting it needs a clear yes from the user (like every action that shows Eya
 * something private); stopping it never does. The Share button in the app is the same switch.
 */
export function createScreenShareTools(share: ScreenShare): Tool[] {
  const start: Tool = {
    schema: {
      name: 'start_screen_share',
      status: 'Starting screen sharing…',
      description:
        'Start sharing the user\'s screen with you: while it is on you can see their screen (a picture about once a second, never saved) and answer questions like "what is this?" or ' +
        '"how do I do this?". It ASKS FIRST: a call without confirm starts nothing and returns the question to put to the user; only after a clear yes call again with confirm: true. ' +
        'Eya\'s own windows are left out, and it pauses by itself while a chat app that Chats are OFF for is showing. Do not start it on your own: only when the user asks to share their screen or to be shown how to do something on it.',
      args: { confirm: { type: 'boolean', description: 'true ONLY after the user clearly said yes to sharing their screen.' } },
    },
    async execute(args): Promise<ToolResult> {
      if (share.status().active) return { ok: true, summary: 'already sharing', data: { sharing: true } };
      if (args['confirm'] !== true) {
        const question = 'Do you want to share your screen with me? I will look at it about once a second so I can help, I will not save anything, and I will leave out my own windows and any chat app that is switched off.';
        return {
          ok: false,
          summary: 'needs confirmation',
          error: `Sharing has not started. Ask the user this, plainly: "${question}" Only if they clearly say yes, call start_screen_share again with confirm: true. If they say no, do not start it.`,
          data: permissionRequest('start_screen_share', 'your screen', question, ['yes', 'no']),
        };
      }
      const status = share.start();
      return {
        ok: true,
        summary: 'sharing started',
        data: { sharing: status.active, note: 'You can now see their screen as pictures. Say what you see when asked; never read out passwords, codes or card numbers. They can stop it any time.' },
      };
    },
  };

  const stop: Tool = {
    schema: {
      name: 'stop_screen_share',
      status: 'Stopping screen sharing…',
      description: 'Stop looking at the user\'s screen. Use it as soon as they say to stop sharing, or that they are done. It needs no confirmation.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const was = share.status().active;
      share.stop('user');
      return { ok: true, summary: was ? 'sharing stopped' : 'was not sharing', data: { sharing: false } };
    },
  };

  return [start, stop];
}
