/* Pantalla del anfitrión: sala de espera → preguntas → resultados → podio. */
(function () {
  'use strict';
  const { h, forma, NOMBRES_FORMA, sesion, aviso, conectar, pedir, cuentaRegresiva, parametro } = window.K;

  const token = sesion.exigir();
  const CLAVE = 'kahahara.host';
  const escenario = document.getElementById('escenario');
  const info = document.getElementById('info-partida');

  let estado = { pin: null, title: '', total: 0, players: [], question: null };
  let detenerReloj = () => {};
  let ocupado = false;

  const socket = conectar({ token });

  // ---------- Conexión y (re)unión ----------

  socket.on('connect', async () => {
    const pinGuardado = sessionStorage.getItem(CLAVE);
    if (pinGuardado) {
      const res = await pedir(socket, 'host:rejoin', { pin: pinGuardado });
      if (res.ok) {
        aplicarEstado(res.state);
        return;
      }
      sessionStorage.removeItem(CLAVE);
      if (res.code === 'NO_AUTORIZADO') return irAlLogin();
      // Si la partida ya no existe y no hay quiz en la URL, se informa.
      if (!parametro('quiz')) return renderError(res.error);
    }

    const quizId = parametro('quiz');
    if (!quizId) return renderError('No se indicó qué quiz jugar.');
    const res = await pedir(socket, 'host:create', { quizId });
    if (!res.ok) {
      if (res.code === 'NO_AUTORIZADO') return irAlLogin();
      return renderError(res.error);
    }
    sessionStorage.setItem(CLAVE, res.pin);
    // Quita ?quiz= para que recargar la página no cree otra partida.
    history.replaceState(null, '', 'host.html');
    aplicarEstado({ pin: res.pin, title: res.title, total: res.total, phase: 'lobby', players: [] });
  });

  function irAlLogin() {
    sesion.borrar();
    location.replace('administrador.html?expirada=1');
  }

  socket.on('lobby:players', ({ players }) => {
    estado.players = players;
    const lista = document.getElementById('lista-jugadores');
    if (lista) actualizarListaJugadores();
  });

  socket.on('question:started', (q) => renderPregunta(q, { answeredCount: 0, playerCount: estado.players.filter((p) => p.connected).length }));
  socket.on('question:progress', (p) => actualizarProgreso(p));
  socket.on('question:ended', (r) => renderResultados(estado.question, r));
  socket.on('game:finished', (f) => renderFinal(f));
  socket.on('game:closed', ({ reason }) => {
    sessionStorage.removeItem(CLAVE);
    renderError(reason);
  });

  function aplicarEstado(s) {
    estado.pin = s.pin;
    estado.title = s.title;
    estado.total = s.total;
    estado.players = s.players || [];
    info.textContent = `${s.title} · PIN ${s.pin}`;
    if (s.phase === 'lobby') renderSala();
    else if (s.phase === 'question') renderPregunta(s.question, s.progress);
    else if (s.phase === 'results') renderResultados(s.question, s.results);
    else if (s.phase === 'finished') renderFinal(s.final);
  }

  // ---------- Acciones ----------

  async function accion(evento, datos) {
    if (ocupado) return null;
    ocupado = true;
    const res = await pedir(socket, evento, datos);
    ocupado = false;
    if (!res.ok) aviso(res.error);
    return res;
  }

  async function cerrarPartida() {
    if (!confirm('¿Cerrar la partida para todos los jugadores?')) return;
    const res = await accion('host:end');
    if (res && res.ok) {
      sessionStorage.removeItem(CLAVE);
      location.href = 'panel.html';
    }
  }

  // ---------- Vistas ----------

  function limpiar() {
    detenerReloj();
    detenerReloj = () => {};
    escenario.replaceChildren();
  }

  /** Agrega nodos al escenario ignorando los nulos (bloques condicionales). */
  function poner(...nodos) {
    escenario.append(...nodos.filter(Boolean));
  }

  function urlUnirse() {
    return `${location.origin}/IngresarPin.html?pin=${estado.pin}`;
  }

  function renderSala() {
    limpiar();
    const botonComenzar = h('button', { id: 'comenzar', type: 'button', class: 'boton grande', onclick: () => accion('host:next') }, 'Comenzar');
    poner(
      h('p', { style: 'text-align:center; margin:0; font-size:1.3rem' },
        'Entra a ', h('strong', null, `${location.host}`), ' → Jugador, y usa el PIN:'),
      h('div', { class: 'pin-grande' }, estado.pin),
      h('div', { class: 'fila centro' },
        h('button', {
          type: 'button',
          class: 'boton secundario pequeno',
          onclick: async () => {
            try { await navigator.clipboard.writeText(urlUnirse()); aviso('Enlace copiado', 'exito'); }
            catch { prompt('Copia este enlace:', urlUnirse()); }
          },
        }, 'Copiar enlace para unirse')
      ),
      h('h2', { id: 'cuenta', style: 'text-align:center; font-size:1.8rem' }),
      h('div', { id: 'lista-jugadores', class: 'chips' }),
      h('div', { class: 'fila centro' },
        h('button', { type: 'button', class: 'boton peligro', onclick: cerrarPartida }, 'Cancelar'),
        botonComenzar
      )
    );
    actualizarListaJugadores();
  }

  function actualizarListaJugadores() {
    const lista = document.getElementById('lista-jugadores');
    const cuenta = document.getElementById('cuenta');
    const boton = document.getElementById('comenzar');
    const n = estado.players.length;
    cuenta.textContent = n === 0 ? 'Esperando jugadores…' : `${n} ${n === 1 ? 'jugador' : 'jugadores'}`;
    boton.disabled = n === 0;
    lista.replaceChildren(
      ...estado.players.map((p) =>
        h('span', { class: `chip${p.connected ? '' : ' desconectado'}` },
          p.nickname,
          h('button', {
            type: 'button',
            'aria-label': `Expulsar a ${p.nickname}`,
            title: 'Expulsar',
            onclick: () => accion('host:kick', { playerId: p.id }),
          }, '×')
        )
      )
    );
  }

  function opcionesVista(q, correctIndex) {
    return h('div', { class: 'opciones-juego' },
      q.options.map((texto, i) => {
        const clases = ['opcion', `op${i}`];
        if (correctIndex !== undefined) clases.push(i === correctIndex ? 'correcta' : 'atenuada');
        return h('div', { class: clases.join(' '), 'aria-label': `${NOMBRES_FORMA[i]}: ${texto}` },
          forma(i),
          h('span', null, texto),
          correctIndex === i ? h('span', { class: 'marca-correcta', 'aria-label': 'Correcta' }, '✔') : null
        );
      })
    );
  }

  function renderPregunta(q, progreso) {
    limpiar();
    estado.question = q;
    const reloj = h('div', { class: 'contador' });
    const barra = h('div', { style: 'width:100%' });
    poner(
      h('div', { class: 'fila entre' },
        h('span', { class: 'titulo', style: 'font-size:1.6rem' }, `Pregunta ${q.index + 1} de ${q.total}`),
        h('span', { id: 'progreso', class: 'titulo', style: 'font-size:1.4rem' }),
        reloj
      ),
      h('div', { class: 'barra-tiempo' }, barra),
      h('div', { class: 'enunciado' }, q.text),
      opcionesVista(q),
      h('div', { class: 'fila entre' },
        h('button', { type: 'button', class: 'boton peligro pequeno', onclick: cerrarPartida }, 'Terminar partida'),
        h('button', { type: 'button', class: 'boton secundario', onclick: () => accion('host:skip') }, 'Saltar ⏭')
      )
    );
    actualizarProgreso(progreso);
    detenerReloj = cuentaRegresiva(q.timeLimit * 1000, q.remainingMs, (seg, fraccion) => {
      reloj.textContent = seg;
      reloj.classList.toggle('urgente', seg <= 5);
      barra.style.width = `${fraccion * 100}%`;
    });
  }

  function actualizarProgreso(p) {
    const el = document.getElementById('progreso');
    if (el && p) el.textContent = `${p.answeredCount}/${p.playerCount} respuestas`;
  }

  function renderResultados(q, r) {
    limpiar();
    const max = Math.max(1, ...r.distribution);
    const esUltima = r.isLast;
    poner(
      h('div', { class: 'fila entre' },
        h('span', { class: 'titulo', style: 'font-size:1.6rem' }, `Pregunta ${r.index + 1} de ${r.total}`),
        h('span', { class: 'titulo', style: 'font-size:1.4rem' }, `${r.answeredCount} respuestas`)
      ),
      q ? h('div', { class: 'enunciado' }, q.text) : null,
      h('div', { class: 'distribucion', style: `--n:${r.distribution.length}`, role: 'img', 'aria-label': 'Respuestas por opción' },
        r.distribution.map((n, i) =>
          h('div', { class: 'columna' },
            h('span', { class: 'valor' }, n),
            h('div', { class: 'barra-col', style: `height:${(n / max) * 75}%; background:var(--op${i})` }),
            (() => { const f = forma(i); f.classList.add(`color-op${i}`); return f; })()
          )
        )
      ),
      q ? opcionesVista(q, r.correctIndex) : null,
      h('h2', { style: 'font-size:1.8rem' }, 'Clasificación'),
      tablaRanking(r.leaderboard.slice(0, 5)),
      h('div', { class: 'fila entre' },
        h('button', { type: 'button', class: 'boton peligro pequeno', onclick: cerrarPartida }, 'Terminar partida'),
        h('button', { type: 'button', class: 'boton grande', onclick: () => accion('host:next') }, esUltima ? 'Ver podio 🏆' : 'Siguiente →')
      )
    );
  }

  function tablaRanking(entradas) {
    if (entradas.length === 0) return h('p', { class: 'muted' }, 'Sin jugadores.');
    return h('ol', { class: 'ranking' },
      entradas.map((e) =>
        h('li', null,
          h('span', { class: 'puesto' }, e.rank),
          h('span', { class: 'nombre' }, e.nickname),
          h('span', { class: 'puntos' }, `${e.score} pts`)
        )
      )
    );
  }

  function renderFinal(f) {
    limpiar();
    sessionStorage.removeItem(CLAVE);
    const top = f.leaderboard.slice(0, 3);
    const medallas = ['🥇', '🥈', '🥉'];
    poner(
      h('h1', { style: 'font-size:clamp(2.4rem,7vw,4rem); text-align:center' }, '¡Podio!'),
      h('div', { class: 'podio', style: `--n:${Math.max(top.length, 1)}` },
        top.map((e, i) =>
          h('div', { class: `escalon p${i + 1}` },
            h('span', { class: 'lugar' }, medallas[i]),
            h('span', { class: 'nombre' }, e.nickname),
            h('span', { class: 'titulo' }, `${e.score} pts`)
          )
        )
      ),
      f.leaderboard.length > 3 ? h('h2', { style: 'font-size:1.6rem' }, 'Clasificación completa') : null,
      f.leaderboard.length > 3 ? tablaRanking(f.leaderboard) : null,
      h('div', { class: 'fila centro' },
        h('a', { class: 'boton', href: 'panel.html' }, 'Volver a mis quizzes')
      )
    );
  }

  function renderError(texto) {
    limpiar();
    info.textContent = '';
    poner(
      h('h1', { style: 'font-size:2.4rem; text-align:center' }, 'Partida no disponible'),
      h('p', { style: 'text-align:center; font-size:1.2rem' }, texto || ''),
      h('div', { class: 'fila centro' }, h('a', { class: 'boton', href: 'panel.html' }, 'Volver a mis quizzes'))
    );
  }
})();
