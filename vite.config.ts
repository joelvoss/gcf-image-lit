/// <reference types="vitest/config" />

import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { defineConfig, type Plugin, type UserConfig } from 'vite';

////////////////////////////////////////////////////////////////////////////////

const FIXTURES_DIR = join(__dirname, 'tests', 'fixtures');
const CONTENT_TYPES: Record<string, string> = {
	avif: 'image/avif',
	css: 'text/css; charset=utf-8',
	gif: 'image/gif',
	html: 'text/html; charset=utf-8',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	js: 'text/javascript; charset=utf-8',
	png: 'image/png',
	svg: 'image/svg+xml',
	webp: 'image/webp',
};

/**
 * A Vite plugin that serves files from the `tests/fixtures` directory at the `/
 * fixtures` URL path. This allows tests to fetch fixture files without needing
 * to know their exact location on disk, and also ensures that the correct
 * content type is set for each file.
 */
function fixturesPlugin(): Plugin {
	return {
		name: 'fixtures-plugin',
		configureServer(server) {
			server.middlewares.use('/fixtures', async (req, res, next) => {
				if (!req.url) return next();

				const { pathname } = new URL(req.url, 'http://127.0.0.1');
				const filePath = join(
					FIXTURES_DIR,
					normalize(pathname.replace(/^\/fixtures\/?/, '')).replace(
						/^(\.\.(\/|\\|$))+/,
						'',
					),
				);
				const contentType =
					CONTENT_TYPES[extname(filePath).slice(1).toLowerCase()] ??
					'application/octet-stream';

				try {
					const body = await readFile(filePath);
					res.statusCode = 200;
					res.setHeader('Content-Type', contentType);
					res.end(body);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					res.statusCode = code === 'ENOENT' ? 404 : 500;
					res.end(code === 'ENOENT' ? 'Not found' : 'Failed to serve fixture');
				}
			});
		},
	};
}

////////////////////////////////////////////////////////////////////////////////

export default defineConfig((): UserConfig => {
	const isDevHarness = process.env.VITE_DEV_HARNESS === 'true';

	// NOTE(joel): Base configuration
	const config: UserConfig = {
		test: {
			environment: 'node',
			globals: true,
			include: ['tests/**/*.test.ts'],
			silent: 'passed-only',
		},
	};

	// NOTE(joel): Development harness configuration
	if (isDevHarness) {
		config.root = './tests/e2e';
		config.publicDir = false;
		config.plugins = [fixturesPlugin()];
		config.server = {
			host: '127.0.0.1',
			port: 8787,
			strictPort: true,
			proxy: {
				'/optimize': 'http://127.0.0.1:8080',
			},
		};
		return config;
	}

	// NOTE(joel): Build configuration
	config.build = {
		ssr: './src/index.ts',
		minify: false,
		lib: {
			entry: './src/index.ts',
			formats: ['cjs'],
			fileName: () => 'index.js',
		},
		rollupOptions: {
			external: ['@google-cloud/storage', '@hapi/accept', 'cors', 'sharp'],
			output: {
				exports: 'named',
			},
		},
		target: 'node24',
	};

	return config;
});
