/* =============================================================
   Calculadora de Temperatura — Service Worker (sw.js)
   -------------------------------------------------------------
   · Guarda los archivos de la app al instalarse.
   · Responde desde la caché (funciona sin conexión) y actualiza
     cada archivo en segundo plano ("stale-while-revalidate").
   · Al publicar cambios, sube VERSION: se borra la caché vieja y
     la app muestra el aviso "Recargar".
   ============================================================= */

const VERSION = 'v2.2.0';
const CACHE = `temperatura-${VERSION}`;
const WIDGET_TAG = 'terma-last-conversion';
const WIDGET_STATE_CACHE = 'terma-widget-state-v1';
const WIDGET_STATE_URL = new URL('./widgets/runtime-state.json', self.registration.scope).href;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './privacy.html',
  './css/estilos.css',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './widgets/widget-template.json',
  './widgets/widget-data.json',
  './widgets/widget-preview.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const claves = await caches.keys();
      await Promise.all(claves.filter((k) => k.startsWith('temperatura-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
      await actualizarWidgetInstalado();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  const actualizacion = descargarYGuardar(request);
  event.waitUntil(actualizacion.catch(() => {}));
  event.respondWith(responder(request, actualizacion));
});

async function descargarYGuardar(request) {
  const respuesta = await fetch(request, { cache: 'no-cache' });
  if (respuesta.ok && respuesta.type === 'basic') {
    const cache = await caches.open(CACHE);
    await cache.put(request, respuesta.clone());
  }
  return respuesta;
}

async function responder(request, actualizacion) {
  const cache = await caches.open(CACHE);
  const esNavegacion = request.mode === 'navigate';
  const enCache = await cache.match(request, { ignoreSearch: esNavegacion });
  if (enCache) return enCache;

  try {
    return await actualizacion;
  } catch {
    if (esNavegacion) {
      const app = (await cache.match('./index.html')) || (await cache.match('./'));
      if (app) return app;
    }
    return new Response('Sin conexión y sin copia guardada de este archivo.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/* ---------- Widget de Windows 11 ----------
   Esta API solo existe en Microsoft Edge/Windows compatibles. Las
   comprobaciones conservan el Service Worker funcional en otros sistemas. */

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'UPDATE_TEMPERATURE_WIDGET' || !event.data.payload) return;
  event.waitUntil(guardarYActualizarWidget(event.data.payload));
});

self.addEventListener('widgetinstall', (event) => {
  event.waitUntil(instalarWidget(event.widget));
});

self.addEventListener('widgetuninstall', (event) => {
  event.waitUntil(desinstalarWidget(event.widget));
});

self.addEventListener('widgetresume', (event) => {
  event.waitUntil(renderizarWidget(event.widget));
});

self.addEventListener('widgetclick', (event) => {
  if (event.action === 'open-temperature') event.waitUntil(abrirAplicacion());
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== WIDGET_TAG || !('widgets' in self)) return;
  event.waitUntil(actualizarWidgetInstalado());
});

function limpiarDatosWidget(datos) {
  const campos = ['inputValue', 'inputUnit', 'resultValue', 'resultUnit', 'sensation', 'formula', 'updatedAt'];
  return Object.fromEntries(campos.map((campo) => [campo, String(datos[campo] ?? '').slice(0, 120)]));
}

async function guardarYActualizarWidget(datos) {
  const cache = await caches.open(WIDGET_STATE_CACHE);
  await cache.put(
    WIDGET_STATE_URL,
    new Response(JSON.stringify(limpiarDatosWidget(datos)), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
  );
  await actualizarWidgetInstalado();
}

async function leerTexto(url) {
  try {
    const respuesta = await fetch(url, { cache: 'no-cache' });
    if (respuesta.ok) return respuesta.text();
  } catch {
    // Si no hay conexión, se intenta la copia precargada.
  }
  const guardado = await caches.match(url);
  if (!guardado) throw new Error(`No se pudo cargar ${url}`);
  return guardado.text();
}

async function leerDatosWidget(widget) {
  const cacheEstado = await caches.open(WIDGET_STATE_CACHE);
  const estado = await cacheEstado.match(WIDGET_STATE_URL);
  if (estado) return estado.text();
  return leerTexto(widget.definition.data);
}

async function renderizarWidget(widget) {
  if (!widget || !('widgets' in self)) return;
  const template = await leerTexto(widget.definition.msAcTemplate);
  const data = await leerDatosWidget(widget);
  await self.widgets.updateByTag(widget.definition.tag, { template, data });
}

async function actualizarWidgetInstalado() {
  if (!('widgets' in self)) return;
  const widget = await self.widgets.getByTag(WIDGET_TAG);
  if (widget) await renderizarWidget(widget);
}

async function instalarWidget(widget) {
  if (
    'periodicSync' in self.registration &&
    'update' in widget.definition
  ) {
    try {
      const etiquetas = await self.registration.periodicSync.getTags();
      if (!etiquetas.includes(widget.definition.tag)) {
        await self.registration.periodicSync.register(widget.definition.tag, {
          minInterval: widget.definition.update,
        });
      }
    } catch {
      // La sincronización periódica depende de los permisos del sistema.
    }
  }
  await renderizarWidget(widget);
}

async function desinstalarWidget(widget) {
  if (
    widget?.instances?.length === 1 &&
    'periodicSync' in self.registration &&
    'update' in widget.definition
  ) {
    try {
      await self.registration.periodicSync.unregister(widget.definition.tag);
    } catch {
      // No hay nada que limpiar si el registro ya desapareció.
    }
  }
}

async function abrirAplicacion() {
  const destino = new URL('./?source=widget', self.registration.scope).href;
  const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const abierta = ventanas.find((cliente) => cliente.url.startsWith(self.registration.scope));
  if (abierta && 'focus' in abierta) return abierta.focus();
  return self.clients.openWindow(destino);
}
