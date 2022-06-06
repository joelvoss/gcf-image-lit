import listen from 'test-listen';
import { Client } from 'undici';
import { getServer } from './utils/test-server';

////////////////////////////////////////////////////////////////////////////////

describe('handler', () => {
	let srv, prefixUrl, client;
	let origDateNow = Date.now;

	const { handler } = require('../src/index');

	beforeEach(async () => {
		srv = getServer(handler);
		prefixUrl = await listen(srv);
		client = new Client(prefixUrl);
		global.Date.now = jest.fn(() => new Date('2021-01-01T12:00:00Z').getTime());
	});

	afterEach(() => {
		srv.close();
		global.Date.now = origDateNow;
	});

	let w = 384;
	let q = 75;

	it('should fail when url is missing', async () => {
		const searchParams = { w, q: 100 };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(`"url" parameter is required`);
		client.close();
	});

	it('should fail when w is missing', async () => {
		const searchParams = { url: 'test-screen.png', q: 100 };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(`"w" parameter (width) is required`);
		client.close();
	});

	it('should fail when w is not supported', async () => {
		const searchParams = { url: 'test-screen.png', w: 9999, q: 100 };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(`"w" parameter (width) of 9999 is not allowed`);
		client.close();
	});

	it('should fail when w is 0 or less', async () => {
		const searchParams = { url: '/test-screen.png', w: 0, q: 100 };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(`"w" parameter (width) must be a number greater than 0`);
		client.close();
	});

	it('should fail when w is not a number', async () => {
		const searchParams = { url: '/test-screen.png', w: 'foo', q: 100 };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(`"w" parameter (width) must be a number greater than 0`);
		client.close();
	});

	it('should fail when q is missing', async () => {
		const searchParams = { url: 'test-screen.png', w };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(`"q" parameter (quality) is required`);
		client.close();
	});

	it('should fail when q is greater than 100', async () => {
		const searchParams = { url: 'test-screen.png', w, q: 101 };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(
			`"q" parameter (quality) must be a number between 1 and 100`,
		);
		client.close();
	});

	it('should fail when q is less than 1', async () => {
		const searchParams = { url: '/test-screen.png', w, q: 0 };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(
			`"q" parameter (quality) must be a number between 1 and 100`,
		);
		client.close();
	});

	it('should fail when q is not a number', async () => {
		const searchParams = { url: '/test-screen.png', w, q: 'foo' };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(
			`"q" parameter (quality) must be a number between 1 and 100`,
		);
		client.close();
	});

	it('should fail when f is not a supported format', async () => {
		const searchParams = { url: '/test-screen.png', w, q, f: 'unsupported' };
		const { statusCode, body: _body } = await client.request({
			path: '/',
			method: 'GET',
			query: searchParams,
		});
		const body = await _body.text();
		expect(statusCode).toBe(400);
		expect(body).toBe(`"f" parameter (format) of unsupported is not allowed`);
		client.close();
	});
});
