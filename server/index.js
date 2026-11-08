'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const { Auth } = require('./auth');
const { QuizStore } = require('./quizStore');
const { GameManager } = require('./gameManager');
const { createApiRouter } = require('./routes');
const { registerSockets } = require('./sockets');

const ROOT = path.join(__dirname, '..');

/**
 * Construye la aplicación sin ponerla a escuchar (útil para pruebas).
 */
async function createServer(options = {}) {
  const config = {
    adminUser: options.adminUser ?? process.env.ADMIN_USER ?? 'admin',
    adminPassword: options.adminPassword ?? process.env.ADMIN_PASSWORD ?? 'admin',
    dataFile: options.dataFile ?? process.env.DATA_FILE ?? path.join(ROOT, 'data', 'quizzes.json'),
    seedFile: options.seedFile ?? path.join(ROOT, 'data', 'quizzes.sample.json'),
    hostGraceMs: options.hostGraceMs,
    lobbyGraceMs: options.lobbyGraceMs,
  };

  const auth = new Auth({ user: config.adminUser, password: config.adminPassword });
  const store = new QuizStore(config.dataFile);
  await store.seedIfEmpty(config.seedFile);
  const gameManager = new GameManager();

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', createApiRouter({ auth, store, gameManager }));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  app.use((req, res) => res.status(404).sendFile(path.join(ROOT, 'public', '404.html')));

  const server = http.createServer(app);
  const io = new Server(server);
  registerSockets(io, {
    auth,
    store,
    gameManager,
    ...(config.hostGraceMs !== undefined && { hostGraceMs: config.hostGraceMs }),
    ...(config.lobbyGraceMs !== undefined && { lobbyGraceMs: config.lobbyGraceMs }),
  });
  gameManager.startSweeper((pin) => io.to(`game:${pin}`).emit('game:closed', { reason: 'Partida inactiva' }));

  const close = () =>
    new Promise((resolve) => {
      gameManager.stop();
      io.close();
      server.close(() => resolve());
    });

  return { app, server, io, auth, store, gameManager, config, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer()
    .then(({ server, config }) => {
      server.listen(port, () => {
        console.log(`Kahahara escuchando en http://localhost:${port}`);
        if (!process.env.ADMIN_PASSWORD) {
          console.warn('Aviso: usando credenciales por defecto admin/admin. Define ADMIN_USER y ADMIN_PASSWORD.');
        }
        console.log(`Quizzes guardados en ${config.dataFile}`);
      });
    })
    .catch((err) => {
      console.error('No se pudo iniciar el servidor:', err);
      process.exit(1);
    });
}

module.exports = { createServer };
