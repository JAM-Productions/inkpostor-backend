# Inkpostor — Game States & Logic

## Game Modes

The host picks the mode from the lobby options carousel. Like the rest of the
options it is **staged in the modal until the host confirms**, and travels with
the `updateGameOptions` payload as a `gameMode` field. It still lives in its own
`room.gameMode` field rather than inside `gameOptions`, and survives `playAgain`.

`updateGameOptions` applies the mode **before** sanitising the options, so a save
that changes both at once resolves the way the host sees it in the modal: the new
mode's locks win over whatever was staged for the previous one. An unknown mode
is ignored rather than rejected, like every other bad field — a stray value must
not throw away the rest of the update.

| Mode | Description |
|---|---|
| `CLASSIC` | Default. The secret word is drawn at random from the built-in word list. |
| `CUSTOM_WORD` | Every player writes a word in `WORD_SELECTION`; one of them becomes the secret word, under the `Special` category. |
| `HOT_WORD` | Words come from the built-in list as in `CLASSIC`, but a **new one is drawn every round**. The impostor stays the same, so each round starts on `WORD_REVEAL` instead of going straight to `DRAWING`. |
| `ORIGINAL` | The in-person party game: players say words out loud instead of drawing. **There is no `DRAWING` phase at all** — every round runs `ORDER_INFO → VOTING`. |
| `ORIGINAL_CHAOS` | `ORIGINAL` played with a word the players write themselves: it opens on `WORD_SELECTION` like `CUSTOM_WORD`, then runs exactly like `ORIGINAL`. |

Modes are combinations of a few traits rather than one-offs, so the rules key off
two predicates in `constants.ts` instead of naming modes one by one — adding a
mode means listing it there, not hunting down every comparison:

| Predicate | Modes | What it decides |
|---|---|---|
| `isSpokenMode` | `ORIGINAL`, `ORIGINAL_CHAOS` | The round opens on `ORDER_INFO` instead of `DRAWING`, and `RANDOM_ORDER` redraws the order each round |
| `isPlayerWordMode` | `CUSTOM_WORD`, `ORIGINAL_CHAOS` | The game opens on `WORD_SELECTION`, and the word is sent verbatim instead of through the translation table |
| `usesVotingPhase` | every mode that draws, plus a spoken mode with `virtualVotingEnabled` | Whether `VOTING` is played at all. Off in a spoken mode, `ORDER_INFO` is the whole round and only the host's `revealResults` ends it |

Some modes take an option over. While such a mode is selected the value is
forced and the host cannot change it — `updateGameOptions` re-applies the table
on every save, so a modified client cannot get around it. `MODE_LOCKED_OPTIONS`
(in `constants.ts`) is the single source of truth, mirrored by the options modal
in the client:

| Mode | Locked option | Why |
|---|---|---|
| `CUSTOM_WORD` | `impostorGuessEnabled: false` (and its sub-options, back to default) | The word is written by a player, so it could simply be handed to the impostor. |
| `HOT_WORD` | `clearCanvasEachRound: true` | Every round has a new word, so keeping the previous drawing makes no sense. |
| `ORIGINAL`, `ORIGINAL_CHAOS` | every drawing option | Nothing is drawn, so `roundTime`, `unlimitedInk`, `playerColorsEnabled`, `clearCanvasEachRound`, `impostorGuessEnabled` (with its sub-options) and `impostorGuessAttempts` are all forced to a neutral value instead of lingering as settings the host cannot see. |

The lock **masks** the value, it does not consume it. The room keeps the two side
by side: `hostGameOptions` is what the host picked and `gameOptions` is that with
the current mode's locks applied on top — the only one the rules ever read. So a
detour through a mode that owns an option hands the value back untouched the
moment the host picks a mode that leaves it alone, and the options modal edits
(and saves) `hostGameOptions` for the same reason.

A spoken mode locks the drawing options *away* rather than showing them with a
padlock: the client hides those sections entirely and renders `turnOrderMode`
and `virtualVotingEnabled` instead. `hideHint` and `impostorCount` are available
in **every** mode.

### Virtual Voting (`virtualVotingEnabled`, spoken modes only)

Off by default. Like `turnOrderMode`, no mode takes it over — the modes that draw
simply never read it (`usesVotingPhase`), so it survives a detour through one of
them untouched.

| Value | How a spoken round ends |
|---|---|
| `false` (default) | The table votes out loud. `ORDER_INFO` is the whole round: confirmations resolve nothing and `VOTING` is unreachable. The **host** ends the game with `revealResults`, which goes straight to `RESULTS` with `gameEnded: true` and no ejection — the client shows the list of impostors instead of a verdict. |
| `true` | The round runs `ORDER_INFO → VOTING` exactly like a drawing mode, with ejections, several rounds and a winner. |

### Extra Inkpostors (`impostorCount` & `revealImpostorTeammates`)
* **Maximum Inkpostors**: Calculated dynamically from lobby player count $N$:
  $$\text{maxImpostors} = \max\left(1, \left\lfloor \frac{N - 1}{2} \right\rfloor\right)$$
  For example: 5 players allows up to 2 Inkpostors; 7 players allows up to 3 Inkpostors.
* **Teammate Reveal**: Sub-option `revealImpostorTeammates` (default: `true`) appears when `impostorCount > 1`. When enabled, Inkpostors see their fellow Inkpostor names during `ROLE_REVEAL`.
* **Prevent Repeat Inkpostors**: Sub-option `preventRepeatImpostors` (default: `true`) reduces the probability of electing the same Inkpostor(s) several games in a row when playing consecutive games in the same room (`playAgain`). When enabled, previous Inkpostors receive a $5\times$ lower selection weight ($0.2$ vs $1.0$) in weighted random sampling, significantly suppressing consecutive streaks without completely eliminating repeat possibility.
* **Multi-Inkpostor Win & Ejection Rules**:
  * Ejecting an Inkpostor when active Inkpostors remain does NOT end the game; the game proceeds to `RESULTS` informing how many Inkpostors remain, then continues to the next round.
  * Crewmates win when all Inkpostors are eliminated (`activeImpostors.length === 0`).
  * Inkpostors win when active Inkpostors outnumber or equal active Crewmates (`activeImpostors.length >= activeCrewmates.length`), or when an Inkpostor guesses the secret word.

## Game Phases

| Phase | Description |
|---|---|
| `LOBBY` | Players join the room. Host can kick players. Game hasn't started. |
| `WORD_SELECTION` | Player-word modes only. Every player writes and confirms a word. Reached instead of `ROLE_REVEAL` when the game starts. |
| `ROLE_REVEAL` | Players see their role (Inkpostor or Crewmate). Must confirm before proceeding. |
| `WORD_REVEAL` | `HOT_WORD` mode only. Players see the new word of the round (the impostor, only its category) and confirm. Roles are not shown again — they haven't changed. |
| `ORDER_INFO` | Spoken modes only. Announces who opens the round and in which direction, then every player confirms. Replaces `DRAWING` as the start of the round. Without the virtual voting it is also the *end* of the round: nobody confirms anything and the host reveals the results from here. |
| `DRAWING` | Players take turns drawing on the canvas. Vote-kick is available. |
| `VOTING` | All players vote on who they think the Inkpostor is (or skip). |
| `IMPOSTOR_GUESS` | The ejected Inkpostor gets one final guess at the secret word. Everyone else waits. Only reached when the impostor-guess option is on and the Inkpostor still has an attempt left. |
| `RESULTS` | The round or game result is revealed. |

---

## Phase Transitions

```
LOBBY → ROLE_REVEAL          (host starts the game in CLASSIC mode, ≥ 3 players required)
LOBBY → WORD_SELECTION       (host starts the game in a player-word mode, ≥ 3 players required)
WORD_SELECTION → ROLE_REVEAL (all connected players submit their word)
ROLE_REVEAL → DRAWING        (all players confirm their role)
ROLE_REVEAL → ORDER_INFO     (same, in a spoken mode — nothing is drawn)
ORDER_INFO → VOTING          (all non-ejected players confirm they have read the order — virtual voting on)
ORDER_INFO → RESULTS         (host reveals the impostors — virtual voting off, ends the game)
DRAWING → VOTING             (all turns used up, or emergency voting triggered)
DRAWING → RESULTS            (vote-kick causes game-ending condition)
DRAWING → RESULTS            (impostor guesses the word correctly — impostor wins)
DRAWING → RESULTS            (impostor spends a lethal guess pool — impostor loses)
VOTING → RESULTS             (voting ends and the impostor is NOT ejected, or they have no guess left)
VOTING → RESULTS             (impostor guesses the word correctly — impostor wins)
VOTING → RESULTS             (impostor spends a lethal guess pool — impostor loses)
VOTING → IMPOSTOR_GUESS      (impostor ejected by vote AND they still have a guess left)
IMPOSTOR_GUESS → RESULTS     (impostor submits their final guess, or skips it)
RESULTS → DRAWING            (next round, all connected non-ejected players confirm)
RESULTS → WORD_REVEAL        (same, in HOT_WORD mode — a new word is drawn)
RESULTS → ORDER_INFO         (same, in a spoken mode — same word, same order)
WORD_REVEAL → DRAWING        (all non-ejected players confirm the new word)
RESULTS → LOBBY              (host clicks Play Again)
```

> `ROLE_REVEAL`, `WORD_REVEAL` and `ORDER_INFO` wait for **every** non-ejected
> player, including disconnected ones: no round starts until everyone still in
> the game has seen the screen, even if that means waiting for a reconnection
> (the host can always end the game). Ejected players may watch the reveal —
> in multi-impostor games, ejected players may include eliminated Inkpostors
> when other Inkpostors remain in play — but are not waited for.

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
RESULTS → ORDER_INFO                (same, in a spoken mode)
```

> A disconnect in `RESULTS` therefore pushes everyone onto the round-start screen
> (`ORDER_INFO` / `WORD_REVEAL`), which then **does** wait for that same
> disconnected player. That is deliberate: the round is not played out behind
> their back, and the host can always end the game.

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
| All Inkpostors eliminated (`activeImpostors.length === 0`) | 🟢 **Crewmates win** — Inkpostors Defeated |
| Inkpostors reach parity (`activeImpostors.length >= activeCrewmates.length`) | 🔴 **Inkpostors win** — Inkpostors Parity Victory |
| Inkpostor ejected via voting (`ejectedId === impostorId`) | 🟢 **Crewmates win** — Inkpostor Defeated *(unless they still hold a guess → first goes to `IMPOSTOR_GUESS`)* |
| Inkpostor ejected via vote-kick (`ejectedId === impostorId`) | 🟢 **Crewmates win** — Inkpostor Defeated |
| Crewmate kicked, impostor still active, connected players < 3 | 🔴 **Inkpostor wins** |
| Crewmate kicked, impostor disconnected / not in game, connected players < 3 | 🟢 **Crewmates win** — impostor abandoned |
| Host manually ends game (`endGame`) | ⚪ **Nobody wins** — the game was cut short, so it is closed with `gameEnded = true` **and `endedByHost = true`**, and the clients reveal the Inkpostors instead of a verdict |
| Host reveals the results of a spoken round (`revealResults`) | ⚪ **Nobody wins** — same ending: the table already voted out loud (`endedByHost = true`) |
| Voting ends in a tie or everyone skips | ➡ Next round (`ejectedId = null`) |
| Inkpostor guesses the secret word (any phase: DRAWING / VOTING / IMPOSTOR_GUESS) | 🔴 **Inkpostor wins** (`impostorGuessedCorrectly = true`, and `guessingImpostorId` names which one) |
| Inkpostor ejected, then fails or skips their final guess | 🟢 **Crewmates win** — Inkpostor Defeated |
| Inkpostor spends the whole guess pool while `impostorLosesWhenOutOfGuesses` is on | 🟢 **Crewmates win** — Inkpostor Defeated (`impostorOutOfGuesses = true`, no ejection involved; `guessingImpostorId` names who spent it) |
| Inkpostor disconnects while ejected and owing a final guess (in `IMPOSTOR_GUESS`, or a `VOTING` resolution that would enter it) | 🟢 **Crewmates win** — counts as a surrender (`ejectedId === impostorId`) |

> **Active player (for win/loss conditions)** = `!isEjected` (disconnected players remain assigned to their team until reconnected or kicked).

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

## Original Modes (`ORIGINAL`, `ORIGINAL_CHAOS`)

The in-person party game: nobody draws, players say one word out loud in turn and
then vote. Recommended to play face to face — the phones only hand out the roles
and keep the score.

- In `ORIGINAL`, `startGame` behaves exactly like `CLASSIC` (random word, random
  `turnOrder`, `ROLE_REVEAL`). Only the phase that follows the reveal changes.
- `ORIGINAL_CHAOS` is the same mode played with a word the players write
  themselves: `startGame` opens on `WORD_SELECTION` exactly as `CUSTOM_WORD`
  does (see that section — the impostor's own word is excluded, the category is
  `Special`, and the submissions are never broadcast), and once the phase
  resolves the game continues as `ORIGINAL`.
- With `virtualVotingEnabled` on, every round runs `ORDER_INFO → VOTING →
  RESULTS`. `DRAWING` is never reached, so `canvasStrokes`, `roundTime`, the turn
  timer, the emergency vote **and the vote-kick** are all inert in these modes.
- With it **off** (the default) the game is a single `ORDER_INFO`, ended by the
  host's `revealResults`: the table votes out loud, so there is no ejection, no
  second round and no winner to compute — `RESULTS` simply opens the cards. See
  *Virtual Voting* above.
- The word is the same for the whole game, as in `CLASSIC`.

**The order (`turnOrderMode`)**

`turnOrder` is the array drawn at `startGame`. The option decides how much of it
the game hands out, and whether it is drawn again on every round. The client
reads the starting player as the first non-ejected entry:

| Value | What `ORDER_INFO` announces | Redrawn each round |
|---|---|---|
| `RANDOM_STARTER` *(default)* | Only who opens the round; the table decides the rest | No |
| `FIXED_ORDER` | The full ordered list of players | No |
| `RANDOM_ORDER` | The full ordered list of players | **Yes** |

Only `RANDOM_ORDER` reshuffles `turnOrder` in `checkAllConfirmedNewRound` (after
the ejected players are dropped, so they never come back). In the other two the
same player opens every round. When that starter is ejected, the filter alone
hands the start to the next player in the order.

---

## Hiding the Hint (`hideHint`, optional feature)

Turns the category off **for the impostor only**, so they walk in completely
blind. Available in every mode (in the player-word modes the category is the
generic `Special`, so hiding it gives little away). It is enforced on the server
in two places, because the category travels in two payloads: `roleAssignment`
and the broadcast state (where it is *not* sanitised, unlike `secretWord`). Both
are stripped for the impostor's socket until `RESULTS`, where everything is
revealed.

---

## Impostor Guess (optional feature)

Lets the Inkpostor win by guessing the secret word. Configured by the host in the
lobby, and only available in the drawing modes that don't hand the word to the
players (see Custom Word Mode above):

| Option | Default | Range | Meaning |
|---|---|---|---|
| `impostorGuessEnabled` | `true` | boolean | Turns the whole feature on/off |
| `impostorGuessAttempts` | `1` | `1`–`3` | Size of the shared in-phase guess pool |
| `impostorLosesWhenOutOfGuesses` | `false` | boolean | Spending the whole pool loses the game on the spot |

> The last one is a sub-option of `impostorGuessEnabled`: it goes back to default
> whenever guessing is off (by the host or by the mode).

**In-phase guesses (`DRAWING` / `VOTING`)**

- The impostor can guess at any point during these phases, bounded by the shared pool (`impostorGuessesUsed`).
- The pool **persists across rounds** within the same game; it is reset only on `startGame` / `playAgain`.
- A correct guess ends the game immediately → `RESULTS`, `impostorGuessedCorrectly = true` (🔴 Inkpostor wins).
- Only a guess that **ends** the game records its author in `guessingImpostorId`, so the result screen can name them instead of the whole team. A guess that settles nothing leaves it `null`, and the field is stripped from every broadcast before the game is over — it would point straight at an impostor.
- A wrong in-phase guess consumes one attempt and is broadcast **only to the impostor's socket** (so crewmates don't learn that guessing is happening).
- Unless the pool is lethal: the wrong guess that empties it ends the game → `RESULTS`, `impostorOutOfGuesses = true` (🟢 Crewmates win), which is broadcast to everyone.

**Final guess (`IMPOSTOR_GUESS` phase)**

- When the impostor is ejected by vote **and the pool still has an attempt left** (`hasGuessesLeft`), voting resolves into `IMPOSTOR_GUESS` instead of `RESULTS`. An impostor who already spent every attempt gets no last chance: the vote resolves straight to `RESULTS`.
- The impostor gets **one** final guess plus a **skip** option. Everyone else sees a waiting screen. It is the pool being cashed in, so it is not bounded again inside the phase and does not increment `impostorGuessesUsed`.
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
| `secretCategory` | ✅ Everyone (via `roleAssignment` **and** the broadcast state) — except the impostor when `hideHint` is on, where it is stripped from both | ✅ All |
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
| `updateGameOptions` | LOBBY | Host saves the staged options, game mode included (host only, payload: `GameOptions & { gameMode }`) |
| `startGame` | LOBBY | Host starts the game (host only) |
| `submitCustomWord` | WORD_SELECTION | Player submits their word (payload: `{ word }`) |
| `proceedToDrawing` | ROLE_REVEAL | Player confirms role |
| `confirmNewWord` | WORD_REVEAL | Player confirms they have seen the new word of the round |
| `confirmOrder` | ORDER_INFO | Player confirms they have read who starts the round (resolves nothing while the virtual voting is off) |
| `revealResults` | ORDER_INFO | Host reveals the impostors and ends the game (host only, spoken mode with the virtual voting off, sets `endedByHost`) |
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
| `endGame` | any phase but LOBBY | Host ends the game (host only, sets `endedByHost`). Rejected in LOBBY: there is no game to end and no impostors to reveal |
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
