import type { IncomingMessage, ServerResponse } from 'node:http';

export const SESSION_COOKIE_VALUE: string;
export function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
