'use strict';

/**
 * Autenticación sencilla de un único administrador.
 * Las credenciales vienen de variables de entorno y las sesiones son
 * tokens aleatorios guardados en memoria (se pierden al reiniciar).
 */

const crypto = require('crypto');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class Auth {
  constructor({ user, password, now = Date.now }) {
    this.user = user;
    this.password = password;
    this.now = now;
    this.sessions = new Map();
  }

  login(user, password) {
    // Se evalúan ambas comparaciones para no filtrar cuál falló por tiempo.
    const okUser = safeEqual(user ?? '', this.user);
    const okPass = safeEqual(password ?? '', this.password);
    if (!(okUser && okPass)) return null;
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, this.now() + TOKEN_TTL_MS);
    return token;
  }

  verify(token) {
    if (typeof token !== 'string' || !token) return false;
    const expires = this.sessions.get(token);
    if (!expires) return false;
    if (expires < this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(token) {
    this.sessions.delete(token);
  }

  /** Middleware de Express: exige "Authorization: Bearer <token>". */
  middleware() {
    return (req, res, next) => {
      const header = req.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!this.verify(token)) {
        return res.status(401).json({ error: 'Sesión inválida o expirada' });
      }
      req.token = token;
      return next();
    };
  }
}

module.exports = { Auth };
