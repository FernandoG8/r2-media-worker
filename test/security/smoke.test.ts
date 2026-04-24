import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('security smoke', () => {
	it('rejects /api/clients requests without X-API-Key', async () => {
		const response = await SELF.fetch('https://example.com/api/clients', {
			headers: { Origin: 'http://localhost:5173' },
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
	});
});
