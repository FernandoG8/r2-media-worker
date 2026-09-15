import { describe, expect, it } from 'vitest';
import { resolveOrigin } from '../../src/cors';

describe('unit smoke', () => {
	it('imports src code and resolves an allowlisted origin', () => {
		const request = new Request('https://example.com', {
			headers: { Origin: 'http://localhost:5173' },
		});

		const origin = resolveOrigin(request, { ALLOWED_ORIGIN: 'https://panel.mizcor.dev' } as never);

		expect(origin).toBe('http://localhost:5173');
	});
});
