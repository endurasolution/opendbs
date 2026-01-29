# OpenDBS Production Build

This is a production-ready build of OpenDBS.

## Quick Start

1. Install dependencies:
   ```bash
   npm install --production
   ```

2. Copy and configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

3. Start the server:
   ```bash
   npm start
   ```

   For production mode:
   ```bash
   npm run start:prod
   ```

## Server will run on:
- Port: 4402 (configurable in .env)
- Default admin credentials:
  - Username: admin
  - Password: admin123
  - **⚠️ CHANGE THESE IMMEDIATELY IN PRODUCTION!**

## Documentation
See QUICKSTART.md for complete API documentation.

## License
See LICENSE.md - Non-commercial use only with attribution required.

---

Built: 2026-01-29T17:13:31.880Z
Version: 0.1.0
