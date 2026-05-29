import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { Storage } from '@google-cloud/storage';
import { mediaType } from '@hapi/accept';

////////////////////////////////////////////////////////////////////////////////

const DEFAULT_LOCAL_CACHE_CONTROL = 'public, max-age=60';
const DEFAULT_MAX_INPUT_PAGES = 1;
const DEFAULT_MAX_INPUT_PIXELS = 100_000_000;
const DEFAULT_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const DEFAULT_IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];

let storage: Storage | undefined;

const CONTENT_TYPES: Record<string, string> = {
	avif: 'image/avif',
	gif: 'image/gif',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	svg: 'image/svg+xml',
	webp: 'image/webp',
};

const EXTENSIONS: Record<string, string> = {
	'image/avif': 'avif',
	'image/gif': 'gif',
	'image/jpeg': 'jpeg',
	'image/png': 'png',
	'image/svg+xml': 'svg',
	'image/webp': 'webp',
};

////////////////////////////////////////////////////////////////////////////////

export type HeaderMap = Record<string, string | string[] | undefined>;

export type RequestLike = {
	headers: HeaderMap;
	method?: string;
};

export type ResponseLike = {
	setHeader(name: string, value: string): void;
	statusCode: number;
	end(buffer?: Buffer | string): void;
};

type FreshnessResponseHeaders = {
	etag?: string;
	'last-modified'?: string;
};

type UpstreamResponse = {
	statusCode: number;
	headers: HeaderMap;
};

type CachedFileLike = {
	name: string;
	createReadStream(): Readable;
};

////////////////////////////////////////////////////////////////////////////////
// Config Helpers

/**
 * Parses a comma-separated numeric size list from an environment variable.
 */
export function parseSizeList(value: string | undefined, fallback: number[]) {
	if (!value) {
		return fallback;
	}

	return value
		.split(',')
		.map((item) => Number(item.trim()))
		.filter((item) => Number.isFinite(item) && item > 0);
}

/**
 * Parses a positive integer from an environment variable.
 */
function parsePositiveInteger(value: string | undefined, fallback: number) {
	if (!value) return fallback;

	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves the runtime image handler configuration from process environment.
 */
export function getConfig() {
	return {
		deviceSizes: parseSizeList(process.env.DEVICE_SIZES, DEFAULT_DEVICE_SIZES),
		imageSizes: parseSizeList(process.env.IMAGE_SIZES, DEFAULT_IMAGE_SIZES),
		maxInputPages: parsePositiveInteger(
			process.env.MAX_INPUT_PAGES,
			DEFAULT_MAX_INPUT_PAGES,
		),
		maxInputPixels: parsePositiveInteger(
			process.env.MAX_INPUT_PIXELS,
			DEFAULT_MAX_INPUT_PIXELS,
		),
		maxSourceBytes: parsePositiveInteger(
			process.env.MAX_SOURCE_BYTES,
			DEFAULT_MAX_SOURCE_BYTES,
		),
		srcDir: process.env.SRC_DIR,
		distDir: process.env.DIST_DIR,
		fileDir: process.env.FILE_DIR || '',
	};
}

////////////////////////////////////////////////////////////////////////////////
// Storage Backend Helpers

/**
 * Returns whether the current request flow should use the local filesystem.
 */
function isLocalStorageBackend() {
	return process.env.STORAGE_BACKEND === 'local';
}

/**
 * Returns the Cloud Storage client when the process is not running in local
 * mode.
 */
function getStorage() {
	if (isLocalStorageBackend()) {
		throw new Error('Cloud Storage client is unavailable in local mode.');
	}

	storage ??= new Storage();
	return storage;
}

/**
 * Removes any leading slash characters so storage keys resolve consistently.
 */
function normalizeLocalFileName(fileName: string) {
	return fileName.replace(/^\/+/, '');
}

/**
 * Creates an error for attempted filesystem access outside the configured root.
 */
function createInvalidLocalPathError() {
	return Object.assign(
		new Error('Local file path resolved outside the configured directory.'),
		{ code: 'ERR_INVALID_LOCAL_PATH' },
	);
}

/**
 * Resolves a local storage path from the configured directory and file key.
 */
function resolveLocalFilePath(dir: string, fileName: string) {
	const rootPath = resolve(dir);
	const filePath = resolve(rootPath, normalizeLocalFileName(fileName));
	const relativePath = relative(rootPath, filePath);

	if (
		relativePath === '' ||
		(!relativePath.startsWith('..') && !isAbsolute(relativePath))
	) {
		return filePath;
	}

	throw createInvalidLocalPathError();
}

/**
 * Creates an error object that matches the upstream error shape used by
 * callers.
 */
function createStorageReadError(
	statusCode: number,
	message = 'Storage read failed.',
) {
	return Object.assign(new Error(message), { response: { statusCode } });
}

/**
 * Returns whether the local filesystem error should be treated as a missing
 * file.
 */
function isMissingLocalPathError(code: unknown) {
	return code === 'ENOENT' || code === 'ERR_INVALID_LOCAL_PATH';
}

/**
 * Maps local filesystem errors onto the upstream status codes expected by
 * callers.
 */
function getLocalReadStatusCode(error: unknown) {
	const code =
		error && typeof error === 'object' && 'code' in error
			? error.code
			: undefined;

	return isMissingLocalPathError(code) ? 404 : 500;
}

function assertWithinMaxBytes(size: number, maxBytes: number) {
	if (size > maxBytes) {
		throw createStorageReadError(413, 'Source object exceeds maximum size.');
	}
}

////////////////////////////////////////////////////////////////////////////////
// Storage Access Helpers

/**
 * Checks if a file exists in the specified bucket and retrieves its metadata.
 */
export async function fileExists(bucketName: string, fileName: string) {
	if (isLocalStorageBackend()) {
		try {
			const filePath = resolveLocalFilePath(bucketName, fileName);
			const metadata = await stat(filePath);

			return {
				name: normalizeLocalFileName(fileName),
				size: String(metadata.size),
				updated: metadata.mtime.toISOString(),
			};
		} catch (error) {
			throw createStorageReadError(getLocalReadStatusCode(error));
		}
	}

	const [metadata] = await getStorage()
		.bucket(bucketName)
		.file(fileName)
		.getMetadata();

	return metadata;
}

/**
 * Retrieves the content of a file from the specified bucket as a Buffer, along
 * with the upstream response metadata.
 */
export async function getFileBuffer(
	bucketName: string,
	fileName: string,
	maxBytes = DEFAULT_MAX_SOURCE_BYTES,
) {
	if (isLocalStorageBackend()) {
		try {
			const filePath = resolveLocalFilePath(bucketName, fileName);
			const metadata = await stat(filePath);
			assertWithinMaxBytes(metadata.size, maxBytes);
			const data = await readFile(filePath);
			const contentType = getContentType(fileName.split('.').pop() || '');

			return {
				data,
				response: {
					statusCode: 200,
					headers: {
						'cache-control':
							process.env.LOCAL_CACHE_CONTROL || DEFAULT_LOCAL_CACHE_CONTROL,
						'content-type': contentType || 'application/octet-stream',
						'last-modified': metadata.mtime.toUTCString(),
					},
				},
			};
		} catch (error) {
			if (error && typeof error === 'object' && 'response' in error) {
				throw error;
			}

			throw createStorageReadError(getLocalReadStatusCode(error));
		}
	}

	const fileStream = getStorage()
		.bucket(bucketName)
		.file(fileName)
		.createReadStream();

	let response: UpstreamResponse | undefined;
	fileStream.on('response', (upstreamRes) => {
		response = upstreamRes;
		const contentLengthHeader = upstreamRes.headers['content-length'];
		const contentLengthValue = Array.isArray(contentLengthHeader)
			? contentLengthHeader[0]
			: contentLengthHeader;
		const contentLength = contentLengthValue
			? Number(contentLengthValue)
			: null;
		if (contentLength != null && contentLength > maxBytes) {
			fileStream.destroy(
				createStorageReadError(413, 'Source object exceeds maximum size.'),
			);
		}
	});

	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of fileStream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		assertWithinMaxBytes(size, maxBytes);
		chunks.push(buffer);
	}

	return {
		data: Buffer.concat(chunks),
		response,
	};
}

////////////////////////////////////////////////////////////////////////////////
// Content Helpers

/**
 * Determines the best supported MIME type from the provided options based on
 * the Accept header value. If the Accept header is not provided or does not
 * match any of the options, an empty string is returned.
 */
export function getSupportedMimeType(options: string[], accept = '') {
	const acceptValue = Array.isArray(accept) ? accept.join(',') : accept;
	if (!acceptValue) {
		return '';
	}

	return mediaType(acceptValue, options);
}

/**
 * Generates a hash string based on the provided array of items. The items can
 * be strings, numbers, or Buffers. The resulting hash is a base64-encoded
 * string with slashes replaced by dashes for URL safety.
 */
export function getHash(items: Array<string | number | Buffer>) {
	const hash = createHash('sha256');
	for (const item of items) {
		if (typeof item === 'number') {
			hash.update(String(item));
		} else {
			hash.update(item);
		}
	}

	return hash.digest('base64').replace(/\//g, '-');
}

/**
 * Retrieves the MIME type associated with a given file extension (without the
 * dot). If the extension is not recognized, it returns null.
 */
export function getContentType(extWithoutDot: string) {
	return CONTENT_TYPES[extWithoutDot.toLowerCase()] ?? null;
}

/**
 * Retrieves the file extension associated with a given MIME type. If the MIME
 * type is not recognized, it returns null.
 */
export function getExtension(contentType?: string) {
	return contentType ? (EXTENSIONS[contentType.toLowerCase()] ?? null) : null;
}

/**
 * Parses the Cache-Control header value to determine the maximum age.
 */
export function getMaxAge(str?: string | string[] | null, minimum = 60) {
	return getCachePolicy(str, minimum).maxAge;
}

/**
 * Resolves the response cache policy while respecting private/no-store source
 * directives. The fallback is only used when upstream sends no cache age.
 */
export function getCachePolicy(
	str?: string | string[] | null,
	fallbackMaxAge = 60,
) {
	if (Array.isArray(str)) str = str[0] ?? null;
	if (!str) {
		return {
			cacheable: true,
			cacheControl: `public, max-age=${fallbackMaxAge}, must-revalidate`,
			maxAge: fallbackMaxAge,
		};
	}

	const map = new Map<string, string | undefined>();

	for (const directive of str.split(',')) {
		let [key, value] = directive.trim().split('=');
		key = key.toLowerCase();
		if (value) {
			value = value.toLowerCase();
		}
		map.set(key, value);
	}

	if (map.has('no-store') || map.has('private')) {
		return { cacheable: false, cacheControl: 'no-store', maxAge: 0 };
	}

	if (map.has('no-cache')) {
		return { cacheable: false, cacheControl: 'no-cache', maxAge: 0 };
	}

	let age = map.get('s-maxage') || map.get('max-age') || '';
	if (age.startsWith('"') && age.endsWith('"')) {
		age = age.slice(1, -1);
	}
	const n = parseInt(age, 10);
	const maxAge = !isNaN(n) && n >= 0 ? n : fallbackMaxAge;

	return {
		cacheable: maxAge > 0,
		cacheControl: `public, max-age=${maxAge}, must-revalidate`,
		maxAge,
	};
}

////////////////////////////////////////////////////////////////////////////////
// Animation Helpers

/**
 * Checks whether the provided buffer starts with a GIF signature.
 */
function isGIF(buffer: Buffer) {
	const header = buffer.subarray(0, 3).toString('ascii');
	return header === 'GIF';
}

/**
 * Detects whether a GIF buffer contains more than one image frame.
 */
function isAnimatedGIF(buffer: Buffer) {
	let hasColorTable = 0;
	let colorTableSize = 0;
	let offset = 0;
	let imagesCount = 0;

	/**
	 * Computes the length of a GIF data-block sequence starting at the given
	 * offset.
	 */
	const getDataBlocksLength = (
		currentBuffer: Buffer,
		currentOffset: number,
	) => {
		let length = 0;
		while (currentBuffer[currentOffset + length]) {
			length += currentBuffer[currentOffset + length] + 1;
		}
		return length + 1;
	};

	hasColorTable = buffer[10] & 0x80;
	colorTableSize = buffer[10] & 0x07;

	offset += 6;
	offset += 7;
	offset += hasColorTable ? 3 * Math.pow(2, colorTableSize + 1) : 0;

	while (imagesCount < 2 && offset < buffer.length) {
		switch (buffer[offset]) {
			case 0x2c:
				imagesCount += 1;

				hasColorTable = buffer[offset + 9] & 0x80;
				colorTableSize = buffer[offset + 9] & 0x07;

				offset += 10;
				offset += hasColorTable ? 3 * Math.pow(2, colorTableSize + 1) : 0;
				offset += getDataBlocksLength(buffer, offset + 1) + 1;
				break;
			case 0x21:
				offset += 2;
				offset += getDataBlocksLength(buffer, offset);
				break;
			case 0x3b:
				offset = buffer.length;
				break;
			default:
				offset = buffer.length;
				break;
		}
	}

	return imagesCount > 1;
}

/**
 * Checks whether the provided buffer starts with a PNG signature.
 */
function isPNG(buffer: Buffer) {
	const header = buffer.subarray(0, 8).toString('hex');
	return header === '89504e470d0a1a0a';
}

/**
 * Detects whether a PNG buffer contains the chunk structure used by APNG.
 */
function isAnimatedPNG(buffer: Buffer) {
	let hasACTL = false;
	let hasIDAT = false;
	let hasFDAT = false;

	let previousChunkType = '';

	let offset = 8;

	while (offset < buffer.length) {
		if (offset + 8 > buffer.length) return false;

		const chunkLength = buffer.readUInt32BE(offset);
		if (offset + 12 + chunkLength > buffer.length) return false;

		const chunkType = buffer.subarray(offset + 4, offset + 8).toString('ascii');

		switch (chunkType) {
			case 'acTL':
				hasACTL = true;
				break;
			case 'IDAT':
				if (!hasACTL) {
					return false;
				}

				if (previousChunkType !== 'fcTL') {
					return false;
				}

				hasIDAT = true;
				break;
			case 'fdAT':
				if (!hasIDAT) {
					return false;
				}

				if (previousChunkType !== 'fcTL') {
					return false;
				}

				hasFDAT = true;
				break;
		}

		previousChunkType = chunkType;
		offset += 4 + 4 + chunkLength + 4;
	}

	return hasACTL && hasIDAT && hasFDAT;
}

/**
 * Checks whether the provided buffer contains a WebP signature.
 */
function isWebP(buffer: Buffer) {
	const WEBP = [0x57, 0x45, 0x42, 0x50];
	for (let i = 0; i < WEBP.length; i++) {
		if (buffer[i + 8] !== WEBP[i]) return false;
	}
	return true;
}

/**
 * Detects whether a WebP buffer contains the animation marker chunk.
 */
function isAnimatedWebP(buffer: Buffer) {
	const ANIM = [0x41, 0x4e, 0x49, 0x4d];
	for (let i = 0; i < buffer.length; i++) {
		for (let j = 0; j <= ANIM.length; j++) {
			if (j === ANIM.length) return true;
			if (buffer[i + j] !== ANIM[j]) break;
		}
	}
	return false;
}

/**
 * Determines whether a supported image buffer represents an animated image.
 */
export function isAnimated(buffer: Buffer) {
	if (isGIF(buffer)) return isAnimatedGIF(buffer);
	if (isPNG(buffer)) return isAnimatedPNG(buffer);
	if (isWebP(buffer)) return isAnimatedWebP(buffer);
	return false;
}

////////////////////////////////////////////////////////////////////////////////
// Cache Helpers

/**
 * Writes an image buffer to the cache bucket using an ETag-based filename.
 */
export async function writeToCacheDir(
	dir: string,
	fileDir: string,
	contentType: string,
	maxAge = 1,
	buffer: Buffer,
) {
	const extension = getExtension(contentType);
	const etag = getHash([buffer]);
	// NOTE(joel): Cache files are addressed by the hash directory chosen by the
	// caller plus an ETag-based filename. The directory captures request-level
	// variation (for example width/quality or passthrough assets), while the file
	// name lets us distinguish different encoded payloads within that namespace.
	const filename = join(fileDir, `${etag}.${maxAge}.${extension}`);

	if (isLocalStorageBackend()) {
		const filePath = resolveLocalFilePath(dir, filename);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, buffer);
		return;
	}

	await getStorage()
		.bucket(dir)
		.file(filename)
		.save(buffer, {
			gzip: true,
			metadata: {
				cacheControl: `public, max-age=${maxAge}, must-revalidate`,
			},
		});
}

/**
 * Reads cached files from the cache bucket for the provided hash directory.
 */
export async function readFromCacheDir(dir: string, fileDir: string) {
	if (isLocalStorageBackend()) {
		try {
			const directoryPath = resolveLocalFilePath(dir, fileDir);
			const entries = await readdir(directoryPath, { withFileTypes: true });
			const files = entries
				.filter((entry) => entry.isFile())
				.map<CachedFileLike>((entry) => ({
					name: join(fileDir, entry.name),
					createReadStream: () =>
						createReadStream(join(directoryPath, entry.name)),
				}));

			return files;
		} catch (error) {
			const code =
				error && typeof error === 'object' && 'code' in error
					? error.code
					: undefined;

			if (isMissingLocalPathError(code)) {
				return [];
			}

			throw error;
		}
	}

	const [files] = await getStorage().bucket(dir).getFiles({
		prefix: fileDir,
	});
	return files;
}

////////////////////////////////////////////////////////////////////////////////
// Query Helpers

/**
 * Parses the query parameters from the request URL into a structured object.
 * It supports multiple values for the same key by storing them in an array. If
 * a key appears only once, its value is stored as a string.
 */
export function parseQuery(reqUrl: string) {
	const query: HeaderMap = {};
	const url = new URL(reqUrl, 'http://127.0.0.1');

	for (const [key, value] of url.searchParams.entries()) {
		const current = query[key];
		if (current === undefined) {
			query[key] = value;
		} else if (Array.isArray(current)) {
			current.push(value);
		} else {
			query[key] = [current, value];
		}
	}

	return query;
}

////////////////////////////////////////////////////////////////////////////////
// Response Helpers

/**
 * Sends an image response with cache headers and conditional ETag handling.
 */
export function sendResponse(
	req: RequestLike,
	res: ResponseLike,
	contentType: string,
	maxAge = 1,
	buffer: Buffer,
	cacheControl?: string,
) {
	const etag = normalizeEtag(getHash([buffer]), true);
	// Keep the response header format aligned with the token shape used for freshness checks.
	res.setHeader(
		'Cache-Control',
		cacheControl ?? `public, max-age=${maxAge}, must-revalidate`,
	);
	res.setHeader('Vary', 'Accept, Accept-Encoding');
	res.setHeader('X-Content-Type-Options', 'nosniff');
	if (contentType === 'image/svg+xml') {
		res.setHeader(
			'Content-Security-Policy',
			"default-src 'none'; script-src 'none'; sandbox",
		);
	}
	if (sendEtagResponse(req, res, etag)) return;
	if (contentType) res.setHeader('Content-Type', contentType);
	res.end(req.method === 'HEAD' ? undefined : buffer);
}

/**
 * Sends a `304 Not Modified` response when the request ETag is still fresh.
 */
export function sendEtagResponse(
	req: RequestLike,
	res: ResponseLike,
	etag: string,
) {
	const normalizedEtag = normalizeEtag(etag, true);

	if (normalizedEtag) {
		res.setHeader('ETag', normalizedEtag);
	}

	if (checkResponseFreshness(req.headers, { etag: normalizedEtag })) {
		res.statusCode = 304;
		res.end();
		return true;
	}

	return false;
}

////////////////////////////////////////////////////////////////////////////////
// Freshness Helpers

const CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

/**
 * Checks request freshness headers against the response ETag and modification
 * date.
 */
export function checkResponseFreshness(
	reqHeaders: HeaderMap,
	resHeaders: FreshnessResponseHeaders,
) {
	const modifiedSince = reqHeaders['if-modified-since'];
	const noneMatch = reqHeaders['if-none-match'];
	const modifiedSinceValue = Array.isArray(modifiedSince)
		? modifiedSince[0]
		: modifiedSince;
	const noneMatchValue = Array.isArray(noneMatch) ? noneMatch[0] : noneMatch;

	if (!modifiedSinceValue && !noneMatchValue) return false;

	const cacheControl = reqHeaders['cache-control'];
	const cacheControlValue = Array.isArray(cacheControl)
		? cacheControl[0]
		: cacheControl;
	if (
		cacheControlValue &&
		CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControlValue)
	) {
		return false;
	}

	if (noneMatchValue && noneMatchValue !== '*') {
		const etag = resHeaders.etag;

		if (!etag) return false;

		const normalizedEtag = normalizeEtag(etag);
		let etagStale = true;
		const matches = parseTokenList(noneMatchValue);
		for (let i = 0; i < matches.length; i++) {
			const match = matches[i];
			// Treat quoted and weak validators as equivalent to the stored strong ETag.
			if (normalizeEtag(match) === normalizedEtag) {
				etagStale = false;
				break;
			}
		}

		if (etagStale) return false;
	}

	if (modifiedSinceValue) {
		const lastModified = resHeaders['last-modified'];
		const modifiedStale =
			!lastModified ||
			!(parseHttpDate(lastModified) <= parseHttpDate(modifiedSinceValue));

		if (modifiedStale) return false;
	}

	return true;
}

/**
 * Parses an HTTP date string into a timestamp value.
 */
function parseHttpDate(date: string) {
	const timestamp = date && Date.parse(date);
	return typeof timestamp === 'number' ? timestamp : NaN;
}

/**
 * Normalizes an ETag token so quoted and weak forms compare consistently.
 */
function normalizeEtag(etag: string, quoted = false) {
	if (!etag) {
		return '';
	}

	const normalized = etag.trim().replace(/^W\//, '');
	return quoted && !normalized.startsWith('"') ? `"${normalized}"` : normalized;
}

/**
 * Splits a comma-separated header token list while preserving token order.
 */
function parseTokenList(str: string) {
	let end = 0;
	const list: string[] = [];
	let start = 0;

	for (let i = 0, len = str.length; i < len; i++) {
		switch (str.charCodeAt(i)) {
			case 0x20:
				if (start === end) {
					start = end = i + 1;
				}
				break;
			case 0x2c:
				list.push(str.substring(start, end));
				start = end = i + 1;
				break;
			default:
				end = i + 1;
				break;
		}
	}

	list.push(str.substring(start, end));

	return list;
}
