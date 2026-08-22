(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReinaGlobalSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ALLOWED_KINDS = ['CLIENT', 'JOB', 'ESTIMATE', 'INVOICE', 'REQUEST'];
  var ALLOWED_VIEWS = ['clients', 'jobs', 'estimates', 'invx', 'rqx'];

  function optionalString(value) {
    return value === null || typeof value === 'string';
  }

  function validResult(item) {
    return Boolean(item && typeof item === 'object'
      && ALLOWED_KINDS.indexOf(item.kind) >= 0
      && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256
      && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 300
      && typeof item.subtitle === 'string' && item.subtitle.length <= 300
      && optionalString(item.status)
      && optionalString(item.updatedAt)
      && (item.amount === null || (typeof item.amount === 'number' && Number.isFinite(item.amount)))
      && item.navigation && typeof item.navigation === 'object'
      && ALLOWED_VIEWS.indexOf(item.navigation.view) >= 0
      && typeof item.navigation.recordType === 'string'
      && typeof item.navigation.recordId === 'string'
      && item.navigation.recordId === item.id);
  }

  function validateEnvelope(status, body) {
    if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (body.ok !== true || typeof body.query !== 'string' || !Array.isArray(body.results) || !Array.isArray(body.unavailable)) return null;
    if (!body.results.every(validResult) || !body.unavailable.every(function (value) { return ALLOWED_KINDS.indexOf(value) >= 0; })) return null;
    return { query: body.query, results: body.results.slice(0, 20), unavailable: body.unavailable.slice() };
  }

  function isDisabledEnvelope(status, body) {
    return status === 503 && body && typeof body === 'object' && !Array.isArray(body)
      && body.ok === false && body.code === 'REINA_SEARCH_DISABLED';
  }

  function create(options) {
    options = options || {};
    var fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    var onState = typeof options.onState === 'function' ? options.onState : function () {};
    var wait = Number.isFinite(options.debounceMs) ? options.debounceMs : 180;
    var timer = null;
    var sequence = 0;

    function emit(state) { onState(state); return state; }

    function search(rawQuery) {
      var query = String(rawQuery || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      sequence += 1;
      var mine = sequence;
      if (timer) clearTimeout(timer);
      if (query.length < 2) return Promise.resolve(emit({ phase: 'idle', query: query, results: [], unavailable: [] }));
      emit({ phase: 'loading', query: query, results: [], unavailable: [] });
      return new Promise(function (resolve) {
        timer = setTimeout(function () {
          if (!fetchImpl) return resolve(emit({ phase: 'error', query: query, results: [], unavailable: [] }));
          fetchImpl('/api/reina-search?q=' + encodeURIComponent(query), { method: 'GET', cache: 'no-store' })
            .then(function (response) {
              return response.json().catch(function () { return null; }).then(function (body) {
                if (mine !== sequence) return null;
                if (isDisabledEnvelope(response.status, body)) {
                  return emit({ phase: 'disabled', query: query, results: [], unavailable: [] });
                }
                var valid = validateEnvelope(response.status, body);
                if (!valid) return emit({ phase: 'error', query: query, results: [], unavailable: [] });
                return emit({ phase: 'ready', query: query, results: valid.results, unavailable: valid.unavailable });
              });
            })
            .catch(function () {
              if (mine !== sequence) return null;
              return emit({ phase: 'error', query: query, results: [], unavailable: [] });
            })
            .then(resolve);
        }, wait);
      });
    }

    function dispose() {
      sequence += 1;
      if (timer) clearTimeout(timer);
      timer = null;
    }

    return { search: search, dispose: dispose };
  }

  return { create: create, validateEnvelope: validateEnvelope, validResult: validResult, isDisabledEnvelope: isDisabledEnvelope };
});
