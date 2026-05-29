import corsMiddleware from 'cors';

////////////////////////////////////////////////////////////////////////////////

export type Middleware = (
	req: object,
	res: object,
	next: (result?: unknown) => void,
) => void;

////////////////////////////////////////////////////////////////////////////////

/**
 * Helper method to wait for a middleware to execute before continuing
 * and to throw an error when an error happens in a middleware
 */
export function runMiddleware(req: object, res: object, fn: Middleware) {
	return new Promise<unknown>((resolve, reject) => {
		fn(req, res, (result) => {
			if (result instanceof Error) return reject(result);
			return resolve(result);
		});
	});
}

////////////////////////////////////////////////////////////////////////////////

/**
 * cors middleware
 */
export const cors = corsMiddleware({
	origin: true,
	methods: ['OPTIONS', 'GET', 'HEAD'],
	preflightContinue: false,
	credentials: true,
	optionsSuccessStatus: 200,
});
