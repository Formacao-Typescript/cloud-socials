import { oak } from '../../deps.ts'

export class WrongTokenError extends oak.HttpError {
	constructor(message = 'Token belongs to a different user than allowed', details?: Error) {
		super(message, {
			...(details && { cause: details.message }),
		})
	}

	override get status() {
		return 423
	}
}
