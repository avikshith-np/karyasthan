// Hash router with a generation token and a per-page cleanup context (spec 007 R11).
//
// Every navigation bumps the generation and builds a fresh `ctx`:
//   ctx.gen / ctx.alive()           is this page still the current one?
//   ctx.signal                      aborts the page's fetches on navigation
//   ctx.on(topic, fn, opts)         shared-stream subscription, dropped on navigation
//   ctx.listen(target, evt, fn)     DOM listener, removed on navigation
//   ctx.setInterval / setTimeout    timers, cleared on navigation
//   ctx.onDispose(fn)               anything else
//   ctx.root, ctx.route, ctx.params
// The previous ctx is disposed before the next page mounts, so no handler from a
// page you left can fire, and an async render that finishes late sees
// ctx.alive() === false and must not write.
//
// Dependencies are injected (window, stream) so this module also
// loads in node for tests.

export function createRouter({
  routes,
  win = globalThis.window,
  root = null,
  stream = null,
  onRoute = () => {},
  onUnknown = () => {},
  onError = () => {},
} = {}) {
  let gen = 0;
  let current = null; // { ctx, route }
  let started = false;

  function makeCtx(route, params) {
    const myGen = gen;
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const disposers = [];
    let disposed = false;
    const ctx = {
      gen: myGen,
      route,
      params,
      root: typeof root === 'function' ? root() : root,
      signal: ac?.signal,
      alive: () => !disposed && myGen === gen,
      onDispose(fn) {
        if (disposed) { try { fn(); } catch {} return; }
        disposers.push(fn);
      },
      on(topic, fn, opts) {
        if (!stream) return () => {};
        const off = stream().subscribe(topic, (d, e) => { if (ctx.alive()) fn(d, e); }, opts);
        ctx.onDispose(off);
        return off;
      },
      onStreamState(fn) {
        if (!stream) return () => {};
        const off = stream().onState((s) => { if (ctx.alive()) fn(s); });
        ctx.onDispose(off);
        return off;
      },
      listen(target, evt, fn, opts) {
        if (!target) return () => {};
        const h = (e) => { if (ctx.alive()) fn(e); };
        target.addEventListener(evt, h, opts);
        const off = () => target.removeEventListener(evt, h, opts);
        ctx.onDispose(off);
        return off;
      },
      setInterval(fn, ms) {
        const id = (win?.setInterval || setInterval)(() => { if (ctx.alive()) fn(); }, ms);
        ctx.onDispose(() => (win?.clearInterval || clearInterval)(id));
        return id;
      },
      setTimeout(fn, ms) {
        const id = setTimeout(() => { if (ctx.alive()) fn(); }, ms);
        ctx.onDispose(() => clearTimeout(id));
        return id;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try { ac?.abort(); } catch {}
        while (disposers.length) {
          const fn = disposers.pop();
          try { fn(); } catch (err) { console.error('dispose', err); }
        }
      },
    };
    return ctx;
  }

  function match(hash) {
    const h = hash || '#life';
    for (const r of routes) {
      const m = h.match(r.re);
      if (m) return { route: r, params: m.slice(1).map((p) => { try { return decodeURIComponent(p); } catch { return p; } }) };
    }
    return null;
  }

  async function navigate(hash = win?.location?.hash) {
    if (current) current.ctx.dispose();
    gen++;
    const hit = match(hash);
    if (!hit) {
      current = null;
      onUnknown(hash);
      return;
    }
    const ctx = makeCtx(hit.route, hit.params);
    current = { ctx, route: hit.route };
    try {
      onRoute(hit.route, ctx);
      if (hit.route.load) {
        const mod = await hit.route.load();
        if (!ctx.alive()) return;
        await mod.mount(ctx, ...hit.params);
      } else {
        onUnknown(hash);
      }
    } catch (err) {
      if (ctx.alive() && err?.name !== 'AbortError') onError(err, ctx);
    }
  }

  const onHash = () => { navigate(win.location.hash); };

  return {
    navigate,
    start() {
      if (started) return;
      started = true;
      win.addEventListener('hashchange', onHash);
      return navigate(win.location.hash);
    },
    stop() {
      if (started) win.removeEventListener('hashchange', onHash);
      started = false;
      if (current) current.ctx.dispose();
      current = null;
      gen++;
    },
    generation: () => gen,
    current: () => current,
  };
}
