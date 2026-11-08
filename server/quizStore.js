'use strict';

/**
 * Almacén de quizzes en un archivo JSON. Las escrituras son atómicas
 * (se escribe a un temporal y luego se renombra) y se serializan con una
 * cola de promesas para evitar condiciones de carrera.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const LIMITS = Object.freeze({
  TITLE_MAX: 100,
  DESCRIPTION_MAX: 300,
  QUESTIONS_MIN: 1,
  QUESTIONS_MAX: 50,
  QUESTION_TEXT_MAX: 200,
  OPTIONS_MIN: 2,
  OPTIONS_MAX: 4,
  OPTION_TEXT_MAX: 80,
  TIME_MIN: 5,
  TIME_MAX: 120,
});

class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.errors = errors;
  }
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Valida y normaliza un quiz recibido del cliente.
 * Devuelve un objeto limpio (solo con los campos conocidos) o lanza ValidationError.
 */
function validateQuiz(input) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    throw new ValidationError(['El cuerpo debe ser un objeto JSON']);
  }

  const title = cleanText(input.title);
  if (!title) errors.push('El título es obligatorio');
  else if (title.length > LIMITS.TITLE_MAX) errors.push(`El título admite máximo ${LIMITS.TITLE_MAX} caracteres`);

  const description = cleanText(input.description);
  if (description.length > LIMITS.DESCRIPTION_MAX) {
    errors.push(`La descripción admite máximo ${LIMITS.DESCRIPTION_MAX} caracteres`);
  }

  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  if (rawQuestions.length < LIMITS.QUESTIONS_MIN) errors.push('Agrega al menos una pregunta');
  if (rawQuestions.length > LIMITS.QUESTIONS_MAX) errors.push(`Máximo ${LIMITS.QUESTIONS_MAX} preguntas`);

  const questions = rawQuestions.slice(0, LIMITS.QUESTIONS_MAX).map((raw, i) => {
    const n = i + 1;
    const q = raw && typeof raw === 'object' ? raw : {};
    const text = cleanText(q.text);
    if (!text) errors.push(`Pregunta ${n}: el enunciado es obligatorio`);
    else if (text.length > LIMITS.QUESTION_TEXT_MAX) errors.push(`Pregunta ${n}: enunciado demasiado largo`);

    const options = (Array.isArray(q.options) ? q.options : []).map(cleanText);
    if (options.length < LIMITS.OPTIONS_MIN || options.length > LIMITS.OPTIONS_MAX) {
      errors.push(`Pregunta ${n}: debe tener entre ${LIMITS.OPTIONS_MIN} y ${LIMITS.OPTIONS_MAX} opciones`);
    }
    options.forEach((opt, j) => {
      if (!opt) errors.push(`Pregunta ${n}: la opción ${j + 1} está vacía`);
      else if (opt.length > LIMITS.OPTION_TEXT_MAX) errors.push(`Pregunta ${n}: la opción ${j + 1} es demasiado larga`);
    });

    const correctIndex = Number(q.correctIndex);
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
      errors.push(`Pregunta ${n}: marca cuál opción es la correcta`);
    }

    const timeLimit = Number(q.timeLimit ?? 20);
    if (!Number.isInteger(timeLimit) || timeLimit < LIMITS.TIME_MIN || timeLimit > LIMITS.TIME_MAX) {
      errors.push(`Pregunta ${n}: el tiempo debe estar entre ${LIMITS.TIME_MIN} y ${LIMITS.TIME_MAX} segundos`);
    }

    return { text, options, correctIndex, timeLimit };
  });

  if (errors.length) throw new ValidationError(errors);
  return { title, description, questions };
}

class QuizStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.cache = [];
    }
    return this.cache;
  }

  /** Si el archivo no existe, lo crea con los quizzes de ejemplo. */
  async seedIfEmpty(seedPath) {
    try {
      await fs.access(this.filePath);
      return false;
    } catch {
      const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'));
      const now = new Date().toISOString();
      for (const quiz of seed) {
        const clean = validateQuiz(quiz);
        await this.create(clean, now);
      }
      return true;
    }
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2));
    await fs.rename(tmp, this.filePath);
  }

  /** Ejecuta mutaciones de una en una. */
  mutate(fn) {
    const run = this.queue.then(async () => {
      await this.load();
      const result = await fn(this.cache);
      await this.persist();
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async list() {
    const quizzes = await this.load();
    return quizzes.map((q) => ({
      id: q.id,
      title: q.title,
      description: q.description,
      questionCount: q.questions.length,
      updatedAt: q.updatedAt,
    }));
  }

  async get(id) {
    const quizzes = await this.load();
    return quizzes.find((q) => q.id === id) ?? null;
  }

  create(data, now = new Date().toISOString()) {
    const clean = validateQuiz(data);
    return this.mutate((quizzes) => {
      const quiz = { id: crypto.randomUUID(), ...clean, createdAt: now, updatedAt: now };
      quizzes.push(quiz);
      return quiz;
    });
  }

  update(id, data) {
    const clean = validateQuiz(data);
    return this.mutate((quizzes) => {
      const idx = quizzes.findIndex((q) => q.id === id);
      if (idx === -1) return null;
      quizzes[idx] = { ...quizzes[idx], ...clean, updatedAt: new Date().toISOString() };
      return quizzes[idx];
    });
  }

  remove(id) {
    return this.mutate((quizzes) => {
      const idx = quizzes.findIndex((q) => q.id === id);
      if (idx === -1) return false;
      quizzes.splice(idx, 1);
      return true;
    });
  }
}

module.exports = { QuizStore, validateQuiz, ValidationError, LIMITS };
