import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';

import { handleGet } from './handler';
import { cors, runMiddleware } from './middleware';

export { handleGet } from './handler';

////////////////////////////////////////////////////////////////////////////////

/**
 * Main request listener for the HTTP server. This function is responsible for
 * handling incoming requests, running middleware (like CORS), and routing to
 * the appropriate handler based on the HTTP method.
 */
export async function requestListener(
	req: IncomingMessage,
	res: ServerResponse,
) {
	try {
		await runMiddleware(req, res, cors);
		if (res.writableEnded) return;

		switch (req.method) {
			case 'GET':
			case 'HEAD':
				return handleGet(req, res);
			default:
				res.setHeader('Allow', ['OPTIONS', 'GET', 'HEAD']);
				res.setHeader('Content-Type', 'text/plain');
				res.statusCode = 405;
				res.end('METHOD-NOT-ALLOWED');
				return;
		}
	} catch (error) {
		console.error(error);
		if (!res.headersSent) {
			res.statusCode = 500;
			res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		}
		if (!res.writableEnded) {
			res.end('Internal Server Error');
		}
	}
}

////////////////////////////////////////////////////////////////////////////////

/**
 * If this module is being run directly (e.g., `node src/index.js`), start the
 * HTTP server. The server listens on the port specified by the `PORT`
 * environment variable, or defaults to 8080 if not set. The request listener
 * defined above will handle all incoming requests.
 */
if (require.main === module) {
	const port = Number(process.env.PORT || '8080');
	const server = createServer(requestListener);

	server.listen(port, () => {
		console.log(`Server listening on http://0.0.0.0:${port}`);
	});
}
