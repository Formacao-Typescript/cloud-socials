import { oak } from '../../deps.ts';

function getMessage(size?: number) {
	if (!size) {
		return 'Text exceeds maximum allowed size.';
	}

	return `Text exceeds maximum allowed size of ${size} characters.`;
}

export class MaxTextSizeError extends oak.HttpError {
	constructor(size?: number, message?: string) {
		super(message || getMessage(size));
	}

	override get status() {
		return 422;
	}
}
