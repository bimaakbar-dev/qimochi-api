import type { Env } from './env';
import { createRouter } from './lib/router';
import { json, error, corsHeaders } from './lib/response';
import { mountRatings } from './routes/ratings';
import { mountAuth } from './routes/auth';
import { mountComments } from './routes/comments';
import { mountBot } from './routes/bot';
import { mountTelegram } from './routes/telegram';
import { mountReactions } from './routes/reactions';

const router = createRouter();
mountRatings(router);
mountAuth(router);
mountComments(router);
mountBot(router);
mountTelegram(router);
mountReactions(router);

export default {
  async fetch(
    request: Request,
    env: Env,
    exec: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ name: 'Qimochi API', version: 'v1', status: 'ok' }, env);
    }

    const matched = router.match(request.method, url.pathname);
    if (!matched) {
      return error('NOT_FOUND', `Path ${url.pathname} tidak ditemukan`, env, 404);
    }

    try {
      return await matched.handler({
        request,
        env,
        exec,
        url,
        params: matched.params,
      });
    } catch (err) {
      console.error('[worker error]', err);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return error('INTERNAL_ERROR', `Server error: ${msg}`, env, 500);
    }
  },
} satisfies ExportedHandler<Env>;
