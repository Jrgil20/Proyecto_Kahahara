# Kahahara

Juego de preguntas y respuestas en tiempo real al estilo Kahoot. Un **administrador** crea quizzes y abre partidas; los **jugadores** entran desde su teléfono con un PIN de 6 dígitos, responden contra el reloj y compiten por el podio.

Stack: **Node.js + Express + Socket.IO** en el servidor y HTML/CSS/JavaScript sin frameworks en el cliente. Los quizzes se guardan en un archivo JSON, así que no hace falta base de datos.

## Requisitos

- Node.js 18 o superior

## Puesta en marcha

```bash
npm install
npm start
```

Abre <http://localhost:3000>.

| Variable         | Por defecto           | Descripción                                   |
| ---------------- | --------------------- | --------------------------------------------- |
| `PORT`           | `3000`                | Puerto HTTP                                   |
| `ADMIN_USER`     | `admin`               | Usuario del administrador                     |
| `ADMIN_PASSWORD` | `admin`               | Contraseña del administrador (**cámbiala**)   |
| `DATA_FILE`      | `data/quizzes.json`   | Archivo donde se guardan los quizzes          |

Ejemplo: `ADMIN_PASSWORD=miclave PORT=8080 npm start`

La primera vez se crea `data/quizzes.json` con dos quizzes de ejemplo (`data/quizzes.sample.json`).

Para jugar con teléfonos en la misma red Wi‑Fi, los jugadores deben abrir `http://<IP-de-tu-PC>:3000`.

## Cómo se juega

1. **Administrador** → inicia sesión → *Mis quizzes*.
2. Crea o edita un quiz: de 1 a 50 preguntas, de 2 a 4 opciones cada una, una correcta y un tiempo de 5 a 120 s.
3. Pulsa **▶ Jugar**: aparece el PIN y la sala de espera (puedes expulsar jugadores).
4. Los jugadores van a **Jugador**, escriben el PIN y su apodo.
5. **Comenzar** → cada pregunta se cierra al acabarse el tiempo, cuando todos responden o con **Saltar**.
6. Tras cada pregunta se muestran la distribución de respuestas y la clasificación; al final, el podio.

### Puntuación

- Respuesta correcta: de **1000** puntos (al instante) a **500** (al agotarse el tiempo), de forma lineal.
- Racha: +100 por cada acierto consecutivo a partir del segundo (máximo +500).
- Respuesta incorrecta o sin responder: 0 puntos y se reinicia la racha.

### Reconexión

- Si un jugador recarga la página, vuelve a la partida con su puntaje (se guarda en `sessionStorage`).
- Si el anfitrión recarga, recupera la partida en el mismo punto. Si se desconecta más de 60 s, la partida se cierra.
- Un jugador desconectado en la sala de espera sale de la lista tras 15 s.

## Estructura

```
server/
  index.js        arranque de Express + Socket.IO
  game.js         lógica pura de la partida (fases, puntos, ranking)
  gameManager.js  partidas activas por PIN y limpieza de inactivas
  sockets.js      protocolo en tiempo real (eventos host:* y player:*)
  routes.js       API REST (/api/login, /api/quizzes, /api/games/:pin)
  quizStore.js    persistencia JSON con validación y escrituras atómicas
  auth.js         sesión de administrador con token
public/
  index.html        menú principal
  administrador.html inicio de sesión
  panel.html        lista de quizzes
  editor.html       crear / editar quiz
  host.html         pantalla del anfitrión (proyector)
  IngresarPin.html  pantalla del jugador (PIN, apodo y juego)
  js/, img/, estilos.css
data/quizzes.sample.json  quizzes de ejemplo
test/             pruebas (node:test)
```

## Pruebas

```bash
npm test
```

Incluye pruebas unitarias de la lógica del juego y del almacén de quizzes, y una prueba de extremo a extremo que levanta el servidor y juega una partida completa con varios clientes Socket.IO (unión, expulsión, respuestas, reconexión de jugador y anfitrión, saltar pregunta, podio y cierre).

## Limitaciones conocidas

- Un único administrador; las sesiones viven en memoria y se pierden al reiniciar el servidor.
- Las partidas activas también viven en memoria: reiniciar el servidor las cierra.
- Pensado para un solo proceso (sin escalado horizontal).
