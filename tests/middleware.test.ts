import { describe, expect, it, vi } from 'vitest';

import { cors, runMiddleware } from '../src/middleware';

////////////////////////////////////////////////////////////////////////////////
// Mocks and test setup

const mocks = vi.hoisted(() => ({
	cors: vi.fn(() => 'cors-middleware'),
}));

vi.mock('cors', () => ({
	default: mocks.cors,
}));

////////////////////////////////////////////////////////////////////////////////
// Test cases

describe('middleware', () => {
	it('resolves with the middleware result', async () => {
		await expect(
			runMiddleware({}, {}, (_req, _res, next) => {
				next('done');
			}),
		).resolves.toBe('done');
	});

	it('rejects when the middleware forwards an error', async () => {
		await expect(
			runMiddleware({}, {}, (_req, _res, next) => {
				next(new Error('failed'));
			}),
		).rejects.toThrow('failed');
	});

	it('builds the exported cors middleware with the expected policy', () => {
		expect(mocks.cors).toHaveBeenCalledWith({
			origin: true,
			methods: ['OPTIONS', 'GET', 'HEAD'],
			preflightContinue: false,
			credentials: true,
			optionsSuccessStatus: 200,
		});
		expect(cors).toBe('cors-middleware');
	});
});
