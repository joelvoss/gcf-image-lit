import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestListener } from '../src/index';

////////////////////////////////////////////////////////////////////////////////
// Mocks and test setup

const mocks = vi.hoisted(() => ({
	handleGet: vi.fn(),
	cors: vi.fn(),
	runMiddleware: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/handler', () => ({
	handleGet: mocks.handleGet,
}));
vi.mock('../src/middleware', () => ({
	cors: mocks.cors,
	runMiddleware: mocks.runMiddleware,
}));

function createRequest(
	overrides: {
		headers?: Record<string, string>;
		method?: string;
		url?: string;
	} = {},
) {
	return {
		method: 'GET',
		headers: {},
		url: '/optimize?url=%2Fimage.png&w=640&q=75',
		...overrides,
	};
}

function createResponse() {
	const response = {
		headersSent: false,
		writableEnded: false,
		statusCode: 200,
		body: undefined as Buffer | string | undefined,
		setHeader: vi.fn(),
		end: vi.fn((body?: Buffer | string) => {
			response.body = body;
			response.writableEnded = true;
		}),
	};

	return response;
}

////////////////////////////////////////////////////////////////////////////////
// Test cases

describe('requestListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.runMiddleware.mockResolvedValue(undefined);
		mocks.handleGet.mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('runs cors middleware before delegating GET requests', async () => {
		const req = createRequest();
		const res = createResponse();

		await requestListener(req as never, res as never);

		expect(mocks.runMiddleware).toHaveBeenCalledWith(req, res, mocks.cors);
		expect(mocks.handleGet).toHaveBeenCalledWith(req, res);
	});

	it('returns early when middleware already finished the response', async () => {
		mocks.runMiddleware.mockImplementation(async (_req, res) => {
			(res as { writableEnded: boolean }).writableEnded = true;
		});
		const req = createRequest();
		const res = createResponse();

		await requestListener(req as never, res as never);

		expect(mocks.handleGet).not.toHaveBeenCalled();
		expect(res.end).not.toHaveBeenCalled();
	});

	it('rejects unsupported request methods', async () => {
		const req = createRequest({ method: 'POST' });
		const res = createResponse();

		await requestListener(req as never, res as never);

		expect(mocks.handleGet).not.toHaveBeenCalled();
		expect(res.setHeader).toHaveBeenCalledWith('Allow', [
			'OPTIONS',
			'GET',
			'HEAD',
		]);
		expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
		expect(res.statusCode).toBe(405);
		expect(res.body).toBe('METHOD-NOT-ALLOWED');
	});

	it('delegates HEAD requests to the GET handler', async () => {
		const req = createRequest({ method: 'HEAD' });
		const res = createResponse();

		await requestListener(req as never, res as never);

		expect(mocks.handleGet).toHaveBeenCalledWith(req, res);
	});

	it('converts unexpected handler errors into a 500 response', async () => {
		const error = new Error('boom');
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mocks.handleGet.mockImplementation(() => {
			throw error;
		});
		const req = createRequest();
		const res = createResponse();

		await requestListener(req as never, res as never);

		expect(console.error).toHaveBeenCalledWith(error);
		expect(res.statusCode).toBe(500);
		expect(res.setHeader).toHaveBeenCalledWith(
			'Content-Type',
			'text/plain; charset=utf-8',
		);
		expect(res.body).toBe('Internal Server Error');
	});
});
