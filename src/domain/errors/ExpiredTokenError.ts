import { oak } from '../../deps.ts';

export class ExpiredTokenError extends oak.HttpError {
	constructor(message = 'Token expired', details?: Error) {
		super(message, {
			...(details && { cause: details.message }),
		});
	}

	override get status() {
		return 511;
	}
}
