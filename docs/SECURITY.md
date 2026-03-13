# Security Policy

## Supported Versions

Currently, only the latest version of the Inkpostor backend is supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| v1.0.x  | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within the Inkpostor backend, please refrain from disclosing it publicly.

Instead, please report it via the issue tracker privately or directly contact the maintainers. We take all security vulnerabilities seriously and will work to address them as quickly as possible.

### Security Features

The Inkpostor backend currently implements the following security measures:
- **JWT Authentication:** Ensures only authenticated clients can connect to the Socket.io server.
- **Rate Limiting:** The `/auth` endpoint is protected against brute-force attacks by limiting requests per IP.
- **Socket Connection Limits:** Implements `MAX_CONNECTIONS` to prevent socket exhaustion and potential Denial of Service.
- **CORS:** Restricts API and socket access to allowed frontend origins.
- **Input Validation:** Usernames are sanitized and validated to prevent malicious payloads.
