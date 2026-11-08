'use strict';

const express = require('express');
const { ValidationError } = require('./quizStore');

/** Límite simple de intentos de login por IP (en memoria). */
function loginLimiter({ max = 10, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Demasiados intentos, espera un minuto' });
    }
    return next();
  };
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createApiRouter({ auth, store, gameManager }) {
  const router = express.Router();
  router.use(express.json({ limit: '200kb' }));

  router.post('/login', loginLimiter(), (req, res) => {
    const { usuario, contrasena } = req.body || {};
    const token = auth.login(usuario, contrasena);
    if (!token) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    return res.json({ token });
  });

  router.post('/logout', auth.middleware(), (req, res) => {
    auth.logout(req.token);
    res.status(204).end();
  });

  // Público: permite al jugador comprobar un PIN antes de pedir el apodo.
  router.get('/games/:pin', (req, res) => {
    const game = gameManager.get(req.params.pin);
    if (!game) return res.status(404).json({ error: 'No existe una partida con ese PIN' });
    return res.json({ pin: game.pin, title: game.quiz.title, phase: game.phase });
  });

  const admin = express.Router();
  admin.use(auth.middleware());

  admin.get('/quizzes', asyncHandler(async (req, res) => {
    res.json(await store.list());
  }));

  admin.get('/quizzes/:id', asyncHandler(async (req, res) => {
    const quiz = await store.get(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz no encontrado' });
    return res.json(quiz);
  }));

  admin.post('/quizzes', asyncHandler(async (req, res) => {
    const quiz = await store.create(req.body);
    res.status(201).json(quiz);
  }));

  admin.put('/quizzes/:id', asyncHandler(async (req, res) => {
    const quiz = await store.update(req.params.id, req.body);
    if (!quiz) return res.status(404).json({ error: 'Quiz no encontrado' });
    return res.json(quiz);
  }));

  admin.delete('/quizzes/:id', asyncHandler(async (req, res) => {
    const removed = await store.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Quiz no encontrado' });
    return res.status(204).end();
  }));

  router.use(admin);

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'Datos inválidos', details: err.errors });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'JSON inválido' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'El quiz es demasiado grande' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  });

  return router;
}

module.exports = { createApiRouter };
