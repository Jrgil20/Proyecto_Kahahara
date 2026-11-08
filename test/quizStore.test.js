'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { QuizStore, validateQuiz, ValidationError } = require('../server/quizStore');

const valido = {
  title: '  Mi quiz  ',
  description: 'desc',
  questions: [{ text: '¿Sí?', options: ['Sí', 'No'], correctIndex: 0, timeLimit: 10 }],
  campoExtra: 'se descarta',
};

test('validateQuiz normaliza y descarta campos desconocidos', () => {
  const q = validateQuiz(valido);
  assert.equal(q.title, 'Mi quiz');
  assert.equal(q.campoExtra, undefined);
  assert.equal(q.questions[0].timeLimit, 10);
});

test('validateQuiz reporta todos los errores', () => {
  try {
    validateQuiz({
      title: '',
      questions: [
        { text: '', options: ['a'], correctIndex: 3, timeLimit: 1 },
        { text: 'ok', options: ['a', ''], correctIndex: 0 },
      ],
    });
    assert.fail('debió fallar');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    const texto = err.errors.join('\n');
    assert.match(texto, /título es obligatorio/);
    assert.match(texto, /Pregunta 1: el enunciado/);
    assert.match(texto, /Pregunta 1: debe tener entre 2 y 4/);
    assert.match(texto, /Pregunta 1: marca cuál/);
    assert.match(texto, /Pregunta 1: el tiempo/);
    assert.match(texto, /Pregunta 2: la opción 2 está vacía/);
  }
});

test('QuizStore: CRUD persistente y siembra inicial', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kahahara-'));
  const archivo = path.join(dir, 'quizzes.json');
  const store = new QuizStore(archivo);
  const seed = path.join(__dirname, '..', 'data', 'quizzes.sample.json');

  assert.equal(await store.seedIfEmpty(seed), true);
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.seedIfEmpty(seed), false, 'no vuelve a sembrar');

  const creado = await store.create(valido);
  assert.ok(creado.id);
  const actualizado = await store.update(creado.id, { ...valido, title: 'Nuevo' });
  assert.equal(actualizado.title, 'Nuevo');
  assert.equal(await store.update('no-existe', valido), null);

  // Un almacén nuevo lee lo persistido en disco
  const otro = new QuizStore(archivo);
  assert.equal((await otro.get(creado.id)).title, 'Nuevo');

  assert.equal(await store.remove(creado.id), true);
  assert.equal(await store.remove(creado.id), false);

  // Escrituras concurrentes no se pisan
  await Promise.all(Array.from({ length: 10 }, () => store.create(valido)));
  assert.equal((await new QuizStore(archivo).list()).length, 12);

  await fs.rm(dir, { recursive: true, force: true });
});
