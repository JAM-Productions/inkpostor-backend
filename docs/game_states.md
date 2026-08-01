# Inkpostor — Game States & Logic

## Game Modes

The host picks the mode from the lobby options carousel. Unlike `gameOptions`
(staged until the host confirms), the mode is applied **immediately** on every
carousel change via the `setGameMode` event, so it lives in its own `gameMode`
field on the room. It survives `playAgain`.

| Mode | Description |
|---|---|
| `CLASSIC` | Default. The secret word is drawn at random from the built-in word list. |
| `CUSTOM_WORD` | Every player writes a word in `WORD_SELECTION`; one of them becomes the secret word, under the `Special` category. |
| `HOT_WORD` | Words come from the built-in list as in `CLASSIC`, but a **new one is drawn every round**. The impostor stays the same, so each round starts on `WORD_REVEAL` instead of going straight to `DRAWING`. |

Some modes take an option over. While such a mode is selected the value is
forced and the host cannot change it — `setGameMode` applies it and
`updateGameOptions` keeps re-applying it, so a modified client cannot get around
it. `MODE_LOCKED_OPTIONS` (in `constants.ts`) is the single source of truth,
mirrored by the options modal in the client:

| Mode | Locked option | Why |
|---|---|---|
| `CUSTOM_WORD` | `impostorGuessEnabled: false` | The word is written by a player, so it could simply be handed to the impostor. |
| `HOT_WORD` | `clearCanvasEachRound: true` | Every round has a new word, so keeping the previous drawing makes no sense. |

Switching back to a mode without the lock leaves the forced value in place; the
host can then change it again.

## Game Phases

| Phase | Description |
|---|---|
| `LOBBY` | Players join the room. Host can kick players. Game hasn't started. |
| `WORD_SELECTION` | `CUSTOM_WORD` mode only. Every player writes and confirms a word. Reached instead of `ROLE_REVEAL` when the game starts. |
| `ROLE_REVEAL` | Players see their role (Inkpostor or Crewmate). Must confirm before proceeding. |
| `WORD_REVEAL` | `HOT_WORD` mode only. Players see the new word of the round (the impostor, only its category) and confirm. Roles are not shown again — they haven't changed. |
| `DRAWING` | Players take turns drawing on the canvas. Vote-kick is available. |
| `VOTING` | All players vote on who they think the Inkpostor is (or skip). |
| `IMPOSTOR_GUESS` | The ejected Inkpostor gets one final guess at the secret word. Everyone else waits. Only reached when the impostor-guess option is enabled. |
| `RESULTS` | The round or game result is revealed. |

---

## Phase Transitions

```
LOBBY → ROLE_REVEAL          (host starts the game in CLASSIC mode, ≥ 3 players required)
LOBBY → WORD_SELECTION       (host starts the game in CUSTOM_WORD mode, ≥ 3 players required)
WORD_SELECTION → ROLE_REVEAL (all connected players submit their word)
ROLE_REVEAL → DRAWING        (all players confirm their role)
DRAWING → VOTING             (all turns used up, or emergency voting triggered)
DRAWING → RESULTS            (vote-kick causes game-ending condition)
DRAWING → RESULTS            (impostor guesses the word correctly — impostor wins)
VOTING → RESULTS             (voting ends and the impostor is NOT ejected, or the guess option is off)
VOTING → RESULTS             (impostor guesses the word correctly — impostor wins)
VOTING → IMPOSTOR_GUESS      (impostor ejected by vote AND the impostor-guess option is enabled)
IMPOSTOR_GUESS → RESULTS     (impostor submits their final guess, or skips it)
RESULTS → DRAWING            (next round, all connected non-ejected players confirm)
RESULTS → WORD_REVEAL        (same, in HOT_WORD mode — a new word is drawn)
WORD_REVEAL → DRAWING        (all non-ejected players confirm the new word)
RESULTS → LOBBY              (host clicks Play Again)
```

> `ROLE_REVEAL` and `WORD_REVEAL` wait for **every** non-ejected player, including
> disconnected ones: nobody starts drawing until everyone still in the game has
> seen the word, even if that means waiting for a reconnection (the host can
> always end the game). Ejected players may watch the reveal — they are never
> the impostor, since ejecting the impostor ends the game — but are not waited
> for.

### Disconnect-driven transitions

A player dropping (socket `disconnect`, or leaving by switching rooms) is handled
in `leaveRoom`. In `LOBBY` the player is removed; otherwise they are marked
`isConnected = false`. Because a disconnected player no longer counts towards the
phase's completion condition, the phase is **re-evaluated immediately** so the
game never hangs waiting on someone who left:

```
VOTING → RESULTS / IMPOSTOR_GUESS   (last expected voter disconnects → the vote resolves)
IMPOSTOR_GUESS → RESULTS            (the impostor disconnects → counts as a surrender, crewmates win)
RESULTS → DRAWING                   (last unconfirmed player disconnects → next round starts)
```

> `WORD_SELECTION` is the exception: a disconnect there is **never** acted upon,
> so a dropping player can't rush everyone else out of the word form. The phase
> is only re-evaluated when a word is submitted, and disconnected players are
> skipped at that point so they can't block it forever either. If everyone who
> is left has already submitted, the phase simply waits (the host can still end
> the game).

> A disconnected impostor can never make a final guess. So if a `VOTING`
> resolution would push a now-disconnected impostor into `IMPOSTOR_GUESS`, it is
> short-circuited straight to `RESULTS` (surrender). In every surrender path
> `ejectedId` is already `impostorId`, so the result reads as 🟢 Crewmates win.

---

## Win / Loss Conditions

| Condition | Outcome |
|---|---|
| Inkpostor ejected via voting (`ejectedId === impostorId`) | 🟢 **Crewmates win** — Inkpostor Defeated *(unless the guess option is on → first goes to `IMPOSTOR_GUESS`)* |
| Inkpostor ejected via vote-kick (`ejectedId === impostorId`) | 🟢 **Crewmates win** — Inkpostor Defeated |
| Crewmate kicked, impostor still active, connected players < 3 | 🔴 **Inkpostor wins** |
| Crewmate kicked, impostor disconnected / not in game, connected players < 3 | 🟢 **Crewmates win** — impostor abandoned |
| Host manually ends game (`endGame`) | 🔴 **Inkpostor wins** (`gameEnded = true`) |
| Voting ends in a tie or everyone skips | ➡ Next round (`ejectedId = null`) |
| Inkpostor guesses the secret word (any phase: DRAWING / VOTING / IMPOSTOR_GUESS) | 🔴 **Inkpostor wins** (`impostorGuessedCorrectly = true`) |
| Inkpostor ejected, then fails or skips their final guess | 🟢 **Crewmates win** — Inkpostor Defeated |
| Inkpostor disconnects while ejected and owing a final guess (in `IMPOSTOR_GUESS`, or a `VOTING` resolution that would enter it) | 🟢 **Crewmates win** — counts as a surrender (`ejectedId === impostorId`) |

> **Active player** = `isConnected && !isEjected`

---

## Vote-Kick Mechanics (mid-game only)

- Available during the `DRAWING` phase (not `LOBBY` or `VOTING`).
- Any connected player (even if ejected in a previous round) can vote to kick another.
- Votes are **toggleable** — clicking again removes your vote.
- **Threshold**: all connected players except the target must agree (ejected players who are connected count towards this threshold and can vote, while disconnected players are pruned/ignored).

```
requiredVotes = connectedPlayers.count(id ≠ target)
```

| Players | Target | Required Votes |
|---|---|---|
| 3 | 1 | 2 |
| 4 | 1 | 3 |
| 5 | 1 | 4 |

Once the threshold is met:
1. Target is removed from `room.players` and blocklisted for the current game session.
2. Win condition is evaluated immediately (see table above).
3. If no game-ending condition: turn is skipped to the next active player.
4. If no next active player exists: transition to `VOTING`.
5. Kicked player receives a `kicked` socket event and is disconnected.

---

## Turn Order

- Turn order is randomised at game start.
- Ejected players are skipped automatically.
- The current drawing player can end their turn early.
- If the current drawing player is ejected mid-turn, the turn advances immediately.
- If no valid next player exists, the game transitions to `VOTING`.

---

## Multi-Round Games

- After `RESULTS`, connected non-ejected players can confirm to start the next round (disconnected players are ignored).
- Ejected players wait silently (they cannot confirm or draw).
- A new round resets: `votes`, `kickVotes`, `canvasStrokes`, `turnIndex`.
- The impostor **remains the same** across rounds.
- In `HOT_WORD` the round also draws a new word (excluding `room.usedWords`, which tracks the words already played and is only cleared on `startGame` / `playAgain`) and enters `WORD_REVEAL`. The impostor-guess pool is **not** reset — it stays a per-game budget.
- `impostorId` is hidden from clients until phase = `RESULTS`.

---

## Custom Word Mode (`CUSTOM_WORD`)

Lets the lobby play with a word written by the players themselves.

- `startGame` picks the impostor and the turn order as usual, but leaves
  `secretWord` / `secretCategory` empty and enters `WORD_SELECTION`.
- Each player submits one word (`submitCustomWord`, 2–40 characters after
  trimming). A submission is final — a player cannot resubmit.
- The phase resolves when every **connected** player has submitted, and it is
  only ever evaluated on a submission — a disconnect never advances it.
- The secret word is drawn at random from the submitted words, **excluding the
  impostor's own word** — otherwise the impostor would know the word and win on
  the spot. If that leaves no candidates (only the impostor submitted), the game
  falls back to a random word from the built-in list.
- `secretCategory` is set to the `Special` translation key, so every player sees
  it in their own language ("Special" / "Especial").
- Roles are only emitted once the phase resolves, since there is no word to send
  during `WORD_SELECTION`.
- The submitted words are **never broadcast**; clients only receive each player's
  `hasSubmittedWord` flag.
- **The impostor guess is not available in this mode.** Selecting `CUSTOM_WORD`
  forces `impostorGuessEnabled` to `false`, and `updateGameOptions` keeps
  ignoring attempts to turn it back on while the mode is selected — the word
  comes from a player, so it could simply be handed to the impostor. Switching
  back to `CLASSIC` makes the option settable again (it stays off until the host
  re-enables it).

---

## Impostor Guess (optional feature)

Lets the Inkpostor win by guessing the secret word. Configured by the host in the
lobby, and only available in `CLASSIC` mode (see Custom Word Mode above):

| Option | Default | Range | Meaning |
|---|---|---|---|
| `impostorGuessEnabled` | `false` | boolean | Turns the whole feature on/off |
| `impostorGuessAttempts` | `3` | `1`–`3` | Size of the shared in-phase guess pool |

**In-phase guesses (`DRAWING` / `VOTING`)**

- The impostor can guess at any point during these phases, bounded by the shared pool (`impostorGuessesUsed`).
- The pool **persists across rounds** within the same game; it is reset only on `startGame` / `playAgain`.
- A correct guess ends the game immediately → `RESULTS`, `impostorGuessedCorrectly = true` (🔴 Inkpostor wins).
- A wrong in-phase guess consumes one attempt and is broadcast **only to the impostor's socket** (so crewmates don't learn that guessing is happening).

**Final guess (`IMPOSTOR_GUESS` phase)**

- When the impostor is ejected by vote and the feature is on, voting resolves into `IMPOSTOR_GUESS` instead of `RESULTS`.
- The impostor gets **one** final guess (independent of the in-phase pool) plus a **skip** option. Everyone else sees a waiting screen.
- Correct → 🔴 Inkpostor wins. Wrong or skipped → 🟢 Crewmates win (`ejectedId` already = `impostorId`).

**Validation (server-side, language-aware)**

- The guess is validated **on the server**; the impostor never receives `secretWord`.
- The secret word is stored as its canonical English key. The guess is compared against the **translation for the player's selected language** (sent with the guess), **case- and accent-insensitive**. Only that language is accepted.
- Player-written words are never validated here, because guessing is disabled in the modes that produce them. They are still kept out of the translation table when sent to crewmates: a custom word is not a translation key, and one that happens to collide with one (e.g. "Dog") must be shown exactly as it was typed.

---

## Secret Information

| Field | Visible to clients during game | Visible in RESULTS |
|---|---|---|
| `impostorId` | ❌ Hidden (`null`) — including during `IMPOSTOR_GUESS` | ✅ Revealed |
| `secretWord` | ✅ Crewmates only (via `roleAssignment`); never sent to the impostor | ✅ All |
| `secretCategory` | ✅ Everyone (via `roleAssignment`) | ✅ All |
| `players[].customWord` | ❌ Stripped from every broadcast (only `hasSubmittedWord` is sent) | ❌ Still stripped |
| `kickVotes` | ✅ Everyone (vote counts visible) | ✅ All |
| `impostorGuessesUsed` | ✅ Sent privately to the impostor (not broadcast on wrong guesses) | ✅ All |

> During `IMPOSTOR_GUESS` the broadcast state stays sanitised (`impostorId` / `secretWord` hidden); clients decide what to render from their local `amIImpostor` flag.

---

## Socket Events (Client → Server)

| Event | When | Description |
|---|---|---|
| `createRoom` | LOBBY | Host creates a new room |
| `joinRoom` | LOBBY | Player joins an existing room |
| `setGameMode` | LOBBY | Host selects a game mode from the carousel (host only, applied immediately) |
| `startGame` | LOBBY | Host starts the game (host only) |
| `submitCustomWord` | WORD_SELECTION | Player submits their word (payload: `{ word }`) |
| `proceedToDrawing` | ROLE_REVEAL | Player confirms role |
| `confirmNewWord` | WORD_REVEAL | Player confirms they have seen the new word of the round |
| `drawStroke` | DRAWING | Current turn player draws a stroke |
| `undoStroke` | DRAWING | Current turn player undoes last stroke |
| `endTurn` | DRAWING | Current turn player ends their turn |
| `startEmergencyVoting` | DRAWING | Any player triggers emergency vote |
| `vote` | VOTING | Player casts or changes vote |
| `submitImpostorGuess` | DRAWING / VOTING / IMPOSTOR_GUESS | Impostor guesses the secret word (payload: `{ guess, language }`) |
| `skipImpostorGuess` | IMPOSTOR_GUESS | Ejected impostor declines their final guess (crewmates win) |
| `voteKickPlayer` | DRAWING | Any player votes to kick a target |
| `kickPlayer` | LOBBY | Host removes a player (lobby only) |
| `nextRound` | RESULTS | Player confirms ready for next round |
| `endGame` | RESULTS | Host ends the game (host only) |
| `playAgain` | RESULTS | Host returns to lobby (host only) |

---

## Socket Events (Server → Client)

| Event | Description |
|---|---|
| `gameStateUpdate` | Full (sanitised) room state broadcast to all players in room |
| `roleAssignment` | Private role info sent to each player individually once the game reaches `ROLE_REVEAL` (after `WORD_SELECTION` in `CUSTOM_WORD` mode), **and re-sent to a player who reconnects mid-game** so they recover `amIImpostor` / `secretWord` / `secretCategory` |
| `strokeUpdate` | Real-time stroke broadcast to other players (not the drawer) |
| `strokeUndone` | Broadcast when a stroke is undone |
| `kicked` | Sent to a player who was removed (lobby kick or vote-kick) |
| `error` | Sent on auth failure or other unrecoverable errors |
