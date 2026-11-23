export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

export const notFound = (what = 'Not found') => new HttpError(404, what)
export const badRequest = (message: string) => new HttpError(400, message)
