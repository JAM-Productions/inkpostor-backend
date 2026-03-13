import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, server, io } from '../index';
import { io as Client, Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';

describe('Server API and Socket Integration Tests', () => {
    let port: number;

    beforeAll(() => {
        return new Promise<void>((resolve) => {
            server.listen(0, () => {
                const addy = server.address() as any;
                port = addy.port;
                resolve();
            });
        });
    });

    afterAll(() => {
        io.close();
        server.close();
    });

    describe('API Endpoints', () => {
        it('GET /health should return 200 OK', async () => {
            const response = await request(app).get('/health');
            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                status: 'OK',
                message: 'Inkpostor backend is running',
            });
        });

        it('POST /auth should reject invalid usernames', async () => {
            const response = await request(app)
                .post('/auth')
                .send({ username: 'ab' });
            expect(response.status).toBe(400); // Too short

            const response2 = await request(app)
                .post('/auth')
                .send({ username: 'invalid name!' });
            expect(response2.status).toBe(400); // Invalid characters
        });

        it('POST /auth should return a token for valid usernames', async () => {
            const response = await request(app)
                .post('/auth')
                .send({ username: 'valid_user' });
            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('token');

            // Verify token structure
            const payload = jwt.decode(response.body.token) as any;
            expect(payload.name).toBe('valid_user');
        });
    });

    describe('Socket Connections', () => {
        let clientSocket: Socket;
        let validToken: string;

        beforeAll(async () => {
            // Get valid token for socket connections
            const res = await request(app)
                .post('/auth')
                .send({ username: 'test_socket_user' });
            validToken = res.body.token;
        });

        afterAll(() => {
            if (clientSocket && clientSocket.connected) {
                clientSocket.disconnect();
            }
        });

        it(
            'should block connection if no token provided',
            _vitestCleanupPromiseFactory((resolve) => {
                clientSocket = Client(`http://localhost:${port}`, {
                    reconnectionDelay: 0,
                    forceNew: true,
                });

                clientSocket.on('connect_error', (err) => {
                    expect(err.message).toBe(
                        'Authentication error: token missing'
                    );
                    clientSocket.disconnect();
                    resolve();
                });
            })
        );

        it(
            'should block connection if invalid token provided',
            _vitestCleanupPromiseFactory((resolve) => {
                clientSocket = Client(`http://localhost:${port}`, {
                    reconnectionDelay: 0,
                    forceNew: true,
                    auth: { token: 'invalid.token.here' },
                });

                clientSocket.on('connect_error', (err) => {
                    expect(err.message).toBe(
                        'Authentication error: invalid token'
                    );
                    clientSocket.disconnect();
                    resolve();
                });
            })
        );

        it(
            'should connect successfully with valid token',
            _vitestCleanupPromiseFactory((resolve) => {
                clientSocket = Client(`http://localhost:${port}`, {
                    reconnectionDelay: 0,
                    forceNew: true,
                    auth: { token: validToken },
                });

                clientSocket.on('connect', () => {
                    expect(clientSocket.connected).toBe(true);
                    clientSocket.disconnect();
                    resolve();
                });
            })
        );
    });
});

// Helper for async callbacks
function _vitestCleanupPromiseFactory(callback: (resolve: () => void) => void) {
    return () => new Promise<void>((resolve) => callback(resolve));
}
