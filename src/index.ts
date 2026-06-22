import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import { randomUUID } from 'crypto';
import {
    createRoom,
    joinRoom,
    getRoom,
    leaveRoom,
    startGame,
    proceedToDrawing,
    nextTurn,
    addStroke,
    castVote,
    playAgain,
    undoStroke,
    nextRound,
    endGame,
    startEmergencyVoting,
    kickPlayer,
    voteKickPlayer,
    updateGameOptions,
    submitImpostorGuess,
    skipImpostorGuess,
} from './gameManager';
import { Player, StrokeData, UserPayload } from './types';
import wordTranslations from './wordTranslations.json';

dotenv.config();

const SECRET_KEY = process.env.JWT_SECRET;
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || '100', 10);

if (!SECRET_KEY) {
    throw new Error('JWT_SECRET is not defined');
}

const corsOptions = {
    origin: process.env.INKPOSTOR_FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
};

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many requests, please try again later',
});

const app = express();
app.use(morgan('combined'));
app.use(cors(corsOptions));
app.use(express.json());
app.use('/auth', limiter);

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        message: 'Inkpostor backend is running',
    });
});

app.post('/auth', (req, res) => {
    const origin = req.headers.origin;
    // Allow if origin matches, or if we are in test environment where origin is undefined
    if (origin !== corsOptions.origin && process.env.NODE_ENV !== 'test') {
        return res.status(403).json({ message: 'Forbidden' });
    }
    const { username, userId } = req.body;
    if (!username)
        return res.status(400).json({ message: 'Username required' });
    //Sanitize username
    const sanitizedUsername = username.trim();
    if (sanitizedUsername.length > 20 || sanitizedUsername.length < 3)
        return res.status(400).json({
            message:
                'Invalid username. Username must be between 3 and 20 characters',
        });
    if (!/^[a-zA-Z0-9_]+$/.test(sanitizedUsername))
        return res.status(400).json({
            message:
                'Invalid username. Username can only contain letters, numbers, and underscores',
        });
    const UUID_REGEX =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const persistentUserId =
        typeof userId === 'string' && UUID_REGEX.test(userId)
            ? userId
            : randomUUID();
    const token = generateToken(sanitizedUsername, persistentUserId);
    res.json({ token });
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: corsOptions,
});

const socketToRoom: Record<string, string> = {};
const userIdToSocketId: Record<string, string> = {};

function leaveCurrentRoom(socket: Socket) {
    const user = socket.user;
    const roomId = socketToRoom[socket.id];
    if (roomId && user) {
        leaveRoom(roomId, user.userId);
        const room = getRoom(roomId);
        if (room) {
            broadcastGameState(roomId);
        }
        socket.leave(roomId);
        delete socketToRoom[socket.id];
    }
}

io.use((socket, next) => {
    if (io.engine.clientsCount > MAX_CONNECTIONS) {
        return next(
            new Error(
                'Connection error: Maximum concurrent connections reached'
            )
        );
    }

    const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers['authorization'];
    if (!token) {
        return next(new Error('Authentication error: token missing'));
    }
    try {
        const payload = jwt.verify(token as string, SECRET_KEY);
        if (
            typeof payload === 'object' &&
            payload !== null &&
            'userId' in payload &&
            'name' in payload &&
            typeof payload.userId === 'string' &&
            typeof payload.name === 'string'
        ) {
            // Attach user info to socket for later use
            socket.user = payload as unknown as UserPayload;
            next();
        } else {
            next(new Error('Authentication error: invalid token payload'));
        }
    } catch {
        next(new Error('Authentication error: invalid token'));
    }
});

io.on('connection', (socket: Socket) => {
    console.log('User connected:', socket.id);
    const connectingUser = socket.user;
    if (connectingUser?.userId) {
        const prevSocketId = userIdToSocketId[connectingUser.userId];
        if (prevSocketId && prevSocketId !== socket.id) {
            const prevSocket = io.sockets.sockets.get(prevSocketId);
            if (prevSocket) {
                prevSocket.emit('error', 'Replaced by a newer connection');
                prevSocket.disconnect(true);
            }
        }
        userIdToSocketId[connectingUser.userId] = socket.id;
    }

    socket.on('createRoom', ({ roomId, language }) => {
        const user = socket.user;
        leaveCurrentRoom(socket);
        createRoom(roomId, user.userId);
        const player: Player = {
            id: user.userId,
            name: user.name,
            isConnected: true,
            score: 0,
            hasStartedEmergencyVoting: false,
            language: typeof language === 'string' ? language : 'en',
        };
        const room = joinRoom(roomId, player);
        if (room) {
            socket.join(roomId);
            socketToRoom[socket.id] = roomId;
            broadcastGameState(roomId);
        }
    });

    socket.on('joinRoom', ({ roomId, language }) => {
        const user = socket.user;
        leaveCurrentRoom(socket);
        let room = getRoom(roomId);
        if (!room) {
            // Auto-create room if it doesn't exist for MVP simplicity
            room = createRoom(roomId, user.userId);
        }
        const player: Player = {
            id: user.userId,
            name: user.name,
            isConnected: true,
            score: 0,
            hasStartedEmergencyVoting: false,
            language: typeof language === 'string' ? language : 'en',
        };
        const joinedRoom = joinRoom(roomId, player);
        if (joinedRoom) {
            socket.join(roomId);
            socketToRoom[socket.id] = roomId;
            broadcastGameState(roomId);

            // If the player reconnected into an in-progress game, re-send their
            // private role so they recover amIImpostor / secretWord / category
            // (otherwise a page reload loses it — e.g. the IMPOSTOR_GUESS form).
            if (joinedRoom.impostorId) {
                const isImpostor = user.userId === joinedRoom.impostorId;
                const playerLanguage = player.language || 'en';
                socket.emit('roleAssignment', {
                    isImpostor,
                    secretWord: isImpostor
                        ? null
                        : translateWord(joinedRoom.secretWord, playerLanguage),
                    secretCategory: translateWord(
                        joinedRoom.secretCategory,
                        playerLanguage
                    ),
                });
            }
        } else {
            socket.emit('error', 'Cannot join room');
        }
    });

    socket.on('startGame', () => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = startGame(roomId, user.userId);
        if (room) {
            // Send global state to everyone EXCEPT the secret word and impostor status
            broadcastGameState(roomId);

            // Send private roles directly to each player's socket
            room.players.forEach((p) => {
                const targetSocketId = userIdToSocketId[p.id];
                if (!targetSocketId) return;
                const isImpostor = p.id === room.impostorId;
                const playerLanguage = p.language || 'en';
                io.to(targetSocketId).emit('roleAssignment', {
                    isImpostor,
                    secretWord: isImpostor
                        ? null
                        : translateWord(room.secretWord, playerLanguage),
                    secretCategory: translateWord(
                        room.secretCategory,
                        playerLanguage
                    ),
                });
            });
        }
    });

    socket.on('proceedToDrawing', () => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = proceedToDrawing(roomId, user.userId);
        if (room) {
            broadcastGameState(roomId);
        }
    });

    socket.on('drawStroke', (stroke: StrokeData) => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = addStroke(roomId, user.userId, stroke);
        if (room) {
            // Broadcast stroke to others instantly for smooth drawing
            socket.to(roomId).emit('strokeUpdate', stroke);
        }
    });

    socket.on('undoStroke', () => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = undoStroke(roomId, user.userId);
        if (room) {
            io.to(roomId).emit('strokeUndone');
        }
    });

    socket.on('endTurn', () => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = nextTurn(roomId, user.userId);
        if (room) {
            broadcastGameState(roomId);
        }
    });

    socket.on('vote', (votedForId: string) => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = castVote(roomId, user.userId, votedForId);
        if (room) {
            broadcastGameState(roomId);
        }
    });

    socket.on('submitImpostorGuess', (payload: unknown) => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const guess =
            typeof payload === 'string'
                ? payload
                : isObjectWithGuess(payload)
                  ? payload.guess
                  : undefined;
        const language = isObjectWithGuess(payload)
            ? payload.language
            : undefined;
        const room = submitImpostorGuess(roomId, user.userId, guess, language);
        if (!room) return;
        if (room.phase === 'RESULTS') {
            // Game ended (impostor guessed right, or used their final ejected guess):
            // reveal full state to everyone.
            broadcastGameState(roomId);
        } else {
            // Wrong in-phase guess: only the impostor needs the updated attempt
            // count — avoid leaking guessing activity to the crewmates.
            emitGameStateToPlayer(roomId, user.userId);
        }
    });

    socket.on('skipImpostorGuess', () => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = skipImpostorGuess(roomId, user.userId);
        if (room) {
            // Game ends, crewmates win — reveal full state.
            broadcastGameState(roomId);
        }
    });

    socket.on('playAgain', () => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = playAgain(roomId, user.userId);
        if (room) {
            broadcastGameState(roomId);
        }
    });

    socket.on('nextRound', () => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = nextRound(roomId, user.userId);
        if (room) {
            broadcastGameState(roomId);
        }
    });

    socket.on('endGame', () => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = endGame(roomId, user.userId);
        if (room) {
            broadcastGameState(roomId);
        }
    });

    socket.on('startEmergencyVoting', () => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = startEmergencyVoting(roomId, user.userId);
        if (room) {
            broadcastGameState(roomId);
        }
    });

    socket.on(
        'kickPlayer',
        (payload: string | { playerId?: string } | undefined) => {
            const user = socket.user;
            const roomId = socketToRoom[socket.id];
            if (!roomId) return;

            const playerId =
                typeof payload === 'string' ? payload : payload?.playerId;
            if (!playerId) return;

            const room = kickPlayer(roomId, user.userId, playerId);
            if (room) {
                const kickedSocketId = userIdToSocketId[playerId];
                if (kickedSocketId) {
                    const kickedSocket = io.sockets.sockets.get(kickedSocketId);
                    if (kickedSocket) {
                        kickedSocket.leave(roomId);
                        if (socketToRoom[kickedSocketId] === roomId) {
                            kickedSocket.emit(
                                'kicked',
                                'You were kicked from the room'
                            );
                            delete socketToRoom[kickedSocketId];
                            kickedSocket.disconnect(true);
                            if (userIdToSocketId[playerId] === kickedSocketId) {
                                delete userIdToSocketId[playerId];
                            }
                        }
                    }
                }

                broadcastGameState(roomId);
            }
        }
    );

    socket.on(
        'voteKickPlayer',
        (payload: string | { targetId?: string } | undefined) => {
            const user = socket.user;
            const roomId = socketToRoom[socket.id];
            if (!roomId) return;

            const targetId =
                typeof payload === 'string' ? payload : payload?.targetId;
            if (!targetId) return;

            const room = voteKickPlayer(roomId, user.userId, targetId);
            if (room) {
                // If the vote-kick removed the player from room state, disconnect them.
                const wasKicked = !room.players.some((p) => p.id === targetId);
                if (wasKicked) {
                    const kickedSocketId = userIdToSocketId[targetId];
                    if (kickedSocketId) {
                        const kickedSocket =
                            io.sockets.sockets.get(kickedSocketId);
                        if (kickedSocket) {
                            kickedSocket.leave(roomId);
                            if (socketToRoom[kickedSocketId] === roomId) {
                                kickedSocket.emit(
                                    'kicked',
                                    'You were kicked from the room by vote'
                                );
                                delete socketToRoom[kickedSocketId];
                                kickedSocket.disconnect(true);
                                if (
                                    userIdToSocketId[targetId] ===
                                    kickedSocketId
                                ) {
                                    delete userIdToSocketId[targetId];
                                }
                            }
                        }
                    }
                }

                broadcastGameState(roomId);
            }
        }
    );

    socket.on('updateGameOptions', (options: unknown) => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = updateGameOptions(roomId, user.userId, options);
        if (room) {
            broadcastGameState(roomId);
        }
    });

    socket.on('setLanguage', ({ language }) => {
        const user = socket.user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = getRoom(roomId);
        if (room) {
            const player = room.players.find((p) => p.id === user.userId);
            if (player) {
                player.language =
                    typeof language === 'string' ? language : 'en';
                // Resend the state update custom-translated for this player
                emitGameStateToPlayer(roomId, user.userId);
                // Also send their private role again so they get the secretWord/secretCategory in the new language!
                if (room.impostorId) {
                    const isImpostor = user.userId === room.impostorId;
                    socket.emit('roleAssignment', {
                        isImpostor,
                        secretWord: isImpostor
                            ? null
                            : translateWord(room.secretWord, player.language),
                        secretCategory: translateWord(
                            room.secretCategory,
                            player.language
                        ),
                    });
                }
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const user = socket.user;
        leaveCurrentRoom(socket);
        if (user?.userId && userIdToSocketId[user.userId] === socket.id) {
            delete userIdToSocketId[user.userId];
        }
    });
});

// Helper to hide secrets from general state updates
function getSanitizedRoomState(room: ReturnType<typeof getRoom>) {
    if (!room) return null;
    // If game is over, reveal everything
    if (room.phase === 'RESULTS') return room;
    // Ensure only authenticated user data is exposed
    // (socket user info is attached in middleware; no secret data here)

    return {
        ...room,
        impostorId: null, // Hidden
        secretWord: null, // Hidden
    };
}

type TranslationMap = Record<string, Record<string, string>>;

function translateWord(word: string | null, language: string): string | null {
    if (!word) return null;
    const translations = wordTranslations as TranslationMap;
    const baseLanguage = language.split('-')[0].toLowerCase();
    const langDict = translations[baseLanguage] || translations['en'];
    return langDict[word] || word;
}

function getTranslatedRoomState(
    room: ReturnType<typeof getRoom>,
    language: string
) {
    if (!room) return null;
    const sanitized = getSanitizedRoomState(room);
    if (!sanitized) return null;

    return {
        ...sanitized,
        secretWord: sanitized.secretWord
            ? translateWord(sanitized.secretWord, language)
            : null,
        secretCategory: sanitized.secretCategory
            ? translateWord(sanitized.secretCategory, language)
            : null,
    };
}

function emitGameStateToPlayer(roomId: string, playerId: string) {
    const room = getRoom(roomId);
    if (!room) return;
    const socketId = userIdToSocketId[playerId];
    if (!socketId) return;
    const player = room.players.find((p) => p.id === playerId);
    const language = player?.language || 'en';
    io.to(socketId).emit(
        'gameStateUpdate',
        getTranslatedRoomState(room, language)
    );
}

function broadcastGameState(roomId: string) {
    const room = getRoom(roomId);
    if (!room) return;
    room.players.forEach((p) => {
        emitGameStateToPlayer(roomId, p.id);
    });
}

function isObjectWithGuess(
    value: unknown
): value is { guess?: string; language?: string } {
    return typeof value === 'object' && value !== null && 'guess' in value;
}

function generateToken(username: string, userId: string) {
    return jwt.sign({ name: username, userId }, SECRET_KEY as string, {
        expiresIn: '24h',
    });
}

export { app, server, io };
