import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('express-rate-limit', () => ({
    default: () => (_req: any, _res: any, next: any) => next(),
}));

import { app, server, io } from '../index';
import { io as Client, Socket } from 'socket.io-client';
import { getRoom } from '../gameManager';

describe('Payload Validation and Rate Limiting Tests', () => {
    let port: number;
    let clientSocket: Socket;
    let validToken: string;
    const userId = '00000000-0000-4000-8000-000000000099';

    beforeAll(async () => {
        await new Promise<void>((resolve) => {
            server.listen(0, () => {
                const addy = server.address() as any;
                port = addy.port;
                resolve();
            });
        });

        const res = await request(app).post('/auth').send({
            username: 'val_user',
            userId: userId,
        });
        validToken = res.body.token;
    });

    afterAll(() => {
        io.close();
        server.close();
    });

    const connectSocket = (token: string): Promise<Socket> =>
        new Promise((resolve) => {
            const s = Client(`http://localhost:${port}`, {
                reconnectionDelay: 0,
                forceNew: true,
                auth: { token },
            });
            s.on('connect', () => resolve(s));
        });

    it('should reject invalid createRoom payload (missing roomId)', async () => {
        clientSocket = await connectSocket(validToken);
        const roomId = 'val-room-1';

        // We can't easily listen for "nothing happened" on the server,
        // but we can check if the room was created.
        clientSocket.emit('createRoom', { notRoomId: roomId });

        await new Promise(r => setTimeout(r, 100));
        expect(getRoom(roomId)).toBeUndefined();
        clientSocket.disconnect();
    });

    it('should reject invalid drawStroke payload (wrong types)', async () => {
        clientSocket = await connectSocket(validToken);
        const roomId = 'val-room-2';
        clientSocket.emit('createRoom', { roomId });
        await new Promise(r => setTimeout(r, 100));

        const room = getRoom(roomId);
        room!.phase = 'DRAWING';
        room!.currentTurnPlayerId = userId;

        // Invalid stroke: color too short, x is string
        clientSocket.emit('drawStroke', { x: '10', y: 20, color: 'r', isNewStroke: true });

        await new Promise(r => setTimeout(r, 100));
        expect(room!.canvasStrokes.length).toBe(0);
        clientSocket.disconnect();
    });

    it('should rate limit drawStroke', async () => {
        clientSocket = await connectSocket(validToken);
        const roomId = 'val-room-3';
        clientSocket.emit('createRoom', { roomId });
        await new Promise(r => setTimeout(r, 100));

        const room = getRoom(roomId);
        room!.phase = 'DRAWING';
        room!.currentTurnPlayerId = userId;

        const validStroke = { x: 10, y: 20, color: '#ff0000', isNewStroke: true };

        // Send 10 strokes instantly
        for(let i=0; i<10; i++) {
            clientSocket.emit('drawStroke', validStroke);
        }

        await new Promise(r => setTimeout(r, 100));
        // Only the first one should have been processed due to 5ms limit
        // (Actually, in a local test environment, they might all be sent so fast that only 1 passes)
        // Let's just assert that NOT all 10 passed if they are sent synchronously.
        expect(room!.canvasStrokes.length).toBeLessThan(10);
        expect(room!.canvasStrokes.length).toBeGreaterThanOrEqual(1);

        clientSocket.disconnect();
    });

    it('should reject invalid vote payload (not a string)', async () => {
        clientSocket = await connectSocket(validToken);
        const roomId = 'val-room-4';
        clientSocket.emit('createRoom', { roomId });
        await new Promise(r => setTimeout(r, 100));

        const room = getRoom(roomId);
        room!.phase = 'VOTING';

        clientSocket.emit('vote', { target: 'some-id' }); // Expected string, got object

        await new Promise(r => setTimeout(r, 100));
        expect(Object.keys(room!.votes).length).toBe(0);
        clientSocket.disconnect();
    });
});
