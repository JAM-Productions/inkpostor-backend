import {
    GameMode,
    GameOptions,
    GameRoom,
    Player,
    StrokeData,
    TurnOrderMode,
} from './types';
import wordData from './data.json';
import wordTranslations from './wordTranslations.json';
import {
    ALLOWED_ROUND_TIMES,
    DEFAULT_GAME_MODE,
    DEFAULT_GAME_OPTIONS,
    GAME_MODES,
    isPlayerWordMode,
    isSpokenMode,
    MAX_CUSTOM_WORD_LENGTH,
    MODE_LOCKED_OPTIONS,
    MAX_IMPOSTOR_GUESSES,
    MAX_NUM_PLAYERS_PER_ROOM,
    MIN_CUSTOM_WORD_LENGTH,
    MIN_IMPOSTOR_GUESSES,
    SPECIAL_CATEGORY,
    TURN_ORDER_MODES,
} from './constants';

const rooms: Record<string, GameRoom> = {};
const kickedFromRoom: Record<string, Set<string>> = {}; // roomId -> Set<playerId>

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Some modes take an option over: the value they impose is forced and the host
// cannot change it while that mode is selected (see MODE_LOCKED_OPTIONS).
function applyModeLockedOptions(
    options: GameOptions,
    gameMode: GameMode
): GameOptions {
    return { ...options, ...MODE_LOCKED_OPTIONS[gameMode] };
}

// Reads the host's payload into their stored choices. Mode locks are NOT applied
// here: what the host picked is kept as picked, and the locks are layered on top
// when the effective options are derived (see updateGameOptions).
function sanitizeGameOptionsUpdate(
    options: unknown,
    currentOptions: GameOptions
): GameOptions | null {
    if (!isPlainObject(options)) return null;

    const nextOptions = { ...currentOptions };

    if (
        typeof options.roundTime === 'number' &&
        Number.isFinite(options.roundTime)
    ) {
        const normalizedRoundTime = Math.round(options.roundTime);
        if (
            ALLOWED_ROUND_TIMES.includes(
                normalizedRoundTime as (typeof ALLOWED_ROUND_TIMES)[number]
            )
        ) {
            nextOptions.roundTime = normalizedRoundTime;
        }
    }
    if (typeof options.unlimitedInk === 'boolean') {
        nextOptions.unlimitedInk = options.unlimitedInk;
    }
    if (typeof options.clearCanvasEachRound === 'boolean') {
        nextOptions.clearCanvasEachRound = options.clearCanvasEachRound;
    }
    if (typeof options.playerColorsEnabled === 'boolean') {
        nextOptions.playerColorsEnabled = options.playerColorsEnabled;
    }
    if (typeof options.impostorGuessEnabled === 'boolean') {
        nextOptions.impostorGuessEnabled = options.impostorGuessEnabled;
    }
    if (
        typeof options.impostorGuessAttempts === 'number' &&
        Number.isFinite(options.impostorGuessAttempts)
    ) {
        const rounded = Math.round(options.impostorGuessAttempts);
        nextOptions.impostorGuessAttempts = Math.min(
            MAX_IMPOSTOR_GUESSES,
            Math.max(MIN_IMPOSTOR_GUESSES, rounded)
        );
    }
    if (typeof options.impostorLosesWhenOutOfGuesses === 'boolean') {
        nextOptions.impostorLosesWhenOutOfGuesses =
            options.impostorLosesWhenOutOfGuesses;
    }
    if (typeof options.hideHint === 'boolean') {
        nextOptions.hideHint = options.hideHint;
    }
    if (TURN_ORDER_MODES.includes(options.turnOrderMode as TurnOrderMode)) {
        nextOptions.turnOrderMode = options.turnOrderMode as TurnOrderMode;
    }

    if (!nextOptions.impostorGuessEnabled) {
        nextOptions.impostorLosesWhenOutOfGuesses =
            DEFAULT_GAME_OPTIONS.impostorLosesWhenOutOfGuesses;
    }

    return nextOptions;
}

export function createRoom(roomId: string, hostId: string): GameRoom {
    if (kickedFromRoom[roomId]) delete kickedFromRoom[roomId];
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
        kickVotes: {},
        canvasStrokes: [],
        currentRound: 1,
        ejectedId: null,
        gameEnded: false,
        gameOptions: { ...DEFAULT_GAME_OPTIONS },
        hostGameOptions: { ...DEFAULT_GAME_OPTIONS },
        gameMode: DEFAULT_GAME_MODE,
        usedWords: [],
        impostorGuessesUsed: 0,
        impostorGuessedCorrectly: false,
        impostorOutOfGuesses: false,
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

    // Check if player was kicked from this room (lobby kick)
    if (kickedFromRoom[roomId]?.has(player.id)) return null;

    // Check if player already exists (reconnecting via same UUID)
    const existingPlayerIndex = room.players.findIndex(
        (p) => p.id === player.id
    );
    if (existingPlayerIndex >= 0) {
        room.players[existingPlayerIndex].isConnected = true;
        if (player.language) {
            room.players[existingPlayerIndex].language = player.language;
        }
    } else {
        // Cannot join mid-game unless reconnecting
        if (room.phase !== 'LOBBY') return null;
        // Enforce maximum players per room
        if (room.players.length >= MAX_NUM_PLAYERS_PER_ROOM) return null;

        room.players.push(player);
    }
    return room;
}

export function leaveRoom(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room) return null;
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) return room;

    if (room.phase === 'LOBBY') {
        room.players.splice(playerIndex, 1);
        return room;
    }

    room.players[playerIndex].isConnected = false;

    // Re-evaluate phase transitions so the game doesn't hang when the player who
    // was holding up the current phase drops out.
    //
    // WORD_SELECTION is deliberately excluded: a drop must never advance the
    // phase there, or a flaky connection would rush everyone out of the form
    // before they finish typing. The phase is only re-evaluated when someone
    // actually submits a word.
    switch (room.phase) {
        case 'VOTING':
            checkVotingComplete(room);
            break;
        case 'RESULTS':
            if (!room.gameEnded) checkAllConfirmedNewRound(room);
            break;
    }

    if (room.phase === 'IMPOSTOR_GUESS') {
        const impostor = room.players.find((p) => p.id === room.impostorId);
        if (!impostor || !impostor.isConnected) {
            room.phase = 'RESULTS';
            room.gameEnded = true;
        }
    }

    //NOTE: If no players are connected, we could delete the room after a timeout
    return room;
}

function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

// Fisher-Yates. The usual `sort(() => Math.random() - 0.5)` shortcut is biased
// towards leaving items near where they started, which becomes visible once
// RANDOM_ORDER redraws the order round after round.
function shuffle<T>(items: T[]): T[] {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Draws a word (and its category) from the built-in word list, avoiding words
// already played in this game. Falls back to the full list once they run out.
function assignRandomWord(room: GameRoom) {
    const available = wordData.categories
        .flatMap((category) =>
            category.words.map((word) => ({ word, category: category.name }))
        )
        .filter(({ word }) => !room.usedWords.includes(word));

    const picked =
        available.length > 0
            ? pickRandom(available)
            : (() => {
                  const category = pickRandom(wordData.categories);
                  return {
                      word: pickRandom(category.words),
                      category: category.name,
                  };
              })();

    room.secretWord = picked.word;
    room.secretCategory = picked.category;
    room.usedWords.push(picked.word);
}

export function startGame(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId || room.players.length < 3)
        return null;

    // Pick Impostor
    const impostorIndex = Math.floor(Math.random() * room.players.length);
    room.impostorId = room.players[impostorIndex].id;

    // Setup Turns
    room.turnOrder = shuffle(room.players.map((p) => p.id));
    room.turnIndex = 0;
    room.currentTurnPlayerId = room.turnOrder[0];

    // Reset state
    room.votes = {};
    room.kickVotes = {};
    room.canvasStrokes = [];
    room.players.forEach((p) => {
        p.hasVoted = false;
        p.isEjected = false;
        p.hasRevealedRole = false;
        p.hasRevealedNewWord = false;
        p.hasConfirmedOrder = false;
        p.hasConfirmedNewRound = false;
        p.hasStartedEmergencyVoting = false;
        p.customWord = null;
        p.hasSubmittedWord = false;
    });
    room.ejectedId = null;
    room.gameEnded = false;
    room.usedWords = [];
    room.impostorGuessesUsed = 0;
    room.impostorGuessedCorrectly = false;
    room.impostorOutOfGuesses = false;

    if (isPlayerWordMode(room.gameMode)) {
        // The word comes from the players, so it isn't known yet.
        room.secretWord = null;
        room.secretCategory = null;
        room.phase = 'WORD_SELECTION';
        return room;
    }

    assignRandomWord(room);
    room.phase = 'ROLE_REVEAL';
    return room;
}

// Unknown modes are ignored rather than rejected, like every other field of the
// options payload: a stray value must not throw away the rest of the update.
function applyGameMode(room: GameRoom, mode: unknown) {
    if (!GAME_MODES.includes(mode as GameMode)) return;
    room.gameMode = mode as GameMode;
}

// Resolves WORD_SELECTION once every player who can still answer has submitted.
// Disconnected players are skipped so a player who left cannot block the phase
// forever, but this only ever runs on an actual submission — never on a
// disconnect — so dropping out can't push the phase forward by itself.
function checkAllCustomWordsSubmitted(room: GameRoom) {
    const allSubmitted = room.players.every(
        (p) => !p.isConnected || p.hasSubmittedWord
    );
    if (!allSubmitted) return;

    // The impostor must not be able to win by having their own word drawn, so
    // their submission is excluded from the pool.
    const candidates = room.players
        .filter((p) => p.id !== room.impostorId && p.customWord)
        .map((p) => p.customWord as string);

    if (candidates.length > 0) {
        room.secretWord = pickRandom(candidates);
        room.secretCategory = SPECIAL_CATEGORY;
    } else {
        // Nobody but the impostor supplied a word — fall back to the word list so
        // the game can still run.
        assignRandomWord(room);
    }

    room.phase = 'ROLE_REVEAL';
}

export function submitCustomWord(
    roomId: string,
    playerId: string,
    word: unknown
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'WORD_SELECTION') return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.hasSubmittedWord) return null;
    if (typeof word !== 'string') return null;
    const normalizedWord = word.trim();
    if (
        normalizedWord.length < MIN_CUSTOM_WORD_LENGTH ||
        normalizedWord.length > MAX_CUSTOM_WORD_LENGTH
    )
        return null;

    player.customWord = normalizedWord;
    player.hasSubmittedWord = true;
    checkAllCustomWordsSubmitted(room);
    return room;
}

export function nextTurn(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;

    let foundNext = false;
    while (room.turnIndex < room.turnOrder.length - 1) {
        room.turnIndex++;
        const nextId = room.turnOrder[room.turnIndex];
        const nextP = room.players.find((p) => p.id === nextId);
        if (nextP && nextP.isConnected && !nextP.isEjected) {
            room.currentTurnPlayerId = nextId;
            foundNext = true;
            break;
        }
    }
    if (!foundNext) {
        // Everyone has drawn, start voting phase!
        room.phase = 'VOTING';
        room.currentTurnPlayerId = null;
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
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;

    room.canvasStrokes.push(stroke);
    return room;
}

export function undoStroke(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;

    if (room.canvasStrokes.length > 0) {
        // Find the last index where isNewStroke is true
        let lastNewStrokeIndex = room.canvasStrokes.length - 1;
        while (
            lastNewStrokeIndex >= 0 &&
            !room.canvasStrokes[lastNewStrokeIndex].isNewStroke
        ) {
            lastNewStrokeIndex--;
        }

        if (lastNewStrokeIndex >= 0) {
            room.canvasStrokes = room.canvasStrokes.slice(
                0,
                lastNewStrokeIndex
            );
        } else {
            room.canvasStrokes = [];
        }
    }

    return room;
}

// Where a round actually starts. Nothing is drawn in ORIGINAL: the players say
// their words out loud, so the round opens on the screen that tells them who
// starts and in which direction.
function roundStartPhase(room: GameRoom): 'ORDER_INFO' | 'DRAWING' {
    return isSpokenMode(room.gameMode) ? 'ORDER_INFO' : 'DRAWING';
}

export function proceedToDrawing(
    roomId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'ROLE_REVEAL') return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player) return null;
    player.hasRevealedRole = true;
    const allRevealed = room.players.every((p) => p.hasRevealedRole);
    if (allRevealed) {
        room.phase = roundStartPhase(room);
    }
    return room;
}

// Resolves ORDER_INFO once every non-ejected player has confirmed. Like the
// other reveal screens this waits for disconnected players too — a round must
// not start behind the back of someone who is reconnecting (the host can always
// end the game). Ejected players may watch, but are not waited for.
function checkAllConfirmedOrder(room: GameRoom) {
    const allConfirmed = room.players.every(
        (p) => p.isEjected || p.hasConfirmedOrder
    );
    if (allConfirmed) {
        room.phase = 'VOTING';
    }
}

// Confirmation of the ORDER_INFO screen (ORIGINAL mode). The order itself is
// public, so this is only a "everyone has read it" gate before voting opens.
export function confirmOrder(
    roomId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'ORDER_INFO') return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;
    player.hasConfirmedOrder = true;
    checkAllConfirmedOrder(room);
    return room;
}

// Whether the impostor still holds a guess: the feature is on and the shared
// pool has something left in it. Both the in-phase guesses and the final one an
// ejected impostor is offered come out of this same counter.
function hasGuessesLeft(room: GameRoom): boolean {
    return (
        room.gameOptions.impostorGuessEnabled &&
        room.impostorGuessesUsed < room.gameOptions.impostorGuessAttempts
    );
}

function checkVotingComplete(room: GameRoom) {
    // Prune stale votes from ejected/disconnected players
    Object.keys(room.votes).forEach((voterId) => {
        const voter = room.players.find((p) => p.id === voterId);
        if (!voter || voter.isEjected || !voter.isConnected) {
            delete room.votes[voterId];
        }
    });

    const totalConnected = room.players.filter(
        (p) => p.isConnected && !p.isEjected
    ).length;
    const totalVotesCast = Object.keys(room.votes).length;

    if (totalVotesCast >= totalConnected && totalConnected > 0) {
        const counts: Record<string, number> = {};
        Object.values(room.votes).forEach((vote) => {
            counts[vote] = (counts[vote] || 0) + 1;
        });

        let maxVotes = 0;
        let ejectedId: null | string = null;
        let isTie = false;

        Object.entries(counts).forEach(([id, count]) => {
            if (count > maxVotes) {
                maxVotes = count;
                ejectedId = id;
                isTie = false;
            } else if (count === maxVotes) {
                isTie = true;
            }
        });

        if (isTie || ejectedId === 'skip') {
            room.ejectedId = null;
        } else {
            room.ejectedId = ejectedId;
            const ejectedPlayer = room.players.find((p) => p.id === ejectedId);
            if (ejectedPlayer) ejectedPlayer.isEjected = true;
            if (ejectedId === room.impostorId) {
                // The last chance is what is left of the pool: an impostor
                // caught with attempts still on the counter gets to spend one,
                // one who already burned them all is simply out.
                if (hasGuessesLeft(room)) {
                    room.phase = 'IMPOSTOR_GUESS';
                    return; // Defer RESULTS until the final guess is submitted/skipped
                }
                // Impostor ejected, crewmates win — game over
                room.gameEnded = true;
            }
        }
        room.phase = 'RESULTS';
    }
}

export function castVote(
    roomId: string,
    voterId: string,
    votedForId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'VOTING' || voterId === votedForId) return null;
    const voter = room.players.find((p) => p.id === voterId);
    if (!voter || voter.hasVoted || voter.isEjected) return null;
    const isSkip = votedForId === 'skip';
    if (!isSkip) {
        const voted = room.players.find((p) => p.id === votedForId);
        if (!voted || voted.isEjected) return null;
    }
    room.votes[voterId] = votedForId;
    voter.hasVoted = true;

    checkVotingComplete(room);

    return room;
}

// Case- and accent-insensitive normalization for word comparison.
function normalizeWord(value: string): string {
    return value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

type TranslationMap = Record<string, Record<string, string>>;

function resolveLanguage(language: unknown): string {
    const translations = wordTranslations as TranslationMap;
    if (typeof language !== 'string') return 'en';
    // Accept region-tagged codes such as "es-ES" by taking the base language.
    const base = language.split('-')[0].toLowerCase();
    return base in translations ? base : 'en';
}

// The secret word is stored as its canonical English key. The impostor guesses
// in the language they have selected, so we ONLY accept the translation for that
// language. Player-written words never reach this point: the modes that produce
// them don't allow guessing at all.
function isWordMatch(
    guess: string,
    secretWord: string | null,
    language: string
): boolean {
    if (!secretWord) return false;
    const normalizedGuess = normalizeWord(guess);
    const translations = wordTranslations as TranslationMap;
    const translated = translations[language]?.[secretWord];
    return !!translated && normalizedGuess === normalizeWord(translated);

    // To additionally accept the canonical English key as a fallback (e.g. for
    // missing translations or words identical across languages), uncomment:
    // return normalizedGuess === normalizeWord(secretWord);
}

export function submitImpostorGuess(
    roomId: string,
    playerId: string,
    guess: unknown,
    language: unknown
): GameRoom | null {
    const room = rooms[roomId];
    if (!room) return null;
    // Only the impostor may guess, and only when the feature is enabled in a
    // mode that supports it (the option is already forced off in those modes,
    // so this is just an explicit backstop).
    if (room.impostorId !== playerId) return null;
    if (MODE_LOCKED_OPTIONS[room.gameMode].impostorGuessEnabled === false)
        return null;
    if (!room.gameOptions.impostorGuessEnabled) return null;
    if (typeof guess !== 'string') return null;
    const normalizedGuess = guess.trim();
    if (!normalizedGuess) return null;

    // The post-ejection final guess is its own phase (single shot, can skip).
    // It is what is left of the pool being spent, so it doesn't check the
    // counter again: reaching the phase at all already required a guess left.
    const isFinalGuess = room.phase === 'IMPOSTOR_GUESS';
    if (!isFinalGuess) {
        // In-phase guess (DRAWING/VOTING), bounded by the shared attempt pool.
        if (room.phase !== 'DRAWING' && room.phase !== 'VOTING') return null;
        if (!hasGuessesLeft(room)) return null;
        room.impostorGuessesUsed++;
    }

    if (
        isWordMatch(normalizedGuess, room.secretWord, resolveLanguage(language))
    ) {
        // Correct guess: the impostor wins and the game ends immediately.
        room.impostorGuessedCorrectly = true;
        room.phase = 'RESULTS';
        room.gameEnded = true;
        return room;
    }

    // Wrong guess.
    if (isFinalGuess) {
        // The ejected impostor used their last chance -> crewmates win.
        room.phase = 'RESULTS';
        room.gameEnded = true;
    } else if (
        room.gameOptions.impostorLosesWhenOutOfGuesses &&
        !hasGuessesLeft(room)
    ) {
        // The host made the pool lethal: spending it loses the game on the spot,
        // with no ejection involved (hence the flag — the clients cannot tell).
        room.impostorOutOfGuesses = true;
        room.phase = 'RESULTS';
        room.gameEnded = true;
    }
    return room;
}

export function skipImpostorGuess(
    roomId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room) return null;
    if (room.impostorId !== playerId) return null;
    if (room.phase !== 'IMPOSTOR_GUESS') return null;
    // The ejected impostor declined their final guess -> crewmates win.
    room.phase = 'RESULTS';
    room.gameEnded = true;
    return room;
}

export function playAgain(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId) return null;
    room.phase = 'LOBBY';
    room.currentRound = 1;
    room.impostorId = null;
    room.secretWord = null;
    room.secretCategory = null;
    room.currentTurnPlayerId = null;
    room.turnOrder = [];
    room.turnIndex = 0;
    room.votes = {};
    room.kickVotes = {};
    room.canvasStrokes = [];
    room.players.forEach((p) => {
        p.hasVoted = false;
        p.isEjected = false;
        p.hasRevealedRole = false;
        p.hasRevealedNewWord = false;
        p.hasConfirmedOrder = false;
        p.hasConfirmedNewRound = false;
        p.hasStartedEmergencyVoting = false;
        p.customWord = null;
        p.hasSubmittedWord = false;
    });
    room.ejectedId = null;
    room.gameEnded = false;
    room.usedWords = [];
    room.impostorGuessesUsed = 0;
    room.impostorGuessedCorrectly = false;
    room.impostorOutOfGuesses = false;
    // gameMode is a lobby setting like gameOptions, so it survives Play Again.
    // Clear the lobby-kick blocklist for a fresh game
    delete kickedFromRoom[roomId];
    return room;
}

// Starts the next round once every active (connected, non-ejected) player has
// confirmed. Disconnected and ejected players are treated as already confirmed.
function checkAllConfirmedNewRound(room: GameRoom) {
    const allConfirmed = room.players.every(
        (p) => p.isEjected || !p.isConnected || p.hasConfirmedNewRound
    );
    if (!allConfirmed) return;

    room.phase = roundStartPhase(room);
    room.currentRound++;
    room.turnOrder = room.turnOrder.filter((id) => {
        const player = room.players.find((p) => p.id === id);
        return player && !player.isEjected;
    });
    // Only this mode redraws the order. The other two keep the one drawn at
    // startGame, so the same player opens every round.
    if (
        isSpokenMode(room.gameMode) &&
        room.gameOptions.turnOrderMode === 'RANDOM_ORDER'
    ) {
        room.turnOrder = shuffle(room.turnOrder);
    }
    if (room.turnOrder.length === 0) {
        room.currentTurnPlayerId = null;
    } else {
        room.currentTurnPlayerId = room.turnOrder[0];
    }
    room.turnIndex = 0;
    room.votes = {};
    room.kickVotes = {};
    room.players.forEach((p) => {
        p.hasVoted = false;
        p.hasConfirmedNewRound = false;
        // The order screen is shown again every round, so its gate reopens.
        // The order itself does not change: turnOrder was only filtered above
        // to drop ejected players, which is what moves the starting player on.
        p.hasConfirmedOrder = false;
    });
    room.ejectedId = null;
    if (room.gameOptions.clearCanvasEachRound) {
        room.canvasStrokes = [];
    }

    if (room.gameMode === 'HOT_WORD') {
        // A new word every round. The impostor stays the same, so only the word
        // is revealed again — roles are not.
        assignRandomWord(room);
        room.players.forEach((p) => {
            p.hasRevealedNewWord = false;
        });
        room.phase = 'WORD_REVEAL';
    }
}

// Confirmation of the WORD_REVEAL screen. Mirrors proceedToDrawing, but with its
// own phase and flag: the players already know their role here, only the word is
// new. Ejected players can watch the reveal but are not waited for.
export function confirmNewWord(
    roomId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'WORD_REVEAL') return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player) return null;
    player.hasRevealedNewWord = true;
    const allRevealed = room.players.every(
        (p) => p.isEjected || p.hasRevealedNewWord
    );
    if (allRevealed) {
        room.phase = 'DRAWING';
    }
    return room;
}

export function nextRound(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'RESULTS' || room.gameEnded) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;
    player.hasConfirmedNewRound = true;
    checkAllConfirmedNewRound(room);
    return room;
}

export function endGame(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId) return null;
    room.phase = 'RESULTS';
    room.gameEnded = true;
    return room;
}

export function startEmergencyVoting(
    roomId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;
    player.hasStartedEmergencyVoting = true;
    room.currentTurnPlayerId = null;
    room.phase = 'VOTING';
    return room;
}

export function kickPlayer(
    roomId: string,
    hostId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'LOBBY' || room.hostId !== hostId) return null;
    if (playerId === hostId) return null;
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) return null;
    room.players.splice(playerIndex, 1);
    // Block this player from rejoining the same room
    if (!kickedFromRoom[roomId]) kickedFromRoom[roomId] = new Set();
    kickedFromRoom[roomId].add(playerId);
    return room;
}

function executeKick(room: GameRoom, playerId: string) {
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) return;

    const wasCurrentTurn = room.currentTurnPlayerId === playerId;
    const wasImpostor = playerId === room.impostorId;
    const previousTurnIndex = room.turnIndex;

    room.players.splice(playerIndex, 1);
    room.turnOrder = room.turnOrder.filter((id) => id !== playerId);
    delete room.votes[playerId];
    Object.keys(room.votes).forEach((voterId) => {
        if (room.votes[voterId] === playerId) {
            delete room.votes[voterId];
        }
    });
    delete room.kickVotes[playerId];
    Object.keys(room.kickVotes).forEach((targetId) => {
        room.kickVotes[targetId] = room.kickVotes[targetId].filter(
            (voterId) => voterId !== playerId
        );
    });

    if (wasImpostor) {
        room.ejectedId = playerId;
        room.phase = 'RESULTS';
        room.gameEnded = true;
        return;
    }

    const activePlayers = room.players.filter((p) => p.isConnected);
    if (activePlayers.length < 3) {
        room.phase = 'RESULTS';
        room.gameEnded = true;
        // If the impostor is no longer actively playing (disconnected, kicked or ejected),
        // crewmates win by attrition — signal this by setting ejectedId to impostorId
        const impostorActive = room.players.some(
            (p) => p.id === room.impostorId && p.isConnected
        );
        room.ejectedId = impostorActive ? playerId : room.impostorId;
        return;
    }

    if (wasCurrentTurn) {
        let foundNext = false;
        room.turnIndex = previousTurnIndex;
        while (room.turnIndex >= 0 && room.turnIndex < room.turnOrder.length) {
            const nextId = room.turnOrder[room.turnIndex];
            const nextP = room.players.find((p) => p.id === nextId);
            if (nextP && nextP.isConnected && !nextP.isEjected) {
                room.currentTurnPlayerId = nextId;
                foundNext = true;
                break;
            }
            room.turnIndex++;
        }
        if (!foundNext) {
            room.phase = 'VOTING';
            room.currentTurnPlayerId = null;
        }
    } else if (room.currentTurnPlayerId) {
        const currentTurnIndex = room.turnOrder.indexOf(
            room.currentTurnPlayerId
        );
        if (currentTurnIndex !== -1) {
            room.turnIndex = currentTurnIndex;
        }
    }

    if (room.phase === 'VOTING') {
        checkVotingComplete(room);
    }
}

export function voteKickPlayer(
    roomId: string,
    voterId: string,
    targetId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (voterId === targetId) return null;
    // The host cannot be voted out
    if (targetId === room.hostId) return null;

    const voter = room.players.find((p) => p.id === voterId);
    if (!voter || !voter.isConnected) return null;

    if (!room.kickVotes) room.kickVotes = {};
    if (!room.kickVotes[targetId]) room.kickVotes[targetId] = [];

    // Prune stale votes before evaluating
    room.kickVotes[targetId] = room.kickVotes[targetId].filter((vid) => {
        const v = room.players.find((p) => p.id === vid);
        return v && v.isConnected;
    });

    const votes = room.kickVotes[targetId];
    const voteIndex = votes.indexOf(voterId);

    if (voteIndex !== -1) {
        votes.splice(voteIndex, 1);
    } else {
        votes.push(voterId);
    }

    // Check if threshold is met
    // Threshold is all connected, non-ejected players EXCEPT the target
    const requiredVotes = room.players.filter(
        (p) => p.isConnected && p.id !== targetId
    ).length;

    if (votes.length >= requiredVotes && requiredVotes > 0) {
        executeKick(room, targetId);
        // Clear votes so we don't accidentally re-trigger
        room.kickVotes[targetId] = [];
        // Block from reconnecting for the rest of this game session
        if (!kickedFromRoom[roomId]) kickedFromRoom[roomId] = new Set();
        kickedFromRoom[roomId].add(targetId);
    }

    return room;
}

// The game mode is staged in the options modal alongside everything else and
// travels with this payload, so it is applied *before* the options are
// sanitised: whatever the new mode takes over wins over what the host had
// staged for the previous one.
export function updateGameOptions(
    roomId: string,
    userId: string,
    options: unknown
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'LOBBY') return null;
    if (room.hostId !== userId) return null;
    if (!isPlainObject(options)) return null;

    applyGameMode(room, options.gameMode);
    // The payload updates what the host chose; the mode is layered on top after
    // it, so an option this mode takes over is masked rather than overwritten.
    const hostOptions = sanitizeGameOptionsUpdate(
        options,
        room.hostGameOptions
    );
    if (!hostOptions) return null;
    room.hostGameOptions = hostOptions;
    room.gameOptions = applyModeLockedOptions(hostOptions, room.gameMode);
    return room;
}
