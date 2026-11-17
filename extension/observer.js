// MAIN world: observe LeetCode's own Submit response without reading request bodies.
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

  function report(result, slug) {
    const rawId = result?.submission_id;
    if (typeof rawId !== 'number' && typeof rawId !== 'string') return;
    const id = String(rawId);
    if (numericId.test(id)) window.postMessage({kind: 'verdict-sync:submitted', id, slug}, origin);
  }

  const fetchPage = window.fetch;
  window.fetch = function (input, init) {
    const result = Reflect.apply(fetchPage, this, arguments);
    try {
      const request = input instanceof Request ? input : null;
      const slug = submitSlug(request?.url ?? input, init?.method ?? request?.method ?? 'GET');
      if (slug) {
        // Clone before the page consumes the body. The original response and promise are unchanged.
        void result.then(response => {
          if (!response.ok || (response.url && submitSlug(response.url, 'POST') !== slug)) return;
          return response.clone().json().then(data => report(data, slug));
        }).catch(() => {});
      }
    } catch {
      // Observation failures must not interfere with the site's request.
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

  xhr.send = function () {
    const request = submissions.get(this);
    if (request?.slug) {
      const onLoad = () => {
        if (submissions.get(this) !== request || this.status < 200 || this.status >= 300 ||
            submitSlug(this.responseURL, 'POST') !== request.slug) return;
        try {
          if (this.responseType === 'json') report(this.response, request.slug);
          if (this.responseType === '' || this.responseType === 'text') {
            report(JSON.parse(this.responseText), request.slug);
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
