'use strict';

/**
 * Lógica pura de una partida. No sabe nada de sockets ni de temporizadores:
 * el servidor llama a estos métodos y decide qué emitir. Así se puede probar
 * de forma aislada (ver test/game.test.js).
 */

const crypto = require('crypto');

const PHASES = Object.freeze({
  LOBBY: 'lobby',
  QUESTION: 'question',
  RESULTS: 'results',
  FINISHED: 'finished',
});

const MAX_PLAYERS = 100;
const NICKNAME_MAX = 20;
const MAX_POINTS = 1000;
const STREAK_BONUS = 100;
const STREAK_BONUS_MAX = 500;

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Puntos por respuesta correcta: 1000 si se responde al instante y baja
 * linealmente hasta 500 al agotarse el tiempo (fórmula de Kahoot).
 */
function calculatePoints(elapsedMs, timeLimitMs) {
  const ratio = Math.min(Math.max(elapsedMs / timeLimitMs, 0), 1);
  return Math.round(MAX_POINTS * (1 - ratio / 2));
}

function normalizeNickname(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

class Game {
  /**
   * @param {object} opts
   * @param {string} opts.pin
   * @param {object} opts.quiz  quiz ya validado ({ title, questions: [...] })
   * @param {() => number} [opts.now]  reloj inyectable para pruebas
   */
  constructor({ pin, quiz, now = Date.now }) {
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      throw new GameError('QUIZ_VACIO', 'El quiz no tiene preguntas');
    }
    this.pin = pin;
    this.quiz = quiz;
    this.now = now;
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.questionIndex = -1;
    this.questionStartedAt = 0;
    this.currentAnswers = new Map();
    this.lastResults = null;
  }

  get totalQuestions() {
    return this.quiz.questions.length;
  }

  get currentQuestion() {
    return this.quiz.questions[this.questionIndex] ?? null;
  }

  // ---------- Jugadores ----------

  addPlayer(rawNickname) {
    if (this.phase !== PHASES.LOBBY) {
      throw new GameError('PARTIDA_INICIADA', 'La partida ya comenzó');
    }
    const nickname = normalizeNickname(rawNickname);
    if (nickname.length === 0) {
      throw new GameError('NICK_VACIO', 'Escribe un apodo');
    }
    if (nickname.length > NICKNAME_MAX) {
      throw new GameError('NICK_LARGO', `El apodo admite máximo ${NICKNAME_MAX} caracteres`);
    }
    const taken = [...this.players.values()].some(
      (p) => p.nickname.toLowerCase() === nickname.toLowerCase()
    );
    if (taken) {
      throw new GameError('NICK_EN_USO', 'Ese apodo ya está en uso');
    }
    if (this.players.size >= MAX_PLAYERS) {
      throw new GameError('PARTIDA_LLENA', 'La partida está llena');
    }
    const player = {
      id: crypto.randomUUID(),
      nickname,
      score: 0,
      streak: 0,
      connected: true,
    };
    this.players.set(player.id, player);
    return player;
  }

  getPlayer(playerId) {
    return this.players.get(playerId) ?? null;
  }

  removePlayer(playerId) {
    return this.players.delete(playerId);
  }

  setConnected(playerId, connected) {
    const player = this.players.get(playerId);
    if (player) player.connected = connected;
    return player ?? null;
  }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      connected: p.connected,
    }));
  }

  // ---------- Flujo de preguntas ----------

  hasNextQuestion() {
    return this.questionIndex + 1 < this.totalQuestions;
  }

  startNextQuestion() {
    if (this.phase === PHASES.QUESTION) {
      throw new GameError('PREGUNTA_EN_CURSO', 'Ya hay una pregunta en curso');
    }
    if (this.phase === PHASES.FINISHED) {
      throw new GameError('PARTIDA_TERMINADA', 'La partida terminó');
    }
    if (this.phase === PHASES.LOBBY && this.players.size === 0) {
      throw new GameError('SIN_JUGADORES', 'Se necesita al menos un jugador');
    }
    if (!this.hasNextQuestion()) {
      throw new GameError('SIN_PREGUNTAS', 'No quedan preguntas');
    }
    this.questionIndex += 1;
    this.phase = PHASES.QUESTION;
    this.questionStartedAt = this.now();
    this.currentAnswers = new Map();
    this.lastResults = null;
    return this.questionPayload();
  }

  /** Datos de la pregunta actual sin revelar la respuesta correcta. */
  questionPayload() {
    const q = this.currentQuestion;
    if (!q) return null;
    const elapsed = this.phase === PHASES.QUESTION ? this.now() - this.questionStartedAt : 0;
    return {
      index: this.questionIndex,
      total: this.totalQuestions,
      text: q.text,
      options: [...q.options],
      timeLimit: q.timeLimit,
      remainingMs: Math.max(q.timeLimit * 1000 - elapsed, 0),
    };
  }

  connectedPlayerCount() {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  allAnswered() {
    for (const p of this.players.values()) {
      if (p.connected && !this.currentAnswers.has(p.id)) return false;
    }
    return true;
  }

  submitAnswer(playerId, optionIndex) {
    if (this.phase !== PHASES.QUESTION) {
      throw new GameError('FUERA_DE_TIEMPO', 'No hay una pregunta abierta');
    }
    const player = this.players.get(playerId);
    if (!player) {
      throw new GameError('JUGADOR_DESCONOCIDO', 'Jugador no encontrado');
    }
    if (this.currentAnswers.has(playerId)) {
      throw new GameError('YA_RESPONDIO', 'Ya respondiste esta pregunta');
    }
    const q = this.currentQuestion;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= q.options.length) {
      throw new GameError('OPCION_INVALIDA', 'Opción inválida');
    }
    const limitMs = q.timeLimit * 1000;
    const elapsed = this.now() - this.questionStartedAt;
    if (elapsed > limitMs) {
      throw new GameError('FUERA_DE_TIEMPO', 'Se acabó el tiempo');
    }
    this.currentAnswers.set(playerId, { optionIndex, elapsed });
    return { answeredCount: this.currentAnswers.size, allAnswered: this.allAnswered() };
  }

  /**
   * Cierra la pregunta, asigna puntos y devuelve los resultados.
   * Es idempotente: si ya se cerró, devuelve los mismos resultados.
   */
  endQuestion() {
    if (this.phase === PHASES.RESULTS && this.lastResults) return this.lastResults;
    if (this.phase !== PHASES.QUESTION) {
      throw new GameError('SIN_PREGUNTA', 'No hay una pregunta abierta');
    }
    const q = this.currentQuestion;
    const limitMs = q.timeLimit * 1000;
    const distribution = q.options.map(() => 0);
    const perPlayer = {};

    for (const player of this.players.values()) {
      const answer = this.currentAnswers.get(player.id);
      let points = 0;
      let correct = false;
      if (answer) {
        distribution[answer.optionIndex] += 1;
        correct = answer.optionIndex === q.correctIndex;
      }
      if (correct) {
        player.streak += 1;
        const bonus = Math.min((player.streak - 1) * STREAK_BONUS, STREAK_BONUS_MAX);
        points = calculatePoints(answer.elapsed, limitMs) + bonus;
        player.score += points;
      } else {
        player.streak = 0;
      }
      perPlayer[player.id] = {
        answered: Boolean(answer),
        selectedIndex: answer ? answer.optionIndex : null,
        correct,
        points,
        score: player.score,
        streak: player.streak,
      };
    }

    const leaderboard = this.leaderboard();
    leaderboard.forEach((entry) => {
      perPlayer[entry.id].rank = entry.rank;
    });

    this.phase = PHASES.RESULTS;
    this.lastResults = {
      index: this.questionIndex,
      total: this.totalQuestions,
      correctIndex: q.correctIndex,
      distribution,
      answeredCount: this.currentAnswers.size,
      leaderboard,
      perPlayer,
      isLast: !this.hasNextQuestion(),
    };
    return this.lastResults;
  }

  /** Ranking ordenado; empates comparten puesto (1, 1, 3...). */
  leaderboard() {
    const sorted = [...this.players.values()].sort(
      (a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname)
    );
    let lastScore = null;
    let lastRank = 0;
    return sorted.map((p, i) => {
      const rank = p.score === lastScore ? lastRank : i + 1;
      lastScore = p.score;
      lastRank = rank;
      return { id: p.id, nickname: p.nickname, score: p.score, rank };
    });
  }

  finish() {
    if (this.phase === PHASES.QUESTION) this.endQuestion();
    this.phase = PHASES.FINISHED;
    return { leaderboard: this.leaderboard(), total: this.totalQuestions };
  }
}

module.exports = { Game, GameError, PHASES, calculatePoints, MAX_PLAYERS, NICKNAME_MAX };
