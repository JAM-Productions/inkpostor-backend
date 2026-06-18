# Inkpostor Backend

This is the backend service for the Inkpostor application, built with Node.js, Express, Socket.io, and TypeScript.

## Features
- Real-time multiplayer drawing via Socket.io
- Rate limiting for authentication endpoints
- Configurable maximum concurrent socket connections
- HTTP request logging (Morgan)
- Automated tested Health checks

## Prerequisites

- [Node.js](https://nodejs.org/) installed
- pnpm
- Docker (optional, for containerization)

## Getting Started

1. **Install dependencies:**

    ```bash
    pnpm install
    ```

2. **Environment Variables:**
    Create a `.env` file in the root based on your needs:
    ```env
    JWT_SECRET=your_secret_key
    MAX_CONNECTIONS=30
    ```

3. **Run the development server:**

    ```bash
    pnpm dev
    ```

    The development server will start using Node's native `--watch` mode and auto-reload on file changes.

### Running with Docker

You can also run the backend using Docker:

```bash
docker build -t inkpostor-backend .
docker run -p 3001:3001 --env-file .env inkpostor-backend
```

## API Endpoints

- `GET /health` - Healthcheck endpoint (returns HTTP 200 OK)
- `POST /auth` - Generates a JWT given a valid username within the game constraints.

## Scripts

- `pnpm dev` - Starts the development server using Node native watch mode.
- `pnpm build` - Transpiles the TypeScript code to JavaScript.
- `pnpm start` - Runs the built JavaScript application.
- `pnpm test` - Runs the tests using Vitest.
- `pnpm format` - Formats the codebase using pre-configured Prettier settings.
- `pnpm check-format` - Checks if the codebase is correctly formatted.

## Tech Stack

- **Framework:** Express
- **Real-time Engine:** Socket.io
- **Language:** TypeScript
- **Code Quality:** Prettier, ESLint/oxlint, Vitest

## Documentation

### Game Phases
- [Game Phases](docs/game_states.md#game-phases)

### Phase Transitions
- [Phase Transitions](docs/game_states.md#phase-transitions)

### Win / Loss Conditions
- [Win / Loss Conditions](docs/game_states.md#win--loss-conditions)

### Vote-Kick Mechanics
- [Vote-Kick Mechanics](docs/game_states.md#vote-kick-mechanics)

### Turn Order
- [Turn Order](docs/game_states.md#turn-order)

### Multi-Round Games
- [Multi-Round Games](docs/game_states.md#multi-round-games)

### Secret Information
- [Secret Information](docs/game_states.md#secret-information)

### Socket Events
- [Socket Events](docs/game_states.md#socket-events)
