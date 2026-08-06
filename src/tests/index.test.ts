import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('express-rate-limit', () => ({
    default: () => (_req: any, _res: any, next: any) => next(),
}));

import { app, server, io } from '../index';
import { io as Client, Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { getRoom } from '../gameManager';
import {
    StrokeData,
    UserPayload,
    GameRoom,
    Player,
    GameOptions,
} from '../types';
import { DEFAULT_GAME_OPTIONS } from '../constants';
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

        it('re-sends roleAssignment when a player reconnects mid-game', async () => {
            type Role = {
                isImpostor: boolean;
                secretWord: string | null;
                secretCategory: string | null;
            };

            const roomId = 'reconnect-role-room';
            const hostId = '00000000-0000-4000-8000-000000000031';
            const p1Id = '00000000-0000-4000-8000-000000000032';
            const p2Id = '00000000-0000-4000-8000-000000000033';
            const hostToken = await getToken('RoleHost', hostId);
            const p1Token = await getToken('RolePlayer1', p1Id);
            const p2Token = await getToken('RolePlayer2', p2Id);

            const hostSocket = await connectSocket(hostToken);
            const p1Socket = await connectSocket(p1Token);
            const p2Socket = await connectSocket(p2Token);

            hostSocket.emit('createRoom', { roomId });
            await waitForEvent(hostSocket, 'gameStateUpdate');
            p1Socket.emit('joinRoom', { roomId });
            await waitForEvent(p1Socket, 'gameStateUpdate');
            p2Socket.emit('joinRoom', { roomId });
            await waitForEvent(p2Socket, 'gameStateUpdate');

            // Start the game and capture each player's private role assignment.
            const roleEvents = Promise.all([
                waitForEvent<Role>(hostSocket, 'roleAssignment'),
                waitForEvent<Role>(p1Socket, 'roleAssignment'),
                waitForEvent<Role>(p2Socket, 'roleAssignment'),
            ]);
            hostSocket.emit('startGame');
            const [hostRole, p1Role, p2Role] = await roleEvents;

            const participants = [
                { socket: hostSocket, id: hostId, role: hostRole },
                { socket: p1Socket, id: p1Id, role: p1Role },
                { socket: p2Socket, id: p2Id, role: p2Role },
            ];
            const impostor = participants.find((p) => p.role.isImpostor)!;
            expect(impostor).toBeDefined();

            // The impostor drops and reconnects with the same UUID.
            impostor.socket.disconnect();
            await new Promise((r) => setTimeout(r, 100));

            const reToken = await getToken('ReconnImpostor', impostor.id);
            const reconnectSocket = await connectSocket(reToken);
            const recoveredRolePromise = waitForEvent<Role>(
                reconnectSocket,
                'roleAssignment'
            );
            reconnectSocket.emit('joinRoom', { roomId });
            const recoveredRole = await recoveredRolePromise;

            // The reconnecting impostor recovers their role (so the
            // IMPOSTOR_GUESS form renders again instead of the waiting screen).
            expect(recoveredRole.isImpostor).toBe(true);
            expect(recoveredRole.secretWord).toBeNull();

            participants
                .filter((p) => p.id !== impostor.id)
                .forEach((p) => p.socket.disconnect());
            reconnectSocket.disconnect();
        }, 15_000);

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

    describe('Socket Game Options Flow', () => {
        it('should broadcast updated game options when the host changes them in the lobby', async () => {
            const roomId = 'game-options-socket-room';
            const hostUserId = '00000000-0000-4000-8000-000000000018';
            const playerUserId = '00000000-0000-4000-8000-000000000019';
            const hostToken = await getToken('OptionsHost', hostUserId);
            const playerToken = await getToken('OptionsPlayer', playerUserId);

            const hostSocket = await connectSocket(hostToken);
            const playerSocket = await connectSocket(playerToken);

            const roomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await roomCreated;

            const playerJoined = waitForEvent<GameRoom>(
                playerSocket,
                'gameStateUpdate'
            );
            const hostSawJoin = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            playerSocket.emit('joinRoom', { roomId });
            await Promise.all([playerJoined, hostSawJoin]);

            const nextHostState = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            const nextPlayerState = waitForEvent<GameRoom>(
                playerSocket,
                'gameStateUpdate'
            );

            const updatedOptions: GameOptions = {
                roundTime: 40,
                unlimitedInk: true,
                clearCanvasEachRound: false,
                playerColorsEnabled: true,
                impostorGuessEnabled: true,
                impostorGuessAttempts: 3,
                impostorLosesWhenOutOfGuesses: true,
                hideHint: true,
                turnOrderMode: 'RANDOM_STARTER',
            };

            hostSocket.emit('updateGameOptions', updatedOptions);

            const [hostState, playerState] = await Promise.all([
                nextHostState,
                nextPlayerState,
            ]);

            expect(hostState.gameOptions).toEqual(updatedOptions);
            expect(playerState.gameOptions).toEqual(updatedOptions);

            const room = getRoom(roomId);
            expect(room?.gameOptions).toEqual(updatedOptions);

            hostSocket.disconnect();
            playerSocket.disconnect();
        }, 15_000);

        it('should ignore invalid game option fields from the socket payload', async () => {
            const hostToken = await getToken('Hoster', 'host-options-sanitize');
            const playerToken = await getToken(
                'Guest',
                'guest-options-sanitize'
            );
            const hostSocket = await connectSocket(hostToken);
            const playerSocket = await connectSocket(playerToken);
            const roomId = `room-${Date.now()}-sanitize`;

            const roomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await roomCreated;

            const playerJoined = waitForEvent<GameRoom>(
                playerSocket,
                'gameStateUpdate'
            );
            const hostSawJoin = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            playerSocket.emit('joinRoom', { roomId });
            await Promise.all([playerJoined, hostSawJoin]);

            const nextHostState = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            const nextPlayerState = waitForEvent<GameRoom>(
                playerSocket,
                'gameStateUpdate'
            );

            hostSocket.emit('updateGameOptions', {
                roundTime: 'oops',
                unlimitedInk: true,
                clearCanvasEachRound: 'still nope',
                unexpected: 'ignored',
            });

            const [hostState, playerState] = await Promise.all([
                nextHostState,
                nextPlayerState,
            ]);

            expect(hostState.gameOptions).toEqual({
                ...DEFAULT_GAME_OPTIONS,
                unlimitedInk: true,
            });
            expect(playerState.gameOptions).toEqual(hostState.gameOptions);

            const room = getRoom(roomId);
            expect(room?.gameOptions).toEqual(hostState.gameOptions);
            expect('unexpected' in (room?.gameOptions ?? {})).toBe(false);

            hostSocket.disconnect();
            playerSocket.disconnect();
        }, 15_000);
    });

    describe('Socket Game Mode & Custom Word Flow', () => {
        interface RoleAssignment {
            isImpostor: boolean;
            secretWord: string | null;
            secretCategory: string | null;
        }

        it('should apply the host game mode immediately and ignore non-hosts', async () => {
            const roomId = 'game-mode-socket-room';
            const hostToken = await getToken(
                'ModeHost',
                '00000000-0000-4000-8000-000000000030'
            );
            const playerToken = await getToken(
                'ModePlayer',
                '00000000-0000-4000-8000-000000000031'
            );

            const hostSocket = await connectSocket(hostToken);
            const playerSocket = await connectSocket(playerToken);

            const roomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await roomCreated;

            const playerJoined = waitForEvent<GameRoom>(
                playerSocket,
                'gameStateUpdate'
            );
            const hostSawJoin = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            playerSocket.emit('joinRoom', { roomId });
            await Promise.all([playerJoined, hostSawJoin]);

            const nextHostState = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            const nextPlayerState = waitForEvent<GameRoom>(
                playerSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('updateGameOptions', { gameMode: 'CUSTOM_WORD' });

            const [hostState, playerState] = await Promise.all([
                nextHostState,
                nextPlayerState,
            ]);
            expect(hostState.gameMode).toBe('CUSTOM_WORD');
            expect(playerState.gameMode).toBe('CUSTOM_WORD');

            // A non-host trying to change the mode is ignored
            playerSocket.emit('updateGameOptions', { gameMode: 'CLASSIC' });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(getRoom(roomId)?.gameMode).toBe('CUSTOM_WORD');

            hostSocket.disconnect();
            playerSocket.disconnect();
        }, 15_000);

        it('should run the WORD_SELECTION phase without leaking the submitted words', async () => {
            const roomId = 'custom-word-socket-room';
            const userIds = [
                '00000000-0000-4000-8000-000000000032',
                '00000000-0000-4000-8000-000000000033',
                '00000000-0000-4000-8000-000000000034',
            ];
            const words = ['Lighthouse', 'Volcano', 'Submarine'];
            const sockets = await Promise.all(
                userIds.map(async (userId, index) =>
                    connectSocket(await getToken(`WordP${index}`, userId))
                )
            );
            const [hostSocket] = sockets;

            const roomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await roomCreated;

            for (const s of sockets.slice(1)) {
                const joined = waitForEvent<GameRoom>(s, 'gameStateUpdate');
                s.emit('joinRoom', { roomId });
                await joined;
            }

            hostSocket.emit('updateGameOptions', { gameMode: 'CUSTOM_WORD' });
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Roles must NOT be handed out before the word exists
            let earlyRoles = 0;
            sockets.forEach((s) => s.on('roleAssignment', () => earlyRoles++));

            const started = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('startGame');
            const startedState = await started;
            expect(startedState.phase).toBe('WORD_SELECTION');
            expect(startedState.secretWord).toBeNull();
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(earlyRoles).toBe(0);

            const impostorId = getRoom(roomId)!.impostorId;
            const impostorIndex = userIds.indexOf(impostorId!);
            const impostorWord = words[impostorIndex];

            // Everyone submits; the last submission resolves the phase
            const roles = sockets.map((s) =>
                waitForEvent<RoleAssignment>(s, 'roleAssignment')
            );
            for (let i = 0; i < sockets.length - 1; i++) {
                sockets[i].emit('submitCustomWord', { word: words[i] });
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(getRoom(roomId)!.phase).toBe('WORD_SELECTION');

            const finalStates = sockets.map((s) =>
                waitForEvent<GameRoom>(s, 'gameStateUpdate')
            );
            const last = sockets.length - 1;
            sockets[last].emit('submitCustomWord', { word: words[last] });

            const assignments = await Promise.all(roles);
            const states = await Promise.all(finalStates);

            const room = getRoom(roomId)!;
            expect(room.phase).toBe('ROLE_REVEAL');
            expect(room.secretWord).not.toBe(impostorWord);
            expect(words).toContain(room.secretWord);

            assignments.forEach((assignment, index) => {
                expect(assignment.secretCategory).toBe('Special');
                if (userIds[index] === impostorId) {
                    expect(assignment.isImpostor).toBe(true);
                    expect(assignment.secretWord).toBeNull();
                } else {
                    expect(assignment.isImpostor).toBe(false);
                    expect(assignment.secretWord).toBe(room.secretWord);
                }
            });

            // The broadcast state exposes the submission flag but never the words
            states.forEach((state) => {
                expect(state.phase).toBe('ROLE_REVEAL');
                state.players.forEach((player: Player) => {
                    expect(player.hasSubmittedWord).toBe(true);
                    expect('customWord' in player).toBe(false);
                });
            });

            sockets.forEach((s) => s.disconnect());
        }, 20_000);
    });

    it('should not hand out roles while the players are still writing their word', async () => {
        const roomId = 'word-selection-reconnect-room';
        const userIds = [
            '00000000-0000-4000-8000-000000000050',
            '00000000-0000-4000-8000-000000000051',
            '00000000-0000-4000-8000-000000000052',
        ];
        const tokens = await Promise.all(
            userIds.map((userId, index) => getToken(`RejoinP${index}`, userId))
        );
        const sockets = await Promise.all(tokens.map(connectSocket));
        const [hostSocket] = sockets;

        const roomCreated = waitForEvent<GameRoom>(
            hostSocket,
            'gameStateUpdate'
        );
        hostSocket.emit('createRoom', { roomId });
        await roomCreated;

        for (const s of sockets.slice(1)) {
            const joined = waitForEvent<GameRoom>(s, 'gameStateUpdate');
            s.emit('joinRoom', { roomId });
            await joined;
        }

        hostSocket.emit('updateGameOptions', { gameMode: 'CUSTOM_WORD' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        hostSocket.emit('startGame');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(getRoom(roomId)!.phase).toBe('WORD_SELECTION');

        // A player reloads the page mid-writing: the replacement connection
        // drops the previous socket, so let that settle before rejoining.
        const reconnected = await connectSocket(tokens[1]);
        await new Promise((resolve) => setTimeout(resolve, 200));

        let roleAssignments = 0;
        reconnected.on('roleAssignment', () => roleAssignments++);

        const rejoined = waitForEvent<GameRoom>(reconnected, 'gameStateUpdate');
        reconnected.emit('joinRoom', { roomId });
        expect((await rejoined).phase).toBe('WORD_SELECTION');
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Their role exists on the server already, but the game has revealed
        // nothing yet — so nothing about it may reach the client.
        expect(roleAssignments).toBe(0);

        // Same for a language change, which goes through the same branch
        reconnected.emit('setLanguage', { language: 'es' });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(roleAssignments).toBe(0);

        // Once the phase resolves, they do get their role like everyone else
        const activeSockets = [sockets[0], reconnected, sockets[2]];
        for (const s of activeSockets) {
            s.emit('submitCustomWord', { word: 'Lighthouse' });
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(getRoom(roomId)!.phase).toBe('ROLE_REVEAL');
        expect(roleAssignments).toBe(1);

        activeSockets.forEach((s) => s.disconnect());
    }, 20_000);

    describe('Socket Hot Word Flow', () => {
        interface RoleAssignment {
            isImpostor: boolean;
            secretWord: string | null;
            secretCategory: string | null;
        }

        it('should reveal a new word every round, before announcing the phase', async () => {
            const roomId = 'hot-word-socket-room';
            const userIds = [
                '00000000-0000-4000-8000-000000000040',
                '00000000-0000-4000-8000-000000000041',
                '00000000-0000-4000-8000-000000000042',
            ];
            const sockets = await Promise.all(
                userIds.map(async (userId, index) =>
                    connectSocket(await getToken(`HotP${index}`, userId))
                )
            );
            const [hostSocket] = sockets;

            const roomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await roomCreated;

            for (const s of sockets.slice(1)) {
                const joined = waitForEvent<GameRoom>(s, 'gameStateUpdate');
                s.emit('joinRoom', { roomId });
                await joined;
            }

            hostSocket.emit('updateGameOptions', { gameMode: 'HOT_WORD' });
            await new Promise((resolve) => setTimeout(resolve, 100));

            const firstRoles = sockets.map((s) =>
                waitForEvent<RoleAssignment>(s, 'roleAssignment')
            );
            hostSocket.emit('startGame');
            await Promise.all(firstRoles);
            const firstWord = getRoom(roomId)!.secretWord;
            const impostorId = getRoom(roomId)!.impostorId;

            // Skip the round itself and jump straight to the results screen
            getRoom(roomId)!.phase = 'RESULTS';

            for (const s of sockets.slice(0, -1)) {
                s.emit('nextRound');
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(getRoom(roomId)!.phase).toBe('RESULTS');

            // Record the order in which the last player sees both events
            const sequence: string[] = [];
            const last = sockets[sockets.length - 1];
            last.on('roleAssignment', () => sequence.push('roleAssignment'));
            last.on('gameStateUpdate', (state: GameRoom) =>
                sequence.push(`gameStateUpdate:${state.phase}`)
            );

            const newRoles = sockets.map((s) =>
                waitForEvent<RoleAssignment>(s, 'roleAssignment')
            );
            last.emit('nextRound');
            const assignments = await Promise.all(newRoles);
            await new Promise((resolve) => setTimeout(resolve, 100));

            const room = getRoom(roomId)!;
            expect(room.phase).toBe('WORD_REVEAL');
            expect(room.currentRound).toBe(2);
            expect(room.secretWord).not.toBe(firstWord);
            expect(room.impostorId).toBe(impostorId);

            // The word must land before the phase that shows it on screen,
            // otherwise the reveal renders the previous round's word.
            expect(sequence).toEqual([
                'roleAssignment',
                'gameStateUpdate:WORD_REVEAL',
            ]);

            assignments.forEach((assignment, index) => {
                expect(assignment.secretCategory).not.toBeNull();
                if (userIds[index] === impostorId) {
                    expect(assignment.secretWord).toBeNull();
                } else {
                    expect(assignment.secretWord).toBe(room.secretWord);
                }
            });

            // Everyone confirms the new word and the round starts
            for (const s of sockets) {
                s.emit('confirmNewWord');
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(getRoom(roomId)!.phase).toBe('DRAWING');

            sockets.forEach((s) => s.disconnect());
        }, 20_000);
    });

    describe('Socket Original Mode Flow', () => {
        interface RoleAssignment {
            isImpostor: boolean;
            secretWord: string | null;
            secretCategory: string | null;
        }

        // Lobby of three players sitting in a spoken mode, ready to start.
        const setupLobby = async (
            roomId: string,
            idSuffix: string,
            gameMode: string = 'ORIGINAL'
        ) => {
            const userIds = [0, 1, 2].map(
                (n) => `00000000-0000-4000-8000-0000000000${idSuffix}${n}`
            );
            const sockets = await Promise.all(
                userIds.map(async (userId, index) =>
                    connectSocket(await getToken(`OrigP${index}`, userId))
                )
            );
            const [hostSocket] = sockets;

            const roomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await roomCreated;

            for (const s of sockets.slice(1)) {
                const joined = waitForEvent<GameRoom>(s, 'gameStateUpdate');
                s.emit('joinRoom', { roomId });
                await joined;
            }

            hostSocket.emit('updateGameOptions', { gameMode });
            await new Promise((resolve) => setTimeout(resolve, 100));

            return { sockets, userIds, hostSocket };
        };

        it('should run ROLE_REVEAL -> ORDER_INFO -> VOTING without ever drawing', async () => {
            const roomId = 'original-socket-room';
            const { sockets, hostSocket } = await setupLobby(roomId, '5');

            const roles = sockets.map((s) =>
                waitForEvent<RoleAssignment>(s, 'roleAssignment')
            );
            hostSocket.emit('startGame');
            await Promise.all(roles);
            expect(getRoom(roomId)!.phase).toBe('ROLE_REVEAL');

            for (const s of sockets) {
                s.emit('proceedToDrawing');
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(getRoom(roomId)!.phase).toBe('ORDER_INFO');

            // The order screen is a read-receipt gate: nothing moves until the
            // last player confirms.
            for (const s of sockets.slice(0, -1)) {
                s.emit('confirmOrder');
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(getRoom(roomId)!.phase).toBe('ORDER_INFO');

            const votingReached = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            sockets[sockets.length - 1].emit('confirmOrder');
            const state = await votingReached;

            expect(state.phase).toBe('VOTING');
            expect(getRoom(roomId)!.canvasStrokes).toEqual([]);

            sockets.forEach((s) => s.disconnect());
        }, 20_000);

        it('should keep the category from the impostor when hideHint is on', async () => {
            const roomId = 'original-hide-hint-room';
            const { sockets, userIds, hostSocket } = await setupLobby(
                roomId,
                '6'
            );

            hostSocket.emit('updateGameOptions', { hideHint: true });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(getRoom(roomId)!.gameOptions.hideHint).toBe(true);

            const roles = sockets.map((s) =>
                waitForEvent<RoleAssignment>(s, 'roleAssignment')
            );
            const states = sockets.map((s) =>
                waitForEvent<GameRoom>(s, 'gameStateUpdate')
            );
            hostSocket.emit('startGame');
            const [assignments, gameStates] = await Promise.all([
                Promise.all(roles),
                Promise.all(states),
            ]);

            const impostorId = getRoom(roomId)!.impostorId;
            assignments.forEach((assignment, index) => {
                const isImpostor = userIds[index] === impostorId;
                expect(assignment.isImpostor).toBe(isImpostor);
                // The category must be missing from BOTH payloads: it rides
                // along in the broadcast state as well as in the role.
                if (isImpostor) {
                    expect(assignment.secretCategory).toBeNull();
                    expect(gameStates[index].secretCategory).toBeNull();
                } else {
                    expect(assignment.secretCategory).not.toBeNull();
                    expect(assignment.secretWord).not.toBeNull();
                }
            });

            sockets.forEach((s) => s.disconnect());
        }, 20_000);

        it('should open ORIGINAL_CHAOS on WORD_SELECTION and never translate the written word', async () => {
            const roomId = 'original-chaos-room';
            const { sockets, userIds, hostSocket } = await setupLobby(
                roomId,
                '7',
                'ORIGINAL_CHAOS'
            );

            // Everyone plays in Spanish, and the word they write is also a key
            // of the translation table — it must still arrive exactly as typed.
            sockets.forEach((s) => s.emit('setLanguage', { language: 'es' }));
            await new Promise((resolve) => setTimeout(resolve, 100));

            const started = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('startGame');
            expect((await started).phase).toBe('WORD_SELECTION');

            const impostorId = getRoom(roomId)!.impostorId;
            const roles = sockets.map((s) =>
                waitForEvent<RoleAssignment>(s, 'roleAssignment')
            );
            for (const s of sockets) {
                s.emit('submitCustomWord', { word: 'Dog' });
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const assignments = await Promise.all(roles);

            expect(getRoom(roomId)!.phase).toBe('ROLE_REVEAL');
            assignments.forEach((assignment, index) => {
                if (userIds[index] === impostorId) return;
                // "Perro" would mean the player-written word went through the
                // translation table
                expect(assignment.secretWord).toBe('Dog');
            });

            // ...and from there it runs as ORIGINAL: no drawing
            for (const s of sockets) {
                s.emit('proceedToDrawing');
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(getRoom(roomId)!.phase).toBe('ORDER_INFO');

            sockets.forEach((s) => s.disconnect());
        }, 20_000);
    });

    describe('Socket Kick Player Flow', () => {
        const getToken = async (username: string, userId: string) => {
            const res = await request(app)
                .post('/auth')
                .send({ username, userId });
            return res.body.token as string;
        };

        const connectSocket = (token: string): Promise<Socket> =>
            new Promise((resolve) => {
                const s = Client(`http://localhost:${port}`, {
                    reconnectionDelay: 0,
                    forceNew: true,
                    auth: { token },
                });
                s.on('connect', () => resolve(s));
            });

        const waitForEvent = <T = unknown>(
            s: Socket,
            event: string
        ): Promise<T> => new Promise((resolve) => s.once(event, resolve));

        it('should notify and disconnect the kicked player and remove them from room state', async () => {
            const roomId = 'kick-player-socket-room';
            const hostUserId = '00000000-0000-4000-8000-000000000013';
            const playerUserId = '00000000-0000-4000-8000-000000000014';
            const hostToken = await getToken('KickHost', hostUserId);
            const playerToken = await getToken('KickTarget', playerUserId);

            const hostSocket = await connectSocket(hostToken);
            const playerSocket = await connectSocket(playerToken);

            const roomCreated = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            hostSocket.emit('createRoom', { roomId });
            await roomCreated;

            const playerJoined = waitForEvent<GameRoom>(
                playerSocket,
                'gameStateUpdate'
            );
            const hostSawJoin = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            playerSocket.emit('joinRoom', { roomId });
            await Promise.all([playerJoined, hostSawJoin]);

            const hostUpdatedRoom = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );
            const kickedNotice = waitForEvent<string>(playerSocket, 'kicked');
            const playerDisconnected = new Promise<string>((resolve) =>
                playerSocket.once('disconnect', resolve)
            );

            hostSocket.emit('kickPlayer', playerUserId);

            const [updatedRoom, kickedMessage, disconnectReason] =
                await Promise.all([
                    hostUpdatedRoom,
                    kickedNotice,
                    playerDisconnected,
                ]);

            expect(kickedMessage).toBe('You were kicked from the room');
            expect(disconnectReason).toBe('io server disconnect');
            expect(updatedRoom.players.map((p: Player) => p.id)).toEqual([
                hostUserId,
            ]);
            expect(getRoom(roomId)?.players.map((p) => p.id)).toEqual([
                hostUserId,
            ]);
            expect(playerSocket.connected).toBe(false);

            hostSocket.disconnect();
        }, 15_000);

        it('voteKickPlayer should notify, disconnect target, and broadcast state update when threshold is met', async () => {
            const roomId = 'vote-kick-socket-room';
            const hostUserId = '00000000-0000-4000-8000-000000000015';
            const player1Id = '00000000-0000-4000-8000-000000000016';
            const player2Id = '00000000-0000-4000-8000-000000000017';
            const hostToken = await getToken('VoteHost', hostUserId);
            const p1Token = await getToken('VoteTarget', player1Id);
            const p2Token = await getToken('VoteVoter', player2Id);

            const hostSocket = await connectSocket(hostToken);
            const p1Socket = await connectSocket(p1Token);
            const p2Socket = await connectSocket(p2Token);

            hostSocket.emit('createRoom', { roomId });
            await waitForEvent(hostSocket, 'gameStateUpdate');

            p1Socket.emit('joinRoom', { roomId });
            await Promise.all([
                waitForEvent(p1Socket, 'gameStateUpdate'),
                waitForEvent(hostSocket, 'gameStateUpdate'),
            ]);

            p2Socket.emit('joinRoom', { roomId });
            await Promise.all([
                waitForEvent(p2Socket, 'gameStateUpdate'),
                waitForEvent(p1Socket, 'gameStateUpdate'),
                waitForEvent(hostSocket, 'gameStateUpdate'),
            ]);

            // Start game
            hostSocket.emit('startGame');
            await Promise.all([
                waitForEvent(hostSocket, 'gameStateUpdate'),
                waitForEvent(p1Socket, 'gameStateUpdate'),
                waitForEvent(p2Socket, 'gameStateUpdate'),
            ]);

            // Proceed to drawing
            hostSocket.emit('proceedToDrawing');
            p1Socket.emit('proceedToDrawing');
            p2Socket.emit('proceedToDrawing');
            await new Promise((resolve) => setTimeout(resolve, 200));

            // Setup listeners for ejection
            const kickedNotice = waitForEvent<string>(p1Socket, 'kicked');
            const playerDisconnected = new Promise<string>((resolve) =>
                p1Socket.once('disconnect', resolve)
            );

            // Host votes P1
            hostSocket.emit('voteKickPlayer', { targetId: player1Id });
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Setup listener for final threshold
            const finalHostUpdatedRoom = waitForEvent<GameRoom>(
                hostSocket,
                'gameStateUpdate'
            );

            // P2 votes P1 (Threshold met, 2 active voters)
            p2Socket.emit('voteKickPlayer', { targetId: player1Id });

            const [updatedRoom, kickedMessage, disconnectReason] =
                await Promise.all([
                    finalHostUpdatedRoom,
                    kickedNotice,
                    playerDisconnected,
                ]);

            expect(kickedMessage).toBe('You were kicked from the room by vote');
            expect(disconnectReason).toBe('io server disconnect');
            expect(
                updatedRoom.players.find((p: Player) => p.id === player1Id)
            ).toBeUndefined();

            hostSocket.disconnect();
            p2Socket.disconnect();
        }, 15_000);
    });
});

// Helper for async callbacks
function _vitestCleanupPromiseFactory(callback: (resolve: () => void) => void) {
    return () => new Promise<void>((resolve) => callback(resolve));
}
