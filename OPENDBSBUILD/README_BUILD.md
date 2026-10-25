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
- Web UI: http://localhost:4402/web/ (WEB_INTERFACE_ENABLED=true)
- Admin panel: http://localhost:4402/admin/ (ADMIN_PANEL_ENABLED=true)
- First start creates user `admin` with the password from ADMIN_PASSWORD,
  or a random one printed once to the console.
- Production refuses to start without a strong JWT_SECRET (32+ chars).

## Documentation
- README.md — overview, API, SQL, drivers, configuration
- docs/ADMIN_GUIDE.md — running OpenDBS: production setup, backups, cluster, sharding, security, upgrades
- SECURITY.md, CHANGELOG.md — security model and release notes
- QUICKSTART.md — API walkthrough with curl examples

## License
See LICENSE.md - Non-commercial use only with attribution required.

---

Built: 2026-10-25T13:58:29.773Z
Version: 1.0.1
