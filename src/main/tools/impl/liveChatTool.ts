import type { LiveChatController } from '@main/livechat/LiveChatController';
import { LIVE_RELATIONS } from '@shared/liveChat';
import type { LiveChatRequest, LiveRelation } from '@shared/liveChat';
import type { Tool, ToolResult } from '../types';

/**
 * The model's way to start, pause, resume, stop or ask about the live chat. It can NOT approve or send a reply, switch automatic replies on, or confirm a chat: those
 * are the person's own (the Live chat page, or their own words to Eya), and a tool the model can call is not that.
 */
export function createLiveChatTool(controller: Pick<LiveChatController, 'handle' | 'view'>): Tool {
  return {
    schema: {
      name: 'live_chat',
      status: 'Setting up the live chat…',
      description:
        'The Live Chat Companion for WhatsApp: watch ONE chat the user names, and prepare replies for them to review (it never sends by itself unless the user has switched automatic replies on in the Live chat page). ' +
        'action "start" with the chat name ("Rahul") begins it; "stop", "pause", "resume" and "status" do what they say. If the chat is only a likely match, or several chats fit, it tells you so: ' +
        'the USER confirms or chooses on the Live chat page — never decide for them. You cannot approve, send or switch on automatic replies with this tool. Works only while Communication Access is on for WhatsApp and the plugin may use the live chat. ' +
        'When the user asks you to "do live chat" / chat live with someone on WhatsApp (with a name or a phone number, and perhaps why: "she is my friend, make her happy"), use this tool to start it — do not refuse: it is a supervised chat the user asked for, with replies in their own style that they can stop at any moment. ' +
        'Pass what they said they want from the chat as "purpose" (their words), and opening=true if they want Eya to write first. Pass other_person_knows=false ONLY if the user said the other person does not know (or that it is a secret); otherwise leave it out. ' +
        'If the user has switched on "Enable live chat" (one switch on the Live chat page that allows everything it needs), the live chat answers by itself once the chat is confirmed: say so. If it could not start because that switch is off, tell them to open Live chat in Eya and switch on "Enable live chat" — you cannot switch it on. Otherwise saying "turn on auto reply" lets Eya answer by herself (she asks them the one confirmation question), and "stop live chat" ends it.',
      args: {
        action: { type: 'string', required: true, enum: ['start', 'stop', 'pause', 'resume', 'status'], description: 'What to do.' },
        name: { type: 'string', description: 'The chat to watch (name or phone number) — for "start".' },
        purpose: { type: 'string', description: 'What the user said they want from this chat, in their own words (for "start").' },
        opening: { type: 'boolean', description: 'True if the user asked Eya to write the first message (it is written only once automatic replies are on).' },
        relation: { type: 'string', enum: ['friend', 'partner', 'family', 'senior', 'client', 'other'], description: 'Who the other person is to the user: friend, partner (girlfriend, wife, husband, lover), family, senior (sir, madam, boss, teacher), client, or other. It decides how Eya sounds. Ask the user who the person is before you start, unless they said ("she is my friend", "my sir"), and pass the answer.' },
        other_person_knows: { type: 'boolean', description: 'Pass false ONLY if the user said the other person does not know that Eya writes the replies (or that it is a secret). Leave it out otherwise.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const action = typeof args['action'] === 'string' ? args['action'] : '';
      const name = typeof args['name'] === 'string' ? args['name'].trim() : '';
      const purpose = typeof args['purpose'] === 'string' ? args['purpose'].replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      let request: LiveChatRequest | null = null;
      if (action === 'start') request = name === '' ? null : { kind: 'start', name, ...(purpose !== '' ? { purpose } : {}), ...(args['opening'] === true ? { opening: true } : {}), ...(args['other_person_knows'] === false ? { knows: false } : {}), ...(LIVE_RELATIONS.find((x) => x === args['relation']) !== undefined ? { relation: args['relation'] as LiveRelation } : {}) };
      else if (action === 'stop' || action === 'pause' || action === 'resume') request = { kind: action };
      if (action === 'status') {
        const v = controller.view();
        return { ok: true, summary: v.active ? `live chat ${v.state.toLowerCase().replace(/_/g, ' ')}` : 'no live chat', data: { status: v.state, active: v.active, chat: v.chat, mode: v.mode, say: v.active ? `The live chat with ${v.chat ?? 'a chat'} is ${v.state.toLowerCase().replace(/_/g, ' ')}.` : 'There is no live chat running.' } };
      }
      if (request === null) return { ok: false, summary: 'not understood', error: action === 'start' ? 'Say which chat to watch.' : 'That is not something the live chat tool does.' };
      const result = await controller.handle(request);
      return {
        ok: result.ok,
        summary: result.ok ? `live chat ${result.view.state.toLowerCase().replace(/_/g, ' ')}` : 'live chat not started',
        ...(result.ok ? {} : { error: result.message }),
        data: {
          say: result.message,
          status: result.view.state,
          chat: result.view.chat,
          mode: result.view.mode,
          needsUser: result.view.state === 'WAITING_FOR_USER',
          ...(result.ok ? {} : { next: 'This says exactly why the live chat did not start and what the user has to do. Tell them in the same words as far as you can: do not shorten it to "the page was not clear" and do not add reasons of your own.' }),
        },
      };
    },
  };
}
