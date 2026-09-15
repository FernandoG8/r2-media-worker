import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('integration smoke', () => {
	it('responds to preflight requests with CORS headers', async () => {
		const response = await SELF.fetch('https://example.com/api/clients', {
			method: 'OPTIONS',
			headers: { Origin: 'http://localhost:5173' },
		});

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
		expect(response.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
		expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-API-Key');
	});
});
