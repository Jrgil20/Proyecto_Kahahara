'use strict';

/**
 * Prueba de extremo a extremo: levanta el servidor real en un puerto libre,
 * usa la API HTTP y juega una partida completa con clientes Socket.IO.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../server');

let srv;
let base;
let dir;
const sockets = [];

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kahahara-e2e-'));
  srv = await createServer({
    adminUser: 'profe',
    adminPassword: 'secreta',
    dataFile: path.join(dir, 'quizzes.json'),
    hostGraceMs: 300,
    lobbyGraceMs: 300,
  });
  await new Promise((r) => srv.server.listen(0, r));
  base = `http://localhost:${srv.server.address().port}`;
});

test.after(async () => {
  sockets.forEach((s) => s.close());
  await srv.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function http(method, url, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}

function cliente(token) {
  const s = ioClient(base, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}

function pedir(s, evento, datos) {
  return new Promise((resolve) => s.emit(evento, datos, resolve));
}

function esperar(s, evento, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout esperando ${evento}`)), ms);
    s.once(evento, (d) => {
      clearTimeout(t);
      resolve(d);
    });
  });
}

async function login() {
  const { status, data } = await http('POST', '/api/login', { body: { usuario: 'profe', contrasena: 'secreta' } });
  assert.equal(status, 200);
  return data.token;
}

test('API: login y CRUD requieren autenticación', async () => {
  assert.equal((await http('POST', '/api/login', { body: { usuario: 'profe', contrasena: 'mal' } })).status, 401);
  assert.equal((await http('GET', '/api/quizzes')).status, 401);
  assert.equal((await http('GET', '/api/quizzes', { token: 'inventado' })).status, 401);

  const token = await login();
  const lista = await http('GET', '/api/quizzes', { token });
  assert.equal(lista.status, 200);
  assert.equal(lista.data.length, 2, 'quizzes de ejemplo sembrados');

  const invalido = await http('POST', '/api/quizzes', { token, body: { title: '' } });
  assert.equal(invalido.status, 400);
  assert.ok(invalido.data.details.length > 0);

  const creado = await http('POST', '/api/quizzes', {
    token,
    body: { title: 'Temporal', questions: [{ text: 'q', options: ['a', 'b'], correctIndex: 0, timeLimit: 10 }] },
  });
  assert.equal(creado.status, 201);
  assert.equal((await http('DELETE', `/api/quizzes/${creado.data.id}`, { token })).status, 204);
  assert.equal((await http('GET', `/api/quizzes/${creado.data.id}`, { token })).status, 404);

  assert.equal((await http('GET', '/api/games/000000')).status, 404);
  assert.equal((await fetch(`${base}/no-existe`)).status, 404);
  assert.equal((await fetch(`${base}/IngresarPin.html`)).status, 200);
});

test('Socket: un jugador no puede actuar como anfitrión', async () => {
  const intruso = cliente();
  const res = await pedir(intruso, 'host:create', { quizId: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_AUTORIZADO');
});

test('Partida completa con dos jugadores, reconexión y podio', async () => {
  const token = await login();
  const token2 = token;
  const { data: quiz } = await http('POST', '/api/quizzes', {
    token,
    body: {
      title: 'E2E',
      questions: [
        { text: '¿1+1?', options: ['1', '2', '3'], correctIndex: 1, timeLimit: 30 },
        { text: '¿Cielo?', options: ['Azul', 'Verde'], correctIndex: 0, timeLimit: 30 },
      ],
    },
  });

  const host = cliente(token2);
  const creada = await pedir(host, 'host:create', { quizId: quiz.id });
  assert.equal(creada.ok, true);
  assert.match(creada.pin, /^\d{6}$/);
  const pin = creada.pin;

  const info = await http('GET', `/api/games/${pin}`);
  assert.equal(info.data.phase, 'lobby');

  // Unión de jugadores
  const ana = cliente();
  const beto = cliente();
  let jugadores = esperar(host, 'lobby:players');
  const jAna = await pedir(ana, 'player:join', { pin, nickname: 'Ana' });
  assert.equal(jAna.ok, true);
  assert.equal((await jugadores).players.length, 1);

  const repetido = await pedir(cliente(), 'player:join', { pin, nickname: 'ANA' });
  assert.equal(repetido.code, 'NICK_EN_USO');
  const pinMalo = await pedir(cliente(), 'player:join', { pin: '1', nickname: 'X' });
  assert.equal(pinMalo.code, 'PIN_INVALIDO');

  const jBeto = await pedir(beto, 'player:join', { pin, nickname: 'Beto' });
  assert.equal(jBeto.ok, true);

  // Expulsar a un tercero en la sala
  const caro = cliente();
  const jCaro = await pedir(caro, 'player:join', { pin, nickname: 'Caro' });
  const expulsado = esperar(caro, 'player:kicked');
  assert.equal((await pedir(host, 'host:kick', { playerId: jCaro.playerId })).ok, true);
  await expulsado;

  // Pregunta 1
  const q1Ana = esperar(ana, 'question:started');
  const q1Host = esperar(host, 'question:started');
  assert.equal((await pedir(host, 'host:next')).ok, true);
  const q1 = await q1Ana;
  assert.equal(q1.text, '¿1+1?');
  assert.equal(q1.correctIndex, undefined, 'no se filtra la respuesta');
  await q1Host;

  assert.equal((await pedir(host, 'host:next')).code, 'PREGUNTA_EN_CURSO');

  const progreso = esperar(host, 'question:progress');
  assert.equal((await pedir(ana, 'player:answer', { optionIndex: 1 })).ok, true);
  assert.equal((await progreso).answeredCount, 1);
  assert.equal((await pedir(ana, 'player:answer', { optionIndex: 0 })).code, 'YA_RESPONDIO');

  // Beto recarga la página (nuevo socket) a mitad de la pregunta
  beto.close();
  const beto2 = cliente();
  const re = await pedir(beto2, 'player:rejoin', { pin, playerId: jBeto.playerId });
  assert.equal(re.ok, true);
  assert.equal(re.state.phase, 'question');
  assert.equal(re.state.answered, false);

  // Cuando todos responden la pregunta se cierra sola
  const resAna = esperar(ana, 'question:result');
  const resBeto = esperar(beto2, 'question:result');
  const finHost = esperar(host, 'question:ended');
  assert.equal((await pedir(beto2, 'player:answer', { optionIndex: 0 })).ok, true);
  const [rA, rB, rH] = await Promise.all([resAna, resBeto, finHost]);
  assert.equal(rA.correct, true);
  assert.ok(rA.points >= 900);
  assert.equal(rA.rank, 1);
  assert.equal(rB.correct, false);
  assert.equal(rB.points, 0);
  assert.deepEqual(rH.distribution, [1, 1, 0]);
  assert.equal(rH.correctIndex, 1);
  assert.equal(rH.perPlayer, undefined, 'el anfitrión no recibe datos por jugador');

  // El anfitrión recarga la página y recupera el estado
  host.close();
  const host2 = cliente(token);
  const reHost = await pedir(host2, 'host:rejoin', { pin });
  assert.equal(reHost.ok, true);
  assert.equal(reHost.state.phase, 'results');

  // Pregunta 2: el anfitrión la salta antes de que respondan todos
  const q2 = esperar(ana, 'question:started');
  await pedir(host2, 'host:next');
  await q2;
  await pedir(beto2, 'player:answer', { optionIndex: 0 });
  const fin2 = esperar(host2, 'question:ended');
  const resAna2 = esperar(ana, 'question:result');
  assert.equal((await pedir(host2, 'host:skip')).ok, true);
  const r2 = await fin2;
  assert.equal(r2.isLast, true);
  assert.equal((await resAna2).answered, false);

  // Podio
  const finalAna = esperar(ana, 'game:finished');
  const finalHost = esperar(host2, 'game:finished');
  await pedir(host2, 'host:next');
  const [fA, fH] = await Promise.all([finalAna, finalHost]);
  assert.equal(fH.leaderboard.length, 2);
  assert.equal(fA.playerCount, 2);
  assert.ok(fA.podium.length === 2);
  // Ana: ~1000 en P1; Beto: ~1000 en P2 → orden depende de la velocidad, pero ambos puntúan.
  assert.ok(fH.leaderboard.every((e) => e.score > 0));

  // Cierre
  const cerrada = esperar(ana, 'game:closed');
  assert.equal((await pedir(host2, 'host:end')).ok, true);
  await cerrada;
  assert.equal((await http('GET', `/api/games/${pin}`)).status, 404);
});

test('Si el anfitrión se va y no vuelve, la partida se cierra', async () => {
  const token = await login();
  const { data: lista } = await http('GET', '/api/quizzes', { token });
  const host = cliente(token);
  const { pin } = await pedir(host, 'host:create', { quizId: lista[0].id });
  const jugador = cliente();
  await pedir(jugador, 'player:join', { pin, nickname: 'Solo' });
  const cerrada = esperar(jugador, 'game:closed');
  host.close();
  const { reason } = await cerrada;
  assert.match(reason, /anfitrión/);
});

test('Jugador que se desconecta en la sala de espera sale tras el margen', async () => {
  const token = await login();
  const { data: lista } = await http('GET', '/api/quizzes', { token });
  const host = cliente(token);
  const { pin } = await pedir(host, 'host:create', { quizId: lista[0].id });
  const j = cliente();
  await pedir(j, 'player:join', { pin, nickname: 'Fugaz' });
  const vacia = new Promise((resolve) => {
    host.on('lobby:players', ({ players }) => { if (players.length === 0) resolve(); });
  });
  j.close();
  await vacia;
  await pedir(host, 'host:end');
});
