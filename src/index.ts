import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
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
} from './gameManager';
import { Player, StrokeData } from './types';

dotenv.config();

const SECRET_KEY = process.env.JWT_SECRET;

if (!SECRET_KEY) {
    throw new Error('JWT_SECRET is not defined');
}

const app = express();
app.use(cors());
app.use(express.json());

app.post('/auth', (req, res) => {
    const { username } = req.body;
    if (!username)
        return res.status(400).json({ message: 'Username required' });

    const token = generateToken(username);
    res.json({ token });
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.INKPOSTOR_FRONTEND_URL || 'http://localhost:5173',
        methods: ['GET', 'POST'],
    },
});

const socketToRoom: Record<string, string> = {};

io.use((socket, next) => {
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

    socket.on('createRoom', ({ roomId }) => {
        const user = (socket as any).user;
        createRoom(roomId, socket.id);
        const player: Player = {
            id: socket.id,
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
            room = createRoom(roomId, socket.id);
        }
        const player: Player = {
            id: socket.id,
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
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = startGame(roomId, socket.id);
        if (room) {
            // Send global state to everyone EXCEPT the secret word and impostor status
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));

            // Send private roles
            room.players.forEach((p) => {
                const isImpostor = p.id === room.impostorId;
                io.to(p.id).emit('roleAssignment', {
                    isImpostor,
                    secretWord: isImpostor ? null : room.secretWord,
                    secretCategory: room.secretCategory,
                });
            });
        }
    });

    socket.on('proceedToDrawing', () => {
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = proceedToDrawing(roomId, socket.id);
        if (room) {
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));
        }
    });

    socket.on('drawStroke', (stroke: StrokeData) => {
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = addStroke(roomId, socket.id, stroke);
        if (room) {
            // Broadcast stroke to others instantly for smooth drawing
            socket.to(roomId).emit('strokeUpdate', stroke);
        }
    });

    socket.on('clearCanvas', () => {
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = clearCanvas(roomId, socket.id);
        if (room) {
            io.to(roomId).emit('canvasCleared');
        }
    });

    socket.on('endTurn', () => {
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = nextTurn(roomId, socket.id);
        if (room) {
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));
        }
    });

    socket.on('vote', (votedForId: string) => {
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = castVote(roomId, socket.id, votedForId);
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
        const roomId = socketToRoom[socket.id];
        if (!roomId) return;
        const room = playAgain(roomId, socket.id);
        if (room) {
            io.to(roomId).emit('gameStateUpdate', getSanitizedRoomState(room));
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const roomId = socketToRoom[socket.id];
        if (roomId) {
            leaveRoom(roomId, socket.id);
            const room = getRoom(roomId);
            if (room) {
                io.to(roomId).emit(
                    'gameStateUpdate',
                    getSanitizedRoomState(room)
                );
            }
            delete socketToRoom[socket.id];
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

function generateToken(username: string) {
    return jwt.sign({ name: username }, SECRET_KEY as string, {
        expiresIn: '1h',
    });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Socket.IO Server running on port ${PORT}`);
});
