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
    clearCanvas,
    nextRound,
    ejectPlayer,
} from './gameManager';
import { Player, StrokeData } from './types';

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
        // Attach user info to socket for later use
        (socket as any).user = payload;
        next();
    } catch {
        next(new Error('Authentication error: invalid token'));
    }
});

io.on('connection', (socket: Socket) => {
    console.log('User connected:', socket.id);
    const connectingUser = (socket as any).user;
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

    socket.on('createRoom', ({ roomId }) => {
        const user = (socket as any).user;
        createRoom(roomId, user.userId);
        const player: Player = {
            id: user.userId,
            name: user.name,
            isConnected: true,
            score: 0,
        };
        const room = joinRoom(roomId, player);
        if (room) {
            socket.join(roomId);
            socketToRoom[socket.id] = roomId;
            io.to(roomId).emit('gameStateUpdate', room);
        }
    });

    socket.on('joinRoom', ({ roomId }) => {
        const user = (socket as any).user;
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
        };
        const joinedRoom = joinRoom(roomId, player);
        if (joinedRoom) {
            socket.join(roomId);
            socketToRoom[socket.id] = roomId;
            io.to(roomId).emit('gameStateUpdate', joinedRoom);
        } else {
            socket.emit('error', 'Cannot join room');
        }
    });

    socket.on('startGame', () => {
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = startGame(roomId, user.userId);
        if (room) {
            // Send global state to everyone EXCEPT the secret word and impostor status
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));

            // Send private roles directly to each player's socket
            room.players.forEach((p) => {
                const targetSocketId = userIdToSocketId[p.id];
                if (!targetSocketId) return;
                const isImpostor = p.id === room.impostorId;
                io.to(targetSocketId).emit('roleAssignment', {
                    isImpostor,
                    secretWord: isImpostor ? null : room.secretWord,
                    secretCategory: room.secretCategory,
                });
            });
        }
    });

    socket.on('proceedToDrawing', () => {
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = proceedToDrawing(roomId, user.userId);
        if (room) {
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));
        }
    });

    socket.on('drawStroke', (stroke: StrokeData) => {
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = addStroke(roomId, user.userId, stroke);
        if (room) {
            // Broadcast stroke to others instantly for smooth drawing
            socket.to(roomId).emit('strokeUpdate', stroke);
        }
    });

    socket.on('clearCanvas', () => {
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = clearCanvas(roomId, user.userId);
        if (room) {
            io.to(roomId).emit('canvasCleared');
        }
    });

    socket.on('endTurn', () => {
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = nextTurn(roomId, user.userId);
        if (room) {
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));
        }
    });

    socket.on('vote', (votedForId: string) => {
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = castVote(roomId, user.userId, votedForId);
        if (room) {
            if (room.phase === 'RESULTS') {
                // Send full unsanitized state so everyone sees the impostor
                io.to(roomId).emit('gameStateUpdate', room);
            } else {
                io.to(roomId).emit(
                    'gameStateUpdate',
                    getSanitizedRoomState(room)
                );
            }
        }
    });

    socket.on('playAgain', () => {
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = playAgain(roomId, user.userId);
        if (room) {
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));
        }
    });

    socket.on('nextRound', () => {
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = nextRound(roomId, user.userId);
        if (room) {
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));
        }
    });

    socket.on('ejectPlayer', ({ playerIdToEject }) => {
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = ejectPlayer(roomId, user.userId, playerIdToEject);
        if (room) {
            const ejectedSocketId = userIdToSocketId[playerIdToEject];
            if (ejectedSocketId) {
                const ejectedSocket = io.sockets.sockets.get(ejectedSocketId);
                if (ejectedSocket) {
                    ejectedSocket.emit('ejected');
                    ejectedSocket.leave(roomId);
                }
                delete socketToRoom[ejectedSocketId];
            }
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const user = (socket as any).user;
        const roomId = socketToRoom[socket.id];
        if (roomId && user) {
            leaveRoom(roomId, user.userId);
            const room = getRoom(roomId);
            if (room) {
                io.to(roomId).emit(
                    'gameStateUpdate',
                    getSanitizedRoomState(room)
                );
            }
            delete socketToRoom[socket.id];
        }
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

function generateToken(username: string, userId: string) {
    return jwt.sign({ name: username, userId }, SECRET_KEY as string, {
        expiresIn: '24h',
    });
}

export { app, server, io };
