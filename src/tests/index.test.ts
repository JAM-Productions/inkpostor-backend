import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('express-rate-limit', () => ({
    default: () => (_req: any, _res: any, next: any) => next(),
}));

import { app, server, io } from '../index';
import { io as Client, Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { getRoom } from '../gameManager';
import { StrokeData, UserPayload, GameRoom, Player } from '../types';
import { AddressInfo } from 'net';

describe('Server API and Socket Integration Tests', () => {
    let port: number;

    const getToken = async (username: string, userId: string) => {
        const res = await request(app).post('/auth').send({ username, userId });

        if (res.status !== 200) {
            throw new Error(
                `Failed to get auth token for user "${username}" (${userId}): expected status 200, got ${res.status}. Response body: ${JSON.stringify(res.body)}`
            );
        }
        const token = res.body?.token;
        if (typeof token !== 'string' || token.length === 0) {
            throw new Error(
                `Failed to get auth token for user "${username}" (${userId}): response did not include a valid token. Response body: ${JSON.stringify(res.body)}`
            );
        }
        return token;
    };

    const connectSocket = (token: string): Promise<Socket> =>
        new Promise((resolve, reject) => {
            const s = Client(`http://localhost:${port}`, {
                reconnectionDelay: 0,
                forceNew: true,
                auth: { token },
            });
            const onConnect = () => {
                cleanup();
                resolve(s);
            };
            const onConnectError = (err: Error) => {
                cleanup();
                s.close();
                reject(err);
            };
            const timeout = setTimeout(() => {
                cleanup();
                s.close();
                reject(new Error('Socket connection timed out'));
            }, 5000);
            const cleanup = () => {
                clearTimeout(timeout);
                s.off('connect', onConnect);
                s.off('connect_error', onConnectError);
            };
            s.once('connect', onConnect);
            s.once('connect_error', onConnectError);
        });

    // Resolves when the socket receives the next `event`
    const waitForEvent = <T = unknown>(
        s: Socket,
        event: string,
        timeoutMs = 5000
    ): Promise<T> =>
        new Promise((resolve, reject) => {
            const onEvent = (payload: T) => {
                clearTimeout(timeoutId);
                resolve(payload);
            };
            const timeoutId = setTimeout(() => {
                s.off(event, onEvent);
                reject(
                    new Error(
                        `Timed out after ${timeoutMs}ms waiting for socket event "${event}"`
                    )
                );
            }, timeoutMs);
            s.once(event, onEvent);
        });

    beforeAll(() => {
        return new Promise<void>((resolve) => {
            server.listen(0, () => {
                const addy = server.address() as AddressInfo;
                port = addy.port;
                resolve();
            });
        });
    });

    afterAll(() => {
        io.close();
        server.close();
    });

    describe('API Endpoints', () => {
        it('GET /health should return 200 OK', async () => {
            const response = await request(app).get('/health');
            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                status: 'OK',
                message: 'Inkpostor backend is running',
            });
        });

        it('POST /auth should reject invalid usernames', async () => {
            const response = await request(app)
                .post('/auth')
                .send({ username: 'ab' });
            expect(response.status).toBe(400); // Too short

            const response2 = await request(app)
                .post('/auth')
                .send({ username: 'invalid name!' });
            expect(response2.status).toBe(400); // Invalid characters
        });

        it('POST /auth should return a token for valid usernames', async () => {
            const testUserId = '00000000-0000-4000-8000-000000000001';
            const response = await request(app)
                .post('/auth')
                .send({ username: 'valid_user', userId: testUserId });
            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('token');

            // Verify token structure
            const payload = jwt.decode(response.body.token) as UserPayload;
            expect(payload.name).toBe('valid_user');
            expect(payload.userId).toBe(testUserId);
        });

        it('POST /auth should generate a server-side UUID when no userId is provided', async () => {
            const response = await request(app)
                .post('/auth')
                .send({ username: 'no_uuid_user' });
            expect(response.status).toBe(200);
            const payload = jwt.decode(response.body.token) as UserPayload;
            expect(payload.name).toBe('no_uuid_user');
            // Server must have generated a non-empty UUID
            expect(typeof payload.userId).toBe('string');
            expect(payload.userId.length).toBeGreaterThan(0);
        });

        it('POST /auth should use the client-provided userId, not generate a new one', async () => {
            const myUUID = '00000000-0000-4000-8000-000000000002';
            const response = await request(app)
                .post('/auth')
                .send({ username: 'uuid_user', userId: myUUID });
            expect(response.status).toBe(200);
            const payload = jwt.decode(response.body.token) as UserPayload;
            expect(payload.userId).toBe(myUUID);
        });

        it('POST /auth two users with same display name should get their own UUIDs', async () => {
            const aliceUuidA = '00000000-0000-4000-8000-000000000003';
            const aliceUuidB = '00000000-0000-4000-8000-000000000004';
            const r1 = await request(app)
                .post('/auth')
                .send({ username: 'Alice', userId: aliceUuidA });
            const r2 = await request(app)
                .post('/auth')
                .send({ username: 'Alice', userId: aliceUuidB });

            const p1 = jwt.decode(r1.body.token) as UserPayload;
            const p2 = jwt.decode(r2.body.token) as UserPayload;

            expect(p1.name).toBe('Alice');
            expect(p2.name).toBe('Alice');
            // The UUIDs must be distinct
            expect(p1.userId).not.toBe(p2.userId);
            expect(p1.userId).toBe(aliceUuidA);
            expect(p2.userId).toBe(aliceUuidB);
        });
    });

    describe('Socket Connections', () => {
        let clientSocket: Socket;
        let validToken: string;

        beforeAll(async () => {
            // Get valid token for socket connections
            const res = await request(app).post('/auth').send({
                username: 'test_socket_user',
                userId: '00000000-0000-4000-8000-000000000005',
            });
            validToken = res.body.token;
        });

        afterAll(() => {
            if (clientSocket && clientSocket.connected) {
                clientSocket.disconnect();
            }
        });

        it(
            'should block connection if no token provided',
            _vitestCleanupPromiseFactory((resolve) => {
                clientSocket = Client(`http://localhost:${port}`, {
                    reconnectionDelay: 0,
                    forceNew: true,
                });

                clientSocket.on('connect_error', (err) => {
                    expect(err.message).toBe(
                        'Authentication error: token missing'
                    );
                    clientSocket.disconnect();
                    resolve();
                });
            })
        );

        it(
            'should block connection if invalid token provided',
            _vitestCleanupPromiseFactory((resolve) => {
                clientSocket = Client(`http://localhost:${port}`, {
                    reconnectionDelay: 0,
                    forceNew: true,
                    auth: { token: 'invalid.token.here' },
                });

                clientSocket.on('connect_error', (err) => {
                    expect(err.message).toBe(
                        'Authentication error: invalid token'
                    );
                    clientSocket.disconnect();
                    resolve();
                });
            })
        );

        it(
            'should connect successfully with valid token',
            _vitestCleanupPromiseFactory((resolve) => {
                clientSocket = Client(`http://localhost:${port}`, {
                    reconnectionDelay: 0,
                    forceNew: true,
                    auth: { token: validToken },
                });

                clientSocket.on('connect', () => {
                    expect(clientSocket.connected).toBe(true);
                    clientSocket.disconnect();
                    resolve();
                });
            })
        );
    });

    describe('Socket Game Room Flow (UUID identity)', () => {
        it('player id in room state should be UUID, not display name', async () => {
            const hostUserId = '00000000-0000-4000-8000-000000000006';
            const token = await getToken('HostPlayer', hostUserId);
            const hostSocket = await connectSocket(token);
            const roomId = 'uuid-id-check-room-2';

            const statePromise = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            const state = await statePromise;

            expect(state.roomId).toBe(roomId);
            expect(state.players.length).toBe(1);
            expect(state.players[0].id).toBe(hostUserId);
            expect(state.players[0].name).toBe('HostPlayer');

            hostSocket.disconnect();
        }, 15_000);

        it('reconnecting player with same UUID should not create a second player slot', async () => {
            const roomId = 'uuid-reconnect-isolated-room';
            const hostToken = await getToken(
                'HostR',
                '00000000-0000-4000-8000-000000000007'
            );
            const playerToken = await getToken(
                'PlayerR',
                '00000000-0000-4000-8000-000000000008'
            );

            const hostSocket = await connectSocket(hostToken);
            const playerSocket = await connectSocket(playerToken);

            // Step 1: Host creates room
            const hostRoomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await hostRoomCreated;

            // Step 2: Player joins
            const playerJoined = waitForEvent<GameRoom>(
                playerSocket,
                'gameStateUpdate'
            );
            playerSocket.emit('joinRoom', { roomId });
            await playerJoined;

            // Step 3: Player disconnects
            playerSocket.disconnect();
            // Small pause to let server process the disconnect
            await new Promise((r) => setTimeout(r, 100));

            // Step 4: Player reconnects with the same UUID
            const reconnectToken = await getToken(
                'PlayerR',
                '00000000-0000-4000-8000-000000000008'
            );
            const reconnectSocket = await connectSocket(reconnectToken);

            const reconnectedState = waitForEvent<GameRoom>(
                reconnectSocket,
                'gameStateUpdate'
            );
            reconnectSocket.emit('joinRoom', { roomId });
            const state = await reconnectedState;

            // Must stay at exactly 2 players (not 3)
            expect(state.players.length).toBe(2);
            const reconnectedPlayer = state.players.find(
                (p: Player) => p.id === '00000000-0000-4000-8000-000000000008'
            );
            expect(reconnectedPlayer).toBeDefined();
            expect(reconnectedPlayer?.isConnected).toBe(true);

            hostSocket.disconnect();
            reconnectSocket.disconnect();
        }, 10_000);

        it('two players with same display name have separate player slots when UUIDs differ', async () => {
            const roomId = 'uuid-name-collision-isolated-room';
            const alice1Token = await getToken(
                'Alice',
                '00000000-0000-4000-8000-000000000009'
            );
            const alice2Token = await getToken(
                'Alice',
                '00000000-0000-4000-8000-000000000010'
            );

            const alice1 = await connectSocket(alice1Token);
            const alice2 = await connectSocket(alice2Token);

            // Step 1: Alice1 creates the room
            const alice1Created = waitForEvent<GameRoom>(
                alice1,
                'gameStateUpdate'
            );
            alice1.emit('createRoom', { roomId });
            await alice1Created;

            // Step 2: Alice2 joins
            const alice2Joined = waitForEvent<GameRoom>(
                alice2,
                'gameStateUpdate'
            );
            alice2.emit('joinRoom', { roomId });
            const state = await alice2Joined;

            // Must have 2 distinct player entries
            expect(state.players.length).toBe(2);
            const ids = state.players.map((p: Player) => p.id);
            expect(ids).toContain('00000000-0000-4000-8000-000000000009');
            expect(ids).toContain('00000000-0000-4000-8000-000000000010');

            alice1.disconnect();
            alice2.disconnect();
        }, 15_000);
    });

    describe('Socket Game Canva Flow', () => {
        it('undoStroke should remove only the latest stroke group', async () => {
            const roomId = 'undo-stroke-latest-group-room';
            const hostUserId = '00000000-0000-4000-8000-000000000011';
            const hostToken = await getToken('UndoHost', hostUserId);
            const hostSocket = await connectSocket(hostToken);

            const roomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await roomCreated;

            const room = getRoom(roomId);
            expect(room).toBeDefined();
            room!.phase = 'DRAWING';
            room!.currentTurnPlayerId = hostUserId;

            const strokes: StrokeData[] = [
                { x: 0, y: 0, color: '#000', isNewStroke: true },
                { x: 1, y: 1, color: '#000', isNewStroke: false },
                { x: 2, y: 2, color: '#000', isNewStroke: true },
                { x: 3, y: 3, color: '#000', isNewStroke: false },
            ];

            strokes.forEach((stroke) => hostSocket.emit('drawStroke', stroke));
            await new Promise((resolve) => setTimeout(resolve, 50));

            const strokeUndone = waitForEvent(hostSocket, 'strokeUndone');
            hostSocket.emit('undoStroke');
            await strokeUndone;

            expect(room!.canvasStrokes).toEqual(strokes.slice(0, 2));

            hostSocket.disconnect();
        }, 15_000);
    });

    describe('Socket End Game Flow', () => {
        it('endGame should properly set gameEnded flag to true', async () => {
            const roomId = 'end-game-flow-room';
            const hostUserId = '00000000-0000-4000-8000-000000000012';
            const hostToken = await getToken('EndGameHost', hostUserId);
            const hostSocket = await connectSocket(hostToken);

            const roomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await roomCreated;
            const room = getRoom(roomId);
            expect(room).toBeDefined();

            const endGameEvent = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('endGame');
            const state = await endGameEvent;
            expect(state.gameEnded).toBe(true);

            hostSocket.disconnect();
        }, 15_000);
    });

    describe('Socket Game Emergency Voting Flow', () => {
        it('should handle startEmergencyVoting socket event correctly', async () => {
            const roomId = 'test-room-emergency';
            const userId = '00000000-0000-4000-8000-000000000006';
            const token = await getToken('TestUser', userId);
            const clientSocket = await connectSocket(token);

            const roomCreated = waitForEvent<GameRoom>(
                clientSocket,
                'gameStateUpdate'
            );
            clientSocket.emit('createRoom', { roomId });
            await roomCreated;

            const room = getRoom(roomId);
            expect(room).toBeDefined();
            room!.phase = 'DRAWING';

            const votingStarted = waitForEvent<GameRoom>(
                clientSocket,
                'gameStateUpdate'
            );
            clientSocket.emit('startEmergencyVoting');
            const updatedRoom = await votingStarted;

            expect(updatedRoom.phase).toBe('VOTING');
            expect(
                updatedRoom.players.find((p) => p.id === userId)!
                    .hasStartedEmergencyVoting
            ).toBe(true);

            clientSocket.disconnect();
        }, 15_000);
    });
});

// Helper for async callbacks
function _vitestCleanupPromiseFactory(callback: (resolve: () => void) => void) {
    return () => new Promise<void>((resolve) => callback(resolve));
}
