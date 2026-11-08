'use strict';

/**
 * Protocolo en tiempo real (Socket.IO).
 *
 * Salas:
 *   host:<pin>        pantalla del anfitrión
 *   game:<pin>        todos los jugadores de la partida
 *   player:<id>       un jugador concreto (sobrevive a reconexiones)
 *
 * Eventos del anfitrión (requiere token de admin en handshake.auth.token):
 *   host:create {quizId}      -> ack {ok, pin, title, total}
 *   host:rejoin {pin}         -> ack {ok, state}
 *   host:next                 inicia la siguiente pregunta o termina la partida
 *   host:skip                 cierra la pregunta actual antes de tiempo
 *   host:kick {playerId}      expulsa a un jugador en la sala de espera
 *   host:end                  cierra la partida
 *
 * Eventos del jugador:
 *   player:join {pin, nickname}     -> ack {ok, playerId, nickname, title}
 *   player:rejoin {pin, playerId}   -> ack {ok, nickname, title, state}
 *   player:answer {optionIndex}     -> ack {ok}
 */

const { GameError, PHASES } = require('./game');

const HOST_GRACE_MS = 60_000; // tiempo para que el anfitrión recargue la página
const LOBBY_GRACE_MS = 15_000; // jugador desconectado en sala de espera
const QUESTION_GRACE_MS = 500; // margen por latencia al cerrar una pregunta
const PODIUM_SIZE = 3;

function fail(ack, err) {
  if (typeof ack !== 'function') return;
  if (err instanceof GameError) ack({ ok: false, code: err.code, error: err.message });
  else {
    console.error(err);
    ack({ ok: false, code: 'ERROR', error: 'Error interno' });
  }
}

function safeAck(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

function registerSockets(io, { auth, store, gameManager, hostGraceMs = HOST_GRACE_MS, lobbyGraceMs = LOBBY_GRACE_MS }) {
  io.use((socket, next) => {
    socket.data.isAdmin = auth.verify(socket.handshake.auth?.token);
    next();
  });

  // ---------- Utilidades de emisión ----------

  const hostRoom = (pin) => `host:${pin}`;
  const gameRoom = (pin) => `game:${pin}`;
  const playerRoom = (id) => `player:${id}`;

  function emitPlayers(game) {
    io.to(hostRoom(game.pin)).emit('lobby:players', { players: game.playerList() });
    io.to(gameRoom(game.pin)).emit('lobby:count', { count: game.players.size });
  }

  function finalFor(game, playerId) {
    const leaderboard = game.leaderboard();
    const me = leaderboard.find((e) => e.id === playerId);
    return {
      rank: me?.rank ?? null,
      score: me?.score ?? 0,
      playerCount: leaderboard.length,
      podium: leaderboard.slice(0, PODIUM_SIZE).map(({ nickname, score, rank }) => ({ nickname, score, rank })),
    };
  }

  function resultFor(results, playerId) {
    const mine = results.perPlayer[playerId];
    return {
      index: results.index,
      total: results.total,
      correctIndex: results.correctIndex,
      isLast: results.isLast,
      ...(mine || { answered: false, correct: false, points: 0, score: 0, rank: null }),
    };
  }

  function hostResults(results) {
    const { perPlayer, ...rest } = results;
    return rest;
  }

  function endQuestion(game) {
    const session = gameManager.session(game.pin);
    if (!session || game.phase !== PHASES.QUESTION) return;
    clearTimeout(session.questionTimer);
    session.questionTimer = null;
    const results = game.endQuestion();
    io.to(hostRoom(game.pin)).emit('question:ended', hostResults(results));
    for (const id of game.players.keys()) {
      io.to(playerRoom(id)).emit('question:result', resultFor(results, id));
    }
  }

  function startQuestion(game) {
    const session = gameManager.session(game.pin);
    const payload = game.startNextQuestion();
    io.to(hostRoom(game.pin)).emit('question:started', payload);
    io.to(gameRoom(game.pin)).emit('question:started', payload);
    io.to(hostRoom(game.pin)).emit('question:progress', {
      answeredCount: 0,
      playerCount: game.connectedPlayerCount(),
    });
    session.questionTimer = setTimeout(() => endQuestion(game), payload.timeLimit * 1000 + QUESTION_GRACE_MS);
  }

  function finishGame(game) {
    const session = gameManager.session(game.pin);
    if (session) clearTimeout(session.questionTimer);
    const final = game.finish();
    io.to(hostRoom(game.pin)).emit('game:finished', final);
    for (const id of game.players.keys()) {
      io.to(playerRoom(id)).emit('game:finished', finalFor(game, id));
    }
  }

  function closeGame(pin, reason) {
    io.to(gameRoom(pin)).emit('game:closed', { reason });
    io.to(hostRoom(pin)).emit('game:closed', { reason });
    io.in(gameRoom(pin)).socketsLeave([gameRoom(pin)]);
    gameManager.remove(pin);
  }

  function hostState(game) {
    const state = { pin: game.pin, title: game.quiz.title, total: game.totalQuestions, phase: game.phase, players: game.playerList() };
    if (game.phase === PHASES.QUESTION) {
      state.question = game.questionPayload();
      state.progress = { answeredCount: game.currentAnswers.size, playerCount: game.connectedPlayerCount() };
    } else if (game.phase === PHASES.RESULTS) {
      state.question = game.questionPayload();
      state.results = hostResults(game.lastResults);
    } else if (game.phase === PHASES.FINISHED) {
      state.final = { leaderboard: game.leaderboard(), total: game.totalQuestions };
    }
    return state;
  }

  function playerState(game, playerId) {
    const state = { phase: game.phase, playerCount: game.players.size };
    if (game.phase === PHASES.QUESTION) {
      state.question = game.questionPayload();
      state.answered = game.currentAnswers.has(playerId);
    } else if (game.phase === PHASES.RESULTS) {
      state.result = resultFor(game.lastResults, playerId);
    } else if (game.phase === PHASES.FINISHED) {
      state.final = finalFor(game, playerId);
    }
    return state;
  }

  /** Devuelve la partida del anfitrión o lanza error. */
  function hostGame(socket) {
    if (!socket.data.isAdmin) throw new GameError('NO_AUTORIZADO', 'Inicia sesión como administrador');
    const game = gameManager.get(socket.data.hostPin);
    if (!game) throw new GameError('SIN_PARTIDA', 'La partida ya no existe');
    gameManager.touch(game.pin);
    return game;
  }

  function attachHost(socket, game) {
    if (socket.data.hostPin && socket.data.hostPin !== game.pin) socket.leave(hostRoom(socket.data.hostPin));
    socket.data.hostPin = game.pin;
    socket.join(hostRoom(game.pin));
    const session = gameManager.session(game.pin);
    clearTimeout(session.hostGraceTimer);
    session.hostGraceTimer = null;
  }

  function attachPlayer(socket, game, player) {
    socket.data.pin = game.pin;
    socket.data.playerId = player.id;
    socket.join(gameRoom(game.pin));
    socket.join(playerRoom(player.id));
    const session = gameManager.session(game.pin);
    clearTimeout(session.lobbyKickTimers.get(player.id));
    session.lobbyKickTimers.delete(player.id);
    game.setConnected(player.id, true);
  }

  // ---------- Conexiones ----------

  io.on('connection', (socket) => {
    // ----- Anfitrión -----

    socket.on('host:create', async (data, ack) => {
      ack = safeAck(ack);
      try {
        if (!socket.data.isAdmin) throw new GameError('NO_AUTORIZADO', 'Inicia sesión como administrador');
        const quiz = await store.get(String(data?.quizId ?? ''));
        if (!quiz) throw new GameError('QUIZ_NO_ENCONTRADO', 'Quiz no encontrado');
        const game = gameManager.create(quiz);
        attachHost(socket, game);
        ack({ ok: true, pin: game.pin, title: quiz.title, total: game.totalQuestions });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on('host:rejoin', (data, ack) => {
      ack = safeAck(ack);
      try {
        if (!socket.data.isAdmin) throw new GameError('NO_AUTORIZADO', 'Inicia sesión como administrador');
        const game = gameManager.get(String(data?.pin ?? ''));
        if (!game) throw new GameError('SIN_PARTIDA', 'La partida ya no existe');
        attachHost(socket, game);
        ack({ ok: true, state: hostState(game) });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on('host:next', (_data, ack) => {
      ack = safeAck(ack);
      try {
        const game = hostGame(socket);
        if (game.phase === PHASES.QUESTION) {
          throw new GameError('PREGUNTA_EN_CURSO', 'Espera a que termine la pregunta');
        }
        if (game.phase === PHASES.RESULTS && !game.hasNextQuestion()) {
          finishGame(game);
        } else {
          startQuestion(game);
        }
        ack({ ok: true });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on('host:skip', (_data, ack) => {
      ack = safeAck(ack);
      try {
        const game = hostGame(socket);
        endQuestion(game);
        ack({ ok: true });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on('host:kick', (data, ack) => {
      ack = safeAck(ack);
      try {
        const game = hostGame(socket);
        if (game.phase !== PHASES.LOBBY) throw new GameError('PARTIDA_INICIADA', 'Solo se puede expulsar en la sala de espera');
        const playerId = String(data?.playerId ?? '');
        if (game.removePlayer(playerId)) {
          io.to(playerRoom(playerId)).emit('player:kicked');
          io.in(playerRoom(playerId)).socketsLeave([gameRoom(game.pin), playerRoom(playerId)]);
          emitPlayers(game);
        }
        ack({ ok: true });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on('host:end', (_data, ack) => {
      ack = safeAck(ack);
      try {
        const game = hostGame(socket);
        closeGame(game.pin, 'El anfitrión cerró la partida');
        socket.data.hostPin = null;
        ack({ ok: true });
      } catch (err) {
        fail(ack, err);
      }
    });

    // ----- Jugador -----

    socket.on('player:join', (data, ack) => {
      ack = safeAck(ack);
      try {
        if (socket.data.playerId) throw new GameError('YA_UNIDO', 'Ya estás en una partida');
        const game = gameManager.get(String(data?.pin ?? '').trim());
        if (!game) throw new GameError('PIN_INVALIDO', 'No existe una partida con ese PIN');
        const player = game.addPlayer(data?.nickname);
        attachPlayer(socket, game, player);
        gameManager.touch(game.pin);
        emitPlayers(game);
        ack({ ok: true, playerId: player.id, nickname: player.nickname, title: game.quiz.title });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on('player:rejoin', (data, ack) => {
      ack = safeAck(ack);
      try {
        const game = gameManager.get(String(data?.pin ?? ''));
        if (!game) throw new GameError('PIN_INVALIDO', 'La partida ya no existe');
        const player = game.getPlayer(String(data?.playerId ?? ''));
        if (!player) throw new GameError('JUGADOR_DESCONOCIDO', 'Ya no formas parte de esta partida');
        attachPlayer(socket, game, player);
        emitPlayers(game);
        ack({ ok: true, nickname: player.nickname, title: game.quiz.title, state: playerState(game, player.id) });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on('player:answer', (data, ack) => {
      ack = safeAck(ack);
      try {
        const game = gameManager.get(socket.data.pin);
        if (!game || !socket.data.playerId) throw new GameError('SIN_PARTIDA', 'No estás en una partida');
        const { answeredCount, allAnswered } = game.submitAnswer(socket.data.playerId, Number(data?.optionIndex));
        gameManager.touch(game.pin);
        ack({ ok: true });
        io.to(hostRoom(game.pin)).emit('question:progress', {
          answeredCount,
          playerCount: game.connectedPlayerCount(),
        });
        if (allAnswered) endQuestion(game);
      } catch (err) {
        fail(ack, err);
      }
    });

    // ----- Desconexión -----

    socket.on('disconnect', async () => {
      const { hostPin, pin, playerId } = socket.data;

      if (hostPin && gameManager.get(hostPin)) {
        const remaining = await io.in(hostRoom(hostPin)).fetchSockets();
        const session = gameManager.session(hostPin);
        if (remaining.length === 0 && session && !session.hostGraceTimer) {
          session.hostGraceTimer = setTimeout(
            () => closeGame(hostPin, 'El anfitrión se desconectó'),
            hostGraceMs
          );
        }
      }

      if (pin && playerId) {
        const game = gameManager.get(pin);
        if (!game || !game.getPlayer(playerId)) return;
        const stillHere = await io.in(playerRoom(playerId)).fetchSockets();
        if (stillHere.length > 0) return; // otra pestaña del mismo jugador
        game.setConnected(playerId, false);
        const session = gameManager.session(pin);
        if (game.phase === PHASES.LOBBY) {
          session.lobbyKickTimers.set(playerId, setTimeout(() => {
            session.lobbyKickTimers.delete(playerId);
            if (game.phase === PHASES.LOBBY && game.getPlayer(playerId) && !game.getPlayer(playerId).connected) {
              game.removePlayer(playerId);
              emitPlayers(game);
            }
          }, lobbyGraceMs));
        }
        emitPlayers(game);
        if (game.phase === PHASES.QUESTION) {
          io.to(hostRoom(pin)).emit('question:progress', {
            answeredCount: game.currentAnswers.size,
            playerCount: game.connectedPlayerCount(),
          });
          // No se cierra la pregunta aquí: un jugador que recarga la página
          // debe poder volver y responder. El temporizador la cerrará.
        }
      }
    });
  });
}

module.exports = { registerSockets };
