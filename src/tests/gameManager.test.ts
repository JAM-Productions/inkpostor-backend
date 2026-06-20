import { describe, it, expect } from 'vitest';
import {
    createRoom,
    getRoom,
    joinRoom,
    leaveRoom,
    startGame,
    nextTurn,
    addStroke,
    undoStroke,
    proceedToDrawing,
    castVote,
    playAgain,
    nextRound,
    endGame,
    startEmergencyVoting,
    kickPlayer,
    voteKickPlayer,
    updateGameOptions,
    submitImpostorGuess,
    skipImpostorGuess,
} from '../gameManager';
import { Player, StrokeData } from '../types';
import {
    ALLOWED_ROUND_TIMES,
    DEFAULT_ROUND_TIME,
    MAX_IMPOSTOR_GUESSES,
    MAX_NUM_PLAYERS_PER_ROOM,
} from '../constants';

describe('gameManager', () => {
    // Helper to create basic players
    const createPlayer = (id: string, name: string): Player => ({
        id,
        name,
        isConnected: true,
        score: 0,
        hasVoted: false,
        hasStartedEmergencyVoting: false,
    });

    describe('createRoom & getRoom', () => {
        it('should create a room correctly and retrieve it', () => {
            const room = createRoom('room-create', 'host1');
            expect(room).toBeDefined();
            expect(room.roomId).toBe('room-create');
            expect(room.hostId).toBe('host1');
            expect(room.phase).toBe('LOBBY');
            expect(room.gameOptions).toEqual({
                roundTime: DEFAULT_ROUND_TIME,
                unlimitedInk: false,
                clearCanvasEachRound: true,
                impostorGuessEnabled: false,
                impostorGuessAttempts: 3,
            });

            const fetched = getRoom('room-create');
            expect(fetched).toBe(room);

            const notFound = getRoom('invalid');
            expect(notFound).toBeUndefined();
        });
    });

    describe('joinRoom', () => {
        it('should allow player to join existing room in LOBBY phase', () => {
            createRoom('room-join', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const room = joinRoom('room-join', p1);

            expect(room).not.toBeNull();
            expect(room!.players.length).toBe(1);
            expect(room!.players[0].id).toBe('p1');
        });

        it('should return null for non-existent room', () => {
            const p1 = createPlayer('p1', 'Alice');
            const room = joinRoom('invalid-room', p1);
            expect(room).toBeNull();
        });

        it('should allow reconnection with the same UUID (id match)', () => {
            createRoom('room-reconnect', 'host1');
            const p1 = createPlayer('uuid-persistent-id', 'Alice');
            joinRoom('room-reconnect', p1);

            // Simulate reconnect: same UUID, player was marked disconnected
            const p1Reconnect = createPlayer('uuid-persistent-id', 'Alice');
            p1Reconnect.isConnected = false;
            const room = joinRoom('room-reconnect', p1Reconnect);

            // Must still be 1 player (not duplicated)
            expect(room!.players.length).toBe(1);
            expect(room!.players[0].id).toBe('uuid-persistent-id');
            expect(room!.players[0].isConnected).toBe(true);
        });

        it('should NOT merge two players with the same name but different UUIDs', () => {
            createRoom('room-name-collision', 'host1');
            const p1 = createPlayer('uuid-alice-aaa', 'Alice');
            const p2 = createPlayer('uuid-alice-bbb', 'Alice');

            joinRoom('room-name-collision', p1);
            const room = joinRoom('room-name-collision', p2);

            // Both should exist as separate players
            expect(room!.players.length).toBe(2);
            const ids = room!.players.map((p) => p.id);
            expect(ids).toContain('uuid-alice-aaa');
            expect(ids).toContain('uuid-alice-bbb');
        });

        it('should allow a UUID-matched player to rejoin mid-game', () => {
            const room = createRoom('room-midgame-rejoin', 'host1');
            const p1 = createPlayer('uuid-midgame-id', 'Alice');
            joinRoom('room-midgame-rejoin', p1);

            // Force game to an in-progress phase
            room.phase = 'DRAWING';

            // Mark the player as disconnected (they dropped)
            room.players[0].isConnected = false;

            // They should be allowed back (UUID already in room, just reconnecting)
            const p1Reconnect = createPlayer('uuid-midgame-id', 'Alice');
            const result = joinRoom('room-midgame-rejoin', p1Reconnect);

            expect(result).not.toBeNull();
            expect(result!.players[0].isConnected).toBe(true);
        });

        it('should not allow joining mid-game if new player', () => {
            const room = createRoom('room-midgame', 'host1');
            room.phase = 'DRAWING'; // manually force state

            const p1 = createPlayer('p1', 'Alice');
            const result = joinRoom('room-midgame', p1);
            expect(result).toBeNull();
        });

        it('should enforce MAX_NUM_PLAYERS_PER_ROOM limit', () => {
            createRoom('room-max-limit', 'host1');
            // Fill the room to the max
            for (let i = 0; i < MAX_NUM_PLAYERS_PER_ROOM; i++) {
                const player = createPlayer(`p${i}`, `Player${i}`);
                const room = joinRoom('room-max-limit', player);
                expect(room).not.toBeNull();
            }

            // Try adding one more
            const extraPlayer = createPlayer('extra', 'Extra');
            const result = joinRoom('room-max-limit', extraPlayer);
            expect(result).toBeNull(); // Should be rejected

            const finalRoom = getRoom('room-max-limit');
            expect(finalRoom!.players.length).toBe(MAX_NUM_PLAYERS_PER_ROOM);
        });
    });

    describe('leaveRoom', () => {
        it('should remove player if in LOBBY phase', () => {
            createRoom('room-leave-lobby', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-leave-lobby', p1);

            leaveRoom('room-leave-lobby', 'p1');

            const room = getRoom('room-leave-lobby');
            expect(room!.players.length).toBe(0);
        });

        it('should set isConnected to false if not in LOBBY phase', () => {
            const room = createRoom('room-leave-active', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-leave-active', p1);
            room.phase = 'DRAWING';

            leaveRoom('room-leave-active', 'p1');

            expect(room.players[0].isConnected).toBe(false);
        });

        it('should do nothing if room or player not found', () => {
            createRoom('room-leave-invalid', 'host1');
            expect(() => {
                leaveRoom('room-leave-invalid', 'p1');
                leaveRoom('invalid-room', 'p1');
            }).not.toThrow();
        });
    });

    describe('leaveRoom phase transitions (disconnect)', () => {
        it('VOTING: resolves the round when the last non-voter disconnects', () => {
            const room = createRoom('disc-voting', 'host1');
            room.impostorId = 'p1'; // ejected p3 will be a crewmate
            room.phase = 'VOTING';
            room.players = ['p1', 'p2', 'p3'].map((id) => createPlayer(id, id));

            // Everyone votes for p3 except p3, who never votes.
            castVote('disc-voting', 'p1', 'p3');
            castVote('disc-voting', 'p2', 'p3');
            expect(room.phase).toBe('VOTING'); // still waiting on p3

            // p3 drops without voting -> the round must now resolve.
            leaveRoom('disc-voting', 'p3');

            expect(room.phase).toBe('RESULTS');
            expect(room.ejectedId).toBe('p3');
        });

        it('VOTING: impostor disconnecting instead of voting ends the game (no orphaned IMPOSTOR_GUESS)', () => {
            const room = createRoom('disc-voting-imp', 'host1');
            room.impostorId = 'imp';
            room.secretWord = 'Dog';
            room.gameOptions.impostorGuessEnabled = true;
            room.phase = 'VOTING';
            room.players = ['imp', 'p2', 'p3'].map((id) =>
                createPlayer(id, id)
            );

            // Crewmates vote the impostor out; the impostor never votes.
            castVote('disc-voting-imp', 'p2', 'imp');
            castVote('disc-voting-imp', 'p3', 'imp');
            expect(room.phase).toBe('VOTING'); // still waiting on the impostor

            // The impostor drops without voting -> it would resolve into
            // IMPOSTOR_GUESS, but a disconnected impostor can never guess.
            leaveRoom('disc-voting-imp', 'imp');

            expect(room.phase).toBe('RESULTS');
            expect(room.gameEnded).toBe(true);
            expect(room.ejectedId).toBe('imp');
        });

        it('VOTING: impostor disconnecting still goes to IMPOSTOR_GUESS if guess option is off -> game ends', () => {
            const room = createRoom('disc-voting-imp-off', 'host1');
            room.impostorId = 'imp';
            room.phase = 'VOTING';
            room.players = ['imp', 'p2', 'p3'].map((id) =>
                createPlayer(id, id)
            );

            castVote('disc-voting-imp-off', 'p2', 'imp');
            castVote('disc-voting-imp-off', 'p3', 'imp');
            leaveRoom('disc-voting-imp-off', 'imp');

            // Guess option off: checkVotingComplete already ends the game.
            expect(room.phase).toBe('RESULTS');
            expect(room.gameEnded).toBe(true);
            expect(room.ejectedId).toBe('imp');
        });

        it('RESULTS: starts the next round when the last unconfirmed player disconnects', () => {
            const room = createRoom('disc-results', 'host1');
            room.phase = 'RESULTS';
            room.gameEnded = false;
            room.ejectedId = null;
            room.players = ['p1', 'p2', 'p3'].map((id) => createPlayer(id, id));
            room.turnOrder = ['p1', 'p2', 'p3'];

            nextRound('disc-results', 'p1');
            nextRound('disc-results', 'p2');
            expect(room.phase).toBe('RESULTS'); // still waiting on p3

            // p3 drops -> disconnected players count as confirmed.
            leaveRoom('disc-results', 'p3');

            expect(room.phase).toBe('DRAWING');
            expect(room.currentRound).toBe(2);
        });

        it('IMPOSTOR_GUESS: the impostor disconnecting counts as a surrender (crewmates win)', () => {
            const room = createRoom('disc-guess', 'host1');
            room.impostorId = 'imp';
            room.ejectedId = 'imp';
            room.phase = 'IMPOSTOR_GUESS';
            room.gameEnded = false;
            room.players = ['imp', 'p2', 'p3'].map((id) =>
                createPlayer(id, id)
            );
            room.players.find((p) => p.id === 'imp')!.isEjected = true;

            leaveRoom('disc-guess', 'imp');

            expect(room.phase).toBe('RESULTS');
            expect(room.gameEnded).toBe(true);
            expect(room.ejectedId).toBe('imp');
        });

        it('IMPOSTOR_GUESS: a waiting crewmate disconnecting does not end the game', () => {
            const room = createRoom('disc-guess-crew', 'host1');
            room.impostorId = 'imp';
            room.ejectedId = 'imp';
            room.phase = 'IMPOSTOR_GUESS';
            room.gameEnded = false;
            room.players = ['imp', 'p2', 'p3'].map((id) =>
                createPlayer(id, id)
            );
            room.players.find((p) => p.id === 'imp')!.isEjected = true;

            leaveRoom('disc-guess-crew', 'p2');

            expect(room.phase).toBe('IMPOSTOR_GUESS');
            expect(room.gameEnded).toBe(false);
        });
    });

    describe('startGame', () => {
        it('should return null if room not found or not enough players', () => {
            createRoom('room-start-fail', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-start-fail', p1);

            const result = startGame('room-start-fail', 'host1');
            expect(result).toBeNull();

            const invalidResult = startGame('invalid-room', 'host1');
            expect(invalidResult).toBeNull();
        });

        it('should start game correctly with 3+ players', () => {
            createRoom('room-start', 'host1');
            const players = [
                createPlayer('p1', 'Alice'),
                createPlayer('p2', 'Bob'),
                createPlayer('p3', 'Charlie'),
            ];
            players.forEach((p) => joinRoom('room-start', p));

            const result = startGame('room-start', 'host1');
            expect(result).not.toBeNull();
            expect(result!.phase).toBe('ROLE_REVEAL');
            expect(result!.impostorId).not.toBeNull();
            expect(result!.secretWord).not.toBeNull();
            expect(result!.secretCategory).not.toBeNull();
            expect(result!.turnOrder.length).toBe(3);
            expect(result!.currentTurnPlayerId).not.toBeNull();
            expect(result!.turnOrder).toContain(result!.currentTurnPlayerId);
            expect(result!.gameEnded).toBe(false);
        });
    });

    describe('nextTurn', () => {
        it('should progress turns and switch to VOTING when done', () => {
            const room = createRoom('room-turns', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            joinRoom('room-turns', p1);
            joinRoom('room-turns', p2);

            room.turnOrder = ['p1', 'p2'];
            room.turnIndex = 0;
            room.currentTurnPlayerId = 'p1';
            room.phase = 'DRAWING';

            const r1 = nextTurn('room-turns', 'p1');
            expect(r1).not.toBeNull();
            expect(r1!.currentTurnPlayerId).toBe('p2');
            expect(r1!.turnIndex).toBe(1);

            const r2 = nextTurn('room-turns', 'p2');
            expect(r2!.phase).toBe('VOTING');
            expect(r2!.currentTurnPlayerId).toBeNull();
        });

        it('should return null for non-existent room', () => {
            expect(nextTurn('invalid', 'host1')).toBeNull();
        });

        it('should return null if the player is ejected', () => {
            const room = createRoom('room-turns-ejected', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            p1.isEjected = true;
            joinRoom('room-turns-ejected', p1);

            room.turnOrder = ['p1'];
            room.turnIndex = 0;
            room.currentTurnPlayerId = 'p1';
            room.phase = 'DRAWING';

            const r1 = nextTurn('room-turns-ejected', 'p1');
            expect(r1).toBeNull();
        });
    });

    describe('proceedToDrawing', () => {
        it('should set hasRevealedRole to true for the calling player', () => {
            const room = createRoom('room-proceed', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            joinRoom('room-proceed', p1);
            joinRoom('room-proceed', p2);

            room.phase = 'ROLE_REVEAL';

            const result = proceedToDrawing('room-proceed', 'p1');
            expect(result).not.toBeNull();
            expect(
                result!.players.find((p) => p.id === 'p1')!.hasRevealedRole
            ).toBe(true);
            expect(result!.phase).toBe('ROLE_REVEAL'); // Phase should not change yet
        });

        it('should set phase to DRAWING when all players have revealed roles', () => {
            const room = createRoom('room-proceed-all', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            joinRoom('room-proceed-all', p1);
            joinRoom('room-proceed-all', p2);

            room.phase = 'ROLE_REVEAL';

            proceedToDrawing('room-proceed-all', 'p1');
            const result = proceedToDrawing('room-proceed-all', 'p2');

            expect(result).not.toBeNull();
            expect(result!.phase).toBe('DRAWING');
        });

        it('should return null for invalid room', () => {
            expect(proceedToDrawing('invalid', 'host1')).toBeNull();
        });

        it('should return null for invalid player', () => {
            createRoom('room-proceed-invalid-player', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-proceed-invalid-player', p1);
            expect(
                proceedToDrawing('room-proceed-invalid-player', 'p2')
            ).toBeNull();
        });
    });

    describe('addStroke and undoStroke', () => {
        it('should handle strokes if active player and drawing phase', () => {
            const room = createRoom('room-stroke', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-stroke', p1);

            room.phase = 'DRAWING';
            room.currentTurnPlayerId = 'p1';

            const stroke: StrokeData = {
                x: 0,
                y: 0,
                color: '#000',
                isNewStroke: true,
            };

            // Valid add
            const result1 = addStroke('room-stroke', 'p1', stroke);
            expect(result1).not.toBeNull();
            expect(result1!.canvasStrokes.length).toBe(1);

            // Invalid player add
            const result2 = addStroke('room-stroke', 'p2', stroke);
            expect(result2).toBeNull();

            // Clear valid
            const result3 = undoStroke('room-stroke', 'p1');
            expect(result3).not.toBeNull();
            expect(result3!.canvasStrokes.length).toBe(0);

            // Clear invalid player
            const result4 = undoStroke('room-stroke', 'p2');
            expect(result4).toBeNull();
        });

        it('should return null for add/clear if wrong phase or no room', () => {
            createRoom('room-wrong-phase', 'host1');
            const stroke: StrokeData = {
                x: 0,
                y: 0,
                color: '#000',
                isNewStroke: true,
            };

            expect(addStroke('room-wrong-phase', 'host1', stroke)).toBeNull();
            expect(undoStroke('room-wrong-phase', 'host1')).toBeNull();
            expect(addStroke('invalid', 'host1', stroke)).toBeNull();
            expect(undoStroke('invalid', 'host1')).toBeNull();
        });

        it('should return null if the player is ejected', () => {
            const room = createRoom('room-stroke-ejected', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            p1.isEjected = true;
            joinRoom('room-stroke-ejected', p1);

            room.phase = 'DRAWING';
            room.currentTurnPlayerId = 'p1';

            const stroke: StrokeData = {
                x: 0,
                y: 0,
                color: '#000',
                isNewStroke: true,
            };
            expect(addStroke('room-stroke-ejected', 'p1', stroke)).toBeNull();
            expect(undoStroke('room-stroke-ejected', 'p1')).toBeNull();
        });
    });

    describe('castVote', () => {
        it('should cast vote and change phase to RESULTS when all connected vote', () => {
            const room = createRoom('room-voting', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            joinRoom('room-voting', p1);
            joinRoom('room-voting', p2);

            room.phase = 'VOTING';

            const r1 = castVote('room-voting', 'p1', 'p2');
            expect(r1).not.toBeNull();
            expect(r1!.votes['p1']).toBe('p2');
            expect(r1!.players[0].hasVoted).toBe(true);
            expect(r1!.phase).toBe('VOTING');

            const r2 = castVote('room-voting', 'p2', 'p1');
            expect(r2!.phase).toBe('RESULTS');
        });

        it('should ignore votes if phase is not VOTING or room invalid', () => {
            createRoom('room-not-voting', 'host1');
            const r1 = castVote('room-not-voting', 'p1', 'p2');
            expect(r1).toBeNull();

            const r2 = castVote('invalid', 'p1', 'p2');
            expect(r2).toBeNull();
        });

        it('should return null if the voter is ejected', () => {
            const room = createRoom('room-voting-ejected-voter', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            p1.isEjected = true;
            joinRoom('room-voting-ejected-voter', p1);
            joinRoom('room-voting-ejected-voter', p2);

            room.phase = 'VOTING';

            const r1 = castVote('room-voting-ejected-voter', 'p1', 'p2');
            expect(r1).toBeNull();
        });

        it('should return null if the voted player is ejected (unless skip)', () => {
            const room = createRoom('room-voting-ejected-target', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            p2.isEjected = true;
            joinRoom('room-voting-ejected-target', p1);
            joinRoom('room-voting-ejected-target', p2);

            room.phase = 'VOTING';

            const r1 = castVote('room-voting-ejected-target', 'p1', 'p2');
            expect(r1).toBeNull();

            // Should allow skip
            const r2 = castVote('room-voting-ejected-target', 'p1', 'skip');
            expect(r2).not.toBeNull();
            expect(r2!.phase).toBe('RESULTS'); // Since p2 is ejected, p1 voting skip completes the voting
            expect(r2!.ejectedId).toBeNull();
        });

        it('should set gameEnded=true when impostor is ejected by vote (guess feature off)', () => {
            const room = createRoom('room-voting-impostor-ejected', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            const p3 = createPlayer('p3', 'Charlie');
            joinRoom('room-voting-impostor-ejected', p1);
            joinRoom('room-voting-impostor-ejected', p2);
            joinRoom('room-voting-impostor-ejected', p3);

            room.phase = 'VOTING';
            room.impostorId = 'p3';
            room.gameOptions.impostorGuessEnabled = false;

            castVote('room-voting-impostor-ejected', 'p1', 'p3');
            castVote('room-voting-impostor-ejected', 'p2', 'p3');
            const result = castVote('room-voting-impostor-ejected', 'p3', 'p1');

            expect(result!.phase).toBe('RESULTS');
            expect(result!.ejectedId).toBe('p3');
            expect(result!.gameEnded).toBe(true);
        });

        it('should NOT set gameEnded when a crewmate is ejected by vote', () => {
            const room = createRoom('room-voting-crewmate-ejected', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            const p3 = createPlayer('p3', 'Charlie');
            joinRoom('room-voting-crewmate-ejected', p1);
            joinRoom('room-voting-crewmate-ejected', p2);
            joinRoom('room-voting-crewmate-ejected', p3);

            room.phase = 'VOTING';
            room.impostorId = 'p1';

            castVote('room-voting-crewmate-ejected', 'p1', 'p3');
            castVote('room-voting-crewmate-ejected', 'p2', 'p3');
            const result = castVote('room-voting-crewmate-ejected', 'p3', 'p1');

            expect(result!.phase).toBe('RESULTS');
            expect(result!.ejectedId).toBe('p3');
            expect(result!.gameEnded).toBe(false);
        });

        it('should only require votes from non-ejected connected players to complete voting & handle ties', () => {
            const room = createRoom('room-voting-majority', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            const p3 = createPlayer('p3', 'Charlie');

            p3.isEjected = true;

            joinRoom('room-voting-majority', p1);
            joinRoom('room-voting-majority', p2);
            joinRoom('room-voting-majority', p3);

            room.phase = 'VOTING';

            const r1 = castVote('room-voting-majority', 'p1', 'p2');
            expect(r1!.phase).toBe('VOTING');

            // Voting should be complete now, p3's vote is not needed
            const r2 = castVote('room-voting-majority', 'p2', 'p1');
            expect(r2!.phase).toBe('RESULTS');
            // Tie should result in null ejectedId
            expect(r2!.ejectedId).toBeNull();
        });
    });

    describe('playAgain', () => {
        it('should reset state correctly', () => {
            const room = createRoom('room-playagain', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            p1.hasVoted = true;
            joinRoom('room-playagain', p1);

            room.phase = 'RESULTS';
            room.impostorId = 'p1';
            room.secretWord = 'word';
            room.votes = { p1: 'p2' };
            room.turnOrder = ['p1'];

            const result = playAgain('room-playagain', 'host1');
            expect(result).not.toBeNull();
            expect(result!.phase).toBe('LOBBY');
            expect(result!.impostorId).toBeNull();
            expect(result!.secretWord).toBeNull();
            expect(result!.votes).toEqual({});
            expect(result!.turnOrder).toEqual([]);
            expect(result!.players[0].hasVoted).toBe(false);
            expect(result!.gameEnded).toBe(false);
        });

        it('should return null for invalid room', () => {
            expect(playAgain('invalid', 'host1')).toBeNull();
        });
    });

    describe('nextRound', () => {
        it('should set hasConfirmedNewRound to true for the calling player', () => {
            const room = createRoom('room-nextround', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            joinRoom('room-nextround', p1);
            joinRoom('room-nextround', p2);

            room.phase = 'RESULTS';

            const result = nextRound('room-nextround', 'p1');
            expect(result).not.toBeNull();
            expect(
                result!.players.find((p) => p.id === 'p1')!.hasConfirmedNewRound
            ).toBe(true);
            expect(result!.phase).toBe('RESULTS'); // Phase should not change yet
        });

        it('should set phase to DRAWING when all non-ejected players confirm', () => {
            const room = createRoom('room-nextround-all', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            joinRoom('room-nextround-all', p1);
            joinRoom('room-nextround-all', p2);

            room.phase = 'RESULTS';
            room.currentRound = 1;
            room.votes = { p1: 'p2', p2: 'p1' };
            room.canvasStrokes = [
                {
                    x: 1,
                    y: 2,
                    color: '#000000',
                    isNewStroke: true,
                },
            ];
            room.players.find((p) => p.id === 'p1')!.hasVoted = true;
            room.players.find((p) => p.id === 'p2')!.hasVoted = true;
            nextRound('room-nextround-all', 'p1');
            const result = nextRound('room-nextround-all', 'p2');
            expect(result).not.toBeNull();
            expect(result!.phase).toBe('DRAWING');
            expect(result!.currentRound).toBe(2);
            expect(result!.votes).toEqual({});
            expect(result!.players.every((p) => p.hasVoted === false)).toBe(
                true
            );
            expect(result!.canvasStrokes).toEqual([]);
        });

        it('should preserve canvas strokes when clearCanvasEachRound is false', () => {
            const room = createRoom('room-nextround-keep-canvas', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            joinRoom('room-nextround-keep-canvas', p1);
            joinRoom('room-nextround-keep-canvas', p2);

            room.phase = 'RESULTS';
            room.currentRound = 1;
            room.gameOptions.clearCanvasEachRound = false;
            room.canvasStrokes = [
                {
                    x: 10,
                    y: 20,
                    color: '#123456',
                    isNewStroke: true,
                },
            ];

            nextRound('room-nextround-keep-canvas', 'p1');
            const result = nextRound('room-nextround-keep-canvas', 'p2');

            expect(result).not.toBeNull();
            expect(result!.phase).toBe('DRAWING');
            expect(result!.canvasStrokes).toEqual([
                {
                    x: 10,
                    y: 20,
                    color: '#123456',
                    isNewStroke: true,
                },
            ]);
        });

        it('should return null for invalid room', () => {
            expect(nextRound('invalid', 'host1')).toBeNull();
        });

        it('should filter out ejected players from the turn order', () => {
            const room = createRoom('room-nextround-ejected', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            p2.isEjected = true;
            joinRoom('room-nextround-ejected', p1);
            joinRoom('room-nextround-ejected', p2);

            room.phase = 'RESULTS';
            room.currentRound = 1;
            room.turnOrder = ['p1', 'p2'];

            const ejectedResult = nextRound('room-nextround-ejected', 'p2');
            expect(ejectedResult).toBeNull(); // Ejected player cannot confirm
            const result = nextRound('room-nextround-ejected', 'p1');
            expect(result).not.toBeNull();
            expect(result!.turnOrder).toEqual(['p1']);
            expect(result!.currentTurnPlayerId).toBe('p1');
        });

        it('should set phase to DRAWING when all connected, non-ejected players confirm (ignoring disconnected)', () => {
            const room = createRoom('room-nextround-disconnected', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            p2.isConnected = false;
            joinRoom('room-nextround-disconnected', p1);
            joinRoom('room-nextround-disconnected', p2);

            room.phase = 'RESULTS';
            room.currentRound = 1;
            room.players.find((p) => p.id === 'p1')!.hasVoted = true;
            room.players.find((p) => p.id === 'p2')!.hasVoted = true;

            const result = nextRound('room-nextround-disconnected', 'p1');
            expect(result).not.toBeNull();
            expect(result!.phase).toBe('DRAWING');
        });
    });

    describe('endGame', () => {
        it('should end the game if the host calls it', () => {
            const roomId = 'room-end';
            const hostId = 'host1';

            // Create a room and set the host
            const room = createRoom(roomId, hostId);
            expect(room).toBeDefined();

            // End the game
            const endedRoom = endGame(roomId, hostId);
            expect(endedRoom).toBeDefined();
            expect(endedRoom?.phase).toBe('RESULTS');
            expect(endedRoom?.gameEnded).toBe(true);
        });

        it('should not end the game if a non-host player calls it', () => {
            const roomId = 'room-end-nonhost';
            const hostId = 'host1';
            const playerId = 'player1';

            // Create a room and set the host
            const room = createRoom(roomId, hostId);
            expect(room).toBeDefined();

            // Attempt to end the game as a non-host
            const endedRoom = endGame(roomId, playerId);
            expect(endedRoom).toBeNull();
        });

        it('should return null if the room does not exist', () => {
            const endedRoom = endGame('nonexistent-room', 'host1');
            expect(endedRoom).toBeNull();
        });
    });

    describe('startEmergencyVoting', () => {
        it('should start emergency voting if conditions are met', () => {
            const room = createRoom('room-emergency', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            joinRoom('room-emergency', p1);
            joinRoom('room-emergency', p2);

            room.phase = 'DRAWING';

            const result = startEmergencyVoting('room-emergency', 'p1');
            expect(result).not.toBeNull();
            expect(result!.phase).toBe('VOTING');
            expect(result!.currentTurnPlayerId).toBeNull();
            expect(
                result!.players.find((p) => p.id === 'p1')!
                    .hasStartedEmergencyVoting
            ).toBe(true);
        });

        it('should not start emergency voting if player is ejected', () => {
            const room = createRoom('room-emergency-ejected', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-emergency-ejected', p1);

            room.phase = 'DRAWING';
            p1.isEjected = true;

            const result = startEmergencyVoting('room-emergency-ejected', 'p1');
            expect(result).toBeNull();
        });

        it('should not start emergency voting if phase is not DRAWING', () => {
            const room = createRoom('room-emergency-phase', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-emergency-phase', p1);

            room.phase = 'LOBBY';

            const result = startEmergencyVoting('room-emergency-phase', 'p1');
            expect(result).toBeNull();
        });
    });

    describe('kickPlayer', () => {
        it('should remove a non-host player when kicked by the host in LOBBY', () => {
            createRoom('room-kick-success', 'host1');
            joinRoom('room-kick-success', createPlayer('host1', 'Host'));
            joinRoom('room-kick-success', createPlayer('p2', 'Bob'));

            const result = kickPlayer('room-kick-success', 'host1', 'p2');

            expect(result).not.toBeNull();
            expect(result!.players.map((p) => p.id)).toEqual(['host1']);
        });

        it('should return null if trying to use kickPlayer mid-game', () => {
            const room = createRoom('room-kick-midgame', 'host1');
            joinRoom('room-kick-midgame', createPlayer('host1', 'Host'));
            joinRoom('room-kick-midgame', createPlayer('p2', 'Bob'));

            room.phase = 'DRAWING';
            const result = kickPlayer('room-kick-midgame', 'host1', 'p2');
            expect(result).toBeNull();
        });
    });

    describe('voteKickPlayer', () => {
        it('should return null in LOBBY phase', () => {
            createRoom('room-votekick-lobby', 'host1');
            joinRoom('room-votekick-lobby', createPlayer('host1', 'Host'));
            joinRoom('room-votekick-lobby', createPlayer('p2', 'Bob'));

            const result = voteKickPlayer('room-votekick-lobby', 'host1', 'p2');
            expect(result).toBeNull();
        });

        it('should toggle vote and kick when threshold is met', () => {
            const room = createRoom('room-votekick-success', 'host1');
            joinRoom('room-votekick-success', createPlayer('host1', 'Host'));
            joinRoom('room-votekick-success', createPlayer('p2', 'Bob'));
            joinRoom('room-votekick-success', createPlayer('p3', 'Charlie'));
            joinRoom('room-votekick-success', createPlayer('p4', 'Dave'));

            room.phase = 'DRAWING';
            room.turnOrder = ['host1', 'p2', 'p3', 'p4'];
            room.turnIndex = 1;
            room.currentTurnPlayerId = 'p2';

            // P3 votes to kick P2
            let result = voteKickPlayer('room-votekick-success', 'p3', 'p2');
            expect(result).not.toBeNull();

            // P4 votes to kick P2 (threshold is 3 votes: host1, p3, p4)
            result = voteKickPlayer('room-votekick-success', 'p4', 'p2');
            expect(result).not.toBeNull();
            expect(result!.kickVotes['p2']).toEqual(['p3', 'p4']);
            let target = result!.players.find((p) => p.id === 'p2');
            expect(target!.isEjected).toBeFalsy();

            // Host votes to kick P2 (threshold met)
            result = voteKickPlayer('room-votekick-success', 'host1', 'p2');
            expect(result).not.toBeNull();
            target = result!.players.find((p) => p.id === 'p2');
            expect(target).toBeUndefined();

            // Votes should reset
            expect(result!.kickVotes['p2']).toEqual([]);

            // Turn skips to P3
            expect(result!.currentTurnPlayerId).toBe('p3');
            expect(result!.turnIndex).toBe(1);
        });

        it('should switch to VOTING when the last current turn player is kicked', () => {
            const room = createRoom('room-votekick-last-turn', 'host1');
            joinRoom('room-votekick-last-turn', createPlayer('host1', 'Host'));
            joinRoom('room-votekick-last-turn', createPlayer('p2', 'Bob'));
            joinRoom('room-votekick-last-turn', createPlayer('p3', 'Charlie'));
            joinRoom('room-votekick-last-turn', createPlayer('p4', 'Dave'));

            room.phase = 'DRAWING';
            room.turnOrder = ['host1', 'p2', 'p3', 'p4'];
            room.turnIndex = 3;
            room.currentTurnPlayerId = 'p4';
            room.impostorId = 'host1';

            voteKickPlayer('room-votekick-last-turn', 'host1', 'p4');
            voteKickPlayer('room-votekick-last-turn', 'p2', 'p4');
            const result = voteKickPlayer(
                'room-votekick-last-turn',
                'p3',
                'p4'
            );

            expect(result).not.toBeNull();
            expect(result!.phase).toBe('VOTING');
            expect(result!.currentTurnPlayerId).toBeNull();
            expect(result!.turnOrder).not.toContain('p4');
        });

        it('should return null when a non-host tries to kick a player', () => {
            createRoom('room-kick-non-host', 'host1');
            joinRoom('room-kick-non-host', createPlayer('host1', 'Host'));
            joinRoom('room-kick-non-host', createPlayer('p2', 'Bob'));

            const result = kickPlayer('room-kick-non-host', 'p2', 'host1');

            expect(result).toBeNull();
            expect(
                getRoom('room-kick-non-host')!.players.map((p) => p.id)
            ).toEqual(['host1', 'p2']);
        });

        it('should return null when trying to kick the host or a missing player', () => {
            createRoom('room-kick-invalid-targets', 'host1');
            joinRoom(
                'room-kick-invalid-targets',
                createPlayer('host1', 'Host')
            );
            joinRoom('room-kick-invalid-targets', createPlayer('p2', 'Bob'));

            expect(
                kickPlayer('room-kick-invalid-targets', 'host1', 'host1')
            ).toBeNull();
            expect(
                kickPlayer('room-kick-invalid-targets', 'host1', 'missing')
            ).toBeNull();
            expect(
                getRoom('room-kick-invalid-targets')!.players.map((p) => p.id)
            ).toEqual(['host1', 'p2']);
        });

        // ── Win-condition tests after vote-kick ──────────────────────────────

        it('impostor vote-kicked: phase=RESULTS, ejectedId===impostorId (crewmates win)', () => {
            const room = createRoom('room-vk-impostor-caught', 'host1');
            joinRoom('room-vk-impostor-caught', createPlayer('host1', 'Host'));
            joinRoom(
                'room-vk-impostor-caught',
                createPlayer('impostor', 'Bad')
            );
            joinRoom('room-vk-impostor-caught', createPlayer('p3', 'Charlie'));
            room.phase = 'DRAWING';
            room.impostorId = 'impostor';
            room.turnOrder = ['host1', 'impostor', 'p3'];
            room.currentTurnPlayerId = 'impostor';
            room.turnIndex = 1;

            voteKickPlayer('room-vk-impostor-caught', 'host1', 'impostor');
            const result = voteKickPlayer(
                'room-vk-impostor-caught',
                'p3',
                'impostor'
            );

            expect(result!.phase).toBe('RESULTS');
            expect(result!.gameEnded).toBe(true);
            expect(result!.ejectedId).toBe('impostor');
            expect(result!.ejectedId).toBe(result!.impostorId);
        });

        it('crewmate vote-kicked, impostor still active: ejectedId!=impostorId (impostor wins)', () => {
            const room = createRoom('room-vk-wrong-kick', 'host1');
            joinRoom('room-vk-wrong-kick', createPlayer('host1', 'Host'));
            joinRoom('room-vk-wrong-kick', createPlayer('impostor', 'Bad'));
            joinRoom('room-vk-wrong-kick', createPlayer('p3', 'Charlie'));
            room.phase = 'DRAWING';
            room.impostorId = 'impostor';
            room.turnOrder = ['host1', 'impostor', 'p3'];
            room.currentTurnPlayerId = 'p3';
            room.turnIndex = 2;

            voteKickPlayer('room-vk-wrong-kick', 'impostor', 'p3');
            const result = voteKickPlayer('room-vk-wrong-kick', 'host1', 'p3');

            expect(result!.phase).toBe('RESULTS');
            expect(result!.gameEnded).toBe(true);
            expect(result!.ejectedId).toBe('p3');
            expect(result!.ejectedId).not.toBe(result!.impostorId);
        });

        it('crewmate vote-kicked, impostor disconnected: ejectedId===impostorId (crewmates win by attrition)', () => {
            const room = createRoom('room-vk-impostor-gone', 'host1');
            joinRoom('room-vk-impostor-gone', createPlayer('host1', 'Host'));
            const impostor = createPlayer('impostor', 'Bad');
            joinRoom('room-vk-impostor-gone', impostor);
            joinRoom('room-vk-impostor-gone', createPlayer('p3', 'Charlie'));
            room.phase = 'DRAWING';
            room.impostorId = 'impostor';
            room.turnOrder = ['host1', 'impostor', 'p3'];
            room.currentTurnPlayerId = 'p3';
            room.turnIndex = 2;
            impostor.isConnected = false;

            const result = voteKickPlayer(
                'room-vk-impostor-gone',
                'host1',
                'p3'
            );

            expect(result!.phase).toBe('RESULTS');
            expect(result!.gameEnded).toBe(true);
            expect(result!.ejectedId).toBe('impostor');
        });

        // ── Kick blocklist tests ─────────────────────────────────────────────

        it('lobby-kicked player cannot rejoin the same room', () => {
            createRoom('room-blocklist-lobby', 'host1');
            joinRoom('room-blocklist-lobby', createPlayer('host1', 'Host'));
            joinRoom('room-blocklist-lobby', createPlayer('p2', 'Bob'));
            kickPlayer('room-blocklist-lobby', 'host1', 'p2');

            const rejoin = joinRoom(
                'room-blocklist-lobby',
                createPlayer('p2', 'Bob')
            );
            expect(rejoin).toBeNull();
        });

        it('mid-game vote-kicked player cannot rejoin the same room', () => {
            const room = createRoom('room-blocklist-midgame', 'host1');
            joinRoom('room-blocklist-midgame', createPlayer('host1', 'Host'));
            joinRoom('room-blocklist-midgame', createPlayer('p2', 'Bob'));
            joinRoom('room-blocklist-midgame', createPlayer('p3', 'Charlie'));
            joinRoom('room-blocklist-midgame', createPlayer('p4', 'Dave'));
            room.phase = 'DRAWING';
            room.impostorId = 'host1';
            room.turnOrder = ['host1', 'p2', 'p3', 'p4'];
            room.currentTurnPlayerId = 'p2';
            room.turnIndex = 1;

            voteKickPlayer('room-blocklist-midgame', 'p3', 'p2');
            voteKickPlayer('room-blocklist-midgame', 'p4', 'p2');
            voteKickPlayer('room-blocklist-midgame', 'host1', 'p2');

            const rejoin = joinRoom(
                'room-blocklist-midgame',
                createPlayer('p2', 'Bob')
            );
            expect(rejoin).toBeNull();
        });

        it('playAgain clears the kick blocklist so players can rejoin a new game', () => {
            createRoom('room-blocklist-reset', 'host1');
            joinRoom('room-blocklist-reset', createPlayer('host1', 'Host'));
            joinRoom('room-blocklist-reset', createPlayer('p2', 'Bob'));
            kickPlayer('room-blocklist-reset', 'host1', 'p2');
            playAgain('room-blocklist-reset', 'host1');

            const rejoin = joinRoom(
                'room-blocklist-reset',
                createPlayer('p2', 'Bob')
            );
            expect(rejoin).not.toBeNull();
        });

        // ── playAgain ejected-player cleanup ─────────────────────────────────

        it('playAgain keeps normally ejected players and resets isEjected', () => {
            const room = createRoom('room-playagain-ejected', 'host1');
            joinRoom('room-playagain-ejected', createPlayer('host1', 'Host'));
            joinRoom('room-playagain-ejected', createPlayer('p2', 'Bob'));
            joinRoom('room-playagain-ejected', createPlayer('p3', 'Charlie'));
            room.phase = 'VOTING';
            room.impostorId = 'host1';

            castVote('room-playagain-ejected', 'host1', 'p2');
            castVote('room-playagain-ejected', 'p2', 'skip');
            const result = castVote('room-playagain-ejected', 'p3', 'p2');
            expect(result!.players.find((p) => p.id === 'p2')!.isEjected).toBe(
                true
            );

            result!.gameEnded = true;
            playAgain('room-playagain-ejected', 'host1');

            const lobby = getRoom('room-playagain-ejected')!;
            expect(lobby.phase).toBe('LOBBY');
            expect(lobby.players.map((p) => p.id)).toEqual(
                expect.arrayContaining(['host1', 'p2', 'p3'])
            );
            expect(lobby.players.find((p) => p.id === 'p2')!.isEjected).toBe(
                false
            );
        });

        it('playAgain keeps vote-kicked players out of the lobby', () => {
            const room = createRoom('room-playagain-ejected', 'host1');
            joinRoom('room-playagain-ejected', createPlayer('host1', 'Host'));
            joinRoom('room-playagain-ejected', createPlayer('p2', 'Bob'));
            joinRoom('room-playagain-ejected', createPlayer('p3', 'Charlie'));
            joinRoom('room-playagain-ejected', createPlayer('p4', 'Dave'));
            room.phase = 'DRAWING';
            room.impostorId = 'host1';
            room.turnOrder = ['host1', 'p2', 'p3', 'p4'];
            room.currentTurnPlayerId = 'p2';
            room.turnIndex = 1;

            voteKickPlayer('room-playagain-ejected', 'p3', 'p2');
            voteKickPlayer('room-playagain-ejected', 'p4', 'p2');
            voteKickPlayer('room-playagain-ejected', 'host1', 'p2');

            room.gameEnded = true;
            room.phase = 'RESULTS';
            playAgain('room-playagain-ejected', 'host1');

            const lobby = getRoom('room-playagain-ejected')!;
            expect(lobby.phase).toBe('LOBBY');
            expect(lobby.players.map((p) => p.id)).not.toContain('p2');
            expect(lobby.players.map((p) => p.id)).toEqual(
                expect.arrayContaining(['host1', 'p3', 'p4'])
            );
        });

        it('vote is toggled off when the same player votes for the same target twice', () => {
            const room = createRoom('room-vote-toggle', 'host1');
            joinRoom('room-vote-toggle', createPlayer('host1', 'Host'));
            joinRoom('room-vote-toggle', createPlayer('p2', 'Bob'));
            joinRoom('room-vote-toggle', createPlayer('p3', 'Charlie'));
            joinRoom('room-vote-toggle', createPlayer('p4', 'Dave'));
            room.phase = 'DRAWING';
            room.turnOrder = ['host1', 'p2', 'p3', 'p4'];
            room.currentTurnPlayerId = 'p2';
            room.turnIndex = 1;

            voteKickPlayer('room-vote-toggle', 'p3', 'p2');
            const result = voteKickPlayer('room-vote-toggle', 'p3', 'p2');

            expect(result!.kickVotes['p2']).toEqual([]);
            expect(
                result!.players.find((p) => p.id === 'p2')!.isEjected
            ).toBeFalsy();
        });

        it('should allow an ejected player to vote to kick and be voted to kick', () => {
            const room = createRoom('room-votekick-ejected', 'host1');
            joinRoom('room-votekick-ejected', createPlayer('host1', 'Host'));
            const p2 = createPlayer('p2', 'Bob');
            p2.isEjected = true;
            joinRoom('room-votekick-ejected', p2);
            joinRoom('room-votekick-ejected', createPlayer('p3', 'Charlie'));

            room.phase = 'DRAWING';
            room.turnOrder = ['host1', 'p2', 'p3'];
            room.turnIndex = 0;
            room.currentTurnPlayerId = 'host1';

            // p2 (ejected) votes to kick p3
            let result = voteKickPlayer('room-votekick-ejected', 'p2', 'p3');
            expect(result).not.toBeNull();
            expect(result!.kickVotes['p3']).toEqual(['p2']);

            // p3 votes to kick p2 (ejected)
            result = voteKickPlayer('room-votekick-ejected', 'p3', 'p2');
            expect(result).not.toBeNull();
            expect(result!.kickVotes['p2']).toEqual(['p3']);

            // host1 votes to kick p2 (ejected). Threshold is 2 (host1, p3 since p2 is target)
            result = voteKickPlayer('room-votekick-ejected', 'host1', 'p2');
            expect(result).not.toBeNull();
            expect(result!.players.find((p) => p.id === 'p2')).toBeUndefined();
        });

        it('should return null when trying to vote-kick the host', () => {
            const room = createRoom('room-votekick-host', 'host1');
            joinRoom('room-votekick-host', createPlayer('host1', 'Host'));
            joinRoom('room-votekick-host', createPlayer('p2', 'Bob'));
            joinRoom('room-votekick-host', createPlayer('p3', 'Charlie'));

            room.phase = 'DRAWING';
            room.turnOrder = ['host1', 'p2', 'p3'];
            room.turnIndex = 0;
            room.currentTurnPlayerId = 'host1';

            const result = voteKickPlayer('room-votekick-host', 'p2', 'host1');

            expect(result).toBeNull();
            expect(
                getRoom('room-votekick-host')!.kickVotes['host1']
            ).toBeUndefined();
        });
    });

    describe('updateGameOptions', () => {
        it('should update game options when the host changes them in the lobby', () => {
            const room = createRoom('room-options', 'host1');

            const result = updateGameOptions('room-options', 'host1', {
                roundTime: 40,
                unlimitedInk: true,
                clearCanvasEachRound: false,
            });

            expect(result).toBe(room);
            expect(result!.gameOptions).toEqual({
                roundTime: 40,
                unlimitedInk: true,
                clearCanvasEachRound: false,
                impostorGuessEnabled: false,
                impostorGuessAttempts: 3,
            });
        });

        it('should merge game options with existing values', () => {
            createRoom('room-options-merge', 'host1');

            updateGameOptions('room-options-merge', 'host1', {
                roundTime: 35,
                unlimitedInk: false,
                clearCanvasEachRound: true,
            });

            const result = updateGameOptions('room-options-merge', 'host1', {
                roundTime: 35,
                unlimitedInk: true,
                clearCanvasEachRound: true,
            });

            expect(result).not.toBeNull();
            expect(result!.gameOptions).toEqual({
                roundTime: 35,
                unlimitedInk: true,
                clearCanvasEachRound: true,
                impostorGuessEnabled: false,
                impostorGuessAttempts: 3,
            });
        });

        it('should ignore invalid fields and unknown keys while applying valid updates', () => {
            createRoom('room-options-sanitize', 'host1');

            const result = updateGameOptions('room-options-sanitize', 'host1', {
                roundTime: 'bad-value',
                unlimitedInk: true,
                clearCanvasEachRound: 'nope',
                unexpected: 'ignored',
            });

            expect(result).not.toBeNull();
            expect(result!.gameOptions).toEqual({
                roundTime: DEFAULT_ROUND_TIME,
                unlimitedInk: true,
                clearCanvasEachRound: true,
                impostorGuessEnabled: false,
                impostorGuessAttempts: 3,
            });
            expect('unexpected' in result!.gameOptions).toBe(false);
        });

        it('should only accept configured roundTime values', () => {
            createRoom('room-options-round-times', 'host1');

            const invalidResult = updateGameOptions(
                'room-options-round-times',
                'host1',
                {
                    roundTime: 21,
                }
            );

            expect(invalidResult).not.toBeNull();
            expect(invalidResult!.gameOptions.roundTime).toBe(
                DEFAULT_ROUND_TIME
            );

            for (const roundTime of ALLOWED_ROUND_TIMES) {
                const result = updateGameOptions(
                    'room-options-round-times',
                    'host1',
                    { roundTime }
                );

                expect(result).not.toBeNull();
                expect(result!.gameOptions.roundTime).toBe(roundTime);
            }
        });

        it('should update impostorGuessEnabled', () => {
            createRoom('room-options-guess-enabled', 'host1');

            const result = updateGameOptions(
                'room-options-guess-enabled',
                'host1',
                { impostorGuessEnabled: true }
            );

            expect(result!.gameOptions.impostorGuessEnabled).toBe(true);
        });

        it('should clamp impostorGuessAttempts to [1, 3] and round it', () => {
            createRoom('room-options-attempts', 'host1');
            const update = (value: unknown) =>
                updateGameOptions('room-options-attempts', 'host1', {
                    impostorGuessAttempts: value,
                })!.gameOptions.impostorGuessAttempts;

            expect(update(2)).toBe(2); // in range
            expect(update(5)).toBe(3); // above max -> clamped
            expect(update(0)).toBe(1); // below min -> clamped
            expect(update(-4)).toBe(1); // negative -> clamped
            expect(update(2.4)).toBe(2); // rounded down
            expect(update(2.6)).toBe(3); // rounded up
        });

        it('should ignore a non-numeric impostorGuessAttempts', () => {
            createRoom('room-options-attempts-invalid', 'host1');

            const result = updateGameOptions(
                'room-options-attempts-invalid',
                'host1',
                { impostorGuessAttempts: 'lots' }
            );

            // Falls back to the default (3) rather than corrupting the value.
            expect(result!.gameOptions.impostorGuessAttempts).toBe(3);
        });

        it('should reject non-object payloads', () => {
            createRoom('room-options-non-object', 'host1');

            expect(
                updateGameOptions(
                    'room-options-non-object',
                    'host1',
                    'bad payload'
                )
            ).toBeNull();
        });

        it('should return null for non-hosts, non-lobby rooms, or missing rooms', () => {
            const room = createRoom('room-options-invalid', 'host1');
            room.phase = 'DRAWING';

            expect(
                updateGameOptions('room-options-invalid', 'p2', {
                    roundTime: 30,
                    unlimitedInk: false,
                    clearCanvasEachRound: true,
                })
            ).toBeNull();
            expect(
                updateGameOptions('room-options-invalid', 'host1', {
                    roundTime: 30,
                    unlimitedInk: false,
                    clearCanvasEachRound: true,
                })
            ).toBeNull();
            expect(
                updateGameOptions('missing-room', 'host1', {
                    roundTime: 30,
                    unlimitedInk: false,
                    clearCanvasEachRound: true,
                })
            ).toBeNull();
        });
    });

    describe('submitImpostorGuess & skipImpostorGuess', () => {
        // Build a room ready for the impostor ('imp') to guess the word 'Dog'.
        const setupGuessRoom = (id: string, word = 'Dog') => {
            const room = createRoom(id, 'host1');
            room.impostorId = 'imp';
            room.secretWord = word;
            room.secretCategory = 'Animals';
            room.gameOptions.impostorGuessEnabled = true;
            room.phase = 'DRAWING';
            return room;
        };

        it('should accept the correct word in English', () => {
            setupGuessRoom('guess-en');
            const result = submitImpostorGuess('guess-en', 'imp', 'Dog', 'en');
            expect(result!.impostorGuessedCorrectly).toBe(true);
            expect(result!.phase).toBe('RESULTS');
            expect(result!.gameEnded).toBe(true);
        });

        it('should validate against the selected language (Spanish)', () => {
            const room = setupGuessRoom('guess-es');
            // The English word would be wrong when the player is on Spanish only
            // if it were rejected, but the canonical key is also accepted; the
            // important part is that the Spanish translation is accepted.
            const result = submitImpostorGuess(
                'guess-es',
                'imp',
                'Perro',
                'es'
            );
            expect(result!.impostorGuessedCorrectly).toBe(true);
            expect(room.phase).toBe('RESULTS');
        });

        it('should validate against the selected language (Catalan)', () => {
            setupGuessRoom('guess-ca');
            const result = submitImpostorGuess('guess-ca', 'imp', 'Gos', 'ca');
            expect(result!.impostorGuessedCorrectly).toBe(true);
        });

        it('should be case-insensitive', () => {
            setupGuessRoom('guess-case');
            const result = submitImpostorGuess(
                'guess-case',
                'imp',
                'PeRRo',
                'es'
            );
            expect(result!.impostorGuessedCorrectly).toBe(true);
        });

        it('should be accent-insensitive', () => {
            // Spanish for "Lion" is "León"; guessing "leon" should still match.
            setupGuessRoom('guess-accent', 'Lion');
            const result = submitImpostorGuess(
                'guess-accent',
                'imp',
                'leon',
                'es'
            );
            expect(result!.impostorGuessedCorrectly).toBe(true);
        });

        it('should reject a wrong guess and consume an attempt without ending the game', () => {
            const room = setupGuessRoom('guess-wrong');
            const result = submitImpostorGuess(
                'guess-wrong',
                'imp',
                'Cat',
                'en'
            );
            expect(result!.impostorGuessedCorrectly).toBe(false);
            expect(result!.impostorGuessesUsed).toBe(1);
            expect(result!.phase).toBe('DRAWING');
            expect(room.gameEnded).toBe(false);
        });

        it('should reject another language word when it does not match the selection', () => {
            // Secret 'Dog', player on English, guessing the Spanish word.
            setupGuessRoom('guess-mismatch');
            const result = submitImpostorGuess(
                'guess-mismatch',
                'imp',
                'Perro',
                'en'
            );
            expect(result!.impostorGuessedCorrectly).toBe(false);
        });

        it('should stop accepting guesses once the attempt pool is exhausted', () => {
            const room = setupGuessRoom('guess-cap');
            for (let i = 0; i < MAX_IMPOSTOR_GUESSES; i++) {
                submitImpostorGuess('guess-cap', 'imp', 'Wrong', 'en');
            }
            expect(room.impostorGuessesUsed).toBe(MAX_IMPOSTOR_GUESSES);
            expect(
                submitImpostorGuess('guess-cap', 'imp', 'Dog', 'en')
            ).toBeNull();
            expect(room.impostorGuessedCorrectly).toBe(false);
        });

        it('should only let the impostor guess', () => {
            setupGuessRoom('guess-not-impostor');
            expect(
                submitImpostorGuess(
                    'guess-not-impostor',
                    'someone',
                    'Dog',
                    'en'
                )
            ).toBeNull();
        });

        it('should return null when the feature is disabled', () => {
            const room = setupGuessRoom('guess-disabled');
            room.gameOptions.impostorGuessEnabled = false;
            expect(
                submitImpostorGuess('guess-disabled', 'imp', 'Dog', 'en')
            ).toBeNull();
        });

        it('should default to English for an unknown language', () => {
            setupGuessRoom('guess-unknown-lang');
            const result = submitImpostorGuess(
                'guess-unknown-lang',
                'imp',
                'Dog',
                'fr'
            );
            expect(result!.impostorGuessedCorrectly).toBe(true);
        });

        it('should resolve the final ejected guess: correct wins', () => {
            const room = setupGuessRoom('guess-final-win');
            room.phase = 'IMPOSTOR_GUESS';
            const result = submitImpostorGuess(
                'guess-final-win',
                'imp',
                'Gos',
                'ca'
            );
            expect(result!.impostorGuessedCorrectly).toBe(true);
            expect(result!.phase).toBe('RESULTS');
            expect(result!.gameEnded).toBe(true);
        });

        it('should resolve the final ejected guess: wrong ends the game for crewmates', () => {
            const room = setupGuessRoom('guess-final-lose');
            room.phase = 'IMPOSTOR_GUESS';
            const result = submitImpostorGuess(
                'guess-final-lose',
                'imp',
                'Cat',
                'en'
            );
            expect(result!.impostorGuessedCorrectly).toBe(false);
            expect(result!.phase).toBe('RESULTS');
            expect(result!.gameEnded).toBe(true);
            // The final guess is not bounded by the in-phase attempt pool.
            expect(room.impostorGuessesUsed).toBe(0);
        });

        it('skipImpostorGuess should end the game in favour of the crewmates', () => {
            const room = setupGuessRoom('guess-skip');
            room.phase = 'IMPOSTOR_GUESS';
            const result = skipImpostorGuess('guess-skip', 'imp');
            expect(result!.phase).toBe('RESULTS');
            expect(result!.gameEnded).toBe(true);
            expect(result!.impostorGuessedCorrectly).toBe(false);
        });

        it('skipImpostorGuess should be a no-op when not in the final-guess phase', () => {
            setupGuessRoom('guess-skip-invalid');
            expect(skipImpostorGuess('guess-skip-invalid', 'imp')).toBeNull();
        });

        it('should move the ejected impostor into the IMPOSTOR_GUESS phase', () => {
            const room = createRoom('guess-eject-phase', 'host1');
            room.impostorId = 'imp';
            room.secretWord = 'Dog';
            room.gameOptions.impostorGuessEnabled = true;
            room.phase = 'VOTING';
            room.players = ['imp', 'p2', 'p3'].map((id) => ({
                id,
                name: id,
                isConnected: true,
                score: 0,
                hasStartedEmergencyVoting: false,
            }));
            // Majority votes the impostor out.
            castVote('guess-eject-phase', 'p2', 'imp');
            castVote('guess-eject-phase', 'p3', 'imp');
            castVote('guess-eject-phase', 'imp', 'p2');
            expect(room.phase).toBe('IMPOSTOR_GUESS');
            expect(room.gameEnded).toBe(false);
            expect(room.ejectedId).toBe('imp');
        });
    });
});
