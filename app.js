/* K-PITAL · Gastos
 * App sin frameworks: los datos viven en data/gastos.json dentro de un
 * repositorio de GitHub y se leen/escriben con la API REST de GitHub.
 * Cada dispositivo guarda su propia conexión (owner/repo/token) en localStorage.
 */
(function () {
  'use strict';

  var CONFIG_KEY = 'kpital_gh_config_v1';
  var GH_API = 'https://api.github.com';
  var POLL_MS = 20000;
  var MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  var appEl = document.getElementById('app');
  var pollTimer = null;
  var toastTimer = null;

  var state = {
    config: loadConfig(),
    gastos: [],
    sha: null,
    syncStatus: 'idle', // idle | syncing | ok | error
    lastSync: null,
    tab: 'gastos', // gastos | reportes
    screen: null, // null | 'form' | 'config'
    editingId: null,
    search: '',
    reportTab: 'resumen', // resumen | proveedor | pagado
    period: defaultPeriod(),
    quickPeriod: 'month',
    toast: null,
    configVerifying: false,
    configError: null,
    showToken: false,
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

  function formatMoney(n) {
    var v = Number(n || 0);
    return '$' + v.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

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

  // ---------- API de GitHub ----------

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

  function fetchGastos(cfg) {
    var url = '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
      '/contents/' + cfg.path + '?ref=' + encodeURIComponent(cfg.branch);
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

  function saveGastos(cfg, list, sha) {
    var url = '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/contents/' + cfg.path;
    var body = {
      message: 'Actualiza gastos (K-PITAL app)',
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

  function mutateGastos(mutatorFn, opts) {
    opts = opts || {};
    setSyncStatus('syncing');
    var attempt = 0;
    function tryOnce() {
      attempt++;
      return fetchGastos(state.config).then(function (data) {
        var updated = mutatorFn(data.list.slice());
        return saveGastos(state.config, updated, data.sha).then(function (newSha) {
          state.gastos = updated;
          state.sha = newSha;
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

  // ---------- Sincronización en segundo plano ----------

  function loadInitialData() {
    if (!state.config) return;
    setSyncStatus('syncing');
    render();
    fetchGastos(state.config).then(function (data) {
      state.gastos = data.list;
      state.sha = data.sha;
      state.lastSync = new Date();
      setSyncStatus('ok');
      render();
      startPolling();
    }).catch(function (e) {
      setSyncStatus('error');
      showToast(friendlyError(e), true);
    });
  }

  function refresh() {
    if (!state.config) return Promise.resolve();
    setSyncStatus('syncing');
    updateSyncDomOnly();
    return fetchGastos(state.config).then(function (data) {
      state.gastos = data.list;
      state.sha = data.sha;
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

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });

  // ---------- Acciones de usuario ----------

  function switchTab(tab) { state.tab = tab; state.screen = null; render(); }
  function openNewForm() { state.editingId = null; state.screen = 'form'; render(); }
  function openEditForm(id) { state.editingId = id; state.screen = 'form'; render(); }
  function closeScreen() { state.screen = null; state.editingId = null; state.configError = null; render(); }
  function openConfig() { state.configError = null; state.screen = 'config'; render(); }
  function toggleTokenVisibility() { state.showToken = !state.showToken; render(); }

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

  function deleteGasto(id) {
    if (!window.confirm('¿Eliminar este gasto? Esta acción no se puede deshacer.')) return;
    mutateGastos(function (list) { return list.filter(function (g) { return g.id !== id; }); }, {
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
    mutateGastos(function (list) {
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
    var testConfig = { owner: owner, repo: repo, branch: branch, token: token, path: 'data/gastos.json' };
    var prevConfig = state.config;
    state.configVerifying = true;
    state.configError = null;
    state.config = testConfig;
    render();
    fetchGastos(testConfig).then(function (data) {
      persistConfig(testConfig);
      state.gastos = data.list;
      state.sha = data.sha;
      state.lastSync = new Date();
      state.syncStatus = 'ok';
      state.configVerifying = false;
      state.screen = null;
      render();
      showToast('Conectado correctamente');
      startPolling();
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
    state.gastos = [];
    state.sha = null;
    state.screen = 'config';
    render();
  }

  // ---------- Cálculos de reportes ----------

  function filteredGastosByPeriod() {
    var desde = state.period.desde, hasta = state.period.hasta;
    return state.gastos.filter(function (g) {
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
        '<button class="tab-btn ' + (state.tab === 'gastos' ? 'active' : '') + '" data-action="tab" data-tab="gastos">' +
          '<span class="ic">&#128179;</span>Gastos</button>' +
        '<button class="tab-btn ' + (state.tab === 'reportes' ? 'active' : '') + '" data-action="tab" data-tab="reportes">' +
          '<span class="ic">&#128202;</span>Reportes</button>' +
      '</div></div>'
    );
  }

  function renderMain() {
    if (!state.config) {
      return '<main>' + renderSetupHero() + '</main>';
    }
    if (state.tab === 'gastos') return '<main>' + renderGastosTab() + '</main>' + renderFab();
    return '<main>' + renderReportesTab() + '</main>';
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
    var list = state.gastos.slice().sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || '') || (b.creadoEn || '').localeCompare(a.creadoEn || ''); });
    if (search) {
      list = list.filter(function (g) {
        return (g.proveedor || '').toLowerCase().indexOf(search) !== -1 ||
               (g.pagadoPor || '').toLowerCase().indexOf(search) !== -1;
      });
    }
    var totalCount = state.gastos.length;
    var html = '<div class="search-row"><input id="search-proveedor" type="text" placeholder="Buscar por proveedor o pagado por…" value="' + escapeHtml(state.search) + '" /></div>';

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
    return (
      '<div class="gasto-item" data-action="edit-gasto" data-id="' + escapeHtml(g.id) + '">' +
        '<div class="left">' +
          '<div class="proveedor">' + escapeHtml(g.proveedor) + '</div>' +
          '<div class="meta">' + escapeHtml(formatDateDisplay(g.fecha)) + '</div>' +
          '<span class="badge">Pagado por: ' + escapeHtml(g.pagadoPor) + '</span>' +
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
        segBtn('resumen', 'Resumen') + segBtn('proveedor', 'Por proveedor') + segBtn('pagado', 'Pagado por') +
      '</div>'
    );
    if (state.reportTab === 'resumen') html += renderResumen(filtered);
    else if (state.reportTab === 'proveedor') html += renderGroupTable(filtered, 'proveedor', 'Proveedor');
    else html += renderGroupTable(filtered, 'pagadoPor', 'Pagado por');
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
        '<div class="summary-sub"><div><b>' + filtered.length + '</b>facturas</div>' +
        '<div><b>' + (filtered.length ? escapeHtml(formatMoney(total / filtered.length)) : '$0.00') + '</b>promedio</div></div>' +
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
              '<div><div class="name">' + escapeHtml(monthLabel(m.name)) + '</div><div class="count">' + m.count + ' facturas</div></div>' +
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
          '<div><div class="name">' + escapeHtml(r.name) + '</div><div class="count">' + r.count + ' factura' + (r.count === 1 ? '' : 's') + '</div></div>' +
          '<div class="amt">' + escapeHtml(formatMoney(r.total)) + '</div>' +
        '</div>'
      );
    }).join('');
    html += '<div class="grand-total-row"><span>Total</span><span>' + escapeHtml(formatMoney(total)) + '</span></div>';
    html += '</div>';
    return html;
  }

  function renderToast() {
    if (!state.toast) return '';
    return '<div class="toast ' + (state.toast.isError ? 'error' : '') + '">' + escapeHtml(state.toast.msg) + '</div>';
  }

  // ---------- Screens (formulario / configuración) ----------

  function renderScreen() {
    if (state.screen === 'form') return renderFormScreen();
    if (state.screen === 'config') return renderConfigScreen();
    return '';
  }

  function uniqueValues(key) {
    var seen = {}, out = [];
    state.gastos.forEach(function (g) {
      var v = g[key];
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out;
  }

  function renderFormScreen() {
    var editing = state.editingId ? state.gastos.find(function (g) { return g.id === state.editingId; }) : null;
    var title = editing ? 'Editar gasto' : 'Nuevo gasto';
    var proveedores = uniqueValues('proveedor');
    var pagadores = uniqueValues('pagadoPor');
    var today = toISODate(new Date());

    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>' + title + '</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<form data-form="gasto">' +
            '<label for="f-fecha">Fecha</label>' +
            '<input id="f-fecha" name="fecha" type="date" required value="' + escapeHtml(editing ? editing.fecha : today) + '"/>' +

            '<label for="f-proveedor">Nombre del proveedor</label>' +
            '<input id="f-proveedor" name="proveedor" type="text" required list="lista-proveedores" placeholder="Ej: Distribuidora El Sol" value="' + escapeHtml(editing ? editing.proveedor : '') + '"/>' +
            '<datalist id="lista-proveedores">' + proveedores.map(function (p) { return '<option value="' + escapeHtml(p) + '">'; }).join('') + '</datalist>' +

            '<label for="f-monto">Monto de la factura</label>' +
            '<input id="f-monto" name="monto" type="number" step="0.01" min="0.01" required inputmode="decimal" placeholder="0.00" value="' + (editing ? editing.monto : '') + '"/>' +

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

  function renderConfigScreen() {
    var cfg = state.config || {};
    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          (state.config ? '<button class="icon-btn" data-action="close-screen">&larr;</button>' : '<div style="width:36px;"></div>') +
          '<h2>Configuración</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<p style="color:var(--text-dim);font-size:13px;">Conecta esta app al repositorio de GitHub donde se guardan los gastos de K-PITAL. Solo se hace una vez por dispositivo.</p>' +
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
          (state.config ? '<div class="btn-row" style="margin-top:26px;"><button type="button" class="btn btn-secondary btn-danger" data-action="reset-config">Desconectar este dispositivo</button></div>' : '') +
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
    else if (action === 'open-form') openNewForm();
    else if (action === 'edit-gasto') openEditForm(target.dataset.id);
    else if (action === 'close-screen') closeScreen();
    else if (action === 'open-config') openConfig();
    else if (action === 'delete-gasto') deleteGasto(target.dataset.id);
    else if (action === 'refresh') refresh();
    else if (action === 'quick-period') setQuickPeriod(target.dataset.range);
    else if (action === 'report-tab') { state.reportTab = target.dataset.rt; render(); }
    else if (action === 'reset-config') resetConfig();
    else if (action === 'toggle-token') toggleTokenVisibility();
  });

  appEl.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    var fd = new FormData(form);
    if (form.dataset.form === 'gasto') onSubmitGastoForm(fd);
    else if (form.dataset.form === 'config') onSubmitConfigForm(fd);
  });

  appEl.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'search-proveedor') { state.search = e.target.value; render(); }
    else if (id === 'period-desde') { state.period.desde = e.target.value; state.quickPeriod = 'custom'; render(); }
    else if (id === 'period-hasta') { state.period.hasta = e.target.value; state.quickPeriod = 'custom'; render(); }
  });

  // ---------- Arranque ----------

  if (!state.config) state.screen = 'config';
  render();
  if (state.config) loadInitialData();

  if ('serviceWorker' in navigator) {
    // Sin service worker por ahora: se evita para que los datos nunca se muestren "viejos" en caché.
  }
})();
