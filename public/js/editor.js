/* Editor de quizzes: crea o modifica un quiz y lo guarda vía API. */
(function () {
  'use strict';
  const { h, forma, NOMBRES_FORMA, api, sesion, mostrarMensaje, parametro } = window.K;
  sesion.exigir();

  const TIEMPOS = [5, 10, 20, 30, 60, 90, 120];
  const MAX_PREGUNTAS = 50;
  const MIN_OPCIONES = 2;
  const MAX_OPCIONES = 4;

  const $ = (id) => document.getElementById(id);
  const form = $('form-quiz');
  const contenedor = $('preguntas');
  const mensaje = $('mensaje');
  const id = parametro('id');

  let quiz = { title: '', description: '', questions: [preguntaVacia()] };
  let cambiosSinGuardar = false;

  function preguntaVacia() {
    return { text: '', options: ['', '', '', ''], correctIndex: 0, timeLimit: 20 };
  }

  // ---------- Render ----------

  function render() {
    contenedor.replaceChildren(...quiz.questions.map(renderPregunta));
    $('agregar').disabled = quiz.questions.length >= MAX_PREGUNTAS;
  }

  function renderPregunta(q, qi) {
    const total = quiz.questions.length;
    const nombreRadio = `correcta-${qi}`;

    const opciones = q.options.map((texto, oi) =>
      h('div', { class: 'opcion-editor' },
        h('input', {
          type: 'radio',
          name: nombreRadio,
          checked: q.correctIndex === oi,
          'aria-label': `Marcar opción ${oi + 1} como correcta`,
          title: 'Respuesta correcta',
          onchange: () => { q.correctIndex = oi; marcarCambio(); },
        }),
        (() => { const f = forma(oi); f.classList.add(`color-op${oi}`); f.title = NOMBRES_FORMA[oi]; return f; })(),
        h('input', {
          class: 'entrada compacta',
          value: texto,
          maxlength: 80,
          placeholder: `Opción ${oi + 1}`,
          'aria-label': `Pregunta ${qi + 1}, opción ${oi + 1}`,
          oninput: (e) => { q.options[oi] = e.target.value; marcarCambio(); },
        }),
        q.options.length > MIN_OPCIONES
          ? h('button', {
              type: 'button',
              class: 'boton peligro pequeno',
              'aria-label': `Quitar opción ${oi + 1}`,
              title: 'Quitar opción',
              onclick: () => quitarOpcion(q, oi),
            }, '×')
          : null
      )
    );

    const tiempo = h('select', {
      class: 'entrada compacta',
      style: 'width:auto',
      'aria-label': `Tiempo de la pregunta ${qi + 1}`,
      onchange: (e) => { q.timeLimit = Number(e.target.value); marcarCambio(); },
    }, TIEMPOS.map((t) => h('option', { value: t, selected: t === q.timeLimit }, `${t} s`)));

    return h('fieldset', { class: 'pregunta-editor pila' },
      h('legend', null, `Pregunta ${qi + 1}`),
      h('textarea', {
        class: 'entrada compacta',
        rows: 2,
        maxlength: 200,
        placeholder: 'Escribe la pregunta',
        'aria-label': `Enunciado de la pregunta ${qi + 1}`,
        oninput: (e) => { q.text = e.target.value; marcarCambio(); },
      }, q.text),
      h('p', { class: 'muted', style: 'margin:0' }, 'Marca el círculo de la opción correcta.'),
      h('div', { class: 'opciones-editor' }, opciones),
      h('div', { class: 'fila entre' },
        h('div', { class: 'fila' },
          h('span', null, '⏱'), tiempo,
          q.options.length < MAX_OPCIONES
            ? h('button', { type: 'button', class: 'boton secundario pequeno', onclick: () => { q.options.push(''); marcarCambio(); render(); } }, '+ Opción')
            : null
        ),
        h('div', { class: 'fila' },
          h('button', { type: 'button', class: 'boton secundario pequeno', disabled: qi === 0, 'aria-label': 'Subir pregunta', onclick: () => mover(qi, -1) }, '↑'),
          h('button', { type: 'button', class: 'boton secundario pequeno', disabled: qi === total - 1, 'aria-label': 'Bajar pregunta', onclick: () => mover(qi, 1) }, '↓'),
          h('button', { type: 'button', class: 'boton secundario pequeno', onclick: () => duplicar(qi) }, 'Duplicar'),
          h('button', { type: 'button', class: 'boton peligro pequeno', disabled: total === 1, onclick: () => eliminar(qi) }, 'Eliminar')
        )
      )
    );
  }

  // ---------- Acciones ----------

  function marcarCambio() { cambiosSinGuardar = true; }

  function quitarOpcion(q, oi) {
    q.options.splice(oi, 1);
    if (q.correctIndex === oi) q.correctIndex = 0;
    else if (q.correctIndex > oi) q.correctIndex -= 1;
    marcarCambio();
    render();
  }

  function mover(qi, delta) {
    const destino = qi + delta;
    const [q] = quiz.questions.splice(qi, 1);
    quiz.questions.splice(destino, 0, q);
    marcarCambio();
    render();
  }

  function duplicar(qi) {
    if (quiz.questions.length >= MAX_PREGUNTAS) return;
    quiz.questions.splice(qi + 1, 0, JSON.parse(JSON.stringify(quiz.questions[qi])));
    marcarCambio();
    render();
  }

  function eliminar(qi) {
    if (!confirm(`¿Eliminar la pregunta ${qi + 1}?`)) return;
    quiz.questions.splice(qi, 1);
    marcarCambio();
    render();
  }

  $('agregar').addEventListener('click', () => {
    quiz.questions.push(preguntaVacia());
    marcarCambio();
    render();
    const ultima = contenedor.lastElementChild;
    ultima.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ultima.querySelector('textarea').focus();
  });

  $('titulo').addEventListener('input', (e) => { quiz.title = e.target.value; marcarCambio(); });
  $('descripcion').addEventListener('input', (e) => { quiz.description = e.target.value; marcarCambio(); });

  // ---------- Validación (misma regla que el servidor) ----------

  function validar() {
    const errores = [];
    if (!quiz.title.trim()) errores.push('El título es obligatorio');
    quiz.questions.forEach((q, i) => {
      const n = i + 1;
      if (!q.text.trim()) errores.push(`Pregunta ${n}: el enunciado es obligatorio`);
      q.options.forEach((o, j) => { if (!o.trim()) errores.push(`Pregunta ${n}: la opción ${j + 1} está vacía`); });
    });
    return errores;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errores = validar();
    if (errores.length) {
      mostrarMensaje(mensaje, 'Revisa lo siguiente:', 'error', errores);
      mensaje.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const boton = form.querySelector('[type=submit]');
    boton.disabled = true;
    try {
      if (id) await api(`/quizzes/${encodeURIComponent(id)}`, { method: 'PUT', body: quiz });
      else await api('/quizzes', { method: 'POST', body: quiz });
      cambiosSinGuardar = false;
      location.href = 'panel.html';
    } catch (err) {
      mostrarMensaje(mensaje, err.message, 'error', err.details);
      mensaje.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      boton.disabled = false;
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (cambiosSinGuardar) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- Carga inicial ----------

  async function iniciar() {
    if (id) {
      document.title = 'Editar quiz · Kahahara';
      $('titulo-pagina').textContent = 'Editar quiz';
      try {
        const datos = await api(`/quizzes/${encodeURIComponent(id)}`);
        quiz = {
          title: datos.title,
          description: datos.description || '',
          questions: datos.questions.map((q) => ({ ...q, options: [...q.options] })),
        };
      } catch (err) {
        mostrarMensaje(mensaje, err.message);
        return;
      }
    }
    $('titulo').value = quiz.title;
    $('descripcion').value = quiz.description;
    render();
  }

  iniciar();
})();
