import type { Env } from './types';
import { handleRequest } from './router';
import { corsHeaders, resolveOrigin } from './cors';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      // Unhandled exceptions must still carry CORS headers so the browser
      // can read the error response instead of seeing an opaque network failure.
      const origin = resolveOrigin(request, env);
      const msg = err instanceof Error ? err.message : 'Internal server error';
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(origin),
        },
      });
    }
  },
};
