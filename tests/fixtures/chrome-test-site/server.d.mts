import type { Server } from 'node:http';

export function startTestSite(port?: number): Promise<{ server: Server; port: number }>;
