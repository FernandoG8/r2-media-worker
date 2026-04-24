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
			},
		},
	},
});
