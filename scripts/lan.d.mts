import type { Server } from 'node:http';

export function attachLan(server: Server): { rooms: Map<string, unknown>; close(): void };
