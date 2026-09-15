import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: {
					API_SECRET: 'test-api-secret-xyz',
					MASTER_KEY: 'BmSp3pD7YHLEpnGnDOufCASTcgxF82deciU5Cfkoypo=',
				},
			},
		}),
	],
	test: {
		include: ['test/**/*.{test,spec}.ts'],
		setupFiles: ['./test/setup.ts'],
	},
});
