'use strict';

/**
 * Registro de partidas activas indexadas por PIN.
 * Cada entrada guarda la partida y los temporizadores asociados.
 */

const crypto = require('crypto');
const { Game } = require('./game');

const IDLE_TTL_MS = 2 * 60 * 60 * 1000; // partidas sin actividad por 2 h se eliminan
const SWEEP_EVERY_MS = 5 * 60 * 1000;

class GameManager {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.sessions = new Map();
    this.sweeper = null;
  }

  generatePin() {
    for (let i = 0; i < 1000; i += 1) {
      const pin = String(crypto.randomInt(100000, 1000000));
      if (!this.sessions.has(pin)) return pin;
    }
    throw new Error('No se pudo generar un PIN libre');
  }

  create(quiz) {
    const pin = this.generatePin();
    // Copia profunda: editar el quiz durante la partida no la afecta.
    const snapshot = JSON.parse(JSON.stringify(quiz));
    const game = new Game({ pin, quiz: snapshot, now: this.now });
    this.sessions.set(pin, {
      game,
      questionTimer: null,
      hostGraceTimer: null,
      lobbyKickTimers: new Map(),
      lastActivity: this.now(),
    });
    return game;
  }

  get(pin) {
    return this.sessions.get(String(pin))?.game ?? null;
  }

  session(pin) {
    return this.sessions.get(String(pin)) ?? null;
  }

  touch(pin) {
    const s = this.session(pin);
    if (s) s.lastActivity = this.now();
  }

  remove(pin) {
    const s = this.session(pin);
    if (!s) return false;
    clearTimeout(s.questionTimer);
    clearTimeout(s.hostGraceTimer);
    s.lobbyKickTimers.forEach((t) => clearTimeout(t));
    this.sessions.delete(String(pin));
    return true;
  }

  /** Elimina partidas abandonadas. Devuelve los PIN eliminados. */
  sweep() {
    const removed = [];
    for (const [pin, s] of this.sessions) {
      if (this.now() - s.lastActivity > IDLE_TTL_MS) {
        this.remove(pin);
        removed.push(pin);
      }
    }
    return removed;
  }

  startSweeper(onRemoved = () => {}) {
    this.sweeper = setInterval(() => this.sweep().forEach(onRemoved), SWEEP_EVERY_MS);
    this.sweeper.unref();
  }

  stop() {
    clearInterval(this.sweeper);
    for (const pin of [...this.sessions.keys()]) this.remove(pin);
  }
}

module.exports = { GameManager };
