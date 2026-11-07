/* Utilidades compartidas por todas las páginas de Kahahara. */
(function () {
  'use strict';

  const TOKEN_KEY = 'kahahara.token';

  /** Crea un elemento DOM. Los textos se insertan con textContent (sin riesgo de XSS). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // Formas de las opciones (SVG constantes, propios del proyecto).
  const FORMAS = [
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 23 21H1z"/></svg>',
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5"/></svg>',
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="2"/></svg>',
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 1.5 3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.6l-6.4 3.5L7 14l-5.3-5 7.2-.9z"/></svg>',
  ];
  const NOMBRES_FORMA = ['Triángulo', 'Círculo', 'Cuadrado', 'Estrella'];

  function forma(i) {
    const span = h('span', { class: 'forma' });
    span.innerHTML = FORMAS[i % FORMAS.length];
    return span;
  }

  // ---------- Sesión de administrador ----------

  const sesion = {
    token: () => localStorage.getItem(TOKEN_KEY),
    guardar: (t) => localStorage.setItem(TOKEN_KEY, t),
    borrar: () => localStorage.removeItem(TOKEN_KEY),
    exigir() {
      const t = this.token();
      if (!t) {
        location.replace('administrador.html');
        throw new Error('Sin sesión');
      }
      return t;
    },
  };

  class ApiError extends Error {
    constructor(status, body) {
      super(body?.error || `Error ${status}`);
      this.status = status;
      this.details = body?.details || [];
    }
  }

  async function api(path, { method = 'GET', body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && sesion.token()) headers.Authorization = `Bearer ${sesion.token()}`;
    let res;
    try {
      res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, { error: 'No se pudo contactar al servidor' });
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 401 && auth && sesion.token()) {
      sesion.borrar();
      location.replace('administrador.html?expirada=1');
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  // ---------- Mensajes ----------

  /** Muestra un mensaje dentro de un contenedor (o vacía el contenedor si texto es null). */
  function mostrarMensaje(contenedor, texto, tipo = 'error', detalles = []) {
    contenedor.replaceChildren();
    if (!texto) {
      contenedor.hidden = true;
      return;
    }
    contenedor.hidden = false;
    contenedor.className = `mensaje ${tipo}`;
    contenedor.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
    contenedor.append(texto);
    if (detalles.length) contenedor.append(h('ul', null, detalles.map((d) => h('li', null, d))));
  }

  let avisoTimer = null;
  function aviso(texto, tipo = 'error') {
    let el = document.getElementById('aviso-global');
    if (!el) {
      el = h('div', { id: 'aviso-global', class: 'mensaje aviso', role: 'status' });
      document.body.append(el);
    }
    el.className = `mensaje aviso ${tipo}`;
    el.textContent = texto;
    el.hidden = false;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ---------- Socket.IO ----------

  /** Conecta a Socket.IO y muestra un indicador cuando se pierde la conexión. */
  function conectar({ token } = {}) {
    const socket = window.io({ auth: token ? { token } : {} });
    const indicador = h('div', { class: 'estado-conexion', role: 'status', hidden: true }, 'Reconectando…');
    document.body.append(indicador);
    socket.on('disconnect', () => { indicador.hidden = false; });
    socket.on('connect', () => { indicador.hidden = true; });
    return socket;
  }

  /** emit con acuse como promesa. */
  function pedir(socket, evento, datos) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(evento, datos, (err, res) => {
        if (err) resolve({ ok: false, error: 'El servidor no respondió' });
        else resolve(res);
      });
    });
  }

  /** Cuenta regresiva basada en una hora de fin; llama a cada(segundosRestantes, fraccion). */
  function cuentaRegresiva(totalMs, restanteMs, cada) {
    const fin = Date.now() + restanteMs;
    let id = null;
    const tick = () => {
      const quedan = Math.max(fin - Date.now(), 0);
      cada(Math.ceil(quedan / 1000), totalMs ? quedan / totalMs : 0);
      if (quedan <= 0) clearInterval(id);
    };
    tick();
    id = setInterval(tick, 200);
    return () => clearInterval(id);
  }

  function parametro(nombre) {
    return new URLSearchParams(location.search).get(nombre);
  }

  window.K = { h, forma, NOMBRES_FORMA, sesion, api, ApiError, mostrarMensaje, aviso, conectar, pedir, cuentaRegresiva, parametro };
})();
