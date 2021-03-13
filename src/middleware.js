import corsMiddleware from 'cors';

////////////////////////////////////////////////////////////////////////////////

/**
 * Helper method to wait for a middleware to execute before continuing
 * and to throw an error when an error happens in a middleware
 * @param {Request} req
 * @param {Response} res
 * @param {Function} fn
 */
export function runMiddleware(req, res, fn) {
	return new Promise((resolve, reject) => {
		fn(req, res, result => {
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
	methods: ['OPTIONS', 'GET'],
	preflightContinue: false,
	credentials: true,
	optionsSuccessStatus: 200, // IE11
});
