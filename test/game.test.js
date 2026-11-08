'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, GameError, PHASES, calculatePoints } = require('../server/game');

const quiz = {
  title: 'Prueba',
  questions: [
    { text: '¿2+2?', options: ['3', '4'], correctIndex: 1, timeLimit: 10 },
    { text: '¿Capital de Francia?', options: ['París', 'Roma', 'Madrid'], correctIndex: 0, timeLimit: 20 },
  ],
};

function nuevoJuego() {
  let t = 0;
  const reloj = { avanzar: (ms) => { t += ms; } };
  const game = new Game({ pin: '123456', quiz, now: () => t });
  return { game, reloj };
}

function codigo(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GameError, `se esperaba GameError, llegó ${err}`);
    return err.code;
  }
  assert.fail('no lanzó error');
}

test('calculatePoints: 1000 al instante, 500 al límite', () => {
  assert.equal(calculatePoints(0, 10_000), 1000);
  assert.equal(calculatePoints(5_000, 10_000), 750);
  assert.equal(calculatePoints(10_000, 10_000), 500);
  assert.equal(calculatePoints(99_000, 10_000), 500);
});

test('rechaza quiz sin preguntas', () => {
  assert.throws(() => new Game({ pin: '1', quiz: { title: 'x', questions: [] } }), GameError);
});

test('validación de apodos', () => {
  const { game } = nuevoJuego();
  game.addPlayer('Ana');
  assert.equal(codigo(() => game.addPlayer('  ')), 'NICK_VACIO');
  assert.equal(codigo(() => game.addPlayer('ana')), 'NICK_EN_USO');
  assert.equal(codigo(() => game.addPlayer('x'.repeat(21))), 'NICK_LARGO');
  assert.equal(game.addPlayer('  Luis   Pérez ').nickname, 'Luis Pérez');
});

test('no se puede iniciar sin jugadores ni unirse después de iniciar', () => {
  const { game } = nuevoJuego();
  assert.equal(codigo(() => game.startNextQuestion()), 'SIN_JUGADORES');
  game.addPlayer('Ana');
  game.startNextQuestion();
  assert.equal(codigo(() => game.addPlayer('Tarde')), 'PARTIDA_INICIADA');
});

test('la pregunta pública no revela la respuesta correcta', () => {
  const { game } = nuevoJuego();
  game.addPlayer('Ana');
  const q = game.startNextQuestion();
  assert.equal(q.correctIndex, undefined);
  assert.deepEqual(q.options, ['3', '4']);
  assert.equal(q.remainingMs, 10_000);
});

test('partida completa: puntuación, rachas, ranking y fin', () => {
  const { game, reloj } = nuevoJuego();
  const ana = game.addPlayer('Ana');
  const beto = game.addPlayer('Beto');
  const caro = game.addPlayer('Caro');

  // Pregunta 1
  game.startNextQuestion();
  reloj.avanzar(0);
  game.submitAnswer(ana.id, 1); // correcta al instante -> 1000
  reloj.avanzar(5_000);
  game.submitAnswer(beto.id, 1); // correcta a mitad -> 750
  const r = game.submitAnswer(caro.id, 0); // incorrecta
  assert.equal(r.allAnswered, true);
  assert.equal(codigo(() => game.submitAnswer(ana.id, 0)), 'YA_RESPONDIO');

  const r1 = game.endQuestion();
  assert.equal(game.phase, PHASES.RESULTS);
  assert.deepEqual(r1.distribution, [1, 2]);
  assert.equal(r1.correctIndex, 1);
  assert.equal(r1.perPlayer[ana.id].points, 1000);
  assert.equal(r1.perPlayer[beto.id].points, 750);
  assert.equal(r1.perPlayer[caro.id].points, 0);
  assert.equal(r1.perPlayer[ana.id].rank, 1);
  assert.equal(r1.isLast, false);
  assert.strictEqual(game.endQuestion(), r1, 'endQuestion es idempotente');

  // Pregunta 2: Ana acierta de nuevo (racha +100), Beto no responde
  game.startNextQuestion();
  game.submitAnswer(ana.id, 0);
  game.submitAnswer(caro.id, 0);
  assert.equal(game.allAnswered(), false);
  const r2 = game.endQuestion();
  assert.equal(r2.perPlayer[ana.id].points, 1100);
  assert.equal(r2.perPlayer[ana.id].streak, 2);
  assert.equal(r2.perPlayer[beto.id].answered, false);
  assert.equal(r2.perPlayer[beto.id].streak, 0);
  assert.equal(r2.isLast, true);

  assert.equal(codigo(() => game.startNextQuestion()), 'SIN_PREGUNTAS');
  const final = game.finish();
  assert.equal(game.phase, PHASES.FINISHED);
  assert.deepEqual(final.leaderboard.map((e) => [e.nickname, e.score]), [
    ['Ana', 2100],
    ['Caro', 1000],
    ['Beto', 750],
  ]);
});

test('respuestas fuera de tiempo u opciones inválidas se rechazan', () => {
  const { game, reloj } = nuevoJuego();
  const ana = game.addPlayer('Ana');
  game.startNextQuestion();
  assert.equal(codigo(() => game.submitAnswer(ana.id, 5)), 'OPCION_INVALIDA');
  assert.equal(codigo(() => game.submitAnswer(ana.id, -1)), 'OPCION_INVALIDA');
  assert.equal(codigo(() => game.submitAnswer('nadie', 0)), 'JUGADOR_DESCONOCIDO');
  reloj.avanzar(10_001);
  assert.equal(codigo(() => game.submitAnswer(ana.id, 1)), 'FUERA_DE_TIEMPO');
});

test('empates comparten puesto', () => {
  const { game } = nuevoJuego();
  const a = game.addPlayer('A');
  const b = game.addPlayer('B');
  game.addPlayer('C');
  game.startNextQuestion();
  game.submitAnswer(a.id, 1);
  game.submitAnswer(b.id, 1);
  game.endQuestion();
  assert.deepEqual(game.leaderboard().map((e) => e.rank), [1, 1, 3]);
});

test('jugadores desconectados no bloquean "todos respondieron"', () => {
  const { game } = nuevoJuego();
  const a = game.addPlayer('A');
  const b = game.addPlayer('B');
  game.startNextQuestion();
  game.setConnected(b.id, false);
  assert.equal(game.submitAnswer(a.id, 1).allAnswered, true);
});
