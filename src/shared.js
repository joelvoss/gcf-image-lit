import { join } from 'path';
import { createHash } from 'crypto';
import { mediaType } from '@hapi/accept';
import mime from 'mime';
import { Storage } from '@google-cloud/storage';
import getStream from 'get-stream';

const storage = new Storage();

////////////////////////////////////////////////////////////////////////////////

/**
 * fileExists requests file metadata from an asset hosted on google cloud
 * storage.
 * @param {string} bucketName
 * @param {string} fileName
 */
export async function fileExists(bucketName, fileName) {
	const [metadata] = await storage
		.bucket(bucketName)
		.file(fileName)
		.getMetadata();

	return metadata;
}

/**
 * getFileBuffer returns a filebuffer and response object from a readable
 * cloud storage asset stream.
 * @param {string} bucketName
 * @param {string} fileName
 */
export async function getFileBuffer(bucketName, fileName) {
	const fileStream = storage
		.bucket(bucketName)
		.file(fileName)
		.createReadStream();

	let response;
	fileStream.on('response', upstreamRes => {
		response = upstreamRes;
	});

	const data = await getStream.buffer(fileStream);

	return {
		data,
		response,
	};
}

////////////////////////////////////////////////////////////////////////////////

/**
 * getSupportedMimeType returns a supported mimetype
 * @param {string[]} options
 * @param {string} accept
 */
export function getSupportedMimeType(options, accept = '') {
	const mimeType = mediaType(accept, options);
	return accept.includes(mimeType) ? mimeType : '';
}

////////////////////////////////////////////////////////////////////////////////

/**
 * getHash generates a deterministic hash based off of all input items.
 * @param {(string|number|Buffer)[]} items
 */
export function getHash(items) {
	const hash = createHash('sha256');
	for (let item of items) {
		if (typeof item === 'number') hash.update(String(item));
		else {
			hash.update(item);
		}
	}

	// @see https://en.wikipedia.org/wiki/Base64#Filenames
	return hash.digest('base64').replace(/\//g, '-');
}

////////////////////////////////////////////////////////////////////////////////

/**
 * getContentType returns a matching content-type for a given file extension.
 * @param {string} extWithoutDot
 * @returns {string | null}
 */
export function getContentType(extWithoutDot) {
	return mime.getType(extWithoutDot);
}

////////////////////////////////////////////////////////////////////////////////

/**
 * getExtension returns the file extension (w/o dot) for a given content-type.
 * @param {string} contentType
 * @returns {string | null}
 */
export function getExtension(contentType) {
	return mime.getExtension(contentType);
}

////////////////////////////////////////////////////////////////////////////////

/**
 * getMaxAge returns the a maxAge number from a cache-control header string.
 * @param {string|null} str
 * @param {number} [minimum=60]
 * @returns {number}
 */
export function getMaxAge(str, minimum = 60) {
	const map = parseCacheControl(str);

	if (map) {
		let age = map.get('s-maxage') || map.get('max-age') || '';
		if (age.startsWith('"') && age.endsWith('"')) {
			age = age.slice(1, -1);
		}
		const n = parseInt(age, 10);
		if (!isNaN(n)) {
			return Math.max(n, minimum);
		}
	}
	return minimum;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * parseCacheControl parses a cache-control header string.
 * @param {string|null} str
 * @returns {Map<string, string>}
 */
function parseCacheControl(str) {
	const map = new Map();
	if (!str) {
		return map;
	}
	for (let directive of str.split(',')) {
		let [key, value] = directive.trim().split('=');
		key = key.toLowerCase();
		if (value) {
			value = value.toLowerCase();
		}
		map.set(key, value);
	}
	return map;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * isGIF tests if a given image buffer is of type GIF.
 * @param {Buffer} buffer
 */
function isGIF(buffer) {
	const header = buffer.slice(0, 3).toString('ascii');
	return header === 'GIF';
}

/**
 * isAnimatedGIF tests if a given image buffer is a animated GIF.
 * @param {Buffer} buffer
 */
function isAnimatedGIF(buffer) {
	let hasColorTable, colorTableSize;
	let offset = 0;
	let imagesCount = 0;

	const getDataBlocksLength = (buffer, offset) => {
		let length = 0;
		while (buffer[offset + length]) {
			length += buffer[offset + length] + 1;
		}
		return length + 1;
	};

	hasColorTable = buffer[10] & 0x80; // 0b10000000
	colorTableSize = buffer[10] & 0x07; // 0b00000111

	// NOTE(joel): Skip header, logical screen descriptor and global color table
	offset += 6;
	offset += 7;
	offset += hasColorTable ? 3 * Math.pow(2, colorTableSize + 1) : 0;

	// NOTE(joel): Test if there are more than one image descriptor
	while (imagesCount < 2 && offset < buffer.length) {
		switch (buffer[offset]) {
			// NOTE(joel): This is the image descriptor block.
			case 0x2c:
				imagesCount += 1;

				hasColorTable = buffer[offset + 9] & 0x80; // 0b10000000
				colorTableSize = buffer[offset + 9] & 0x07; // 0b00000111

				// NOTE(joel): Skip the image descriptor, local color table and all
				// image data to get to the next block
				offset += 10;
				offset += hasColorTable ? 3 * Math.pow(2, colorTableSize + 1) : 0;
				offset += getDataBlocksLength(buffer, offset + 1) + 1;
				break;

			// NOTE(joel): Skip all extension blocks. In theory this "plain text
			// extension" blocks could be frames of animation, but no browser renders
			// them.
			case 0x21:
				offset += 2;
				offset += getDataBlocksLength(buffer, offset);
				break;

			// NOTE(joel): All data after this point will be ignored, so we're fast
			// forwarding to the end of the buffer.
			case 0x3b:
				offset = buffer.length;
				break;

			// NOTE(joel): Fast forward to the end if this GIF is invalid.
			default:
				offset = buffer.length;
				break;
		}
	}

	return imagesCount > 1;
}

function isPNG(buffer) {
	let header = buffer.slice(0, 8).toString('hex');
	// NOTE(joel): \211 P N G \r \n \032 'n
	return header === '89504e470d0a1a0a';
}

/**
 * isAnimatedPNG tests if a given image buffer is a animated PNG.
 * @param {Buffer} buffer
 */
function isAnimatedPNG(buffer) {
	let hasACTL = false;
	let hasIDAT = false;
	let hasFDAT = false;

	let previousChunkType = null;

	let offset = 8;

	while (offset < buffer.length) {
		let chunkLength = buffer.readUInt32BE(offset);
		let chunkType = buffer.slice(offset + 4, offset + 8).toString('ascii');

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
 * isWebP tests if a given image buffer is a WebP image.
 * @param {Buffer} buffer
 */
function isWebP(buffer) {
	const WEBP = [0x57, 0x45, 0x42, 0x50];
	for (let i = 0; i < WEBP.length; i++) {
		if (buffer[i + 8] !== WEBP[i]) {
			return false;
		}
	}
	return true;
}

/**
 * isAnimatedWebP tests if a given image buffer is a animated WebP.
 * @param {Buffer} buffer
 */
function isAnimatedWebP(buffer) {
	const ANIM = [0x41, 0x4e, 0x49, 0x4d];
	for (let i = 0; i < buffer.length; i++) {
		for (let j = 0; j <= ANIM.length; j++) {
			if (j === ANIM.length) {
				return true;
			}
			if (buffer[i + j] !== ANIM[j]) {
				break;
			}
		}
	}
	return false;
}

/**
 * isAnimated tests if a given image buffer is a animated image of one of the
 * supported types (gif, webp, png).
 * @param {Buffer} buffer
 */
export function isAnimated(buffer) {
	if (isGIF(buffer)) {
		return isAnimatedGIF(buffer);
	}

	if (isPNG(buffer)) {
		return isAnimatedPNG(buffer);
	}

	if (isWebP(buffer)) {
		return isAnimatedWebP(buffer);
	}

	return false;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * writeToCacheDir saves a given buffer in cloud storage.
 * @param {string} dir
 * @param {string} fileDir
 * @param {string} contentType
 * @param {number} expireAt
 * @param {number} maxAge
 * @param {Buffer} buffer
 */
export async function writeToCacheDir(
	dir,
	fileDir,
	contentType,
	expireAt,
	maxAge = 1,
	buffer,
) {
	const extension = mime.getExtension(contentType);
	const etag = getHash([buffer]);
	const filename = join(fileDir, `${expireAt}.${etag}.${maxAge}.${extension}`);

	await storage
		.bucket(dir)
		.file(filename)
		.save(buffer, {
			gzip: true,
			metadata: {
				cacheControl: `public, max-age=${maxAge}, must-revalidate`,
			},
		});
}

////////////////////////////////////////////////////////////////////////////////

/**
 * readFromCacheDir reads all files stored at a given cloud storage path.
 * @param {string} dir
 * @param {string} fileDir
 */
export async function readFromCacheDir(dir, fileDir) {
	const [files] = await storage.bucket(dir).getFiles({
		prefix: fileDir,
	});
	if (files.length) return files;
	return false;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * sendResponse ends the request lifecycle with a response.
 * @param {Request} req
 * @param {Response} res
 * @param {string} contentType
 * @param {Buffer} buffer
 */
export function sendResponse(req, res, contentType, maxAge = 1, buffer) {
	const etag = getHash([buffer]);
	res.setHeader('Cache-Control', `public, max-age=${maxAge}, must-revalidate`);
	if (sendEtagResponse(req, res, etag)) {
		return;
	}
	if (contentType) {
		res.setHeader('Content-Type', contentType);
	}
	res.end(buffer);
}

////////////////////////////////////////////////////////////////////////////////

/**
 * sendEtagResponse ends the request lifecycle with an Etag response.
 * @param {Request} req
 * @param {Response} res
 * @param {string} etag
 */
export function sendEtagResponse(req, res, etag) {
	if (etag) {
		// The server generating a 304 response MUST generate any of the
		// following header fields that would have been sent in a 200 (OK)
		// response to the same request: Cache-Control, Content-Location, Date,
		// ETag, Expires, and Vary.
		// @see https://tools.ietf.org/html/rfc7232#section-4.1
		res.setHeader('ETag', etag);
	}

	if (checkResponseFreshness(req.headers, { etag })) {
		res.statusCode = 304;
		res.end();
		return true;
	}

	return false;
}

////////////////////////////////////////////////////////////////////////////////

const CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

/**
 * checkResponseFreshness checks the freshness of a response using request and
 * response headers.
 * @param {Object} reqHeaders
 * @param {Object} resHeaders
 * @return {boolean}
 */
export function checkResponseFreshness(reqHeaders, resHeaders) {
	const modifiedSince = reqHeaders['if-modified-since'];
	const noneMatch = reqHeaders['if-none-match'];

	if (!modifiedSince && !noneMatch) return false;

	// NOTE(joel): Always return stale when Cache-Control: no-cache
	// to support end-to-end reload requests.
	// @see https://tools.ietf.org/html/rfc2616#section-14.9.4
	const cacheControl = reqHeaders['cache-control'];
	if (cacheControl && CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControl)) {
		return false;
	}

	if (noneMatch && noneMatch !== '*') {
		const etag = resHeaders.etag;

		if (!etag) return false;

		let etagStale = true;
		const matches = parseTokenList(noneMatch);
		for (let i = 0; i < matches.length; i++) {
			const match = matches[i];
			if (match === etag || match === 'W/' + etag || 'W/' + match === etag) {
				etagStale = false;
				break;
			}
		}

		if (etagStale) return false;
	}

	if (modifiedSince) {
		const lastModified = resHeaders['last-modified'];
		const modifiedStale =
			!lastModified ||
			!(parseHttpDate(lastModified) <= parseHttpDate(modifiedSince));

		if (modifiedStale) return false;
	}

	return true;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * parseHttpDate parses a HTTP Date into a number.
 * @param {string} date
 * @returns {number}
 */
function parseHttpDate(date) {
	let timestamp = date && Date.parse(date);
	return typeof timestamp === 'number' ? timestamp : NaN;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * parseTokenList parses a HTTP token list.
 * @param {string} str
 * @returns {string[]}
 */
function parseTokenList(str) {
	let end = 0;
	let list = [];
	let start = 0;

	for (let i = 0, len = str.length; i < len; i++) {
		switch (str.charCodeAt(i)) {
			case 0x20 /*   */:
				if (start === end) {
					start = end = i + 1;
				}
				break;
			case 0x2c /* , */:
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
