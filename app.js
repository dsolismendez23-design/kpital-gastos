/* K-PITAL · Gastos
 * App sin frameworks: los datos viven como archivos JSON dentro de un
 * repositorio de GitHub y se leen/escriben con la API REST de GitHub.
 * Cada dispositivo guarda su propia conexión (owner/repo/token) en localStorage.
 */
(function () {
  'use strict';

  var CONFIG_KEY = 'kpital_gh_config_v1';
  var GH_API = 'https://api.github.com';
  var POLL_MS = 20000;
  var MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  var COLLECTIONS = {
    gastos: 'data/gastos.json',
    empleados: 'data/empleados.json',
    tiempo: 'data/tiempo_laborado.json',
    otros: 'data/otros_gastos.json',
  };

  var appEl = document.getElementById('app');
  var pollTimer = null;
  var toastTimer = null;

  var state = {
    config: loadConfig(),
    data: {
      gastos: { list: [], sha: null, loaded: false },
      empleados: { list: [], sha: null, loaded: false },
      tiempo: { list: [], sha: null, loaded: false },
      otros: { list: [], sha: null, loaded: false },
    },
    syncStatus: 'idle', // idle | syncing | ok | error
    lastSync: null,
    tab: 'inicio', // inicio | gastos | costo | reportes
    costoTab: 'tiempo', // tiempo | otros
    screen: null, // null | 'form' | 'config' | 'empleado-form' | 'tiempo-form' | 'otro-form' | 'foto-form'
    editingId: null,
    formPrefill: null,
    fotoState: null, // { file, previewUrl, processing, extracted }
    search: '',
    reportTab: 'resumen', // resumen | proveedor | pagado
    period: defaultPeriod(),
    quickPeriod: 'month',
    toast: null,
    configVerifying: false,
    configError: null,
    showToken: false,
    deferredInstallPrompt: null,
  };

  // ---------- Utilidades ----------

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function toISODate(d) {
    var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function defaultPeriod() {
    var now = new Date();
    var first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { desde: toISODate(first), hasta: toISODate(now) };
  }

  function formatMoneyNumber(n) {
    var v = Number(n || 0);
    var sign = v < 0 ? '-' : '';
    var fixed = Math.abs(v).toFixed(2);
    var parts = fixed.split('.');
    var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return sign + intPart + ',' + parts[1];
  }
  function formatMoney(n) { return '₡' + formatMoneyNumber(n); }
  function formatMoneyPdf(n) { return 'CRC ' + formatMoneyNumber(n); }

  function formatDateDisplay(iso) {
    if (!iso) return '';
    var parts = iso.split('-');
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  function monthLabel(ym) {
    if (!ym || ym.indexOf('-') === -1) return ym || '—';
    var parts = ym.split('-');
    var idx = parseInt(parts[1], 10) - 1;
    return (MESES[idx] || ym) + ' ' + parts[0];
  }

  function timeAgo(date) {
    if (!date) return 'sin sincronizar';
    var s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 10) return 'ahora mismo';
    if (s < 60) return 'hace ' + s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    var h = Math.floor(m / 60);
    return 'hace ' + h + ' h';
  }

  // ---------- Config (localStorage por dispositivo) ----------

  function loadConfig() {
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function persistConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }
  function clearConfig() {
    localStorage.removeItem(CONFIG_KEY);
  }

  // ---------- Codificación UTF-8 <-> Base64 ----------

  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    bytes.forEach(function (b) { binary += String.fromCharCode(b); });
    return btoa(binary);
  }
  function base64ToUtf8(b64) {
    var binary = atob(b64.replace(/\n/g, ''));
    var bytes = Uint8Array.from(binary, function (c) { return c.charCodeAt(0); });
    return new TextDecoder().decode(bytes);
  }

  // ---------- API de GitHub (genérica por colección) ----------

  function ApiError(status, message) {
    this.status = status;
    this.message = message;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function ghRequest(cfg, path, options) {
    options = options || {};
    var headers = Object.assign({
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + cfg.token,
      'X-GitHub-Api-Version': '2022-11-28',
    }, options.headers || {});
    return fetch(GH_API + path, Object.assign({ cache: 'no-store' }, options, { headers: headers }));
  }

  function safeJson(res) {
    return res.json().catch(function () { return null; });
  }

  function fetchCollection(name) {
    var cfg = state.config;
    var path = COLLECTIONS[name];
    var url = '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
      '/contents/' + path + '?ref=' + encodeURIComponent(cfg.branch);
    return ghRequest(cfg, url).then(function (res) {
      if (res.status === 404) return { list: [], sha: null };
      if (!res.ok) {
        return safeJson(res).then(function (err) {
          throw new ApiError(res.status, (err && err.message) || ('Error ' + res.status));
        });
      }
      return res.json().then(function (json) {
        var text = base64ToUtf8(json.content);
        var list;
        try { list = JSON.parse(text); } catch (e) { list = []; }
        return { list: Array.isArray(list) ? list : [], sha: json.sha };
      });
    });
  }

  function saveCollection(name, list, sha) {
    var cfg = state.config;
    var path = COLLECTIONS[name];
    var url = '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/contents/' + path;
    var body = {
      message: 'Actualiza ' + name + ' (K-PITAL app)',
      content: utf8ToBase64(JSON.stringify(list, null, 2)),
      branch: cfg.branch,
    };
    if (sha) body.sha = sha;
    return ghRequest(cfg, url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) {
        return safeJson(res).then(function (err) {
          throw new ApiError(res.status, (err && err.message) || ('Error ' + res.status));
        });
      }
      return res.json().then(function (json) { return json.content.sha; });
    });
  }

  function friendlyError(e) {
    if (e instanceof ApiError) {
      if (e.status === 401) return 'Token inválido o vencido. Revisa la Configuración.';
      if (e.status === 404) return 'No se encontró el repositorio. Revisa la Configuración.';
      if (e.status === 403) return 'Sin permisos, o se alcanzó el límite de solicitudes. Intenta de nuevo en un momento.';
      if (e.status === 409 || e.status === 422) return 'Otro dispositivo guardó al mismo tiempo. Intenta de nuevo.';
    }
    return 'No se pudo conectar. Revisa tu conexión a internet.';
  }

  function mutateCollection(name, mutatorFn, opts) {
    opts = opts || {};
    setSyncStatus('syncing');
    var attempt = 0;
    function tryOnce() {
      attempt++;
      return fetchCollection(name).then(function (res) {
        var updated = mutatorFn(res.list.slice());
        return saveCollection(name, updated, res.sha).then(function (newSha) {
          state.data[name].list = updated;
          state.data[name].sha = newSha;
          state.data[name].loaded = true;
          state.lastSync = new Date();
          setSyncStatus('ok');
          if (opts.onSuccess) opts.onSuccess();
          if (opts.successMessage) state.toast = { msg: opts.successMessage, isError: false };
          render();
          scheduleToastClear();
          return true;
        });
      }).catch(function (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 422) && attempt < 4) {
          return tryOnce();
        }
        setSyncStatus('error');
        state.toast = { msg: friendlyError(e), isError: true };
        render();
        scheduleToastClear();
        return false;
      });
    }
    return tryOnce();
  }

  function setSyncStatus(status) { state.syncStatus = status; }

  function scheduleToastClear() {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { state.toast = null; render(); }, 3200);
  }

  function showToast(msg, isError) {
    state.toast = { msg: msg, isError: !!isError };
    render();
    scheduleToastClear();
  }

  // ---------- Carga y sincronización (según la vista activa) ----------

  function neededCollectionsForView() {
    if (state.tab === 'gastos') return ['gastos', 'tiempo', 'otros'];
    if (state.tab === 'reportes') return ['gastos', 'tiempo', 'otros'];
    if (state.tab === 'costo') return state.costoTab === 'tiempo' ? ['empleados', 'tiempo'] : ['otros'];
    return [];
  }

  function ensureLoaded(names) {
    var toFetch = names.filter(function (n) { return !state.data[n].loaded; });
    if (!toFetch.length) { restartPollingForCurrentView(); return Promise.resolve(); }
    setSyncStatus('syncing');
    render();
    return Promise.all(toFetch.map(function (n) {
      return fetchCollection(n).then(function (res) {
        state.data[n].list = res.list;
        state.data[n].sha = res.sha;
        state.data[n].loaded = true;
      });
    })).then(function () {
      state.lastSync = new Date();
      setSyncStatus('ok');
      render();
      restartPollingForCurrentView();
    }).catch(function (e) {
      setSyncStatus('error');
      showToast(friendlyError(e), true);
      restartPollingForCurrentView();
    });
  }

  function refreshCurrentView() {
    if (!state.config) return Promise.resolve();
    var names = neededCollectionsForView();
    if (!names.length) return Promise.resolve();
    setSyncStatus('syncing');
    updateSyncDomOnly();
    return Promise.all(names.map(function (n) {
      return fetchCollection(n).then(function (res) {
        state.data[n].list = res.list;
        state.data[n].sha = res.sha;
        state.data[n].loaded = true;
      });
    })).then(function () {
      state.lastSync = new Date();
      setSyncStatus('ok');
      backgroundDataUpdated();
    }).catch(function () {
      setSyncStatus('error');
      backgroundDataUpdated();
    });
  }

  function backgroundDataUpdated() {
    if (state.screen) {
      updateSyncDomOnly();
    } else {
      render();
    }
  }

  function updateSyncDomOnly() {
    var dot = document.querySelector('[data-sync-dot]');
    var label = document.querySelector('[data-sync-label]');
    if (dot) dot.className = 'dot ' + (state.syncStatus === 'ok' ? 'ok' : state.syncStatus === 'error' ? 'err' : '');
    if (label) label.textContent = syncLabelText();
  }

  function syncLabelText() {
    if (state.syncStatus === 'syncing') return 'Sincronizando…';
    if (state.syncStatus === 'error') return 'Sin conexión';
    return timeAgo(state.lastSync);
  }

  function restartPollingForCurrentView() {
    stopPolling();
    pollTimer = setInterval(function () { if (!document.hidden) refreshCurrentView(); }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshCurrentView();
  });

  // ---------- Instalar como app ----------

  function isIosDevice() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  }
  function isStandaloneApp() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    if (!state.screen) render();
  });
  window.addEventListener('appinstalled', function () {
    state.deferredInstallPrompt = null;
    if (!state.screen) render();
  });

  function installApp() {
    var promptEvent = state.deferredInstallPrompt;
    if (!promptEvent) return;
    state.deferredInstallPrompt = null;
    promptEvent.prompt();
    promptEvent.userChoice.then(function () { render(); }).catch(function () {});
  }

  function loadInitialData() {
    if (!state.config) return;
    ensureLoaded(neededCollectionsForView());
  }

  // ---------- Acciones de usuario: navegación ----------

  function switchTab(tab) {
    state.tab = tab;
    state.screen = null;
    render();
    ensureLoaded(neededCollectionsForView());
  }
  function switchCostoTab(ct) {
    state.costoTab = ct;
    render();
    ensureLoaded(neededCollectionsForView());
  }
  function closeScreen() {
    if (state.fotoState && state.fotoState.previewUrl) URL.revokeObjectURL(state.fotoState.previewUrl);
    state.screen = null; state.editingId = null; state.configError = null; state.fotoState = null;
    render();
  }
  function openConfig() { state.configError = null; state.screen = 'config'; render(); }
  function toggleTokenVisibility() { state.showToken = !state.showToken; render(); }

  function openNewForm(prefill) { state.editingId = null; state.formPrefill = prefill || null; state.screen = 'form'; render(); }
  function openEditForm(id) { state.editingId = id; state.formPrefill = null; state.screen = 'form'; render(); }

  function openFotoForm() { state.fotoState = { file: null, previewUrl: null, processing: false, extracted: null }; state.screen = 'foto-form'; render(); }

  function openNewEmpleadoForm() { state.editingId = null; state.screen = 'empleado-form'; render(); }
  function openEditEmpleadoForm(id) { state.editingId = id; state.screen = 'empleado-form'; render(); }

  function openNewTiempoForm() {
    if (!state.data.empleados.list.length) { showToast('Primero agrega al menos un empleado.', true); return; }
    state.editingId = null; state.screen = 'tiempo-form'; render();
  }
  function openEditTiempoForm(id) { state.editingId = id; state.screen = 'tiempo-form'; render(); }

  function openNewOtroForm() { state.editingId = null; state.screen = 'otro-form'; render(); }
  function openEditOtroForm(id) { state.editingId = id; state.screen = 'otro-form'; render(); }

  function setQuickPeriod(kind) {
    var now = new Date(), desde, hasta;
    if (kind === 'month') { desde = new Date(now.getFullYear(), now.getMonth(), 1); hasta = now; }
    else if (kind === 'lastmonth') { desde = new Date(now.getFullYear(), now.getMonth() - 1, 1); hasta = new Date(now.getFullYear(), now.getMonth(), 0); }
    else if (kind === 'year') { desde = new Date(now.getFullYear(), 0, 1); hasta = now; }
    else { desde = null; hasta = null; }
    state.period = { desde: desde ? toISODate(desde) : '', hasta: hasta ? toISODate(hasta) : '' };
    state.quickPeriod = kind;
    render();
  }

  // ---------- Acciones de usuario: guardar/eliminar ----------

  function deleteGasto(id) {
    if (!window.confirm('¿Eliminar este gasto? Esta acción no se puede deshacer.')) return;
    mutateCollection('gastos', function (list) { return list.filter(function (g) { return g.id !== id; }); }, {
      successMessage: 'Gasto eliminado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  function onSubmitGastoForm(fd) {
    var fecha = fd.get('fecha');
    var proveedor = (fd.get('proveedor') || '').trim();
    var monto = parseFloat(fd.get('monto'));
    var pagadoPor = (fd.get('pagadoPor') || '').trim();
    if (!fecha || !proveedor || !pagadoPor || isNaN(monto) || monto <= 0) {
      showToast('Completa fecha, proveedor, monto (mayor a 0) y "Pagado por".', true);
      return;
    }
    var editingId = state.editingId;
    mutateCollection('gastos', function (list) {
      if (editingId) {
        return list.map(function (g) {
          return g.id === editingId ? Object.assign({}, g, { fecha: fecha, proveedor: proveedor, monto: monto, pagadoPor: pagadoPor }) : g;
        });
      }
      return list.concat([{ id: genId(), fecha: fecha, proveedor: proveedor, monto: monto, pagadoPor: pagadoPor, creadoEn: new Date().toISOString() }]);
    }, {
      successMessage: editingId ? 'Gasto actualizado' : 'Gasto guardado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  function deleteEmpleado(id) {
    if (!window.confirm('¿Eliminar este empleado? Los registros de horas ya guardados no se borran.')) return;
    mutateCollection('empleados', function (list) { return list.filter(function (e) { return e.id !== id; }); }, {
      successMessage: 'Empleado eliminado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  function onSubmitEmpleadoForm(fd) {
    var nombre = (fd.get('nombre') || '').trim();
    var precioHoraNormal = parseFloat(fd.get('precioHoraNormal'));
    var precioHoraExtra = parseFloat(fd.get('precioHoraExtra'));
    if (isNaN(precioHoraExtra)) precioHoraExtra = 0;
    if (!nombre || isNaN(precioHoraNormal) || precioHoraNormal <= 0 || precioHoraExtra < 0) {
      showToast('Completa el nombre y un precio de hora normal válido (mayor a 0).', true);
      return;
    }
    var editingId = state.editingId;
    mutateCollection('empleados', function (list) {
      if (editingId) {
        return list.map(function (e) {
          return e.id === editingId ? Object.assign({}, e, { nombre: nombre, precioHoraNormal: precioHoraNormal, precioHoraExtra: precioHoraExtra }) : e;
        });
      }
      return list.concat([{ id: genId(), nombre: nombre, precioHoraNormal: precioHoraNormal, precioHoraExtra: precioHoraExtra, creadoEn: new Date().toISOString() }]);
    }, {
      successMessage: editingId ? 'Empleado actualizado' : 'Empleado guardado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  function deleteTiempo(id) {
    if (!window.confirm('¿Eliminar este registro de horas? Esta acción no se puede deshacer.')) return;
    mutateCollection('tiempo', function (list) { return list.filter(function (t) { return t.id !== id; }); }, {
      successMessage: 'Registro eliminado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  function onSubmitTiempoForm(fd) {
    var empleadoId = fd.get('empleadoId');
    var fecha = fd.get('fecha');
    var horasNormales = parseFloat(fd.get('horasNormales')) || 0;
    var horasExtras = parseFloat(fd.get('horasExtras')) || 0;
    var emp = state.data.empleados.list.find(function (e) { return e.id === empleadoId; });
    if (!emp || !fecha || (horasNormales <= 0 && horasExtras <= 0)) {
      showToast('Selecciona un empleado, una fecha y al menos una cantidad de horas.', true);
      return;
    }
    var monto = horasNormales * Number(emp.precioHoraNormal || 0) + horasExtras * Number(emp.precioHoraExtra || 0);
    var editingId = state.editingId;
    var payload = {
      empleadoId: empleadoId,
      empleadoNombre: emp.nombre,
      fecha: fecha,
      horasNormales: horasNormales,
      horasExtras: horasExtras,
      precioHoraNormal: emp.precioHoraNormal,
      precioHoraExtra: emp.precioHoraExtra,
      monto: monto,
    };
    mutateCollection('tiempo', function (list) {
      if (editingId) {
        return list.map(function (t) { return t.id === editingId ? Object.assign({}, t, payload) : t; });
      }
      return list.concat([Object.assign({ id: genId(), creadoEn: new Date().toISOString() }, payload)]);
    }, {
      successMessage: editingId ? 'Registro actualizado' : 'Registro guardado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  function deleteOtro(id) {
    if (!window.confirm('¿Eliminar este gasto operativo? Esta acción no se puede deshacer.')) return;
    mutateCollection('otros', function (list) { return list.filter(function (o) { return o.id !== id; }); }, {
      successMessage: 'Gasto eliminado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  function onSubmitOtroForm(fd) {
    var fecha = fd.get('fecha');
    var concepto = (fd.get('concepto') || '').trim();
    var monto = parseFloat(fd.get('monto'));
    if (!fecha || !concepto || isNaN(monto) || monto <= 0) {
      showToast('Completa fecha, concepto y un monto válido (mayor a 0).', true);
      return;
    }
    var editingId = state.editingId;
    mutateCollection('otros', function (list) {
      if (editingId) {
        return list.map(function (o) { return o.id === editingId ? Object.assign({}, o, { fecha: fecha, concepto: concepto, monto: monto }) : o; });
      }
      return list.concat([{ id: genId(), fecha: fecha, concepto: concepto, monto: monto, creadoEn: new Date().toISOString() }]);
    }, {
      successMessage: editingId ? 'Gasto actualizado' : 'Gasto guardado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  // ---------- Configuración ----------

  function onSubmitConfigForm(fd) {
    var owner = (fd.get('owner') || '').trim();
    var repo = (fd.get('repo') || '').trim();
    var branch = (fd.get('branch') || '').trim() || 'main';
    var token = (fd.get('token') || '').trim();
    if (!owner || !repo || !token) {
      state.configError = 'Completa usuario/organización, repositorio y token.';
      render();
      return;
    }
    var testConfig = { owner: owner, repo: repo, branch: branch, token: token };
    var prevConfig = state.config;
    state.configVerifying = true;
    state.configError = null;
    state.config = testConfig;
    render();
    fetchCollection('gastos').then(function (data) {
      persistConfig(testConfig);
      state.data.gastos.list = data.list;
      state.data.gastos.sha = data.sha;
      state.data.gastos.loaded = true;
      state.lastSync = new Date();
      state.syncStatus = 'ok';
      state.configVerifying = false;
      state.screen = null;
      render();
      showToast('Conectado correctamente');
      restartPollingForCurrentView();
    }).catch(function (e) {
      state.config = prevConfig;
      state.configVerifying = false;
      state.configError = friendlyError(e);
      render();
    });
  }

  function resetConfig() {
    if (!window.confirm('¿Desconectar este dispositivo? Deberás ingresar el token nuevamente para volver a usar la app aquí.')) return;
    clearConfig();
    stopPolling();
    state.config = null;
    state.data = {
      gastos: { list: [], sha: null, loaded: false },
      empleados: { list: [], sha: null, loaded: false },
      tiempo: { list: [], sha: null, loaded: false },
      otros: { list: [], sha: null, loaded: false },
    };
    state.screen = 'config';
    render();
  }

  function copyConfigForSharing() {
    var cfg = state.config;
    if (!cfg) return;
    var code = [cfg.owner, cfg.repo, cfg.branch || 'main', cfg.token].join('|');
    var done = function () { showToast('Configuración copiada. Compártela solo por un canal seguro con tu equipo.'); };
    var fallback = function () { window.prompt('Copia este código de configuración:', code); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function usePastedConfig() {
    var input = document.getElementById('c-paste');
    var raw = (input ? input.value : '').trim();
    var parts = raw.split('|').map(function (s) { return s.trim(); });
    if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[3]) {
      showToast('Ese código no es válido. Pídele a tu compañero que use "Copiar configuración" y pega el texto completo.', true);
      return;
    }
    var fd = new FormData();
    fd.append('owner', parts[0]);
    fd.append('repo', parts[1]);
    fd.append('branch', parts[2] || 'main');
    fd.append('token', parts[3]);
    onSubmitConfigForm(fd);
  }

  // ---------- Cálculos de reportes (Gastos + Costo Operativo) ----------

  function buildUnifiedGastos() {
    var list = [];
    state.data.gastos.list.forEach(function (g) {
      list.push({ id: g.id, fecha: g.fecha, nombre: g.proveedor, monto: g.monto, categoria: g.pagadoPor, tipo: 'gasto' });
    });
    state.data.tiempo.list.forEach(function (t) {
      list.push({ id: t.id, fecha: t.fecha, nombre: t.empleadoNombre, monto: t.monto, categoria: 'Mano de obra', tipo: 'tiempo' });
    });
    state.data.otros.list.forEach(function (o) {
      list.push({ id: o.id, fecha: o.fecha, nombre: o.concepto, monto: o.monto, categoria: 'Costo operativo', tipo: 'otro' });
    });
    return list;
  }

  function filteredGastosByPeriod() {
    var desde = state.period.desde, hasta = state.period.hasta;
    return buildUnifiedGastos().filter(function (g) {
      if (desde && g.fecha < desde) return false;
      if (hasta && g.fecha > hasta) return false;
      return true;
    });
  }

  function groupBy(list, key) {
    var map = {}, order = [];
    list.forEach(function (g) {
      var k = (g[key] || '(sin dato)');
      if (!map[k]) { map[k] = { name: k, total: 0, count: 0 }; order.push(k); }
      map[k].total += Number(g.monto) || 0;
      map[k].count++;
    });
    return order.map(function (k) { return map[k]; }).sort(function (a, b) { return b.total - a.total; });
  }

  function monthlyBreakdown(list) {
    var map = {}, order = [];
    list.forEach(function (g) {
      var k = g.fecha ? g.fecha.slice(0, 7) : '—';
      if (!map[k]) { map[k] = { name: k, total: 0, count: 0 }; order.push(k); }
      map[k].total += Number(g.monto) || 0;
      map[k].count++;
    });
    return order.map(function (k) { return map[k]; }).sort(function (a, b) { return a.name < b.name ? 1 : -1; });
  }

  // ---------- Cargar factura por foto (OCR) ----------

  var TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  function loadTesseractScript() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('No se pudo cargar el motor de reconocimiento.')); };
      document.head.appendChild(s);
    });
  }

  function preprocessImageForOcr(file) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var maxDim = 1800;
          var scale = Math.min(2, maxDim / Math.max(img.width, img.height));
          if (scale < 1) scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          var imageData = ctx.getImageData(0, 0, w, h);
          var d = imageData.data;
          for (var i = 0; i < d.length; i += 4) {
            var gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            gray = (gray - 128) * 1.5 + 128;
            gray = gray < 0 ? 0 : (gray > 255 ? 255 : gray);
            d[i] = d[i + 1] = d[i + 2] = gray;
          }
          ctx.putImageData(imageData, 0, 0);
          canvas.toBlob(function (blob) { resolve(blob || file); }, 'image/png');
        } catch (e) {
          resolve(file);
        }
      };
      img.onerror = function () { resolve(file); };
      img.src = URL.createObjectURL(file);
    });
  }

  function parseAmountToken(str) {
    if (!str) return null;
    var cleaned = str.replace(/[^\d.,]/g, '');
    if (!cleaned) return null;
    var lastComma = cleaned.lastIndexOf(','), lastDot = cleaned.lastIndexOf('.');
    var decSep = lastComma > lastDot ? ',' : (lastDot > lastComma ? '.' : null);
    var val;
    if (decSep) {
      var thouSep = decSep === ',' ? '.' : ',';
      var segs = cleaned.split(decSep);
      var decPart = segs.pop();
      var intPart = segs.join('').split(thouSep).join('');
      val = parseFloat(intPart + '.' + decPart);
    } else {
      val = parseFloat(cleaned.replace(/[.,]/g, ''));
    }
    return isNaN(val) ? null : val;
  }

  var PROVEEDOR_NOISE_WORDS = [
    'factura', 'recibo', 'tiquete', 'ticket', 'comprobante', 'cliente', 'ruc', 'cedula',
    'telefono', 'tel', 'fecha', 'hora', 'caja', 'copia', 'original', 'senor', 'senora',
    'direccion', 'nit', 'consumidor', 'final', 'gracias', 'vuelto', 'efectivo', 'tarjeta',
    'subtotal', 'total', 'iva', 'impuesto', 'descuento', 'articulo', 'cantidad', 'precio', 'no.'
  ];

  function stripAccents(str) {
    return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function extractInvoiceFields(text) {
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

    var fecha = null;
    var reDMY = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/;
    var reYMD = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/;
    for (var i = 0; i < lines.length && !fecha; i++) {
      var m1 = lines[i].match(reDMY);
      if (m1) {
        var mo1 = parseInt(m1[2], 10), d1 = parseInt(m1[1], 10);
        if (mo1 >= 1 && mo1 <= 12 && d1 >= 1 && d1 <= 31) fecha = m1[3] + '-' + String(mo1).padStart(2, '0') + '-' + String(d1).padStart(2, '0');
      }
      if (!fecha) {
        var m2 = lines[i].match(reYMD);
        if (m2) {
          var mo2 = parseInt(m2[2], 10), d2 = parseInt(m2[3], 10);
          if (mo2 >= 1 && mo2 <= 12 && d2 >= 1 && d2 <= 31) fecha = m2[1] + '-' + String(mo2).padStart(2, '0') + '-' + String(d2).padStart(2, '0');
        }
      }
    }

    var monto = null;
    var reTotalLine = /\btotal(\s*(a\s*pagar|general|final|neto))?[^0-9]{0,18}([\d][\d.,]*)/i;
    for (var j = lines.length - 1; j >= 0; j--) {
      if (/subtotal/i.test(lines[j])) continue;
      var mt = lines[j].match(reTotalLine);
      if (mt) {
        var parsed = parseAmountToken(mt[3]);
        if (parsed != null && parsed > 0) { monto = parsed; break; }
      }
    }
    if (monto == null) {
      var allNums = text.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/g) || [];
      var parsedNums = allNums
        .map(parseAmountToken)
        .filter(function (n) { return n != null && n > 0 && n < 5000000; });
      // Prefiere montos con decimales (más probable que sean dinero y no cédulas/teléfonos)
      var withDecimals = parsedNums.filter(function (n) { return Math.round(n * 100) % 100 !== 0; });
      var pool = withDecimals.length ? withDecimals : parsedNums;
      if (pool.length) monto = Math.max.apply(null, pool);
    }

    var proveedor = '';
    for (var k = 0; k < lines.length; k++) {
      var l = lines[k];
      var normalized = stripAccents(l).toLowerCase();
      var isNoise = PROVEEDOR_NOISE_WORDS.some(function (w) { return normalized.indexOf(w) !== -1; });
      var mostlyDigits = (l.match(/\d/g) || []).length > l.length / 2;
      if (l.length >= 3 && /[a-zA-ZÀ-ÿ]{3,}/.test(l) && !isNoise && !mostlyDigits) { proveedor = l; break; }
    }

    return { fecha: fecha, proveedor: proveedor, monto: monto };
  }

  function procesarFoto() {
    if (!state.fotoState || !state.fotoState.file) return;
    state.fotoState.processing = true;
    render();
    var originalFile = state.fotoState.file;
    Promise.all([loadTesseractScript(), preprocessImageForOcr(originalFile)]).then(function (results) {
      return Tesseract.recognize(results[1], 'spa');
    }).then(function (result) {
      var text = (result && result.data && result.data.text) || '';
      state.fotoState.processing = false;
      state.fotoState.extracted = extractInvoiceFields(text);
      render();
    }).catch(function () {
      state.fotoState.processing = false;
      render();
      showToast('No se pudo procesar la imagen. Intenta con otra foto o ingresa los datos manualmente.', true);
    });
  }

  function resetFoto() {
    if (state.fotoState && state.fotoState.previewUrl) URL.revokeObjectURL(state.fotoState.previewUrl);
    state.fotoState = { file: null, previewUrl: null, processing: false, extracted: null };
    render();
  }

  function continuarConExtraido() {
    var ex = (state.fotoState && state.fotoState.extracted) || {};
    if (state.fotoState && state.fotoState.previewUrl) URL.revokeObjectURL(state.fotoState.previewUrl);
    state.fotoState = null;
    openNewForm({ fecha: ex.fecha, proveedor: ex.proveedor, monto: ex.monto });
  }

  // ---------- PDF del reporte ----------

  function buildReportePdfDoc() {
    var filtered = filteredGastosByPeriod();
    var total = filtered.reduce(function (s, g) { return s + (Number(g.monto) || 0); }, 0);
    var porProveedor = groupBy(filtered, 'nombre');
    var porPagado = groupBy(filtered, 'categoria');
    var periodoLabel = (state.period.desde || state.period.hasta)
      ? ('Periodo: ' + (state.period.desde ? formatDateDisplay(state.period.desde) : 'inicio') + ' a ' + (state.period.hasta ? formatDateDisplay(state.period.hasta) : 'hoy'))
      : 'Periodo: todos los registros';

    var doc = new jspdf.jsPDF();
    var y = 20;
    var pageH = 280;

    function ensureSpace(need) {
      if (y + need > pageH) { doc.addPage(); y = 20; }
    }

    doc.setFontSize(16);
    doc.text('K-PITAL - Reporte de gastos', 14, y); y += 8;
    doc.setFontSize(10);
    doc.text(periodoLabel, 14, y); y += 6;
    doc.text('Generado: ' + new Date().toLocaleString('es-CR'), 14, y); y += 12;

    doc.setFontSize(12);
    doc.text('Total gastado: ' + formatMoneyPdf(total), 14, y); y += 7;
    doc.text('Cantidad de registros: ' + filtered.length, 14, y); y += 7;
    doc.text('Promedio por registro: ' + formatMoneyPdf(filtered.length ? total / filtered.length : 0), 14, y); y += 12;

    function section(title, rows) {
      ensureSpace(14);
      doc.setFontSize(13);
      doc.text(title, 14, y); y += 8;
      doc.setFontSize(10);
      if (!rows.length) { doc.text('Sin datos en este periodo.', 14, y); y += 8; return; }
      rows.forEach(function (r) {
        ensureSpace(7);
        doc.text(String(r.name).slice(0, 45) + '  (' + r.count + ')', 14, y);
        doc.text(formatMoneyPdf(r.total), 196, y, { align: 'right' });
        y += 6.5;
      });
      y += 6;
    }

    section('Por proveedor / concepto', porProveedor);
    section('Pagado por / categoria', porPagado);

    return doc;
  }

  function downloadOrShareReportePdf() {
    if (typeof jspdf === 'undefined') {
      showToast('No se pudo generar el PDF (sin conexión a internet la primera vez).', true);
      return;
    }
    var doc = buildReportePdfDoc();
    var filename = 'kpital-reporte-' + toISODate(new Date()) + '.pdf';
    var blob = doc.output('blob');
    var file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Reporte K-PITAL', text: 'Reporte de gastos K-PITAL' }).catch(function () {});
    } else {
      doc.save(filename);
    }
  }

  // ---------- Render ----------

  function withFocusPreserved(fn) {
    var active = document.activeElement;
    var id = active && active.id;
    var start = active && 'selectionStart' in active ? active.selectionStart : null;
    var end = active && 'selectionStart' in active ? active.selectionEnd : null;
    fn();
    if (id) {
      var el = document.getElementById(id);
      if (el) {
        el.focus();
        if (start != null && el.setSelectionRange) {
          try { el.setSelectionRange(start, end); } catch (e) {}
        }
      }
    }
  }

  function render() { withFocusPreserved(paint); }

  function paint() {
    appEl.innerHTML = renderHeader() + renderMain() + renderTabbar() + renderScreen() + renderToast();
    updateTiempoPreview();
  }

  function renderHeader() {
    var dotClass = state.syncStatus === 'ok' ? 'ok' : state.syncStatus === 'error' ? 'err' : '';
    return (
      '<div class="header">' +
        '<div class="brand">' +
          '<div class="logo">K</div>' +
          '<div><h1>K-PITAL</h1><small>Control de gastos</small></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div class="sync-status">' +
            '<span class="dot ' + dotClass + '" data-sync-dot></span>' +
            '<span data-sync-label>' + escapeHtml(syncLabelText()) + '</span>' +
          '</div>' +
          '<button class="icon-btn" data-action="refresh" title="Actualizar">&#8635;</button>' +
          '<button class="icon-btn" data-action="open-config" title="Configuración">&#9881;</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTabbar() {
    return (
      '<div class="tabbar"><div class="tabbar-inner">' +
        '<button class="tab-btn ' + (state.tab === 'inicio' ? 'active' : '') + '" data-action="tab" data-tab="inicio">' +
          '<span class="ic">&#127968;</span>Inicio</button>' +
        '<button class="tab-btn ' + (state.tab === 'gastos' ? 'active' : '') + '" data-action="tab" data-tab="gastos">' +
          '<span class="ic">&#128179;</span>Gastos</button>' +
        '<button class="tab-btn ' + (state.tab === 'costo' ? 'active' : '') + '" data-action="tab" data-tab="costo">' +
          '<span class="ic">&#129518;</span>Costo Operativo</button>' +
        '<button class="tab-btn ' + (state.tab === 'reportes' ? 'active' : '') + '" data-action="tab" data-tab="reportes">' +
          '<span class="ic">&#128202;</span>Reportes</button>' +
      '</div></div>'
    );
  }

  function renderMain() {
    if (!state.config) {
      return '<main>' + renderSetupHero() + '</main>';
    }
    if (state.tab === 'inicio') return '<main>' + renderInicioTab() + '</main>';
    if (state.tab === 'gastos') return '<main>' + renderRefreshBar() + renderGastosTab() + '</main>' + renderFab();
    if (state.tab === 'costo') return '<main>' + renderRefreshBar() + renderCostoOperativoTab() + '</main>';
    return '<main>' + renderRefreshBar() + renderReportesTab() + '</main>';
  }

  function renderInicioTab() {
    return (
      '<div class="setup-hero">' +
        '<div class="logo-lg">K</div>' +
        '<h2>Hola 👋</h2>' +
        '<p>Elige qué quieres hacer.</p>' +
      '</div>' +
      '<div class="card" style="text-align:center;padding:18px;cursor:pointer;" data-action="tab" data-tab="gastos">' +
        '<div style="font-size:28px;">&#128179;</div>' +
        '<div style="font-weight:700;margin-top:6px;">Gastos</div>' +
        '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Registrar y ver facturas de proveedores</div>' +
      '</div>' +
      '<div class="card" style="text-align:center;padding:18px;cursor:pointer;" data-action="tab" data-tab="costo">' +
        '<div style="font-size:28px;">&#129518;</div>' +
        '<div style="font-weight:700;margin-top:6px;">Costo Operativo</div>' +
        '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Horas trabajadas y otros gastos operativos</div>' +
      '</div>' +
      '<div class="card" style="text-align:center;padding:18px;cursor:pointer;" data-action="tab" data-tab="reportes">' +
        '<div style="font-size:28px;">&#128202;</div>' +
        '<div style="font-weight:700;margin-top:6px;">Reportes</div>' +
        '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Totales por período, proveedor y pagado por</div>' +
      '</div>' +
      renderInstallCard()
    );
  }

  function renderInstallCard() {
    if (isStandaloneApp()) return '';
    if (state.deferredInstallPrompt) {
      return (
        '<div class="card" style="text-align:center;padding:18px;cursor:pointer;background:linear-gradient(135deg,rgba(242,181,68,.12),transparent);" data-action="install-app">' +
          '<div style="font-size:28px;">&#128241;</div>' +
          '<div style="font-weight:700;margin-top:6px;">Instalar la app</div>' +
          '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Agrégala a tu pantalla de inicio para abrirla como una app</div>' +
        '</div>'
      );
    }
    if (isIosDevice()) {
      return (
        '<div class="card" style="text-align:center;padding:18px;">' +
          '<div style="font-size:28px;">&#128241;</div>' +
          '<div style="font-weight:700;margin-top:6px;">Instalar en iPhone</div>' +
          '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Toca el botón Compartir &#8593; de Safari y elige "Agregar a pantalla de inicio"</div>' +
        '</div>'
      );
    }
    return '';
  }

  function renderRefreshBar() {
    var syncing = state.syncStatus === 'syncing';
    return (
      '<div style="margin-bottom:12px;">' +
        '<button type="button" class="btn btn-secondary" data-action="refresh" ' + (syncing ? 'disabled' : '') + '>' +
          (syncing ? '<span class="spinner"></span> Actualizando…' : '&#8635; Actualizar') +
        '</button>' +
      '</div>'
    );
  }

  function renderSetupHero() {
    return (
      '<div class="setup-hero">' +
        '<div class="logo-lg">K</div>' +
        '<h2>Bienvenido a K-PITAL</h2>' +
        '<p>Para que todos los usuarios vean los mismos gastos, conecta esta app a tu repositorio de GitHub.</p>' +
        '<div style="margin-top:22px;"><button class="btn btn-primary" data-action="open-config">Conectar ahora</button></div>' +
      '</div>'
    );
  }

  function renderFab() {
    return '<button class="fab" data-action="open-form" title="Nuevo gasto">+</button>';
  }

  function renderGastosTab() {
    var search = state.search.trim().toLowerCase();
    var list = buildUnifiedGastos().sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
    var totalCount = list.length;
    if (search) {
      list = list.filter(function (g) {
        return (g.nombre || '').toLowerCase().indexOf(search) !== -1 ||
               (g.categoria || '').toLowerCase().indexOf(search) !== -1;
      });
    }
    var html = '<div class="btn-row" style="margin-bottom:10px;"><button type="button" class="btn btn-secondary" data-action="open-foto-form">&#128248; Cargar factura por foto</button></div>';
    html += '<div class="search-row"><input id="search-proveedor" type="text" placeholder="Buscar por proveedor, empleado, concepto o categoría…" value="' + escapeHtml(state.search) + '" /></div>';

    if (totalCount === 0) {
      html += '<div class="empty-state"><span class="big">&#128221;</span>Aún no hay gastos registrados.<br/>Toca el botón + para agregar el primero.</div>';
      return html;
    }
    if (list.length === 0) {
      html += '<div class="empty-state"><span class="big">&#128269;</span>No se encontraron gastos con ese criterio.</div>';
      return html;
    }
    html += '<div class="card">';
    html += list.map(renderGastoItem).join('');
    html += '</div>';
    return html;
  }

  function renderGastoItem(g) {
    var editAction = g.tipo === 'tiempo' ? 'edit-tiempo' : (g.tipo === 'otro' ? 'edit-otro' : 'edit-gasto');
    return (
      '<div class="gasto-item" data-action="' + editAction + '" data-id="' + escapeHtml(g.id) + '">' +
        '<div class="left">' +
          '<div class="proveedor">' + escapeHtml(g.nombre) + '</div>' +
          '<div class="meta">' + escapeHtml(formatDateDisplay(g.fecha)) + '</div>' +
          '<span class="badge">' + (g.tipo === 'gasto' ? 'Pagado por: ' + escapeHtml(g.categoria) : escapeHtml(g.categoria)) + '</span>' +
        '</div>' +
        '<div class="monto">' + escapeHtml(formatMoney(g.monto)) + '</div>' +
      '</div>'
    );
  }

  function renderPeriodPicker() {
    return (
      '<div class="card">' +
        '<label>Período</label>' +
        '<div class="period-row">' +
          '<div><label style="margin-top:0;">Desde</label><input id="period-desde" type="date" value="' + escapeHtml(state.period.desde || '') + '"/></div>' +
          '<div><label style="margin-top:0;">Hasta</label><input id="period-hasta" type="date" value="' + escapeHtml(state.period.hasta || '') + '"/></div>' +
        '</div>' +
        '<div class="quick-periods">' +
          quickChip('month', 'Este mes') + quickChip('lastmonth', 'Mes pasado') + quickChip('year', 'Este año') + quickChip('all', 'Todo') +
        '</div>' +
      '</div>'
    );
  }

  function quickChip(kind, label) {
    return '<button type="button" class="chip ' + (state.quickPeriod === kind ? 'active' : '') + '" data-action="quick-period" data-range="' + kind + '">' + label + '</button>';
  }

  function renderReportesTab() {
    var filtered = filteredGastosByPeriod();
    var html = renderPeriodPicker();
    html += (
      '<div class="segmented">' +
        segBtn('resumen', 'Resumen') + segBtn('proveedor', 'Proveedor') + segBtn('pagado', 'Categoría') +
      '</div>'
    );
    if (state.reportTab === 'resumen') html += renderResumen(filtered);
    else if (state.reportTab === 'proveedor') html += renderGroupTable(filtered, 'nombre', 'Por proveedor / concepto');
    else html += renderGroupTable(filtered, 'categoria', 'Pagado por / categoría');
    return html;
  }

  function segBtn(key, label) {
    return '<button class="' + (state.reportTab === key ? 'active' : '') + '" data-action="report-tab" data-rt="' + key + '">' + label + '</button>';
  }

  function renderResumen(filtered) {
    var total = filtered.reduce(function (s, g) { return s + (Number(g.monto) || 0); }, 0);
    var meses = monthlyBreakdown(filtered);
    var html = '<div class="card">';
    html += (
      '<div class="summary-total">' +
        '<div class="amount">' + escapeHtml(formatMoney(total)) + '</div>' +
        '<div class="label">Total gastado en el período</div>' +
        '<div class="summary-sub"><div><b>' + filtered.length + '</b>registros</div>' +
        '<div><b>' + (filtered.length ? escapeHtml(formatMoney(total / filtered.length)) : formatMoney(0)) + '</b>promedio</div></div>' +
        '<div style="margin-top:16px;"><button type="button" class="btn btn-secondary" data-action="download-report-pdf">&#128196; Descargar / compartir PDF</button></div>' +
      '</div>'
    );
    html += '</div>';
    if (meses.length) {
      html += '<div class="card"><label style="margin-top:0;">Desglose por mes</label>';
      var max = Math.max.apply(null, meses.map(function (m) { return m.total; }));
      html += meses.map(function (m) {
        var pct = max ? Math.round((m.total / max) * 100) : 0;
        return (
          '<div class="report-row-wrap">' +
            '<div class="report-row" style="border:none;padding:0;">' +
              '<div><div class="name">' + escapeHtml(monthLabel(m.name)) + '</div><div class="count">' + m.count + ' registros</div></div>' +
              '<div class="amt">' + escapeHtml(formatMoney(m.total)) + '</div>' +
            '</div>' +
            '<div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
          '</div>'
        );
      }).join('');
      html += '</div>';
    }
    return html;
  }

  function renderGroupTable(filtered, key, label) {
    var rows = groupBy(filtered, key);
    var total = rows.reduce(function (s, r) { return s + r.total; }, 0);
    if (!rows.length) {
      return '<div class="empty-state"><span class="big">&#128202;</span>No hay datos para este período.</div>';
    }
    var html = '<div class="card"><label style="margin-top:0;">' + escapeHtml(label) + '</label>';
    html += rows.map(function (r) {
      return (
        '<div class="report-row">' +
          '<div><div class="name">' + escapeHtml(r.name) + '</div><div class="count">' + r.count + ' registro' + (r.count === 1 ? '' : 's') + '</div></div>' +
          '<div class="amt">' + escapeHtml(formatMoney(r.total)) + '</div>' +
        '</div>'
      );
    }).join('');
    html += '<div class="grand-total-row"><span>Total</span><span>' + escapeHtml(formatMoney(total)) + '</span></div>';
    html += '</div>';
    return html;
  }

  // ---------- Costo Operativo ----------

  function renderCostoOperativoTab() {
    var html = (
      '<div class="segmented">' +
        '<button class="' + (state.costoTab === 'tiempo' ? 'active' : '') + '" data-action="costo-tab" data-ct="tiempo">Tiempo laborado</button>' +
        '<button class="' + (state.costoTab === 'otros' ? 'active' : '') + '" data-action="costo-tab" data-ct="otros">Otros gastos</button>' +
      '</div>'
    );
    html += state.costoTab === 'tiempo' ? renderTiempoLaboradoView() : renderOtrosGastosView();
    return html;
  }

  function renderTiempoLaboradoView() {
    var tiempoList = state.data.tiempo.list.slice().sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
    var empleados = state.data.empleados.list;

    var html = '<div class="btn-row" style="margin-bottom:14px;">' +
      '<button type="button" class="btn btn-secondary" data-action="open-empleado-new">+ Empleado</button>' +
      '<button type="button" class="btn btn-primary" data-action="open-tiempo-new">+ Registrar horas</button>' +
    '</div>';

    if (!tiempoList.length) {
      html += '<div class="empty-state"><span class="big">&#9203;</span>Aún no hay horas registradas.</div>';
    } else {
      html += '<div class="card">';
      html += tiempoList.map(renderTiempoItem).join('');
      html += '</div>';
    }

    html += '<label style="margin:22px 0 6px;">Empleados registrados</label>';
    if (!empleados.length) {
      html += '<div class="empty-state"><span class="big">&#128100;</span>Aún no hay empleados. Toca "+ Empleado" para agregar el primero.</div>';
    } else {
      html += '<div class="card">';
      html += empleados.map(renderEmpleadoItem).join('');
      html += '</div>';
    }
    return html;
  }

  function renderTiempoItem(t) {
    return (
      '<div class="gasto-item" data-action="edit-tiempo" data-id="' + escapeHtml(t.id) + '">' +
        '<div class="left">' +
          '<div class="proveedor">' + escapeHtml(t.empleadoNombre) + '</div>' +
          '<div class="meta">' + escapeHtml(formatDateDisplay(t.fecha)) + ' · ' + Number(t.horasNormales || 0) + 'h normales, ' + Number(t.horasExtras || 0) + 'h extra</div>' +
        '</div>' +
        '<div class="monto">' + escapeHtml(formatMoney(t.monto)) + '</div>' +
      '</div>'
    );
  }

  function renderEmpleadoItem(e) {
    return (
      '<div class="gasto-item" data-action="edit-empleado" data-id="' + escapeHtml(e.id) + '">' +
        '<div class="left">' +
          '<div class="proveedor">' + escapeHtml(e.nombre) + '</div>' +
          '<div class="meta">Hora normal: ' + escapeHtml(formatMoney(e.precioHoraNormal)) + ' · Hora extra: ' + escapeHtml(formatMoney(e.precioHoraExtra)) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderOtrosGastosView() {
    var list = state.data.otros.list.slice().sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
    var html = '<div class="btn-row" style="margin-bottom:14px;">' +
      '<button type="button" class="btn btn-primary" data-action="open-otro-new">+ Nuevo gasto operativo</button>' +
    '</div>';
    if (!list.length) {
      html += '<div class="empty-state"><span class="big">&#128221;</span>Aún no hay gastos operativos registrados.</div>';
      return html;
    }
    html += '<div class="card">';
    html += list.map(function (o) {
      return (
        '<div class="gasto-item" data-action="edit-otro" data-id="' + escapeHtml(o.id) + '">' +
          '<div class="left">' +
            '<div class="proveedor">' + escapeHtml(o.concepto) + '</div>' +
            '<div class="meta">' + escapeHtml(formatDateDisplay(o.fecha)) + '</div>' +
          '</div>' +
          '<div class="monto">' + escapeHtml(formatMoney(o.monto)) + '</div>' +
        '</div>'
      );
    }).join('');
    html += '</div>';
    return html;
  }

  function renderToast() {
    if (!state.toast) return '';
    return '<div class="toast ' + (state.toast.isError ? 'error' : '') + '">' + escapeHtml(state.toast.msg) + '</div>';
  }

  // ---------- Screens (formularios / configuración) ----------

  function renderScreen() {
    if (state.screen === 'form') return renderFormScreen();
    if (state.screen === 'config') return renderConfigScreen();
    if (state.screen === 'empleado-form') return renderEmpleadoFormScreen();
    if (state.screen === 'tiempo-form') return renderTiempoFormScreen();
    if (state.screen === 'otro-form') return renderOtroFormScreen();
    if (state.screen === 'foto-form') return renderFotoFormScreen();
    return '';
  }

  function uniqueValues(key) {
    var seen = {}, out = [];
    state.data.gastos.list.forEach(function (g) {
      var v = g[key];
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out;
  }

  function renderFormScreen() {
    var editing = state.editingId ? state.data.gastos.list.find(function (g) { return g.id === state.editingId; }) : null;
    var title = editing ? 'Editar gasto' : 'Nuevo gasto';
    var proveedores = uniqueValues('proveedor');
    var pagadores = uniqueValues('pagadoPor');
    var today = toISODate(new Date());
    var prefill = (!editing && state.formPrefill) ? state.formPrefill : null;

    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>' + title + '</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          (prefill ? '<div class="field-hint" style="background:var(--bg-alt);border:1px solid var(--card-border);border-radius:10px;padding:10px 12px;margin-bottom:14px;">&#128248; Datos detectados de la foto. Revísalos y corrige lo que haga falta antes de guardar.</div>' : '') +
          '<form data-form="gasto">' +
            '<label for="f-fecha">Fecha</label>' +
            '<input id="f-fecha" name="fecha" type="date" required value="' + escapeHtml(editing ? editing.fecha : (prefill && prefill.fecha ? prefill.fecha : today)) + '"/>' +

            '<label for="f-proveedor">Nombre del proveedor</label>' +
            '<input id="f-proveedor" name="proveedor" type="text" required list="lista-proveedores" placeholder="Ej: Distribuidora El Sol" value="' + escapeHtml(editing ? editing.proveedor : (prefill ? prefill.proveedor || '' : ''))  + '"/>' +
            '<datalist id="lista-proveedores">' + proveedores.map(function (p) { return '<option value="' + escapeHtml(p) + '">'; }).join('') + '</datalist>' +

            '<label for="f-monto">Monto de la factura (₡)</label>' +
            '<input id="f-monto" name="monto" type="number" step="0.01" min="0.01" required inputmode="decimal" placeholder="0.00" value="' + escapeHtml(editing ? editing.monto : (prefill && prefill.monto != null ? prefill.monto : '')) + '"/>' +

            '<label for="f-pagado">Pagado por:</label>' +
            '<input id="f-pagado" name="pagadoPor" type="text" required list="lista-pagadores" placeholder="Ej: Caja chica, Juan Pérez…" value="' + escapeHtml(editing ? editing.pagadoPor : '') + '"/>' +
            '<datalist id="lista-pagadores">' + pagadores.map(function (p) { return '<option value="' + escapeHtml(p) + '">'; }).join('') + '</datalist>' +

            '<div class="btn-row" style="margin-top:22px;">' +
              '<button type="submit" class="btn btn-primary">Guardar</button>' +
            '</div>' +
            (editing ? '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn btn-danger" data-action="delete-gasto" data-id="' + escapeHtml(editing.id) + '">Eliminar gasto</button></div>' : '') +
          '</form>' +
        '</div>' +
      '</div>'
    );
  }

  function renderFotoFormScreen() {
    var fs = state.fotoState || {};
    var html = (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>Cargar factura por foto</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<input id="foto-input" type="file" accept="image/*" capture="environment" style="display:none;"/>'
    );

    if (!fs.previewUrl) {
      html += (
        '<div class="empty-state"><span class="big">&#128248;</span>Toma una foto de la factura o elige una imagen. Luego revisa los datos antes de guardar el gasto.</div>' +
        '<div class="btn-row"><button type="button" class="btn btn-primary" data-action="trigger-foto-input">&#128247; Tomar foto / elegir imagen</button></div>'
      );
    } else {
      html += '<div class="card" style="text-align:center;"><img src="' + fs.previewUrl + '" style="max-width:100%;max-height:320px;border-radius:10px;"/></div>';

      if (fs.processing) {
        html += '<div class="empty-state"><span class="spinner" style="border-top-color:var(--accent);width:26px;height:26px;"></span><br/><br/>Procesando imagen, puede tardar unos segundos…</div>';
      } else if (fs.extracted) {
        var ex = fs.extracted;
        html += (
          '<div class="card">' +
            '<label style="margin-top:0;">Datos detectados</label>' +
            '<div class="report-row"><div class="name">Fecha</div><div class="amt">' + (ex.fecha ? escapeHtml(formatDateDisplay(ex.fecha)) : 'No detectada') + '</div></div>' +
            '<div class="report-row"><div class="name">Proveedor</div><div class="amt">' + (ex.proveedor ? escapeHtml(ex.proveedor) : 'No detectado') + '</div></div>' +
            '<div class="report-row"><div class="name">Monto</div><div class="amt">' + (ex.monto != null ? escapeHtml(formatMoney(ex.monto)) : 'No detectado') + '</div></div>' +
          '</div>' +
          '<div class="field-hint" style="text-align:center;margin-bottom:14px;">El reconocimiento automático puede fallar. En el siguiente paso puedes corregir cualquier dato antes de guardar.</div>' +
          '<div class="btn-row"><button type="button" class="btn btn-primary" data-action="foto-continuar">Continuar</button></div>' +
          '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn btn-secondary" data-action="foto-reset">Elegir otra foto</button></div>'
        );
      } else {
        html += (
          '<div class="btn-row"><button type="button" class="btn btn-primary" data-action="foto-procesar">Procesar</button></div>' +
          '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn btn-secondary" data-action="foto-reset">Elegir otra foto</button></div>'
        );
      }
    }

    html += '</div></div>';
    return html;
  }

  function renderEmpleadoFormScreen() {
    var editing = state.editingId ? state.data.empleados.list.find(function (e) { return e.id === state.editingId; }) : null;
    var title = editing ? 'Editar empleado' : 'Nuevo empleado';
    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>' + title + '</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<form data-form="empleado">' +
            '<label for="e-nombre">Nombre del empleado</label>' +
            '<input id="e-nombre" name="nombre" type="text" required placeholder="Ej: Juan Pérez" value="' + escapeHtml(editing ? editing.nombre : '') + '"/>' +

            '<label for="e-normal">Precio hora normal (₡)</label>' +
            '<input id="e-normal" name="precioHoraNormal" type="number" step="0.01" min="0.01" required inputmode="decimal" placeholder="0.00" value="' + (editing ? editing.precioHoraNormal : '') + '"/>' +

            '<label for="e-extra">Precio hora extra (₡)</label>' +
            '<input id="e-extra" name="precioHoraExtra" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00" value="' + (editing ? editing.precioHoraExtra : '') + '"/>' +

            '<div class="btn-row" style="margin-top:22px;">' +
              '<button type="submit" class="btn btn-primary">Guardar</button>' +
            '</div>' +
            (editing ? '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn btn-danger" data-action="delete-empleado" data-id="' + escapeHtml(editing.id) + '">Eliminar empleado</button></div>' : '') +
          '</form>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTiempoFormScreen() {
    var editing = state.editingId ? state.data.tiempo.list.find(function (t) { return t.id === state.editingId; }) : null;
    var title = editing ? 'Editar registro de horas' : 'Registrar horas';
    var empleados = state.data.empleados.list;
    var selectedId = editing ? editing.empleadoId : (empleados[0] ? empleados[0].id : '');
    var today = toISODate(new Date());

    var options = empleados.map(function (e) {
      var sel = e.id === selectedId ? 'selected' : '';
      return '<option value="' + escapeHtml(e.id) + '" data-normal="' + e.precioHoraNormal + '" data-extra="' + e.precioHoraExtra + '" ' + sel + '>' + escapeHtml(e.nombre) + '</option>';
    }).join('');

    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>' + title + '</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<form data-form="tiempo">' +
            '<label for="tf-empleado">Empleado</label>' +
            '<select id="tf-empleado" name="empleadoId">' + options + '</select>' +

            '<label for="tf-fecha">Fecha</label>' +
            '<input id="tf-fecha" name="fecha" type="date" required value="' + escapeHtml(editing ? editing.fecha : today) + '"/>' +

            '<label for="tf-normales">Cantidad de horas normales</label>' +
            '<input id="tf-normales" name="horasNormales" type="number" step="0.25" min="0" inputmode="decimal" placeholder="0" value="' + (editing ? editing.horasNormales : '') + '"/>' +

            '<label for="tf-extras">Cantidad de horas extras</label>' +
            '<input id="tf-extras" name="horasExtras" type="number" step="0.25" min="0" inputmode="decimal" placeholder="0" value="' + (editing ? editing.horasExtras : '') + '"/>' +

            '<div class="summary-total" style="padding:16px 10px 0;">' +
              '<div class="amount" id="tf-preview" style="font-size:24px;">' + escapeHtml(formatMoney(editing ? editing.monto : 0)) + '</div>' +
              '<div class="label">Monto a pagar</div>' +
            '</div>' +

            '<div class="btn-row" style="margin-top:22px;">' +
              '<button type="submit" class="btn btn-primary">Guardar</button>' +
            '</div>' +
            (editing ? '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn btn-danger" data-action="delete-tiempo" data-id="' + escapeHtml(editing.id) + '">Eliminar registro</button></div>' : '') +
          '</form>' +
        '</div>' +
      '</div>'
    );
  }

  function updateTiempoPreview() {
    if (state.screen !== 'tiempo-form') return;
    var select = document.getElementById('tf-empleado');
    var preview = document.getElementById('tf-preview');
    if (!select || !preview) return;
    var opt = select.options[select.selectedIndex];
    var normal = opt ? parseFloat(opt.getAttribute('data-normal')) || 0 : 0;
    var extra = opt ? parseFloat(opt.getAttribute('data-extra')) || 0 : 0;
    var hn = parseFloat(document.getElementById('tf-normales').value) || 0;
    var he = parseFloat(document.getElementById('tf-extras').value) || 0;
    preview.textContent = formatMoney(hn * normal + he * extra);
  }

  function renderOtroFormScreen() {
    var editing = state.editingId ? state.data.otros.list.find(function (o) { return o.id === state.editingId; }) : null;
    var title = editing ? 'Editar gasto operativo' : 'Nuevo gasto operativo';
    var today = toISODate(new Date());
    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>' + title + '</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<form data-form="otro">' +
            '<label for="o-fecha">Fecha</label>' +
            '<input id="o-fecha" name="fecha" type="date" required value="' + escapeHtml(editing ? editing.fecha : today) + '"/>' +

            '<label for="o-concepto">Concepto</label>' +
            '<input id="o-concepto" name="concepto" type="text" required placeholder="Ej: Alquiler, electricidad…" value="' + escapeHtml(editing ? editing.concepto : '') + '"/>' +

            '<label for="o-monto">Monto (₡)</label>' +
            '<input id="o-monto" name="monto" type="number" step="0.01" min="0.01" required inputmode="decimal" placeholder="0.00" value="' + (editing ? editing.monto : '') + '"/>' +

            '<div class="btn-row" style="margin-top:22px;">' +
              '<button type="submit" class="btn btn-primary">Guardar</button>' +
            '</div>' +
            (editing ? '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn btn-danger" data-action="delete-otro" data-id="' + escapeHtml(editing.id) + '">Eliminar gasto</button></div>' : '') +
          '</form>' +
        '</div>' +
      '</div>'
    );
  }

  function renderConfigScreen() {
    var cfg = state.config || {};
    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          (state.config ? '<button class="icon-btn" data-action="close-screen">&larr;</button>' : '<div style="width:36px;"></div>') +
          '<h2>Configuración</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<p style="color:var(--text-dim);font-size:13px;">Conecta esta app al repositorio de GitHub donde se guardan los datos de K-PITAL. Solo se hace una vez por dispositivo.</p>' +

          '<div class="card">' +
            '<label style="margin-top:0;">¿Alguien del equipo ya te compartió un código de configuración?</label>' +
            '<input id="c-paste" type="text" placeholder="Pega aquí el código"/>' +
            '<div class="btn-row" style="margin-top:10px;">' +
              '<button type="button" class="btn btn-primary" data-action="paste-config" ' + (state.configVerifying ? 'disabled' : '') + '>Usar este código y conectar</button>' +
            '</div>' +
          '</div>' +
          '<p style="color:var(--text-dim);font-size:12px;text-align:center;margin:-6px 0 18px;">— o completa los datos manualmente —</p>' +

          '<form data-form="config">' +
            '<label for="c-owner">Usuario u organización de GitHub</label>' +
            '<input id="c-owner" name="owner" type="text" required placeholder="Ej: kpital-restaurante" value="' + escapeHtml(cfg.owner || '') + '"/>' +

            '<label for="c-repo">Repositorio</label>' +
            '<input id="c-repo" name="repo" type="text" required placeholder="Ej: kpital-gastos" value="' + escapeHtml(cfg.repo || '') + '"/>' +

            '<label for="c-branch">Rama</label>' +
            '<input id="c-branch" name="branch" type="text" placeholder="main" value="' + escapeHtml(cfg.branch || 'main') + '"/>' +

            '<label for="c-token">Token de acceso personal</label>' +
            '<input id="c-token" name="token" type="' + (state.showToken ? 'text' : 'password') + '" required placeholder="ghp_..." value="' + escapeHtml(cfg.token || '') + '"/>' +
            '<button type="button" class="link-btn" data-action="toggle-token">' + (state.showToken ? 'Ocultar token' : 'Mostrar token') + '</button>' +
            '<div class="field-hint">El token debe ser un "fine-grained token" con permiso de Contents (lectura y escritura) limitado a este repositorio.</div>' +

            (state.configError ? '<div class="toast error" style="position:static;transform:none;margin-top:14px;width:100%;">' + escapeHtml(state.configError) + '</div>' : '') +

            '<div class="btn-row" style="margin-top:22px;">' +
              '<button type="submit" class="btn btn-primary" ' + (state.configVerifying ? 'disabled' : '') + '>' +
                (state.configVerifying ? '<span class="spinner"></span> Verificando…' : 'Guardar y conectar') +
              '</button>' +
            '</div>' +
          '</form>' +
          (state.config ? (
            '<div class="btn-row" style="margin-top:26px;"><button type="button" class="btn btn-secondary" data-action="copy-config">Copiar configuración para otro dispositivo</button></div>' +
            '<div class="field-hint" style="text-align:center;">Comparte ese código solo por un canal seguro (WhatsApp, etc.). Da acceso completo a los datos de este repositorio.</div>' +
            '<div class="btn-row" style="margin-top:18px;"><button type="button" class="btn btn-secondary btn-danger" data-action="reset-config">Desconectar este dispositivo</button></div>'
          ) : '') +
        '</div>' +
      '</div>'
    );
  }

  // ---------- Delegación de eventos ----------

  appEl.addEventListener('click', function (e) {
    var target = e.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;
    if (action === 'tab') switchTab(target.dataset.tab);
    else if (action === 'costo-tab') switchCostoTab(target.dataset.ct);
    else if (action === 'open-form') openNewForm();
    else if (action === 'edit-gasto') openEditForm(target.dataset.id);
    else if (action === 'delete-gasto') deleteGasto(target.dataset.id);
    else if (action === 'open-empleado-new') openNewEmpleadoForm();
    else if (action === 'edit-empleado') openEditEmpleadoForm(target.dataset.id);
    else if (action === 'delete-empleado') deleteEmpleado(target.dataset.id);
    else if (action === 'open-tiempo-new') openNewTiempoForm();
    else if (action === 'edit-tiempo') openEditTiempoForm(target.dataset.id);
    else if (action === 'delete-tiempo') deleteTiempo(target.dataset.id);
    else if (action === 'open-otro-new') openNewOtroForm();
    else if (action === 'edit-otro') openEditOtroForm(target.dataset.id);
    else if (action === 'delete-otro') deleteOtro(target.dataset.id);
    else if (action === 'close-screen') closeScreen();
    else if (action === 'open-config') openConfig();
    else if (action === 'refresh') refreshCurrentView();
    else if (action === 'quick-period') setQuickPeriod(target.dataset.range);
    else if (action === 'report-tab') { state.reportTab = target.dataset.rt; render(); }
    else if (action === 'reset-config') resetConfig();
    else if (action === 'toggle-token') toggleTokenVisibility();
    else if (action === 'copy-config') copyConfigForSharing();
    else if (action === 'paste-config') usePastedConfig();
    else if (action === 'download-report-pdf') downloadOrShareReportePdf();
    else if (action === 'install-app') installApp();
    else if (action === 'open-foto-form') openFotoForm();
    else if (action === 'trigger-foto-input') document.getElementById('foto-input').click();
    else if (action === 'foto-procesar') procesarFoto();
    else if (action === 'foto-reset') resetFoto();
    else if (action === 'foto-continuar') continuarConExtraido();
  });

  appEl.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    var fd = new FormData(form);
    var type = form.dataset.form;
    if (type === 'gasto') onSubmitGastoForm(fd);
    else if (type === 'config') onSubmitConfigForm(fd);
    else if (type === 'empleado') onSubmitEmpleadoForm(fd);
    else if (type === 'tiempo') onSubmitTiempoForm(fd);
    else if (type === 'otro') onSubmitOtroForm(fd);
  });

  appEl.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'search-proveedor') { state.search = e.target.value; render(); }
    else if (id === 'period-desde') { state.period.desde = e.target.value; state.quickPeriod = 'custom'; render(); }
    else if (id === 'period-hasta') { state.period.hasta = e.target.value; state.quickPeriod = 'custom'; render(); }
    else if (id === 'tf-normales' || id === 'tf-extras') updateTiempoPreview();
  });

  appEl.addEventListener('change', function (e) {
    if (e.target.id === 'tf-empleado') updateTiempoPreview();
    else if (e.target.id === 'foto-input') {
      var f = e.target.files && e.target.files[0];
      if (!f || !state.fotoState) return;
      if (state.fotoState.previewUrl) URL.revokeObjectURL(state.fotoState.previewUrl);
      state.fotoState.file = f;
      state.fotoState.previewUrl = URL.createObjectURL(f);
      state.fotoState.extracted = null;
      render();
    }
  });

  // ---------- Arranque ----------

  if (!state.config) state.screen = 'config';
  render();
  if (state.config) loadInitialData();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
