# OpenDBS Deployment Guide

## Production Deployment Checklist

### 1. Environment Setup
- [ ] Copy `.env.example` to `.env`
- [ ] Set `NODE_ENV=production`
- [ ] Change default admin password
- [ ] Set secure `JWT_SECRET`
- [ ] Configure backup settings
- [ ] Set appropriate `PORT` and `HOST`

### 2. Install Dependencies
```bash
npm install --production
```

### 3. Security Considerations
- Change default admin credentials immediately
- Use strong JWT_SECRET (min 32 characters)
- Enable HTTPS/TLS in production (use nginx/reverse proxy)
- Configure firewall to allow only port 4402
- Enable backup encryption if storing sensitive data
- Regularly update dependencies

### 4. Start Server

**Option A: Direct**
```bash
npm run start:prod
```

**Option B: PM2 (Recommended)**
```bash
npm install -g pm2
pm2 start dist/index.js --name opendbs
pm2 save
pm2 startup
```

**Option C: Docker**
Create a Dockerfile:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 4402
CMD ["npm", "run", "start:prod"]
```

### 5. Monitoring
```bash
# With PM2
pm2 logs opendbs
pm2 monit

# Check server health
curl http://localhost:4402/health
```

### 6. Backup Configuration
- Automated backups are configured in .env
- Default: Daily at 2 AM, 7-day retention
- Backup location: ./backups (configurable)
- Supports: Local, S3, FTP

### 7. Nginx Reverse Proxy (Optional but Recommended)
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:4402;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 8. SSL/TLS (Recommended)
```bash
# Using Certbot
sudo certbot --nginx -d your-domain.com
```

## Performance Tuning

### Environment Variables
```env
MAX_CONNECTIONS=1000
CACHE_SIZE_MB=512
ENABLE_COMPRESSION=true
```

### OS-Level (Linux)
```bash
# Increase file descriptors
ulimit -n 65536

# Optimize TCP
sysctl -w net.ipv4.tcp_tw_reuse=1
sysctl -w net.ipv4.ip_local_port_range="1024 65535"
```

## Troubleshooting

### Port Already in Use
```bash
# Find process using port 4402
lsof -i :4402
# Kill process
kill -9 <PID>
```

### Permission Denied
```bash
# Ensure data directory is writable
chmod 755 ./data
chmod 755 ./backups
```

### Out of Memory
- Increase Node.js memory limit:
  ```bash
  NODE_OPTIONS="--max-old-space-size=4096" npm run start:prod
  ```

## Support
For issues, documentation, and updates:
- GitHub: [Your Repository URL]
- Documentation: See QUICKSTART.md

---
**⚠️ IMPORTANT**: This software is licensed for non-commercial use only.
See LICENSE.md for details. Commercial use requires a separate license.
