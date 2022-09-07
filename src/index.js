import { join } from 'path';
import { cors, runMiddleware } from './middleware';
import {
	getHash,
	getSupportedMimeType,
	getFileBuffer,
	getMaxAge,
	isAnimated,
	sendResponse,
	writeToCacheDir,
	readFromCacheDir,
	getContentType,
	sendEtagResponse,
	getExtension,
} from './shared';
import sharp from 'sharp';

////////////////////////////////////////////////////////////////////////////////

const AVIF = 'image/avif';
const WEBP = 'image/webp';
const PNG = 'image/png';
const JPEG = 'image/jpeg';
const GIF = 'image/gif';
const SVG = 'image/svg+xml';
const MAX_AGE = 60 * 60 * 24 * 365;
const CACHE_VERSION = 1;
const OVERWRITE_TYPES = [AVIF, WEBP, PNG, JPEG];
const MODERN_TYPES = [AVIF, WEBP];
const ANIMATABLE_TYPES = [WEBP, PNG, GIF];
const VECTOR_TYPES = [SVG];

const deviceSizes = process.env.DEVICE_SIZES || [
	640, 750, 828, 1080, 1200, 1920, 2048, 3840,
];
const imageSizes = process.env.IMAGE_SIZES || [
	16, 32, 48, 64, 96, 128, 256, 384,
];
const srcDir = process.env.SRC_DIR;
const distDir = process.env.DIST_DIR;
const fileDir = process.env.FILE_DIR || '';

////////////////////////////////////////////////////////////////////////////////

/**
 * handler is the main request handler.
 * @param {Request} req
 * @param {Response} res
 */
export async function handler(req, res) {
	// Run CORS middleware
	await runMiddleware(req, res, cors);

	// Make sure required environment variables are set.
	if (srcDir == null || distDir == null) {
		res.statusCode = 400;
		res.end('Missing required environment variables.');
	}

	// Switch on request method
	switch (req.method) {
		case 'GET': {
			return run(req, res);
		}
		default:
			res.setHeader('Allow', ['OPTIONS', 'GET']);
			res.setHeader('Content-Type', 'text/plain');
			return res.status(405).send('METHOD-NOT-ALLOWED');
	}
}

////////////////////////////////////////////////////////////////////////////////

/**
 * run returns an optimized image based on the given request query parameters.
 * @param {Request} req
 * @param {Response} res
 */
async function run(req, res) {
	const { headers, query } = req;
	const { url, w, q, f } = query;
	const mimeType = getSupportedMimeType(MODERN_TYPES, headers.accept);

	//////////////////////////////////////////////////////////////////////////////
	// URL parameter handling

	if (!url) {
		res.statusCode = 400;
		res.end('"url" parameter is required');
		return { finished: true };
	} else if (Array.isArray(url)) {
		res.statusCode = 400;
		res.end('"url" parameter cannot be an array');
		return { finished: true };
	}

	if (!w) {
		res.statusCode = 400;
		res.end('"w" parameter (width) is required');
		return { finished: true };
	} else if (Array.isArray(w)) {
		res.statusCode = 400;
		res.end('"w" parameter (width) cannot be an array');
		return { finished: true };
	}

	const width = parseInt(w, 10);
	if (!width || isNaN(width)) {
		res.statusCode = 400;
		res.end('"w" parameter (width) must be a number greater than 0');
		return { finished: true };
	}

	const sizes = [...deviceSizes, ...imageSizes];

	if (!sizes.includes(width)) {
		res.statusCode = 400;
		res.end(`"w" parameter (width) of ${width} is not allowed`);
		return { finished: true };
	}

	if (!q) {
		res.statusCode = 400;
		res.end('"q" parameter (quality) is required');
		return { finished: true };
	} else if (Array.isArray(q)) {
		res.statusCode = 400;
		res.end('"q" parameter (quality) cannot be an array');
		return { finished: true };
	}

	const quality = parseInt(q, 10);
	if (isNaN(quality) || quality < 1 || quality > 100) {
		res.statusCode = 400;
		res.end('"q" parameter (quality) must be a number between 1 and 100');
		return { finished: true };
	}

	if (f && !OVERWRITE_TYPES.includes(`image/${f}`)) {
		res.statusCode = 400;
		res.end(`"f" parameter (format) of ${f} is not allowed`);
		return { finished: true };
	}

	let format = f || '';

	//////////////////////////////////////////////////////////////////////////////
	// Hashing and main business logic

	const hash = getHash([CACHE_VERSION, url, width, quality, format, mimeType]);
	const hashDir = join(fileDir, hash);
	const now = Date.now();

	// NOTE(joel): Check if an optimized file exists on cloud storage and pipe it
	// into `res`.
	const cachedFiles = await readFromCacheDir(distDir, hashDir);
	if (cachedFiles) {
		for (let file of cachedFiles) {
			const [prefix, etag, maxAge, extension] = file.name
				.replace(hashDir + '/', '')
				.split('.');
			const expireAt = Number(prefix);
			const contentType = getContentType(extension);

			if (now < expireAt) {
				res.setHeader(
					'Cache-Control',
					`public, max-age=${maxAge}, must-revalidate`,
				);
				if (sendEtagResponse(req, res, etag)) {
					return { finished: true };
				}
				if (contentType) {
					res.setHeader('Content-Type', contentType);
				}
				file.createReadStream().pipe(res);
				return { finished: true };
			}
			await file.delete();
		}
	}

	// NOTE(joel): An optimized file doesn't exist yet. Try fetching the original
	// and process it.
	let upstreamBuffer;
	let upstreamType;
	let maxAge;

	try {
		const { data, response: upstreamRes } = await getFileBuffer(srcDir, url);
		res.statusCode = upstreamRes.statusCode;
		upstreamBuffer = data;
		upstreamType = upstreamRes.headers['content-type'];
		maxAge = getMaxAge(upstreamRes.headers['cache-control'], MAX_AGE);
	} catch ({ response: upstreamRes }) {
		res.statusCode = upstreamRes.statusCode;
		res.end('"url" parameter is valid but upstream response is invalid');
		return { finished: true };
	}

	const expireAt = maxAge * 1000 + now;

	// NOTE(joel): Handle image types that cannot be optimized by sharp, e.g.
	// vector grafics or animatables
	if (upstreamType) {
		const vector = VECTOR_TYPES.includes(upstreamType);
		const animate =
			ANIMATABLE_TYPES.includes(upstreamType) && isAnimated(upstreamBuffer);
		if (vector || animate) {
			await writeToCacheDir(
				distDir,
				hashDir,
				upstreamType,
				expireAt,
				maxAge,
				upstreamBuffer,
			);
			sendResponse(req, res, upstreamType, maxAge, upstreamBuffer);
			return { finished: true };
		}
	}

	// NOTE(joel): Decide the output contentType:
	//   1) Use user provided contentType
	//   2) Use a contentType based off of the accept header
	//   3) Use the contentType of the upstream image
	//   4) Fallback to "image/jpeg" as contentType
	let contentType;
	if (format) {
		contentType = format;
	} else if (mimeType) {
		contentType = mimeType;
	} else if (upstreamType?.startsWith('image/') && getExtension(upstreamType)) {
		contentType = upstreamType;
	} else {
		contentType = JPEG;
	}

	try {
		const transformer = sharp(upstreamBuffer);
		// NOTE(joel): Auto rotate based on EXIF data
		transformer.rotate();

		// NOTE(joel): Make sure we're don't resize images that are smaller than
		// the target width.
		const { width: metaWidth } = await transformer.metadata();
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
		await writeToCacheDir(
			distDir,
			hashDir,
			contentType,
			expireAt,
			maxAge,
			optimizedBuffer,
		);
		sendResponse(req, res, contentType, maxAge, optimizedBuffer);
	} catch (error) {
		sendResponse(req, res, upstreamType, maxAge, upstreamBuffer);
	}

	return { finished: true };
}
