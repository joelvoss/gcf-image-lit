import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	checkResponseFreshness,
	fileExists,
	getCachePolicy,
	getContentType,
	getExtension,
	getFileBuffer,
	getHash,
	getMaxAge,
	getSupportedMimeType,
	isAnimated,
	parseQuery,
	readFromCacheDir,
	sendEtagResponse,
	sendResponse,
	writeToCacheDir,
} from '../src/shared';

////////////////////////////////////////////////////////////////////////////////
// Mocks and test setup

const mocks = vi.hoisted(() => {
	const file = {
		getMetadata: vi.fn(),
		createReadStream: vi.fn(),
		save: vi.fn(),
	};
	const bucket = {
		file: vi.fn(() => file),
		getFiles: vi.fn(),
	};
	const storage = {
		bucket: vi.fn(() => bucket),
	};

	return { file, bucket, storage };
});

vi.mock('@google-cloud/storage', () => ({
	Storage: vi.fn(function Storage() {
		return mocks.storage;
	}),
}));

const tempDirs = new Set<string>();

async function createTempDir() {
	const directory = await mkdtemp(join(tmpdir(), 'gcf-image-lit-tests-'));
	tempDirs.add(directory);
	return directory;
}

////////////////////////////////////////////////////////////////////////////////
// Test cases

describe('shared helpers', () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		mocks.file.getMetadata.mockReset();
		mocks.file.createReadStream.mockReset();
		mocks.file.save.mockReset();
		mocks.bucket.file.mockClear();
		mocks.bucket.getFiles.mockReset();
		mocks.storage.bucket.mockClear();
	});

	afterEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();

		for (const directory of tempDirs) {
			await rm(directory, { recursive: true, force: true });
		}
		tempDirs.clear();
	});

	it('parses query strings into single values and arrays', () => {
		expect(parseQuery('/optimize?url=%2Fimage.png&w=640&q=75&q=80')).toEqual({
			url: '/image.png',
			w: '640',
			q: ['75', '80'],
		});
	});

	it('selects MIME types and cache ages predictably', () => {
		expect(
			getSupportedMimeType(
				['image/avif', 'image/webp'],
				'image/webp,image/apng,*/*;q=0.8',
			),
		).toBe('image/webp');
		expect(getSupportedMimeType(['image/avif'], 'image/png,image/jpeg')).toBe(
			'',
		);
		expect(getContentType('jpg')).toBe('image/jpeg');
		expect(getExtension('image/svg+xml')).toBe('svg');
		expect(getMaxAge('public, s-maxage="120", max-age=60')).toBe(120);
		expect(getMaxAge(['private, max-age=10'], 60)).toBe(0);
		expect(getCachePolicy('private, max-age=10', 60)).toEqual({
			cacheable: false,
			cacheControl: 'no-store',
			maxAge: 0,
		});
		expect(getCachePolicy('public, max-age=10', 60)).toEqual({
			cacheable: true,
			cacheControl: 'public, max-age=10, must-revalidate',
			maxAge: 10,
		});
	});

	it('supports wildcard Accept negotiation for modern image formats', () => {
		expect(getSupportedMimeType(['image/avif', 'image/webp'], 'image/*')).toBe(
			'image/avif',
		);
		expect(getSupportedMimeType(['image/avif', 'image/webp'], '*/*')).toBe(
			'image/avif',
		);
		expect(getSupportedMimeType(['image/avif', 'image/webp'], '')).toBe('');
	});

	it('detects animated image fixtures', async () => {
		const fixturesDir = join(import.meta.dirname, 'fixtures');

		expect(isAnimated(await readFile(join(fixturesDir, 'default.png')))).toBe(
			false,
		);
		expect(isAnimated(await readFile(join(fixturesDir, 'animated.png')))).toBe(
			true,
		);
		expect(isAnimated(await readFile(join(fixturesDir, 'default.gif')))).toBe(
			false,
		);
		expect(isAnimated(await readFile(join(fixturesDir, 'animated.gif')))).toBe(
			true,
		);
		expect(isAnimated(await readFile(join(fixturesDir, 'default.webp')))).toBe(
			false,
		);
		expect(isAnimated(await readFile(join(fixturesDir, 'animated.webp')))).toBe(
			true,
		);
	});

	it('treats truncated PNG-like input as non-animated without throwing', () => {
		expect(isAnimated(Buffer.from('89504e470d0a1a0a000000', 'hex'))).toBe(
			false,
		);
	});

	it('uses etags and freshness checks when sending responses', () => {
		const buffer = Buffer.from('payload');
		const freshRes = {
			statusCode: 200,
			setHeader: vi.fn(),
			end: vi.fn(),
		};
		const staleRes = {
			statusCode: 200,
			setHeader: vi.fn(),
			end: vi.fn(),
		};

		expect(
			checkResponseFreshness({ 'if-none-match': '"etag"' }, { etag: '"etag"' }),
		).toBe(true);
		expect(
			sendEtagResponse(
				{ headers: { 'if-none-match': '"fresh"' } },
				freshRes,
				'"fresh"',
			),
		).toBe(true);
		expect(freshRes.statusCode).toBe(304);
		expect(freshRes.end).toHaveBeenCalledWith();
		expect(freshRes.setHeader).toHaveBeenCalledWith('ETag', '"fresh"');

		sendResponse({ headers: {} }, staleRes, 'image/png', 120, buffer);

		expect(staleRes.setHeader).toHaveBeenCalledWith(
			'Cache-Control',
			'public, max-age=120, must-revalidate',
		);
		expect(staleRes.setHeader).toHaveBeenCalledWith(
			'ETag',
			`"${getHash([buffer])}"`,
		);
		expect(staleRes.setHeader).toHaveBeenCalledWith(
			'Content-Type',
			'image/png',
		);
		expect(staleRes.end).toHaveBeenCalledWith(buffer);
		expect(
			checkResponseFreshness(
				{ 'if-none-match': `W/"${getHash([buffer])}"` },
				{ etag: `"${getHash([buffer])}"` },
			),
		).toBe(true);
	});

	it('reads and writes files in local storage mode', async () => {
		vi.stubEnv('STORAGE_BACKEND', 'local');
		const sourceDir = await createTempDir();
		const cacheDir = await createTempDir();
		const sourceBuffer = Buffer.from('source-file');

		vi.stubEnv('LOCAL_CACHE_CONTROL', 'public, max-age=120');
		await writeFile(join(sourceDir, 'image.png'), sourceBuffer);

		const metadata = await fileExists(sourceDir, '/image.png');
		const upstream = await getFileBuffer(sourceDir, '/image.png');
		await writeToCacheDir(
			cacheDir,
			'variants',
			'image/webp',
			300,
			Buffer.from('optimized-file'),
		);
		const files = await readFromCacheDir(cacheDir, 'variants');

		expect(metadata).toMatchObject({
			name: 'image.png',
			size: String(sourceBuffer.length),
		});
		expect(upstream).toEqual({
			data: sourceBuffer,
			response: {
				statusCode: 200,
				headers: {
					'cache-control': 'public, max-age=120',
					'content-type': 'image/png',
					'last-modified': expect.any(String),
				},
			},
		});
		expect(files).toHaveLength(1);
		expect(files[0]?.name).toMatch(/^variants\/.+\.300\.webp$/);
	});

	it('rejects local storage reads that escape the configured directory', async () => {
		vi.stubEnv('STORAGE_BACKEND', 'local');
		const sourceDir = await createTempDir();
		const outsideDir = await createTempDir();
		const outsideFile = join(outsideDir, 'secret.txt');
		const escapedPath = `/${relative(sourceDir, outsideFile).replace(/\\/g, '/')}`;

		await writeFile(outsideFile, Buffer.from('secret'));

		await expect(getFileBuffer(sourceDir, escapedPath)).rejects.toMatchObject({
			response: { statusCode: 404 },
		});
	});

	it('rejects local files larger than the configured byte limit', async () => {
		vi.stubEnv('STORAGE_BACKEND', 'local');
		const sourceDir = await createTempDir();

		await writeFile(join(sourceDir, 'image.png'), Buffer.from('too-large'));

		await expect(
			getFileBuffer(sourceDir, '/image.png', 4),
		).rejects.toMatchObject({
			response: { statusCode: 413 },
		});
	});

	it('wraps the Cloud Storage client in remote mode', async () => {
		const stream = Readable.from([Buffer.from('hello'), Buffer.from(' world')]);

		mocks.file.getMetadata.mockResolvedValue([{ name: 'image.png' }]);
		mocks.file.createReadStream.mockReturnValue(stream);
		mocks.bucket.getFiles.mockResolvedValue([[{ name: 'cache/file.webp' }]]);

		process.nextTick(() => {
			stream.emit('response', {
				statusCode: 200,
				headers: { 'content-type': 'image/png' },
			});
		});

		expect(await fileExists('source-bucket', 'image.png')).toEqual({
			name: 'image.png',
		});
		expect(await getFileBuffer('source-bucket', 'image.png')).toEqual({
			data: Buffer.from('hello world'),
			response: {
				statusCode: 200,
				headers: { 'content-type': 'image/png' },
			},
		});

		await writeToCacheDir(
			'cache-bucket',
			'hash-dir',
			'image/webp',
			3600,
			Buffer.from('optimized'),
		);
		expect(await readFromCacheDir('cache-bucket', 'hash-dir')).toEqual([
			{ name: 'cache/file.webp' },
		]);

		expect(mocks.storage.bucket).toHaveBeenCalledWith('source-bucket');
		expect(mocks.storage.bucket).toHaveBeenCalledWith('cache-bucket');
		expect(mocks.file.save).toHaveBeenCalledWith(Buffer.from('optimized'), {
			gzip: true,
			metadata: {
				cacheControl: 'public, max-age=3600, must-revalidate',
			},
		});
		expect(mocks.bucket.getFiles).toHaveBeenCalledWith({
			prefix: 'hash-dir',
		});
	});

	it.each([
		Object.assign(new Error('missing'), { response: { statusCode: 404 } }),
		Object.assign(new Error('forbidden'), { code: 403 }),
	])('preserves remote stream errors for callers to map: %o', async (error) => {
		const stream = new Readable({
			read() {
				this.destroy(error);
			},
		});

		mocks.file.createReadStream.mockReturnValue(stream);

		await expect(getFileBuffer('source-bucket', 'image.png')).rejects.toBe(
			error,
		);
	});
});
