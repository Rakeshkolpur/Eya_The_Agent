/**
 * What the page's chat watcher says on its console when something changed in the open chat (see injected.js `chatWatch`): `__EYA_CHAT_EVENT__ <reason> <rows>` — only that something
 * changed and how many message rows there are, never a word of the chat. Electron hands a page's console line to its listener in one of two shapes (the text as the third argument,
 * or on the event as `message`); both are read here.
 */
export interface ChatConsoleEvent {
  readonly reason: string;
  readonly rows: number;
}

const LINE = /^__EYA_CHAT_EVENT__ (\w{1,12}) (\d{1,6})/;

export function parseChatConsole(args: readonly unknown[]): ChatConsoleEvent | null {
  const first = args[0] as { message?: unknown } | undefined;
  const text = args.find((a): a is string => typeof a === 'string' && a.startsWith('__EYA_CHAT_EVENT__')) ?? (typeof first?.message === 'string' ? first.message : '');
  const m = LINE.exec(text);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { reason: m[1], rows: Number(m[2]) };
}
