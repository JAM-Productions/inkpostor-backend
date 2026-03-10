# Inkpostor Backend

This is the backend service for the Inkpostor application, built with Node.js, Express, Socket.io, and TypeScript.

## Prerequisites

- [Node.js](https://nodejs.org/) installed
- npm or yarn

## Getting Started

1. **Install dependencies:**

    ```bash
    npm install
    ```

2. **Run the development server:**

    ```bash
    npm run dev
    ```

    The development server will start using `nodemon` and auto-reload on file changes.

## Scripts

- `npm run dev` - Starts the development server using nodemon.
- `npm run build` - Transpiles the TypeScript code to JavaScript.
- `npm run start` - Runs the built JavaScript application.
- `npm run test` - Runs the tests using Vitest.
- `npm run format` - Formats the codebase using pre-configured Prettier settings.
- `npm run check-format` - Checks if the codebase is correctly formatted.

## Tech Stack

- **Framework:** Express
- **Real-time Engine:** Socket.io
- **Language:** TypeScript
- **Code Quality:** Prettier, ESLint/oxlint, Vitest
