declare module 'cors' {
	export default function cors(options?: {
		origin?: boolean | string | RegExp | Array<boolean | string | RegExp>;
		methods?: string[] | string;
		preflightContinue?: boolean;
		credentials?: boolean;
		optionsSuccessStatus?: number;
	}): (req: object, res: object, next: (result?: unknown) => void) => void;
}
