import { oak } from '../../deps.ts'

export class FailedToShareError extends oak.HttpError {
	constructor(network: string, details?: Record<string, unknown>, message = 'Failed to share post') {
		super(message, {
			...(details && { cause: { ...details, network } }),
		})
		this.name = `${network}FailedToShareError`
	}

	override get status() {
		return 424
	}
}
