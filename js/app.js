'use strict';

/* =============================================================
   Calculadora de Temperatura — js/app.js
   -------------------------------------------------------------
   Índice
   1. Escalas y conversiones
   2. Utilidades (formato y almacenamiento)
   3. Interfaz: convertidor, termómetro y referencias
   4. Historial (LocalStorage)
   5. Barra de título (Window Controls Overlay)
   6. PWA: service worker, instalación y conexión
   7. Arranque
   ============================================================= */

const APP_VERSION = '2.2.0';

/* ---------- 1. Escalas y conversiones ---------- */

/**
 * Cada escala sabe convertirse a Celsius (aC) y desde Celsius (deC).
 * Todas las conversiones pasan por Celsius: valor → °C → destino.
 */
const ESCALAS = {
  C: { nombre: 'Celsius',    simbolo: '°C', aC: (v) => v,                  deC: (c) => c },
  F: { nombre: 'Fahrenheit', simbolo: '°F', aC: (v) => ((v - 32) * 5) / 9, deC: (c) => (c * 9) / 5 + 32 },
  K: { nombre: 'Kelvin',     simbolo: 'K',  aC: (v) => v - 273.15,         deC: (c) => c + 273.15 },
};

/** Cero absoluto en Celsius: ninguna temperatura puede ser menor. */
const CERO_ABSOLUTO_C = -273.15;

/** Fórmula de cada par de escalas (con «x» como el valor de entrada). */
const FORMULAS = {
  'C>F': '°F = x × 9/5 + 32',
  'F>C': '°C = (x − 32) × 5/9',
  'C>K': 'K = x + 273.15',
  'K>C': '°C = x − 273.15',
  'F>K': 'K = (x − 32) × 5/9 + 273.15',
  'K>F': '°F = (x − 273.15) × 9/5 + 32',
};

/** Sensación según la temperatura en °C (el primer límite que no se supera). */
const SENSACIONES = [
  [-20, 'Congelante'],
  [0, 'Bajo cero'],
  [12, 'Frío'],
  [20, 'Fresco'],
  [26, 'Agradable'],
  [32, 'Cálido'],
  [40, 'Caluroso'],
  [100, 'Muy caliente'],
  [Infinity, 'Hirviendo'],
];

function convertir(valor, de, a) {
  return ESCALAS[a].deC(ESCALAS[de].aC(valor));
}

/* ---------- 2. Utilidades ---------- */

const formato = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });

/** Número con hasta 2 decimales; evita mostrar «-0». */
function fmt(n) {
  const redondeado = Math.round(n * 100) / 100;
  return formato.format(Object.is(redondeado, -0) ? 0 : redondeado);
}

function conUnidad(n, escala) {
  return `${fmt(n)} ${ESCALAS[escala].simbolo}`;
}

/**
 * Lo único que se puede escribir en el campo: un signo menos opcional al inicio,
 * dígitos y un solo separador decimal (punto o coma). También acepta estados
 * incompletos mientras se escribe, como «-», «.» o «12.».
 */
const PATRON_ENTRADA = /^-?\d*(?:[.,]\d*)?$/;

/** Lee un número escrito por el usuario (acepta coma decimal y signo menos tipográfico). */
function leerNumero(texto) {
  const limpio = String(texto).trim().replace(',', '.').replace('−', '-');
  if (limpio === '' || limpio === '-') return NaN;
  return /^-?\d*\.?\d+$|^-?\d+\.$/.test(limpio) ? parseFloat(limpio) : NaN;
}

const almacen = {
  leer(clave, porDefecto) {
    try {
      const crudo = localStorage.getItem(clave);
      return crudo ? JSON.parse(crudo) : porDefecto;
    } catch {
      return porDefecto;
    }
  },
  guardar(clave, valor) {
    try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* sin acceso */ }
  },
};

const CLAVES = { estado: 'temperatura:estado:v1', historial: 'temperatura:historial:v1' };
const HISTORIAL_MAX = 12;

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function debounce(func, espera) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), espera);
  };
}

/* ---------- 3. Interfaz ---------- */

const ui = {};
// ultDe / ultA: escalas del último cálculo (para saber cuál era la anterior)
// ultimoValido: último texto aceptado en el campo (para deshacer lo que no sea número)
const estado = { conversion: null, ultDe: 'C', ultA: 'F', ultimoValido: '' };
const horaWidget = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' });

function datosWidgetTemperatura() {
  const c = estado.conversion;
  if (!c) return null;
  const celsius = ESCALAS[c.de].aC(c.valor);
  const sensacion = SENSACIONES.find(([limite]) => celsius < limite)[1];
  const formula = c.de === c.a
    ? 'Misma unidad: el valor no cambia'
    : FORMULAS[`${c.de}>${c.a}`].replace('x', fmt(c.valor));
  return {
    inputValue: fmt(c.valor),
    inputUnit: ESCALAS[c.de].simbolo,
    resultValue: fmt(c.resultado),
    resultUnit: ESCALAS[c.a].simbolo,
    sensation: sensacion,
    formula,
    updatedAt: horaWidget.format(new Date()),
  };
}

function sincronizarWidgetTemperatura(worker = navigator.serviceWorker?.controller) {
  const payload = datosWidgetTemperatura();
  if (!worker || !payload) return;
  worker.postMessage({ type: 'UPDATE_TEMPERATURE_WIDGET', payload });
}

const sincronizarWidgetDiferido = debounce(sincronizarWidgetTemperatura, 300);

function tomarElementos() {
  const ids = [
    'valor', 'unidadEntrada', 'error', 'resultado', 'formula', 'btnIntercambiar',
    'btnCopiar', 'btnGuardar', 'sensacion', 'marca', 'todas', 'referencias', 'historial', 'lista',
    'vacio', 'btnBorrarHist', 'toast', 'toastTexto', 'toastAccion',
    'aviso', 'barra', 'version',
  ];
  for (const id of ids) ui[id] = document.getElementById(id);
}

const escalaDe = () => document.querySelector('input[name="de"]:checked').value;
const escalaA = () => document.querySelector('input[name="a"]:checked').value;

function marcar(grupo, escala) {
  document.querySelector(`input[name="${grupo}"][value="${escala}"]`).checked = true;
}

/* --- Validación: solo números --- */

let rechazoTimer = 0;
/** Deshace lo último que se escribió y avisa con una sacudida y un mensaje. */
function rechazarEntrada() {
  const caret = ui.valor.selectionStart - (ui.valor.value.length - estado.ultimoValido.length);
  ui.valor.value = estado.ultimoValido;
  const pos = Math.max(0, Math.min(caret, ui.valor.value.length));
  ui.valor.setSelectionRange(pos, pos);

  const caja = ui.valor.closest('.entrada');
  caja.classList.remove('rechazo');
  void caja.offsetWidth; // reinicia la animación
  caja.classList.add('rechazo');
  ui.error.textContent = 'Solo puedes escribir números, un signo «-» al inicio y un punto decimal.';
  clearTimeout(rechazoTimer);
  rechazoTimer = setTimeout(() => actualizar(), 2500);
}

function alEscribir() {
  const texto = ui.valor.value.replace('−', '-').replace(/\s+/g, '');
  if (!PATRON_ENTRADA.test(texto)) {
    rechazarEntrada();
    return;
  }
  if (texto !== ui.valor.value) ui.valor.value = texto;
  clearTimeout(rechazoTimer);
  actualizar();
  guardarEstadoDiferido();
}

/** Flechas ↑ / ↓ suman o restan 1 (con Shift, 10). */
function alPresionarTecla(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const actual = leerNumero(ui.valor.value);
  const paso = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
  const nuevo = Math.round(((Number.isFinite(actual) ? actual : 0) + paso) * 100) / 100;
  ui.valor.value = String(nuevo);
  actualizar();
  guardarEstadoDiferido();
}

/** Al salir del campo, se limpian los estados incompletos («-», «.», «12.»). */
function alSalir() {
  const v = leerNumero(ui.valor.value);
  const normal = Number.isFinite(v) ? String(v) : '';
  if (normal !== ui.valor.value) {
    ui.valor.value = normal;
    actualizar();
    guardarEstado();
  }
}

/** Recalcula y pinta todo a partir del valor y las escalas elegidas. */
function actualizar({ animar = false } = {}) {
  const de = escalaDe();
  const a = escalaA();
  const valor = leerNumero(ui.valor.value);
  estado.ultDe = de;
  estado.ultA = a;
  estado.ultimoValido = ui.valor.value;
  ui.unidadEntrada.textContent = ESCALAS[de].simbolo;

  // El campo solo acepta números, así que un valor no legible es uno incompleto («-», «.»): sin error
  let error = '';
  if (Number.isFinite(valor) && ESCALAS[de].aC(valor) < CERO_ABSOLUTO_C - 1e-9) {
    error = `No existe una temperatura menor que el cero absoluto (${conUnidad(ESCALAS[de].deC(CERO_ABSOLUTO_C), de)}).`;
  }
  ui.error.textContent = error;
  ui.valor.closest('.entrada').classList.toggle('invalida', !!error);
  ui.valor.setAttribute('aria-invalid', String(!!error));

  if (error || !Number.isFinite(valor)) {
    estado.conversion = null;
    ui.resultado.textContent = '—';
    ui.formula.textContent = de === a ? '' : FORMULAS[`${de}>${a}`];
    ui.sensacion.textContent = '—';
    ui.todas.innerHTML = '';
    return;
  }

  const celsius = ESCALAS[de].aC(valor);
  const resultado = convertir(valor, de, a);
  estado.conversion = { valor, de, a, resultado };

  ui.resultado.textContent = conUnidad(resultado, a);
  if (animar && !reduceMotion()) {
    ui.resultado.classList.remove('cambio');
    void ui.resultado.offsetWidth; // reinicia la animación
    ui.resultado.classList.add('cambio');
  }

  ui.formula.textContent = de === a
    ? 'Misma unidad: el valor no cambia.'
    : `${FORMULAS[`${de}>${a}`].replace('x', fmt(valor))} = ${fmt(resultado)}`;

  // Las tres escalas a la vez
  ui.todas.innerHTML = Object.entries(ESCALAS)
    .map(([clave, e]) => `<li><small>${e.nombre}</small><b>${conUnidad(e.deC(celsius), clave)}</b></li>`)
    .join('');

  // Termómetro (de -40 °C a 120 °C) y color del fondo
  const pos = Math.min(1, Math.max(0, (celsius + 40) / 160));
  ui.marca.style.setProperty('--pos', `${pos * 100}%`);
  ui.sensacion.textContent = SENSACIONES.find(([limite]) => celsius < limite)[1];
  const calor = Math.min(1, Math.max(0, (celsius + 20) / 80));
  document.documentElement.style.setProperty('--calor', calor.toFixed(3));
  sincronizarWidgetDiferido();
}

function guardarEstado() {
  almacen.guardar(CLAVES.estado, { valor: ui.valor.value, de: escalaDe(), a: escalaA() });
}
const guardarEstadoDiferido = debounce(guardarEstado, 250);

/** Cambia la escala de un grupo; si queda igual a la del otro, el otro toma la anterior. */
function alCambiarEscala(grupo) {
  const anterior = grupo === 'de' ? estado.ultDe : estado.ultA;
  const otro = grupo === 'de' ? 'a' : 'de';
  const nueva = grupo === 'de' ? escalaDe() : escalaA();
  const delOtro = otro === 'de' ? escalaDe() : escalaA();
  if (nueva === delOtro) marcar(otro, anterior);
  actualizar({ animar: true });
  guardarEstado();
}

function intercambiar() {
  const de = escalaDe();
  const a = escalaA();
  // El resultado actual pasa a ser el valor de entrada
  if (estado.conversion) ui.valor.value = String(Math.round(estado.conversion.resultado * 100) / 100);
  marcar('de', a);
  marcar('a', de);
  actualizar({ animar: true });
  guardarEstado();
}

function limpiar() {
  ui.valor.value = '';
  actualizar();
  guardarEstado();
  ui.valor.focus();
}

function cargarReferencia(celsius) {
  ui.valor.value = String(Math.round(ESCALAS[escalaDe()].deC(celsius) * 100) / 100);
  actualizar({ animar: true });
  guardarEstado();
}

async function copiar() {
  const c = estado.conversion;
  if (!c) {
    toast('Escribe una temperatura para poder copiarla');
    return;
  }
  const texto = `${conUnidad(c.valor, c.de)} = ${conUnidad(c.resultado, c.a)}`;
  try {
    await navigator.clipboard.writeText(texto);
    toast(`Copiado: ${texto}`);
  } catch {
    toast('No se pudo copiar al portapapeles');
  }
}

/* --- Notificación flotante --- */

let toastTimer = 0;
function toast(mensaje, { accion, alAccionar, duracion = 3000 } = {}) {
  clearTimeout(toastTimer);
  ui.toastTexto.textContent = mensaje;
  ui.toastAccion.hidden = !accion;
  ui.toastAccion.textContent = accion || '';
  ui.toastAccion.onclick = accion ? () => { ui.toast.hidden = true; alAccionar?.(); } : null;
  ui.toast.hidden = false;
  if (duracion > 0) toastTimer = setTimeout(() => { ui.toast.hidden = true; }, duracion);
}

/* ---------- 4. Historial ---------- */

const fechaFmt = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

function leerHistorial() {
  const lista = almacen.leer(CLAVES.historial, []);
  return Array.isArray(lista) ? lista : [];
}

function guardarEnHistorial() {
  const c = estado.conversion;
  if (!c) {
    toast('Escribe una temperatura para poder guardarla');
    return;
  }
  let lista = leerHistorial();
  const igual = lista[0] && lista[0].valor === c.valor && lista[0].de === c.de && lista[0].a === c.a;
  const item = { id: Date.now(), fecha: new Date().toISOString(), ...c };
  if (igual) lista[0] = item;
  else lista.unshift(item);
  lista = lista.slice(0, HISTORIAL_MAX);
  almacen.guardar(CLAVES.historial, lista);
  renderHistorial();
  toast('Guardado en el historial');
}

function renderHistorial() {
  const lista = leerHistorial();
  ui.vacio.hidden = lista.length > 0;
  ui.btnBorrarHist.hidden = lista.length === 0;
  ui.lista.innerHTML = lista
    .filter((h) => ESCALAS[h.de] && ESCALAS[h.a] && Number.isFinite(h.valor))
    .map((h) => {
      const fecha = new Date(h.fecha);
      const cuando = Number.isNaN(fecha.getTime()) ? '' : fechaFmt.format(fecha);
      const texto = `${conUnidad(h.valor, h.de)} → ${conUnidad(convertir(h.valor, h.de, h.a), h.a)}`;
      return (
        `<li><button type="button" class="lista__cargar" data-id="${h.id}"><b>${texto}</b><small>${cuando}</small></button>` +
        `<button type="button" class="lista__borrar" data-borrar="${h.id}" aria-label="Eliminar ${texto}">` +
        `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>` +
        `</button></li>`
      );
    })
    .join('');
}

function cargarDelHistorial(id) {
  const h = leerHistorial().find((x) => String(x.id) === String(id));
  if (!h) return;
  marcar('de', h.de);
  marcar('a', h.a);
  ui.valor.value = String(h.valor);
  actualizar({ animar: true });
  guardarEstado();
  window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

function borrarDelHistorial(id) {
  almacen.guardar(CLAVES.historial, leerHistorial().filter((x) => String(x.id) !== String(id)));
  renderHistorial();
}

let confirmarTimer = 0;
function borrarHistorial() {
  // Doble toque para confirmar (evita borrar por accidente)
  if (!ui.btnBorrarHist.classList.contains('confirmar')) {
    ui.btnBorrarHist.classList.add('confirmar');
    ui.btnBorrarHist.textContent = '¿Seguro? Toca otra vez';
    clearTimeout(confirmarTimer);
    confirmarTimer = setTimeout(restaurarBotonBorrar, 3500);
    return;
  }
  restaurarBotonBorrar();
  almacen.guardar(CLAVES.historial, []);
  renderHistorial();
  toast('Historial borrado');
}

function restaurarBotonBorrar() {
  clearTimeout(confirmarTimer);
  ui.btnBorrarHist.classList.remove('confirmar');
  ui.btnBorrarHist.textContent = 'Borrar todo';
}

/* ---------- 5. Barra de título (Window Controls Overlay) ----------
   Con "display_override": ["window-controls-overlay"] en el manifiesto,
   la app instalada ocupa también el área de la barra de título. La barra
   se coloca con env(titlebar-area-*) en CSS y se arrastra con app-region. */

/** Ancho (px) por debajo del cual los controles muestran solo el ícono. */
const BARRA_ANCHO_COMPACTO = 560;

const accionesBarra = {
  intercambiar,
  copiar,
  guardar: guardarEnHistorial,
  limpiar,
  historial: () => ui.historial.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }),
};

function ajustarBarra(rect) {
  const wco = navigator.windowControlsOverlay;
  const visible = !!wco && wco.visible;
  const ancho = rect?.width ?? (visible ? wco.getTitlebarAreaRect().width : window.innerWidth);
  ui.barra.classList.toggle('barra--compacta', ancho < BARRA_ANCHO_COMPACTO);
}

function iniciarBarra() {
  ui.barra.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-accion]');
    if (btn) accionesBarra[btn.dataset.accion]?.();
  });

  ajustarBarra();
  // geometrychange avisa al redimensionar o al mostrar/ocultar la barra; se limita con debounce
  if ('windowControlsOverlay' in navigator) {
    navigator.windowControlsOverlay.addEventListener('geometrychange', debounce((e) => ajustarBarra(e.titlebarAreaRect), 200));
  }
  window.addEventListener('resize', debounce(() => ajustarBarra(), 200));
}

/* ---------- 6. PWA ---------- */

function iniciarPWA() {
  const esLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol === 'file:') {
    ui.aviso.innerHTML =
      'Abriste el archivo directamente. La calculadora funciona, pero para <strong>instalarla</strong> y usarla ' +
      '<strong>sin conexión</strong> ábrela desde <code>http://localhost:8081</code> (ver README).';
    ui.aviso.hidden = false;
  } else if (!window.isSecureContext && !esLocal) {
    ui.aviso.innerHTML = 'La instalación y el modo sin conexión solo funcionan en <code>localhost</code> o con HTTPS.';
    ui.aviso.hidden = false;
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    let teniaControlador = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!teniaControlador) {
        teniaControlador = true; // primera instalación: no hace falta avisar
        sincronizarWidgetTemperatura(navigator.serviceWorker.controller);
        return;
      }
      sincronizarWidgetTemperatura(navigator.serviceWorker.controller);
      toast('Hay una nueva versión de la app', { accion: 'Recargar', alAccionar: () => location.reload(), duracion: 0 });
    });
    navigator.serviceWorker
      .register('./sw.js')
      .then(async (reg) => {
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
        const lista = await navigator.serviceWorker.ready;
        sincronizarWidgetTemperatura(navigator.serviceWorker.controller || lista.active || reg.active);
      })
      .catch((err) => console.warn('[PWA] No se pudo registrar el service worker:', err));
  }

  // La instalación la ofrece el propio navegador (ícono en la barra de direcciones)

  window.addEventListener('offline', () => toast('Sin conexión: la calculadora sigue funcionando'));
}

/* ---------- 7. Arranque ---------- */

function iniciar() {
  tomarElementos();
  ui.version.textContent = APP_VERSION;

  // Restaurar el último estado
  const guardado = almacen.leer(CLAVES.estado, null);
  if (guardado && ESCALAS[guardado.de] && ESCALAS[guardado.a] && guardado.de !== guardado.a) {
    marcar('de', guardado.de);
    marcar('a', guardado.a);
  }
  const valorGuardado = guardado && typeof guardado.valor === 'string' ? guardado.valor : '25';
  ui.valor.value = PATRON_ENTRADA.test(valorGuardado) ? valorGuardado : '25';
  actualizar();

  // Campo de temperatura (solo números)
  ui.valor.addEventListener('input', alEscribir);
  ui.valor.addEventListener('keydown', alPresionarTecla);
  ui.valor.addEventListener('blur', alSalir);

  // Selectores de escala
  for (const grupo of ['de', 'a']) {
    document.querySelectorAll(`input[name="${grupo}"]`).forEach((r) =>
      r.addEventListener('change', () => alCambiarEscala(grupo)),
    );
  }

  ui.btnIntercambiar.addEventListener('click', intercambiar);
  ui.btnCopiar.addEventListener('click', copiar);
  ui.btnGuardar.addEventListener('click', guardarEnHistorial);

  ui.referencias.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-c]');
    if (btn) cargarReferencia(parseFloat(btn.dataset.c));
  });

  ui.lista.addEventListener('click', (e) => {
    const borrar = e.target.closest('[data-borrar]');
    if (borrar) return borrarDelHistorial(borrar.dataset.borrar);
    const cargar = e.target.closest('[data-id]');
    if (cargar) cargarDelHistorial(cargar.dataset.id);
  });
  ui.btnBorrarHist.addEventListener('click', borrarHistorial);
  renderHistorial();

  iniciarBarra();
  iniciarPWA();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
else iniciar();
