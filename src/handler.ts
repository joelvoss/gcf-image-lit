import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import sharp from 'sharp';

import {
	getCachePolicy,
	getConfig,
	getContentType,
	getExtension,
	getFileBuffer,
	getHash,
	getSupportedMimeType,
	isAnimated,
	parseQuery,
	readFromCacheDir,
	sendEtagResponse,
	sendResponse,
	writeToCacheDir,
} from './shared';

////////////////////////////////////////////////////////////////////////////////

const AVIF = 'image/avif';
const WEBP = 'image/webp';
const PNG = 'image/png';
const JPEG = 'image/jpeg';
const GIF = 'image/gif';
const SVG = 'image/svg+xml';
const MAX_AGE = 60 * 60 * 24 * 30;
const CACHE_VERSION = 1;
const OVERWRITE_TYPES = [AVIF, WEBP, PNG, JPEG];
const MODERN_TYPES = [AVIF, WEBP];
const ANIMATABLE_TYPES = [WEBP, PNG, GIF];
const VECTOR_TYPES = [SVG];
const SOURCE_TYPES = [AVIF, WEBP, PNG, JPEG, GIF, SVG];

////////////////////////////////////////////////////////////////////////////////

/**
 * Handles image optimization GET requests by validating query parameters,
 * serving cached variants when available, and otherwise fetching, transforming,
 * caching, and returning the source image.
 */
export async function handleGet(req: IncomingMessage, res: ServerResponse) {
	const {
		deviceSizes,
		imageSizes,
		maxInputPages,
		maxInputPixels,
		maxSourceBytes,
		srcDir,
		distDir,
		fileDir,
	} = getConfig();

	if (!req.url) {
		res.statusCode = 400;
		res.end('Missing request url.');
		return;
	}

	if (srcDir == null || distDir == null) {
		res.statusCode = 400;
		res.end('Missing required environment variables.');
		return;
	}

	const { url, w, q, f } = parseQuery(req.url);
	const acceptHeader = Array.isArray(req.headers.accept)
		? req.headers.accept.join(',')
		: req.headers.accept;
	const mimeType = getSupportedMimeType(MODERN_TYPES, acceptHeader);

	if (!url) {
		res.statusCode = 400;
		res.end('"url" parameter is required');
		return;
	} else if (Array.isArray(url)) {
		res.statusCode = 400;
		res.end('"url" parameter cannot be an array');
		return;
	}

	if (!w) {
		res.statusCode = 400;
		res.end('"w" parameter (width) is required');
		return;
	} else if (Array.isArray(w)) {
		res.statusCode = 400;
		res.end('"w" parameter (width) cannot be an array');
		return;
	}

	const width = parseInt(w, 10);
	if (!width || isNaN(width)) {
		res.statusCode = 400;
		res.end('"w" parameter (width) must be a number greater than 0');
		return;
	}

	const sizes = [...deviceSizes, ...imageSizes].map(Number);

	if (!sizes.includes(width)) {
		res.statusCode = 400;
		res.end(`"w" parameter (width) of ${width} is not allowed`);
		return;
	}

	if (!q) {
		res.statusCode = 400;
		res.end('"q" parameter (quality) is required');
		return;
	} else if (Array.isArray(q)) {
		res.statusCode = 400;
		res.end('"q" parameter (quality) cannot be an array');
		return;
	}

	const quality = parseInt(q, 10);
	if (isNaN(quality) || quality < 1 || quality > 100) {
		res.statusCode = 400;
		res.end('"q" parameter (quality) must be a number between 1 and 100');
		return;
	}

	if (f && !Array.isArray(f) && !OVERWRITE_TYPES.includes(`image/${f}`)) {
		res.statusCode = 400;
		res.end(`"f" parameter (format) of ${f} is not allowed`);
		return;
	}

	if (Array.isArray(f)) {
		res.statusCode = 400;
		res.end('"f" parameter (format) cannot be an array');
		return;
	}

	const format = f || '';
	// NOTE(joel): Keep the cache key scoped to request parameters only. Checking
	// upstream metadata on every request would reduce stale-cache risk when a
	// source object is replaced in place, but the extra GCS read adds cost and
	// latency to the hot path. We accept stale variants until the cache is
	// otherwise refreshed in exchange for cheaper, faster steady-state traffic.
	const variantHash = getHash([CACHE_VERSION, url, width, quality]);
	const variantHashDir = join(fileDir, variantHash);
	// NOTE(joel): Passthrough assets ignore width and quality, so cache them in a
	// separate namespace to avoid writing identical animated/vector files for
	// every raster-oriented request variant.
	const passthroughHash = getHash([CACHE_VERSION, url, 'passthrough']);
	const passthroughHashDir = join(fileDir, passthroughHash);

	const [cachedFiles, passthroughCachedFiles] = await Promise.all([
		readFromCacheDir(distDir, variantHashDir),
		readFromCacheDir(distDir, passthroughHashDir),
	]);

	// NOTE(joel): Loop through cached files to find an explicit format match,
	// a MIME type match or fallback to a JPEG variant if available, to maximize
	// the chance of a cache hit while still respecting client capabilities and
	// preferences. `cachedFiles` is unordered so we need to check all files to
	// find the best match instead of assuming the first match is the best match.
	let formatVariant, mimeVariant, fallbackVariant, passthroughVariant;
	for (const file of [...cachedFiles, ...passthroughCachedFiles]) {
		const [etag, maxAge, extension] = file.name
			.replace(`${variantHashDir}/`, '')
			.replace(`${passthroughHashDir}/`, '')
			.split('.');
		if (!etag || !maxAge || !extension) continue;

		const contentType = getContentType(extension);
		if (!contentType) continue;

		const variant = { contentType, etag, file, maxAge };
		if (!formatVariant && contentType === `image/${format}`) {
			formatVariant = variant;
			continue;
		}
		if (!mimeVariant && mimeType && contentType === mimeType) {
			mimeVariant = variant;
			continue;
		}
		if (!fallbackVariant && contentType === JPEG) {
			fallbackVariant = variant;
			continue;
		}
		if (!passthroughVariant) {
			passthroughVariant = variant;
		}
	}
	// NOTE(joel): Explicit format requests are authoritative. Without one, select
	// the best cached variant based on MIME negotiation, JPEG fallback, or a
	// cached passthrough variant for formats that are not negotiated.
	const cachedVariant = format
		? formatVariant
		: (mimeVariant ?? fallbackVariant ?? passthroughVariant);
	if (cachedVariant) {
		// NOTE(joel): Set caching headers to enable client and intermediary
		// caching of the optimized variant. The ETag allows clients to make
		// conditional requests to check if their cached variant is still fresh
		// without downloading the file again, and the Vary header ensures that
		// caches store separate variants for different Accept and Accept-Encoding
		// headers.
		res.setHeader(
			'Cache-Control',
			`public, max-age=${cachedVariant.maxAge}, must-revalidate`,
		);
		res.setHeader('Vary', 'Accept, Accept-Encoding');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		if (cachedVariant.contentType === 'image/svg+xml') {
			res.setHeader(
				'Content-Security-Policy',
				"default-src 'none'; script-src 'none'; sandbox",
			);
		}

		// NOTE(joel): Short-circuit the response with a 304 if the client's cached
		// variant is still fresh according to the ETag. This saves bandwidth and
		// reduces latency by avoiding streaming the cached file from GCS when the
		// client can reuse its cached bytes.
		if (sendEtagResponse(req, res, cachedVariant.etag)) return;

		res.setHeader('Content-Type', cachedVariant.contentType);
		// NOTE(joel): For HEAD requests we can skip streaming the file and end the
		// response immediately after sending headers since the client only wants
		// metadata and not the file bytes.
		if (req.method === 'HEAD') {
			res.end();
			return;
		}

		const cachedStream = cachedVariant.file.createReadStream();
		try {
			// NOTE(joel): Stream cached bytes directly to keep the memory footprint
			// low. If the stream fails before the response is committed we can still
			// fall back to rebuilding from source, but once bytes are on the wire we
			// terminate the response instead of buffering the whole file in memory.
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					cachedStream.off('error', onStreamError);
					res.off('error', onResponseError);
					res.off('finish', onFinish);
				};

				const onStreamError = (error: Error) => {
					cleanup();
					cachedStream.unpipe(res);
					reject(error);
				};

				const onResponseError = (error: Error) => {
					cleanup();
					reject(error);
				};

				const onFinish = () => {
					cleanup();
					resolve();
				};

				cachedStream.once('error', onStreamError);
				res.once('error', onResponseError);
				res.once('finish', onFinish);
				cachedStream.pipe(res);
			});
			return;
		} catch (error) {
			const streamError =
				error instanceof Error ? error : new Error(String(error));
			cachedStream.destroy(streamError);

			if (res.headersSent || res.writableEnded) {
				if (!res.destroyed) res.destroy(streamError);
				return;
			}

			console.warn(
				`WARN - Failed to read cached variant '${cachedVariant.file.name}'`,
				error,
			);
		}
	}

	console.log(`INFO - Cache miss for hashDir '${variantHashDir}'`);

	const upstream = await (async () => {
		try {
			const { data, response: upstreamRes } = await getFileBuffer(
				srcDir,
				url,
				maxSourceBytes,
			);

			// NOTE(joel): If the upstream response is invalid, we end the response
			// with an error status code and message here and return null so we can
			// return early after the await-block without doing any further 
			// processing.
			if (!upstreamRes) {
				res.statusCode = 502;
				res.end('"url" parameter is valid but upstream response is invalid');
				return null;
			}

			res.statusCode = upstreamRes.statusCode;
			const contentTypeHeader = upstreamRes.headers['content-type'];
			const cacheControlHeader = upstreamRes.headers['cache-control'];
			const type = (
				Array.isArray(contentTypeHeader)
					? contentTypeHeader[0]
					: contentTypeHeader
			)
				?.split(';', 1)[0]
				?.trim()
				.toLowerCase();

			if (!type || !SOURCE_TYPES.includes(type)) {
				res.statusCode = 415;
				res.setHeader('Content-Type', 'text/plain; charset=utf-8');
				res.end('Unsupported upstream content type');
				return null;
			}

			const cachePolicy = getCachePolicy(cacheControlHeader, MAX_AGE);
			return {
				buffer: data,
				type,
				cachePolicy,
			};
		} catch (error) {
			let upstreamStatusCode = 502;
			if (error && typeof error === 'object') {
				if (
					'response' in error &&
					error.response &&
					typeof error.response === 'object' &&
					'statusCode' in error.response &&
					typeof error.response.statusCode === 'number'
				) {
					upstreamStatusCode = error.response.statusCode;
				}

				if ('code' in error && typeof error.code === 'number') {
					upstreamStatusCode = error.code;
				}
			}

			res.statusCode =
				upstreamStatusCode >= 400 && upstreamStatusCode < 600
					? upstreamStatusCode
					: 502;
			res.end('"url" parameter is valid but upstream response is invalid');
			return null;
		}
	})();

	if (!upstream) return;
	const { buffer: upstreamBuffer, type: upstreamType, cachePolicy } = upstream;

	if (upstreamType) {
		const vector = VECTOR_TYPES.includes(upstreamType);
		const animate =
			ANIMATABLE_TYPES.includes(upstreamType) && isAnimated(upstreamBuffer);
		if (vector || animate) {
			if (cachePolicy.cacheable) {
				await writeToCacheDir(
					distDir,
					passthroughHashDir,
					upstreamType,
					cachePolicy.maxAge,
					upstreamBuffer,
				);
			}
			sendResponse(
				req,
				res,
				upstreamType,
				cachePolicy.maxAge,
				upstreamBuffer,
				cachePolicy.cacheControl,
			);
			return;
		}
	}

	const contentType = format
		? `image/${format}`
		: mimeType
			? mimeType
			: upstreamType?.startsWith('image/') && getExtension(upstreamType)
				? upstreamType
				: JPEG;

	try {
		const transformer = sharp(upstreamBuffer, {
			limitInputPixels: maxInputPixels,
			pages: maxInputPages,
		});
		transformer.rotate();

		const { pages, width: metaWidth } = await transformer.metadata();
		if (pages && pages > maxInputPages) {
			res.statusCode = 413;
			res.end('Source image exceeds maximum page count');
			return;
		}

		if (metaWidth && metaWidth > width) {
			transformer.resize(width);
		}

		if (contentType === AVIF) {
			transformer.avif({ quality });
		} else if (contentType === WEBP) {
			transformer.webp({ quality });
		} else if (contentType === PNG) {
			transformer.png({ quality });
		} else if (contentType === JPEG) {
			transformer.jpeg({ quality });
		}

		const optimizedBuffer = await transformer.toBuffer();
		if (cachePolicy.cacheable) {
			await writeToCacheDir(
				distDir,
				variantHashDir,
				contentType,
				cachePolicy.maxAge,
				optimizedBuffer,
			);
		}
		sendResponse(
			req,
			res,
			contentType,
			cachePolicy.maxAge,
			optimizedBuffer,
			cachePolicy.cacheControl,
		);
	} catch {
		res.statusCode = 415;
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.end('Unsupported upstream image');
	}

	return;
}
