describe('getSupportedMimeType', () => {
	const { getSupportedMimeType } = require('../src/shared');

	it(`should return a supported mimetype`, () => {
		const preferredTypes = ['image/avif', 'image/webp'];
		const acceptHeader =
			'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
		const mimeType = getSupportedMimeType(preferredTypes, acceptHeader);
		expect(mimeType).toBe('image/avif');
	});

	it(`shouldn't return a mimetype, if no preferred one was found`, () => {
		const preferredTypes = ['image/avif', 'image/webp'];
		const acceptHeader = 'image/apng,image/svg+xml,image/*,*/*;q=0.8';
		const mimeType = getSupportedMimeType(preferredTypes, acceptHeader);
		expect(mimeType).toBe('');
	});

	it(`should return the mimetype the accept header prefers`, () => {
		const preferredTypes = [];
		const acceptHeader = 'image/apng,image/svg+xml,image/*,*/*;q=0.8';
		const mimeType = getSupportedMimeType(preferredTypes, acceptHeader);
		expect(mimeType).toBe('image/apng');
	});
});

////////////////////////////////////////////////////////////////////////////////

describe('getHash', () => {
	const { getHash } = require('../src/shared');

	it(`should return a hash`, () => {
		const hash = getHash([1, 'test-screen.jpeg', 385, 75, '', 'image/webp']);
		expect(hash).toBe('+8puXuu4zr4ojrOqHlySeeZRUgWfxVRsT-txaO7e3bw=');
	});
});

////////////////////////////////////////////////////////////////////////////////

describe('getContentType', () => {
	const { getContentType } = require('../src/shared');

	it(`should return a proper contentType`, () => {
		const jpg = getContentType('jpg');
		const jpeg = getContentType('jpeg');
		const png = getContentType('png');
		const webp = getContentType('webp');
		const avif = getContentType('avif');

		expect(jpeg).toBe('image/jpeg');
		expect(jpg).toBe('image/jpeg');
		expect(png).toBe('image/png');
		expect(webp).toBe('image/webp');
		expect(avif).toBe('image/avif');
	});

	it(`should return null if the input is unknown`, () => {
		const empty = getContentType('');
		const unknown = getContentType('unknown');
		const _null = getContentType('unknown');

		expect(empty).toBeNull();
		expect(unknown).toBeNull();
		expect(_null).toBeNull();
	});
});

////////////////////////////////////////////////////////////////////////////////

describe('getExtension', () => {
	const { getExtension } = require('../src/shared');

	it(`should return a proper extension`, () => {
		const jpeg = getExtension('image/jpeg');
		const png = getExtension('image/png');
		const webp = getExtension('image/webp');
		const avif = getExtension('image/avif');

		expect(jpeg).toBe('jpeg');
		expect(png).toBe('png');
		expect(webp).toBe('webp');
		expect(avif).toBe('avif');
	});

	it(`should return null if the mime is unknown`, () => {
		const unknown = getExtension('image/unkown');
		const empty = getExtension('');
		const _null = getExtension();

		expect(unknown).toBeNull();
		expect(empty).toBeNull();
		expect(_null).toBeNull();
	});
});

////////////////////////////////////////////////////////////////////////////////

describe('getMaxAge', () => {
	const { getMaxAge } = require('../src/shared');

	it(`should return a proper maxAge`, () => {
		const maxAge = getMaxAge('public, max-age=120, while-revalidate');
		expect(maxAge).toBe(120);
	});

	it(`should return a the minimum maxAge configured`, () => {
		const noMaxAge = getMaxAge('private, no-cache');
		const empty = getMaxAge('');
		const _null = getMaxAge();

		expect(noMaxAge).toBe(60);
		expect(empty).toBe(60);
		expect(_null).toBe(60);
	});
});

////////////////////////////////////////////////////////////////////////////////

describe('isAnimated', () => {
	const { isAnimated } = require('../src/shared');
	const fixtures = require('fixturez');
	const fs = require('fs');

	let f;
	beforeEach(() => {
		f = fixtures(__dirname);
	});
	afterEach(() => {
		f.cleanup();
	});

	it('should detect if a PNG image is of type animated', () => {
		let png = f.find('default.png');
		const pngBuffer = fs.readFileSync(png);
		expect(isAnimated(pngBuffer)).toBe(false);

		let a_png = f.find('animated.png');
		const a_pngBuffer = fs.readFileSync(a_png);
		expect(isAnimated(a_pngBuffer)).toBe(true);
	});

	it('should detect if a GIF image is of type animated', () => {
		let gif = f.find('default.gif');
		const gifBuffer = fs.readFileSync(gif);
		expect(isAnimated(gifBuffer)).toBe(false);

		let a_gif = f.find('animated.gif');
		const a_gifBuffer = fs.readFileSync(a_gif);
		expect(isAnimated(a_gifBuffer)).toBe(true);
	});

	it('should detect if a WebP image is of type animated', () => {
		let webp = f.find('default.webp');
		const webpBuffer = fs.readFileSync(webp);
		expect(isAnimated(webpBuffer)).toBe(false);

		let a_webp = f.find('animated.webp');
		const a_webpBuffer = fs.readFileSync(a_webp);
		expect(isAnimated(a_webpBuffer)).toBe(true);
	});
});

////////////////////////////////////////////////////////////////////////////////

describe('checkResponseFreshness', () => {
	const { checkResponseFreshness } = require('../src/shared');

	it('should be stale when a non-conditional GET is performed', () => {
		const reqHeaders = {};
		const resHeaders = {};
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);
	});

	it('should be fresh when ETags match', () => {
		const reqHeaders = { 'if-none-match': '"foo"' };
		const resHeaders = { etag: '"foo"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(true);
	});

	it('should be stale when ETags mismatch', () => {
		const reqHeaders = { 'if-none-match': '"foo"' };
		const resHeaders = { etag: '"bar"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);
	});

	it('should be fresh when at least one matches', () => {
		const reqHeaders = { 'if-none-match': '"bar" , "foo"' };
		const resHeaders = { etag: '"foo"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(true);
	});

	it('should be stale when etag is missing', () => {
		const reqHeaders = { 'if-none-match': '"foo"' };
		const resHeaders = {};
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);
	});

	it('should be fresh when ETag is weak', () => {
		let reqHeaders = { 'if-none-match': 'W/"foo"' };
		let resHeaders = { etag: 'W/"foo"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(true);

		reqHeaders = { 'if-none-match': 'W/"foo"' };
		resHeaders = { etag: '"foo"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(true);
	});

	it('should be fresh when ETag is strong', () => {
		let reqHeaders = { 'if-none-match': '"foo"' };
		let resHeaders = { etag: '"foo"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(true);

		reqHeaders = { 'if-none-match': '"foo"' };
		resHeaders = { etag: 'W/"foo"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(true);
	});

	it('should be fresh when * is given', () => {
		let reqHeaders = { 'if-none-match': '*' };
		let resHeaders = { etag: '"foo"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(true);
	});

	it('should get ignored if * is not only value', () => {
		reqHeaders = { 'if-none-match': '*, "bar"' };
		resHeaders = { etag: '"foo"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);
	});

	it('should be stale when modified since the date', () => {
		const reqHeaders = { 'if-modified-since': 'Sat, 01 Jan 2000 00:00:00 GMT' };
		const resHeaders = { 'last-modified': 'Sat, 01 Jan 2000 01:00:00 GMT' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);
	});

	it('should be fresh when unmodified since the date', () => {
		const reqHeaders = { 'if-modified-since': 'Sat, 01 Jan 2000 01:00:00 GMT' };
		const resHeaders = { 'last-modified': 'Sat, 01 Jan 2000 00:00:00 GMT' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(true);
	});

	it('should be stale when Last-Modified is missing', () => {
		const reqHeaders = { 'if-modified-since': 'Sat, 01 Jan 2000 00:00:00 GMT' };
		const resHeaders = {};
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);
	});

	it('should be stale with invalid If-Modified-Since date', () => {
		const reqHeaders = { 'if-modified-since': 'foo' };
		const resHeaders = { 'last-modified': 'Sat, 01 Jan 2000 00:00:00 GMT' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);
	});

	it('should be stale with invalid Last-Modified date', () => {
		const reqHeaders = { 'if-modified-since': 'Sat, 01 Jan 2000 00:00:00 GMT' };
		const resHeaders = { 'last-modified': 'foo' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);
	});

	it('should be stale when requested with Cache-Control: no-cache', () => {
		let reqHeaders = { 'cache-control': ' no-cache' };
		let resHeaders = {};
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);

		reqHeaders = { 'cache-control': ' no-cache', 'if-none-match': '"foo"' };
		resHeaders = { etag: '"foo"' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);

		reqHeaders = {
			'cache-control': ' no-cache',
			'if-modified-since': 'Sat, 01 Jan 2000 01:00:00 GMT',
		};
		resHeaders = { 'last-modified': 'Sat, 01 Jan 2000 00:00:00 GMT' };
		expect(checkResponseFreshness(reqHeaders, resHeaders)).toBe(false);
	});
});
