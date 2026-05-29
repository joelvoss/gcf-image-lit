import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleGet } from '../src/handler';
import * as shared from '../src/shared';
import { getHash } from '../src/shared';

////////////////////////////////////////////////////////////////////////////////
// Mocks and test setup

const mocks = vi.hoisted(() => {
	const transformer = {
		rotate: vi.fn(),
		metadata: vi.fn().mockResolvedValue({ width: 1200 }),
		resize: vi.fn(),
		avif: vi.fn(),
		webp: vi.fn(),
		png: vi.fn(),
		jpeg: vi.fn(),
		toBuffer: vi.fn().mockResolvedValue(Buffer.from('optimized')),
	};
	const sharp = vi.fn(() => transformer);

	return { sharp, transformer };
});

vi.mock('sharp', () => ({ default: mocks.sharp }));

const tempDirs = new Set<string>();
const fixturesDir = join(import.meta.dirname, 'fixtures');

function stubHandlerEnv(values: Record<string, string>) {
	for (const [key, value] of Object.entries(values)) {
		vi.stubEnv(key, value);
	}
}

class ResponseDouble extends Writable {
	headers = new Map<string, string | string[]>();
	statusCode = 200;
	private readonly chunks: Buffer[] = [];

	setHeader(name: string, value: string | string[]) {
		this.headers.set(name, value);
	}

	_write(
		chunk: string | Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	) {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		callback();
	}

	get body() {
		return Buffer.concat(this.chunks);
	}

	get text() {
		return this.body.toString('utf8');
	}
}

async function createTempDir() {
	const directory = await mkdtemp(join(tmpdir(), 'gcf-image-handler-'));
	tempDirs.add(directory);
	return directory;
}

async function seedSourceFile(
	sourceDir: string,
	fileName: string,
	fixtureName: string,
) {
	const buffer = await readFile(join(fixturesDir, fixtureName));
	return seedSourceBuffer(sourceDir, fileName, buffer);
}

async function seedSourceBuffer(
	sourceDir: string,
	fileName: string,
	buffer: Buffer,
) {
	const filePath = join(sourceDir, fileName.replace(/^\//, ''));
	await mkdir(join(filePath, '..'), { recursive: true });
	await writeFile(filePath, buffer);
	return buffer;
}

function createRequest(
	overrides: {
		headers?: Record<string, string>;
		query?: Record<string, string | string[]>;
		url?: null;
	} = {},
) {
	if (overrides.url === null) {
		return {
			method: 'GET',
			headers: overrides.headers ?? {},
			url: undefined,
		};
	}

	const query = overrides.query ?? {
		url: '/default.png',
		w: '640',
		q: '75',
	};
	const url = new URL('http://127.0.0.1/optimize');

	for (const [key, value] of Object.entries(query)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				url.searchParams.append(key, item);
			}
		} else {
			url.searchParams.append(key, value);
		}
	}

	return {
		method: 'GET',
		headers: overrides.headers ?? {},
		url: `${url.pathname}${url.search}`,
	};
}

////////////////////////////////////////////////////////////////////////////////
// Test cases

describe('handleGet', () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		stubHandlerEnv({
			STORAGE_BACKEND: 'local',
			FILE_DIR: 'variants',
			LOCAL_CACHE_CONTROL: 'public, max-age=120',
		});
		mocks.sharp.mockClear();
		mocks.transformer.rotate.mockReset();
		mocks.transformer.metadata.mockReset();
		mocks.transformer.metadata.mockResolvedValue({ width: 1200 });
		mocks.transformer.resize.mockReset();
		mocks.transformer.avif.mockReset();
		mocks.transformer.webp.mockReset();
		mocks.transformer.png.mockReset();
		mocks.transformer.jpeg.mockReset();
		mocks.transformer.toBuffer.mockReset();
		mocks.transformer.toBuffer.mockResolvedValue(Buffer.from('optimized'));
		vi.clearAllMocks();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();

		for (const directory of tempDirs) {
			await rm(directory, { recursive: true, force: true });
		}
		tempDirs.clear();
	});

	it('fails when the request URL is missing', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({ SRC_DIR: sourceDir, DIST_DIR: cacheDir });
		const res = new ResponseDouble();

		await handleGet(createRequest({ url: null }) as never, res as never);
		await finished(res);

		expect(res.statusCode).toBe(400);
		expect(res.text).toBe('Missing request url.');
	});

	it.each([
		[{ w: '640', q: '75' }, '"url" parameter is required'],
		[{ url: '/default.png', q: '75' }, '"w" parameter (width) is required'],
		[
			{ url: '/default.png', w: '999', q: '75' },
			'"w" parameter (width) of 999 is not allowed',
		],
		[
			{ url: '/default.png', w: '640', q: '101' },
			'"q" parameter (quality) must be a number between 1 and 100',
		],
		[
			{ url: '/default.png', w: '640', q: '75', f: 'bmp' },
			'"f" parameter (format) of bmp is not allowed',
		],
	])('rejects invalid query %j', async (query, message) => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({ SRC_DIR: sourceDir, DIST_DIR: cacheDir });
		const res = new ResponseDouble();

		await handleGet(createRequest({ query }) as never, res as never);
		await finished(res);

		expect(res.statusCode).toBe(400);
		expect(res.text).toBe(message);
	});

	it('serves cached files directly from the local cache directory', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({
			SRC_DIR: sourceDir,
			DIST_DIR: cacheDir,
			FILE_DIR: 'variants',
		});
		const hash = getHash([1, '/default.png', 640, 75]);
		const cacheSubdir = join(cacheDir, 'variants', hash);
		const etag = 'fresh-etag';
		const cachedBuffer = Buffer.from('cached-image');

		await mkdir(cacheSubdir, { recursive: true });
		await writeFile(join(cacheSubdir, `${etag}.300.webp`), cachedBuffer);

		const req = createRequest({ headers: { accept: 'image/webp,image/*' } });
		const res = new ResponseDouble();

		await handleGet(req as never, res as never);
		await finished(res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual(cachedBuffer);
		expect(res.headers.get('Cache-Control')).toBe(
			'public, max-age=300, must-revalidate',
		);
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('ETag')).toBe(`"${etag}"`);
		expect(res.headers.get('Vary')).toBe('Accept, Accept-Encoding');
	});

	it('prefers a negotiated cached variant over an earlier jpeg fallback', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({
			SRC_DIR: sourceDir,
			DIST_DIR: cacheDir,
			FILE_DIR: 'variants',
		});
		const hash = getHash([1, '/default.png', 640, 75]);
		const cacheSubdir = join(cacheDir, 'variants', hash);
		const jpegBuffer = Buffer.from('jpeg-cached-image');
		const webpBuffer = Buffer.from('webp-cached-image');

		await mkdir(cacheSubdir, { recursive: true });
		await writeFile(join(cacheSubdir, `jpeg-etag.300.jpeg`), jpegBuffer);
		await writeFile(join(cacheSubdir, `webp-etag.300.webp`), webpBuffer);

		const req = createRequest({ headers: { accept: 'image/webp,image/*' } });
		const res = new ResponseDouble();

		await handleGet(req as never, res as never);
		await finished(res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual(webpBuffer);
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('ETag')).toBe('"webp-etag"');
		expect(res.headers.get('Vary')).toBe('Accept, Accept-Encoding');
	});

	it('rebuilds when an explicit format has no matching cached variant', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({
			SRC_DIR: sourceDir,
			DIST_DIR: cacheDir,
			FILE_DIR: 'variants',
		});
		await seedSourceFile(sourceDir, '/default.png', 'default.png');
		const hash = getHash([1, '/default.png', 640, 75]);
		const cacheSubdir = join(cacheDir, 'variants', hash);

		await mkdir(cacheSubdir, { recursive: true });
		await writeFile(
			join(cacheSubdir, 'webp-etag.300.webp'),
			Buffer.from('webp-cached-image'),
		);

		const req = createRequest({
			headers: { accept: 'image/webp,image/*' },
			query: { url: '/default.png', w: '640', q: '75', f: 'png' },
		});
		const res = new ResponseDouble();

		await handleGet(req as never, res as never);
		await finished(res);

		expect(mocks.transformer.png).toHaveBeenCalledWith({ quality: 75 });
		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(res.body).toEqual(Buffer.from('optimized'));
	});

	it('returns 304 when a cached etag is still fresh', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({
			SRC_DIR: sourceDir,
			DIST_DIR: cacheDir,
			FILE_DIR: 'variants',
		});
		const hash = getHash([1, '/default.png', 640, 75]);
		const cacheSubdir = join(cacheDir, 'variants', hash);
		const etag = 'fresh-etag';

		await mkdir(cacheSubdir, { recursive: true });
		await writeFile(
			join(cacheSubdir, `${etag}.300.jpeg`),
			Buffer.from('cached-image'),
		);

		const req = createRequest({ headers: { 'if-none-match': `"${etag}"` } });
		const res = new ResponseDouble();

		await handleGet(req as never, res as never);
		await finished(res);

		expect(res.statusCode).toBe(304);
		expect(res.body).toEqual(Buffer.alloc(0));
		expect(res.headers.get('ETag')).toBe(`"${etag}"`);
	});

	it.each([
		['/animated.gif', 'gif', 'image/gif'],
		['/animated.png', 'png', 'image/png'],
		['/vector.svg', 'svg', 'image/svg+xml'],
	])(
		'reuses cached passthrough %s variants without refetching upstream',
		async (url, extension, contentType) => {
			const sourceDir = await createTempDir();
			const cacheDir = await createTempDir();
			stubHandlerEnv({
				SRC_DIR: sourceDir,
				DIST_DIR: cacheDir,
				FILE_DIR: 'variants',
			});
			const hash = getHash([1, url, 'passthrough']);
			const cacheSubdir = join(cacheDir, 'variants', hash);
			const cachedBuffer = Buffer.from(`${extension}-cached-image`);

			await mkdir(cacheSubdir, { recursive: true });
			await writeFile(
				join(cacheSubdir, `cached-etag.300.${extension}`),
				cachedBuffer,
			);

			const res = new ResponseDouble();

			await handleGet(
				createRequest({ query: { url, w: '640', q: '75' } }) as never,
				res as never,
			);
			await finished(res);

			expect(res.statusCode).toBe(200);
			expect(res.body).toEqual(cachedBuffer);
			expect(res.headers.get('Content-Type')).toBe(contentType);
			expect(mocks.sharp).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			'response status codes',
			Object.assign(new Error('missing'), { response: { statusCode: 404 } }),
			404,
		],
		[
			'numeric error codes',
			Object.assign(new Error('forbidden'), { code: 403 }),
			403,
		],
	])(
		'preserves remote GCS %s when upstream reads fail',
		async (_label, error, statusCode) => {
			const sourceDir = await createTempDir();
			const cacheDir = await createTempDir();
			await seedSourceFile(sourceDir, '/default.png', 'default.png');
			stubHandlerEnv({ SRC_DIR: sourceDir, DIST_DIR: cacheDir });
			vi.spyOn(shared, 'getFileBuffer').mockRejectedValueOnce(error);
			const res = new ResponseDouble();

			await handleGet(createRequest() as never, res as never);
			await finished(res);

			expect(res.statusCode).toBe(statusCode);
			expect(res.text).toBe(
				'"url" parameter is valid but upstream response is invalid',
			);
		},
	);

	it('optimizes raster images, writes them to cache, and serves the result', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({ SRC_DIR: sourceDir, DIST_DIR: cacheDir });
		const sourceBuffer = await seedSourceFile(
			sourceDir,
			'/default.png',
			'default.png',
		);

		const optimizedBuffer = Buffer.from('optimized-buffer');
		mocks.transformer.toBuffer.mockResolvedValue(optimizedBuffer);

		const req = createRequest({ headers: { accept: 'image/webp,image/*' } });
		const res = new ResponseDouble();

		await handleGet(req as never, res as never);
		await finished(res);

		const hash = getHash([1, '/default.png', 640, 75]);
		const cachedFiles = await readdir(join(cacheDir, 'variants', hash));

		expect(mocks.transformer.rotate).toHaveBeenCalled();
		expect(mocks.transformer.resize).toHaveBeenCalledWith(640);
		expect(mocks.transformer.webp).toHaveBeenCalledWith({ quality: 75 });
		expect(mocks.sharp).toHaveBeenCalledWith(sourceBuffer, {
			limitInputPixels: 100_000_000,
			pages: 1,
		});
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.body).toEqual(optimizedBuffer);
		expect(cachedFiles).toHaveLength(1);
		expect(cachedFiles[0]).toMatch(/^.+\.120\.webp$/);
	});

	it('rejects unsupported upstream content types', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({ SRC_DIR: sourceDir, DIST_DIR: cacheDir });
		await seedSourceBuffer(
			sourceDir,
			'/document.txt',
			Buffer.from('not an image'),
		);
		const res = new ResponseDouble();

		await handleGet(
			createRequest({
				query: { url: '/document.txt', w: '640', q: '75' },
			}) as never,
			res as never,
		);
		await finished(res);

		expect(res.statusCode).toBe(415);
		expect(res.text).toBe('Unsupported upstream content type');
		expect(mocks.sharp).not.toHaveBeenCalled();
	});

	it('rejects oversized source objects before optimization', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({
			SRC_DIR: sourceDir,
			DIST_DIR: cacheDir,
			MAX_SOURCE_BYTES: '4',
		});
		await seedSourceFile(sourceDir, '/default.png', 'default.png');
		const res = new ResponseDouble();

		await handleGet(createRequest() as never, res as never);
		await finished(res);

		expect(res.statusCode).toBe(413);
		expect(res.text).toBe(
			'"url" parameter is valid but upstream response is invalid',
		);
		expect(mocks.sharp).not.toHaveBeenCalled();
	});

	it('respects private upstream cache-control and does not write cache files', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({
			SRC_DIR: sourceDir,
			DIST_DIR: cacheDir,
			LOCAL_CACHE_CONTROL: 'private, max-age=0',
		});
		await seedSourceFile(sourceDir, '/default.png', 'default.png');
		const res = new ResponseDouble();

		await handleGet(createRequest() as never, res as never);
		await finished(res);

		const hash = getHash([1, '/default.png', 640, 75]);

		expect(res.headers.get('Cache-Control')).toBe('no-store');
		await expect(
			readdir(join(cacheDir, 'variants', hash)),
		).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('sends no body for HEAD responses', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({ SRC_DIR: sourceDir, DIST_DIR: cacheDir });
		await seedSourceFile(sourceDir, '/default.png', 'default.png');
		const res = new ResponseDouble();

		await handleGet(
			{ ...createRequest(), method: 'HEAD' } as never,
			res as never,
		);
		await finished(res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual(Buffer.alloc(0));
		expect(res.headers.get('Content-Type')).toBe('image/png');
	});

	it('rejects images that exceed the configured page limit', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({ SRC_DIR: sourceDir, DIST_DIR: cacheDir });
		await seedSourceFile(sourceDir, '/default.png', 'default.png');
		mocks.transformer.metadata.mockResolvedValueOnce({ pages: 2, width: 640 });
		const res = new ResponseDouble();

		await handleGet(createRequest() as never, res as never);
		await finished(res);

		expect(res.statusCode).toBe(413);
		expect(res.text).toBe('Source image exceeds maximum page count');
		expect(mocks.transformer.toBuffer).not.toHaveBeenCalled();
	});

	it('passes animated images through without invoking sharp', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({ SRC_DIR: sourceDir, DIST_DIR: cacheDir });
		const animatedBuffer = await seedSourceFile(
			sourceDir,
			'/animated.gif',
			'animated.gif',
		);

		const req = createRequest({
			query: { url: '/animated.gif', w: '640', q: '75' },
		});
		const res = new ResponseDouble();

		await handleGet(req as never, res as never);
		await finished(res);

		const hash = getHash([1, '/animated.gif', 'passthrough']);
		const cachedFiles = await readdir(join(cacheDir, 'variants', hash));

		expect(mocks.sharp).not.toHaveBeenCalled();
		expect(res.headers.get('Content-Type')).toBe('image/gif');
		expect(res.body).toEqual(animatedBuffer);
		expect(cachedFiles[0]).toMatch(/^.+\.120\.gif$/);
	});

	it('parses size overrides from env strings before validating widths', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		stubHandlerEnv({
			SRC_DIR: sourceDir,
			DIST_DIR: cacheDir,
			DEVICE_SIZES: '777,888',
			IMAGE_SIZES: '123,456',
		});
		await seedSourceFile(sourceDir, '/default.png', 'default.png');

		const res = new ResponseDouble();

		await handleGet(
			createRequest({
				query: { url: '/default.png', w: '123', q: '75' },
			}) as never,
			res as never,
		);
		await finished(res);

		expect(res.statusCode).toBe(200);
		expect(mocks.transformer.resize).toHaveBeenCalledWith(123);
	});

	it('falls back to the source image when a cached read fails', async () => {
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		await seedSourceFile(sourceDir, '/default.png', 'default.png');
		stubHandlerEnv({ SRC_DIR: sourceDir, DIST_DIR: cacheDir });

		const readError = new Error('cache stream failed');
		const warnSpy = vi
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const readSpy = vi.spyOn(shared, 'readFromCacheDir');
		readSpy.mockResolvedValueOnce([
			{
				name: 'variants/broken/cached-etag.300.webp',
				createReadStream() {
					return new Readable({
						read() {
							this.destroy(readError);
						},
					});
				},
			},
		]);
		readSpy.mockResolvedValueOnce([]);

		const optimizedBuffer = Buffer.from('optimized-after-cache-failure');
		mocks.transformer.toBuffer.mockResolvedValue(optimizedBuffer);

		const res = new ResponseDouble();

		await handleGet(createRequest() as never, res as never);
		await finished(res);

		expect(warnSpy).toHaveBeenCalled();
		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual(optimizedBuffer);
		expect(res.headers.get('Content-Type')).toBe('image/png');
	});
});
