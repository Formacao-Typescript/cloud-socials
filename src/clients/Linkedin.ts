import { AppConfig } from '../config.ts';
import { encodeBase64, z } from '../deps.ts';

const accessTokenResponseSchema = z.object({
	access_token: z.string(),
	expires_in: z.number().transform((n) => n * 1000),
	refresh_token: z.string().optional(),
	refresh_token_expires_in: z
		.number()
		.optional()
		.transform((n) => (n ? n * 1000 : n)),
});

export class LinkedinClient {
	private readonly config: AppConfig['linkedin'];
	private readonly logger: AppConfig['loggers']['default'];
	private readonly oauthCallbackUrl: string;

	private get kvKeyBuilder() {
		return {
			nonces: (nonce: string) => ['linkedin', 'nonces', nonce],
			accessToken: () => ['linkedin', 'accessToken'],
			refreshToken: () => ['linkedin', 'refreshToken'],
		};
	}

	constructor(config: AppConfig, private readonly db: Deno.Kv) {
		this.config = config.linkedin;
		this.logger = config.loggers.default;
		this.oauthCallbackUrl = `${config.server.oauthCallbackBaseUrl}/linkedin/oauth/callback`;
	}

	get loginUrl() {
		const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
		const nonce = encodeBase64(crypto.getRandomValues(new Uint8Array(32)));
		url.searchParams.append('response_type', 'code');
		url.searchParams.append('client_id', this.config.clientId);
		url.searchParams.append('redirect_uri', this.oauthCallbackUrl);
		url.searchParams.append('state', nonce);
		url.searchParams.append('scope', 'r_emailaddress w_member_social r_basicprofile');

		this.logger.debug(`LinkedinClient.loginUrl :: URL ${url.toString()}`);
		this.logger.debug(`LinkedinClient.loginUrl :: nonce ${nonce}`);

		this.db.set(this.kvKeyBuilder.nonces(nonce), nonce, { expireIn: 60000 });
		return url.toString().replaceAll('+', '%20');
	}

	async matchState(state: string) {
		const nonce = await this.db.get(this.kvKeyBuilder.nonces(state));
		return nonce.value && nonce.value === state;
	}

	async exchangeAccessToken(code: string, nonce: string) {
		this.logger.debug(`LinkedinClient.getAccessToken :: nonce ${nonce}`);

		const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: this.oauthCallbackUrl,
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
			}),
		});

		const data = accessTokenResponseSchema.parse(await response.json());
		this.logger.debug(`LinkedinClient.getAccessToken :: data ${data}`);
		return data;
	}

	async saveAccessToken(data: z.infer<typeof accessTokenResponseSchema>) {
		await this.db.set(this.kvKeyBuilder.accessToken(), data.access_token, { expireIn: data.expires_in });

		if (data.refresh_token) {
			await this.db.set(this.kvKeyBuilder.refreshToken(), data.refresh_token, {
				expireIn: data.refresh_token_expires_in,
			});
		}
	}

	async getAccessToken() {
		const accessToken = await this.db.get<string>(this.kvKeyBuilder.accessToken());
		return accessToken.value;
	}
}
