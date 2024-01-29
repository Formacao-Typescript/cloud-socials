import { oak } from '../../deps.ts';

function getMessage(size?: number) {
	if (!size) {
		return 'Too much media attachments.';
	}

	return `Cannot send more than ${size} media attatchments.`;
}

export class MaxMediaCountError extends oak.HttpError {
	constructor(size?: number, message?: string) {
		super(message || getMessage(size));
	}

	override get status() {
		return 422;
	}
}
