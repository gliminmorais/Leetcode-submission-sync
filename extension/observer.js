// MAIN world: correlate a successful Submit response with its exact request.
(() => {
  'use strict';

  const origin = 'https://leetcode.com';
  const submitPath = /^\/problems\/([a-z0-9-]{1,200})\/submit\/?$/;
  const numericId = /^[1-9]\d{0,18}$/;

  function submitSlug(input, method) {
    if (String(method).toUpperCase() !== 'POST') return null;
    try {
      const url = new URL(input, location.href);
      return url.origin === origin ? submitPath.exec(url.pathname)?.[1] : null;
    } catch {
      return null;
    }
  }

  function submittedSource(body) {
    if (typeof body !== 'string' || body.length > 600_000) return undefined;
    try {
      const {typed_code: code, lang: language} = JSON.parse(body);
      if (typeof code === 'string' && code.length <= 96 * 1024 &&
          typeof language === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(language)) {
        return {code, language};
      }
    } catch {
      // An unreadable body can still be synced via the saved submission.
    }
  }

  function report(result, slug, submitted) {
    const rawId = result?.submission_id;
    if (typeof rawId !== 'string' && !Number.isSafeInteger(rawId)) return;
    const id = String(rawId);
    if (numericId.test(id)) {
      window.postMessage({kind: 'verdict-sync:submitted', id, slug, ...(submitted ? {submitted} : {})}, origin);
    }
  }

  const fetchPage = window.fetch;
  window.fetch = function (input, init) {
    let slug, source;
    try {
      const request = input instanceof Request ? input : null;
      slug = submitSlug(request?.url ?? input, init?.method ?? request?.method ?? 'GET');
      if (slug && request && init?.body == null) {
        source = request.clone().text().then(submittedSource).catch(() => undefined);
      } else if (slug) {
        source = submittedSource(init?.body);
      }
    } catch {
      // Observation failures must not interfere with the site's request.
    }
    const result = Reflect.apply(fetchPage, this, arguments);
    if (slug) {
      // Clone before the page consumes the response. The original promise is unchanged.
      void result.then(async response => {
        if (!response.ok || (response.url && submitSlug(response.url, 'POST') !== slug)) return;
        const data = await response.clone().json();
        report(data, slug, await source);
      }).catch(() => {});
    }
    return result;
  };

  const xhr = window.XMLHttpRequest.prototype;
  const open = xhr.open;
  const send = xhr.send;
  const submissions = new WeakMap();

  xhr.open = function (method, url) {
    const result = Reflect.apply(open, this, arguments);
    const slug = submitSlug(url, method);
    submissions.set(this, {slug});
    return result;
  };

  xhr.send = function (body) {
    const request = submissions.get(this);
    if (request?.slug) {
      const source = submittedSource(body);
      const onLoad = () => {
        if (submissions.get(this) !== request || this.status < 200 || this.status >= 300 ||
            submitSlug(this.responseURL, 'POST') !== request.slug) return;
        try {
          if (this.responseType === 'json') report(this.response, request.slug, source);
          if (this.responseType === '' || this.responseType === 'text') {
            report(JSON.parse(this.responseText), request.slug, source);
          }
        } catch {
          // The page owns the request and handles its own HTTP or parsing errors.
        }
      };
      this.addEventListener('load', onLoad, {once: true});
      this.addEventListener('loadend', () => this.removeEventListener('load', onLoad), {once: true});
    }
    return Reflect.apply(send, this, arguments);
  };
})();
