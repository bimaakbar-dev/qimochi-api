import type { Env } from '../env';

export interface Ctx {
  request: Request;
  env: Env;
  exec: ExecutionContext;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { pattern: new RegExp(`^${source}$`), keys };
}

export function createRouter() {
  const routes: Route[] = [];

  function add(method: string, path: string, handler: Handler): void {
    const { pattern, keys } = compile(path);
    routes.push({ method, pattern, keys, handler });
  }

  return {
    get: (path: string, handler: Handler) => add('GET', path, handler),
    post: (path: string, handler: Handler) => add('POST', path, handler),
    delete: (path: string, handler: Handler) => add('DELETE', path, handler),
    options: (path: string, handler: Handler) => add('OPTIONS', path, handler),

    match(
      method: string,
      path: string
    ): { handler: Handler; params: Record<string, string> } | null {
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = path.match(route.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(m[i + 1] ?? '');
        });
        return { handler: route.handler, params };
      }
      return null;
    },
  };
}

export type Router = ReturnType<typeof createRouter>;