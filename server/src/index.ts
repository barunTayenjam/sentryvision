import 'reflect-metadata';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import { configureRoutes } from './routes/index.js';
import { staticRoutes } from './routes/staticRoutes.js';
import { getFrontendDistPath } from './config/frontendDist.js';
import { securityHeaders } from './config/securityHeaders.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { initializeServices, gracefulShutdown } from './bootstrap.js';
import { logger } from './utils/logger.js';
import { go2rtcAuth, extractMediaToken } from './middleware/go2rtcAuth.js';
import { authService } from './auth/index.js';

dotenv.config({ path: './.env' });

// Local dev: the NVIDIA LLM config lives in the project-root .env (Docker
// reads it via compose substitution). Fall back to it for NVIDIA vars only,
// so server/.env never needs to duplicate credentials.
try {
  const rootEnv = dotenv.parse(fs.readFileSync(path.join(process.cwd(), '..', '.env')));
  for (const k of ['NVIDIA_API_KEY', 'NVIDIA_API_BASE_URL', 'NVIDIA_MODEL']) {
    if (!process.env[k] && rootEnv[k]) process.env[k] = rootEnv[k];
  }
} catch {
  /* no root .env next to the repo — keep server/.env values */
}

const app = express();
app.use(compression());

const corsOrigins = (() => {
  if (process.env.CORS_ORIGIN) return process.env.CORS_ORIGIN.split(',');
  const isDev = process.env.NODE_ENV !== 'production';
  return isDev ? true : ['http://localhost:3000', 'http://localhost:5173'];
})();

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  }),
);

const go2rtcUrl = process.env.GO2RTC_URL || 'http://go2rtc:1984';
app.use(
  '/go2rtc',
  go2rtcAuth,
  createProxyMiddleware({
    target: go2rtcUrl,
    changeOrigin: true,
    pathRewrite: { '^/go2rtc': '' },
  }),
);

app.use(express.json());
app.use(securityHeaders());

// Request log — every API response, one line, with status and duration.
app.use((req, res, next) => {
  if (!req.url.startsWith('/api/') || req.url.startsWith('/api/streams')) return next();
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`API ${req.method} ${req.url} - ${res.statusCode} - ${Date.now() - start}ms`);
  });
  next();
});

const server = http.createServer(app);

const go2rtcParsed = new URL(go2rtcUrl);
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/go2rtc')) return;

  // Same JWT gate as the HTTP proxy — browser WebSocket cannot set headers,
  // so the token arrives via ?token=.
  const mediaToken = extractMediaToken(req);
  if (!mediaToken || !authService.verifyToken(mediaToken)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Strip the auth token before forwarding — go2rtc never needs it.
  const targetUrl = new URL(req.url.replace('/go2rtc', '') || '/', 'http://localhost');
  targetUrl.searchParams.delete('token');
  const targetPath = targetUrl.pathname + targetUrl.search;
  const headers: Record<string, string> = {};
  const blockedHeaders = new Set([
    'authorization',
    'cookie',
    'cookie2',
    'proxy-authorization',
    'proxy-connection',
    'x-forwarded-for',
    'x-real-ip',
    'forwarded',
  ]);
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i].toLowerCase();
    if (blockedHeaders.has(key)) continue;
    if (key === 'host') {
      headers['host'] = `${go2rtcParsed.hostname}:${go2rtcParsed.port || 1984}`;
    } else {
      headers[key] = req.rawHeaders[i + 1];
    }
  }

  const proxyReq = http.request({
    hostname: go2rtcParsed.hostname,
    port: parseInt(go2rtcParsed.port || '1984'),
    path: targetPath,
    method: req.method || 'GET',
    headers,
  });

  proxyReq.on('upgrade', (_proxyRes, proxySocket, proxyHead) => {
    proxySocket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        /* socket already destroyed */
      }
    });
    socket.on('error', () => {
      try {
        proxySocket.destroy();
      } catch {
        /* socket already destroyed */
      }
    });
    socket.on('close', () => {
      try {
        proxySocket.destroy();
      } catch {
        /* socket already destroyed */
      }
    });
    proxySocket.on('close', () => {
      try {
        socket.destroy();
      } catch {
        /* socket already destroyed */
      }
    });

    let responseLine = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [k, v] of Object.entries(_proxyRes.headers)) {
      if (v !== undefined) responseLine += `${k}: ${v}\r\n`;
    }
    responseLine += '\r\n';
    socket.write(responseLine);

    if (proxyHead.length > 0) proxySocket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('error', () => {
    try {
      socket.destroy();
    } catch {
      /* socket already destroyed */
    }
  });
  proxyReq.end();
});
const io = new SocketIOServer(server, {
  cors: {
    origin: corsOrigins,
    credentials: true,
  },
});

await initializeServices(io);
configureRoutes(app, io);

logger.info('Routes configured successfully', 'SERVER');

app.use(staticRoutes);

const frontendDistPath = getFrontendDistPath();
if (fs.existsSync(frontendDistPath)) {
  const frontendRoot = path.resolve(frontendDistPath);
  const getSafePath = (relativePath: string) => {
    const candidate = path.resolve(frontendRoot, relativePath);
    return candidate === frontendRoot || candidate.startsWith(`${frontendRoot}${path.sep}`) ? candidate : null;
  };

  app.get('/{*path}', (req, res) => {
    const relativePath = req.path.replace(/^\/+|\/+$/g, '');
    const routeIndexPath = getSafePath(path.join(relativePath, 'index.html'));
    if (routeIndexPath && fs.existsSync(routeIndexPath)) {
      return res.sendFile(routeIndexPath);
    }

    const notFoundPath = getSafePath('404.html');
    if (notFoundPath && fs.existsSync(notFoundPath)) {
      return res.status(404).sendFile(notFoundPath);
    }

    return res.status(404).sendFile(path.join(frontendRoot, 'index.html'));
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM', server, io));
process.on('SIGINT', () => gracefulShutdown('SIGINT', server, io));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', 'SERVER', reason);
});

const PORT = process.env.PORT || 9753;

server.listen(PORT, () => {
  logger.info(`SentryVision Server started on port ${PORT}`, 'SERVER');
});

server.on('error', (error: any) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use. Kill the process or change PORT.`, 'SERVER');
    logger.error(`  Run: fuser -k ${PORT}/tcp`, 'SERVER');
    process.exit(1);
  }
  throw error;
});
