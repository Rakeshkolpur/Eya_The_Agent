import type { CommunicationPolicy, CommunicationSettings } from '@main/privacy/communicationAccess';
import type { CommunicationAccessStore } from '@main/privacy/communicationAccessStore';
import type { PluginConnector, PluginManifest } from '../types';

/**
 * WhatsApp, as a plugin over what Eya already does: the user's own WhatsApp Web session in their own browser (Eya never holds the account, a password or a
 * token — the person scans WhatsApp's QR code themselves), the existing chat tools, and the existing checks after a send. What is declared here is what
 * is really there; what is not built is listed as not supported rather than left out, so nobody is promised it.
 */
export const WHATSAPP_APP = 'whatsapp';

export const WHATSAPP_PLUGIN: PluginManifest = {
  id: 'whatsapp',
  name: 'WhatsApp',
  description: "Find chats and contacts, send messages and files, and check they went — in your own WhatsApp Web in your own browser. Eya never has your account or password.",
  version: '1.2.0',
  author: 'Eya',
  compat: { minEya: '0.1.0' },
  bundled: true,
  auth: {
    kind: 'app_switch',
    app: WHATSAPP_APP,
    describe: 'You allow WhatsApp in Eya (your own switch), and you sign in to WhatsApp Web in your browser by scanning its QR code yourself.',
  },
  permissions: [
    { id: 'chats.read', label: 'Find chats and contacts', description: 'Look up a chat by name or phone number, open it, and see only the names of chats (never messages).', risk: 'read' },
    { id: 'files.find', label: 'Find files in chats', description: "Look through WhatsApp's own list of documents (file names, who sent them and when) to say where a file is, and open the chat at it. Nothing is sent, changed or deleted.", risk: 'read' },
    { id: 'chats.live', label: 'Live chat companion', description: 'Watch ONE chat you choose, only while you allow it: read its new messages and prepare replies for you to review. Sending a reply still needs "Send text messages", and automatic replies need your explicit switch for that chat.', risk: 'read' },
    { id: 'messages.send', label: 'Send text messages', description: 'Type and send a text message in a chat you asked for.', risk: 'send' },
    { id: 'files.send', label: 'Send files', description: 'Send a file from this PC to a chat you asked for.', risk: 'send' },
  ],
  actions: [
    {
      id: 'find_chat',
      label: 'Find a chat',
      description: 'By name, part of a name, a phone number, or the end of one. Never invents digits; asks when several chats fit.',
      tools: ['find_chat'],
      gate: 'registry',
      permission: 'chats.read',
      verify: 'The page itself must show the chat open (its message box names it). A likely match is said to be one.',
    },
    {
      id: 'remember_chat_names',
      label: 'Remember chat names',
      description: 'Keep the names of your chats on this PC (names only) so they are found faster. Only after you say yes.',
      tools: ['learn_chat_names'],
      gate: 'registry',
      permission: 'chats.read',
      verify: 'Counts the names read from the chat list.',
    },
    {
      id: 'find_files',
      label: 'Find a file in the chats',
      description: "A file you sent or received, by part of its name, who sent it and when (\"last week\"). Says where it is and opens that chat on the file. Reads only WhatsApp's own list of documents.",
      tools: ['find_chat_files'],
      gate: 'registry',
      permission: 'files.find',
      verify: "Reads the rows of WhatsApp's document list and judges them here. The chat is named only when the page shows it open at that file's message; otherwise it is said that the chat is not known.",
    },
    {
      id: 'live_chat',
      label: 'Live chat companion',
      description: 'Start, pause, resume or stop a live chat with one person. New messages in that one chat are read as they arrive and a reply is drafted for you; it sends only as far as you allow (Draft: never; Assisted: when you approve; Auto-reply: within limits you set, only for that chat and run).',
      tools: ['live_chat'],
      gate: 'registry',
      permission: 'chats.live',
      verify: "The chat must be shown open by the page itself (its message box names it). A reply is checked against the page before it is sent (still the right chat, no newer message), and after: only what the page shows is called sent. An uncertain send is never repeated.",
    },
    {
      id: 'send_message',
      label: 'Send a text message',
      description: 'Type the message exactly as you said it and send it in the chat that was found and checked.',
      tools: ['fill_on_page', 'click_on_page'],
      gate: 'send_gate',
      permission: 'messages.send',
      consequential: true,
      verify: "Looks for the message in the chat and reads WhatsApp's own mark: sent, delivered, read or failed. A send that cannot be seen is looked at, never repeated.",
    },
    {
      id: 'send_file',
      label: 'Send a file',
      description: 'Send a file from this PC to a chat, through WhatsApp Web\'s own "Select chats" step or the chat itself.',
      tools: ['share_file_to_chat', 'attach_file'],
      gate: 'registry',
      permission: 'files.send',
      consequential: true,
      verify: "Looks for the file in the chat and reads WhatsApp's own mark. A send that cannot be seen is looked at, never repeated.",
    },
    {
      id: 'check_delivery',
      label: 'Check a send',
      description: 'Look in the chat for what was just sent and report only what the page shows: attempted, sent, delivered, read or failed.',
      tools: ['verify_sent'],
      gate: 'registry',
      permission: 'chats.read',
      verify: "WhatsApp's own tick marks; nothing is claimed beyond them.",
    },
    {
      id: 'find_messages',
      label: 'Find messages',
      description: 'Search inside a chat for a message.',
      tools: [],
      gate: 'registry',
      verify: 'Not applicable.',
      unsupported: 'Not built yet: reading messages needs the chat page checked first, and nothing here is guessed.',
    },
    {
      id: 'download_attachment',
      label: 'Save a file received in a chat',
      description: 'Save a photo or document someone sent you to a folder on this PC.',
      tools: [],
      gate: 'registry',
      verify: 'Not applicable.',
      unsupported: 'Not built yet: needs a read-only look at how WhatsApp Web shows received files, with your say-so.',
    },
  ],
};

/**
 * WhatsApp's account is the person's own switch in Communication Access (the one place that decides whether Eya may look at, or act in, a chat app) plus
 * their own sign-in in their browser. Connecting here is that same switch — there is no second authority — and is reachable only from the person's click.
 * Allowing WhatsApp must not quietly allow any other chat app: when the master switch is off, every other app is left off.
 */
export function whatsappConnector(policy: CommunicationPolicy, store: CommunicationAccessStore): PluginConnector {
  const settings = (): CommunicationSettings => store.get();
  return {
    status() {
      const app = policy.apps().find((a) => a.id === WHATSAPP_APP);
      if (app === undefined) return { state: 'error', detail: 'WhatsApp is not one of the chat apps Eya knows.' };
      if (policy.allowed(app)) return { state: 'connected', detail: 'WhatsApp is allowed. Sign in to WhatsApp Web in your browser (scan its QR code) when Eya asks; she never sees your password.' };
      return { state: 'not_connected', detail: settings().enabled ? 'WhatsApp is switched off in Eya.' : 'Chats are switched off in Eya.' };
    },
    connect() {
      const now = settings();
      const others: Record<string, boolean> = {};
      if (!now.enabled) for (const a of policy.apps()) if (a.id !== WHATSAPP_APP && now.apps[a.id] !== true) others[a.id] = false;
      try {
        store.set({ enabled: true, apps: { ...now.apps, ...others, [WHATSAPP_APP]: true } });
      } catch {
        return { ok: false, message: 'Could not save the choice, so WhatsApp was not connected.' };
      }
      return { ok: true, message: 'WhatsApp is connected. Sign in to WhatsApp Web in your browser when Eya opens it.' };
    },
    disconnect() {
      const now = settings();
      try {
        store.set({ enabled: now.enabled, apps: { ...now.apps, [WHATSAPP_APP]: false } });
      } catch {
        return { ok: false, message: 'Could not save the choice, so WhatsApp was not disconnected.' };
      }
      return { ok: true, message: 'WhatsApp is disconnected: Eya will not look at or use it.' };
    },
  };
}
