const APP_CACHE_PREFIX = "pi-web-";
const SERVICE_WORKER_PATH = "/sw.js";

function safeReturnPath(requestUrl: URL): string {
  const requested = requestUrl.searchParams.get("returnTo") ?? "/";
  try {
    const candidate = new URL(requested, requestUrl.origin);
    if (candidate.origin !== requestUrl.origin) return "/";
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return "/";
  }
}

export function GET(request: Request): Response {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const returnPath = safeReturnPath(requestUrl);
  const returnPathJson = JSON.stringify(returnPath).replaceAll("<", "\\u003c");

  return new Response(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>正在恢复 Minerva</title>
    <style>
      :root { color-scheme: light dark; font-family: "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #faf9f5; color: #171613; }
      main { width: min(420px, calc(100vw - 40px)); padding: 28px; border: 1px solid #e3dbcf; border-radius: 16px; background: #fffdf8; text-align: center; }
      strong { font-family: Georgia, serif; font-size: 24px; font-weight: 500; }
      p { color: #68655f; line-height: 1.6; }
      @media (prefers-color-scheme: dark) {
        body { background: #181715; color: #f7f2e9; }
        main { border-color: #3b3832; background: #211f1c; }
        p { color: #aaa69d; }
      }
    </style>
  </head>
  <body>
    <main><strong>Minerva</strong><p>正在清理旧的开发缓存并恢复界面…</p></main>
    <script>
      const returnPath = ${returnPathJson};
      const isMinervaWorker = (registration) =>
        [registration.active, registration.waiting, registration.installing]
          .filter(Boolean)
          .some((worker) => new URL(worker.scriptURL).pathname === ${JSON.stringify(SERVICE_WORKER_PATH)});

      Promise.all([
        "serviceWorker" in navigator
          ? navigator.serviceWorker.getRegistrations().then((registrations) =>
              Promise.all(registrations.filter(isMinervaWorker).map((registration) => registration.unregister())))
          : Promise.resolve([]),
        "caches" in window
          ? caches.keys().then((keys) =>
              Promise.all(keys.filter((key) => key.startsWith(${JSON.stringify(APP_CACHE_PREFIX)})).map((key) => caches.delete(key))))
          : Promise.resolve([]),
      ]).finally(() => location.replace(returnPath));
    </script>
  </body>
</html>`, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
