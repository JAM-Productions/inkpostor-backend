import { GameRoom, Player, StrokeData } from './types';
import fs from 'fs';
import path from 'path';

// Load word data
const dataPath = path.join(__dirname, 'data.json');
const rawData = fs.readFileSync(dataPath, 'utf-8');
const wordData = JSON.parse(rawData);

const rooms: Record<string, GameRoom> = {};

export function createRoom(roomId: string, hostId: string): GameRoom {
    const newRoom: GameRoom = {
        roomId,
        hostId,
        phase: 'LOBBY',
        players: [],
        impostorId: null,
        secretWord: null,
        secretCategory: null,
        currentTurnPlayerId: null,
        turnOrder: [],
        turnIndex: 0,
        votes: {},
        canvasStrokes: [],
    };
    rooms[roomId] = newRoom;
    return newRoom;
}

export function getRoom(roomId: string): GameRoom | undefined {
    return rooms[roomId];
}

export function joinRoom(roomId: string, player: Player): GameRoom | null {
    const room = rooms[roomId];
    if (!room) return null;

    // Check if player already exists (reconnecting)
    const existingPlayerIndex = room.players.findIndex(
        (p) => p.id === player.id || p.name === player.name
    );
    if (existingPlayerIndex >= 0) {
        room.players[existingPlayerIndex].isConnected = true;
        room.players[existingPlayerIndex].id = player.id; // Update socket id
    } else {
        // Cannot join mid-game unless reconnecting
        if (room.phase !== 'LOBBY') return null;
        room.players.push(player);
    }
    return room;
}

export function leaveRoom(roomId: string, playerId: string) {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find((p) => p.id === playerId);
    if (player) {
        player.isConnected = false;
    }

    // If no players are connected, we could delete the room after a timeout, but for MVP we just keep it
}

export function startGame(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId || room.players.length < 3)
        return null;

    // Pick Impostor
    const impostorIndex = Math.floor(Math.random() * room.players.length);
    room.impostorId = room.players[impostorIndex].id;

    // Pick Word
    const categoryIndex = Math.floor(
        Math.random() * wordData.categories.length
    );
    const category = wordData.categories[categoryIndex];
    const wordIndex = Math.floor(Math.random() * category.words.length);
    room.secretCategory = category.name;
    room.secretWord = category.words[wordIndex];

    // Setup Turns
    room.turnOrder = room.players
        .map((p) => p.id)
        .sort(() => Math.random() - 0.5);
    room.turnIndex = 0;
    room.currentTurnPlayerId = room.turnOrder[0];

    // Reset state
    room.votes = {};
    room.canvasStrokes = [];
    room.players.forEach((p) => {
        p.hasVoted = false;
    });

    room.phase = 'ROLE_REVEAL';
    return room;
}

export function nextTurn(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null;

    room.turnIndex++;
    if (room.turnIndex >= room.turnOrder.length) {
        // Everyone has drawn, start voting phase!
        room.phase = 'VOTING';
        room.currentTurnPlayerId = null;
    } else {
        room.currentTurnPlayerId = room.turnOrder[room.turnIndex];
    }

    return room;
}

export function addStroke(
    roomId: string,
    playerId: string,
    stroke: StrokeData
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null; // Only active player can draw

    room.canvasStrokes.push(stroke);
    return room;
}

export function clearCanvas(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null;

    room.canvasStrokes = [];
    return room;
}

export function proceedToDrawing(
    roomId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId) return null;
    room.phase = 'DRAWING';
    return room;
}

export function castVote(
    roomId: string,
    voterId: string,
    votedForId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'VOTING' || voterId === votedForId) return null;
    const isSkip = votedForId === 'skip';
    const candidateExists = room.players.some((p) => p.id === votedForId);
    if (!isSkip && !candidateExists) return null;
    room.votes[voterId] = votedForId;
    const voter = room.players.find((p) => p.id === voterId);
    if (voter) voter.hasVoted = true;

    // Check if everyone has voted
    const totalConnected = room.players.filter((p) => p.isConnected).length;
    const totalVotesCast = Object.keys(room.votes).length;

    if (totalVotesCast >= totalConnected && totalConnected > 0) {
        room.phase = 'RESULTS';
    }

    return room;
}

export function playAgain(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId) return null;
    room.phase = 'LOBBY';
    room.impostorId = null;
    room.secretWord = null;
    room.secretCategory = null;
    room.currentTurnPlayerId = null;
    room.turnOrder = [];
    room.turnIndex = 0;
    room.votes = {};
    room.canvasStrokes = [];
    room.players.forEach((p) => {
        p.hasVoted = false;
    });
    return room;
}
