import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		include: ['test/**/*.{test,spec}.ts'],
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'html', 'json-summary'],
			reportsDirectory: './coverage',
		},
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						API_SECRET: 'test-api-secret-xyz',
						// AES-256 key de prueba (32 bytes en base64). No es un secret real.
						MASTER_KEY: 'BmSp3pD7YHLEpnGnDOufCASTcgxF82deciU5Cfkoypo=',
					},
				},
			},
		},
	},
});
