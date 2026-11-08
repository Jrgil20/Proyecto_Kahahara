/* Pantalla del jugador: PIN → apodo → sala de espera → preguntas → resultado final. */
(function () {
  'use strict';
  const { h, forma, NOMBRES_FORMA, api, mostrarMensaje, aviso, conectar, pedir, cuentaRegresiva, parametro } = window.K;

  const CLAVE = 'kahahara.jugador';
  const $ = (id) => document.getElementById(id);

  const vistas = { pin: $('vista-pin'), apodo: $('vista-apodo'), juego: $('vista-juego') };
  const area = $('area-juego');

  let socket = null;
  let pinActual = null;
  let detenerReloj = () => {};

  // ---------- Sesión local del jugador ----------

  function leerSesion() {
    try { return JSON.parse(sessionStorage.getItem(CLAVE)); } catch { return null; }
  }
  function guardarSesion(datos) { sessionStorage.setItem(CLAVE, JSON.stringify(datos)); }
  function borrarSesion() { sessionStorage.removeItem(CLAVE); }

  function mostrarVista(nombre) {
    for (const [clave, el] of Object.entries(vistas)) el.hidden = clave !== nombre;
  }

  function actualizarPie(nickname, score) {
    if (nickname !== undefined) $('pie-apodo').textContent = nickname;
    if (score !== undefined) $('pie-puntos').textContent = `${score} pts`;
  }

  // ---------- Paso 1: PIN ----------

  $('form-pin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('pin').value.trim();
    const msg = $('mensaje-pin');
    if (!/^\d{6}$/.test(pin)) {
      mostrarMensaje(msg, 'El PIN tiene 6 dígitos.');
      return;
    }
    try {
      const info = await api(`/games/${pin}`, { auth: false });
      if (info.phase !== 'lobby') {
        mostrarMensaje(msg, 'Esa partida ya comenzó.');
        return;
      }
      mostrarMensaje(msg, null);
      pinActual = pin;
      $('titulo-partida').textContent = info.title;
      mostrarVista('apodo');
      $('apodo').focus();
    } catch (err) {
      mostrarMensaje(msg, err.status === 404 ? 'No existe una partida con ese PIN.' : err.message);
    }
  });

  $('pin').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });

  $('volver-pin').addEventListener('click', () => {
    mostrarVista('pin');
    $('pin').focus();
  });

  // ---------- Paso 2: apodo ----------

  $('form-apodo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nickname = $('apodo').value.trim();
    const msg = $('mensaje-apodo');
    if (!nickname) {
      mostrarMensaje(msg, 'Escribe un apodo.');
      return;
    }
    const boton = e.submitter || $('form-apodo').querySelector('[type=submit]');
    boton.disabled = true;
    asegurarSocket();
    const res = await pedir(socket, 'player:join', { pin: pinActual, nickname });
    boton.disabled = false;
    if (!res.ok) {
      mostrarMensaje(msg, res.error);
      if (res.code === 'PIN_INVALIDO' || res.code === 'PARTIDA_INICIADA') {
        setTimeout(() => mostrarVista('pin'), 1500);
      }
      return;
    }
    mostrarMensaje(msg, null);
    guardarSesion({ pin: pinActual, playerId: res.playerId });
    actualizarPie(res.nickname, 0);
    mostrarVista('juego');
    renderEspera(res.title);
  });

  // ---------- Socket ----------

  function asegurarSocket() {
    if (socket) return socket;
    socket = conectar();

    // Cada (re)conexión crea un socket nuevo en el servidor: hay que volver a unirse.
    socket.on('connect', async () => {
      const s = leerSesion();
      if (!s) return;
      const res = await pedir(socket, 'player:rejoin', s);
      if (!res.ok) {
        borrarSesion();
        renderCerrada(res.error);
        return;
      }
      actualizarPie(res.nickname);
      mostrarVista('juego');
      aplicarEstado(res.title, res.state);
    });

    socket.on('lobby:count', ({ count }) => {
      const el = $('cuenta-jugadores');
      if (el) el.textContent = textoJugadores(count);
    });
    socket.on('question:started', (q) => renderPregunta(q, false));
    socket.on('question:result', (r) => renderResultado(r));
    socket.on('game:finished', (f) => renderFinal(f));
    socket.on('game:closed', ({ reason }) => {
      borrarSesion();
      renderCerrada(reason);
    });
    socket.on('player:kicked', () => {
      borrarSesion();
      renderCerrada('El anfitrión te sacó de la partida.');
    });
    return socket;
  }

  function aplicarEstado(titulo, state) {
    if (state.phase === 'lobby') renderEspera(titulo, state.playerCount);
    else if (state.phase === 'question') renderPregunta(state.question, state.answered);
    else if (state.phase === 'results') renderResultado(state.result);
    else if (state.phase === 'finished') renderFinal(state.final);
  }

  // ---------- Vistas del juego ----------

  function textoJugadores(n) {
    return n === 1 ? '1 jugador conectado' : `${n} jugadores conectados`;
  }

  function limpiar() {
    detenerReloj();
    detenerReloj = () => {};
    area.replaceChildren();
  }

  function renderEspera(titulo, count) {
    limpiar();
    area.append(
      h('div', { class: 'resultado neutro' },
        h('div', { class: 'grande' }, '¡Estás dentro!'),
        h('div', { class: 'mediano' }, titulo || ''),
        h('div', { class: 'girador', role: 'img', 'aria-label': 'Esperando' }),
        h('p', { class: 'muted', style: 'margin:0' }, 'Espera a que el anfitrión inicie la partida.'),
        h('p', { id: 'cuenta-jugadores', class: 'muted', style: 'margin:0' }, count ? textoJugadores(count) : '')
      )
    );
  }

  function renderEnviada(texto) {
    limpiar();
    area.append(
      h('div', { class: 'resultado neutro' },
        h('div', { class: 'grande' }, texto),
        h('div', { class: 'girador', role: 'img', 'aria-label': 'Esperando' }),
        h('p', { class: 'muted', style: 'margin:0' }, 'Esperando a los demás jugadores…')
      )
    );
  }

  function renderPregunta(q, yaRespondio) {
    if (yaRespondio) {
      renderEnviada('¡Respuesta enviada!');
      return;
    }
    limpiar();
    const reloj = h('div', { class: 'contador', 'aria-live': 'off' });
    const botones = q.options.map((texto, i) =>
      h('button', {
        type: 'button',
        class: `opcion op${i}`,
        'aria-label': `${NOMBRES_FORMA[i]}: ${texto}`,
        onclick: () => responder(i, botones),
      }, forma(i), h('span', null, texto))
    );
    area.append(
      h('div', { class: 'fila entre' },
        h('span', { class: 'titulo', style: 'font-size:1.5rem' }, `Pregunta ${q.index + 1} de ${q.total}`),
        reloj
      ),
      h('div', { class: 'enunciado', style: 'font-size:clamp(1.2rem,3.5vw,2rem)' }, q.text),
      h('div', { class: 'opciones-juego' }, botones)
    );
    detenerReloj = cuentaRegresiva(q.timeLimit * 1000, q.remainingMs, (seg) => {
      reloj.textContent = seg;
      reloj.classList.toggle('urgente', seg <= 5);
      if (seg === 0) botones.forEach((b) => { b.disabled = true; });
    });
  }

  async function responder(indice, botones) {
    botones.forEach((b, i) => {
      b.disabled = true;
      b.classList.toggle('elegida', i === indice);
      b.classList.toggle('atenuada', i !== indice);
    });
    const res = await pedir(socket, 'player:answer', { optionIndex: indice });
    if (res.ok || res.code === 'YA_RESPONDIO') {
      // Puede que el resultado ya haya llegado (último en responder): no lo tapes.
      if (botones[0].isConnected) renderEnviada('¡Respuesta enviada!');
      return;
    }
    if (res.code === 'FUERA_DE_TIEMPO') {
      if (botones[0].isConnected) renderEnviada('¡Se acabó el tiempo!');
      return;
    }
    aviso(res.error);
    botones.forEach((b) => { b.disabled = false; b.classList.remove('elegida', 'atenuada'); });
  }

  function renderResultado(r) {
    limpiar();
    actualizarPie(undefined, r.score);
    let clase = 'neutro';
    let titular = 'Sin respuesta';
    if (r.answered) {
      clase = r.correct ? 'bien' : 'mal';
      titular = r.correct ? '¡Correcto!' : 'Incorrecto';
    }
    area.append(
      h('div', { class: `resultado ${clase}`, role: 'status' },
        h('div', { class: 'grande' }, titular),
        r.correct ? h('div', { class: 'mediano' }, `+${r.points} puntos`) : null,
        r.correct && r.streak > 1 ? h('div', null, `🔥 Racha de ${r.streak}`) : null,
        r.rank ? h('div', { class: 'mediano' }, `Vas en el puesto ${r.rank}`) : null,
        h('p', { style: 'margin:0' }, r.isLast ? 'Era la última pregunta.' : 'Mira la pantalla del anfitrión.')
      )
    );
  }

  function renderFinal(f) {
    limpiar();
    actualizarPie(undefined, f.score);
    const medalla = { 1: '🥇', 2: '🥈', 3: '🥉' }[f.rank] || '';
    area.append(
      h('div', { class: 'resultado neutro' },
        h('div', { class: 'grande' }, f.rank ? `${medalla} Puesto ${f.rank}` : 'Partida terminada'),
        h('div', { class: 'mediano' }, `${f.score} puntos · ${f.playerCount} jugadores`),
        h('ol', { class: 'ranking', style: 'width:100%; max-width:420px' },
          f.podium.map((p) =>
            h('li', null,
              h('span', { class: 'puesto' }, p.rank),
              h('span', { class: 'nombre' }, p.nickname),
              h('span', { class: 'puntos' }, p.score)
            )
          )
        ),
        h('button', { type: 'button', class: 'boton', onclick: jugarOtraVez }, 'Jugar otra vez')
      )
    );
    borrarSesion();
  }

  function renderCerrada(motivo) {
    limpiar();
    mostrarVista('juego');
    area.append(
      h('div', { class: 'resultado neutro' },
        h('div', { class: 'grande' }, 'Partida cerrada'),
        h('p', { class: 'mediano', style: 'margin:0' }, motivo || ''),
        h('button', { type: 'button', class: 'boton', onclick: jugarOtraVez }, 'Volver al inicio')
      )
    );
  }

  function jugarOtraVez() {
    borrarSesion();
    location.href = 'IngresarPin.html';
  }

  // ---------- Inicio ----------

  const pinUrl = parametro('pin');
  if (pinUrl && /^\d{6}$/.test(pinUrl)) $('pin').value = pinUrl;

  if (leerSesion()) {
    // Recarga de la página en medio de una partida: volver a unirse.
    mostrarVista('juego');
    renderEnviada('Reconectando…');
    asegurarSocket();
  } else {
    mostrarVista('pin');
  }
})();
