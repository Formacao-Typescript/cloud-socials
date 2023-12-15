import { AppConfig } from '../config.ts';
import { encodeBase64, z } from '../deps.ts';
import { ExpiredTokenError } from '../domain/errors/ExpiredTokenError.ts';
import { WrongTokenError } from '../domain/errors/WrongTokenError.ts';

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
	private readonly baseUrl = 'https://api.linkedin.com/v2';
	private readonly oauthURL = 'https://www.linkedin.com/oauth/v2';

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

	private get accessToken() {
		return this.db.get<string>(this.kvKeyBuilder.accessToken()).then((maybeToken) => maybeToken.value);
	}

	private get refreshToken() {
		return this.db.get<string>(this.kvKeyBuilder.refreshToken()).then((maybeToken) => maybeToken.value);
	}

	get loginUrl() {
		const url = new URL(`${this.oauthURL}/authorization`);
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

	async exchangeAccessToken(code: string, nonce: string) {
		this.logger.debug(`LinkedinClient.getAccessToken :: nonce ${nonce}`);

		const response = await fetch(`${this.oauthURL}/accessToken`, {
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
		this.logger.debug(`LinkedinClient.getAccessToken :: data ${JSON.stringify(data, null, 2)}`);
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

	async validateAccessToken(): Promise<void> {
		const accessToken = await this.accessToken;
		if (!accessToken) throw new ExpiredTokenError();
		this.logger.debug(`LinkedinClient.validateAccessToken :: accessToken is present`);

		const response = await fetch(`${this.baseUrl}/me`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (response.status === 401) {
			this.logger.debug(`LinkedinClient.validateAccessToken :: accessToken is expired refreshing...`);
			const success = await this.refreshAccessToken();
			if (!success) {
				this.logger.info(
					`LinkedinClient.validateAccessToken :: accessToken is expired and refresh token is not present`,
				);
				await this.clearTokens();
				throw new ExpiredTokenError('Expired token', new Error('Failed to refresh token or no refresh token present'));
			}

			this.logger.info(`LinkedinClient.validateAccessToken :: accessToken is expired and refreshed successfully`);
			return await this.validateAccessToken();
		}

		const data: { id: string } = await response.json();
		if (!data.id || data.id !== this.config.allowedUserId) {
			this.logger.info(`LinkedinClient.validateAccessToken :: accessToken does not belong to allowed user`);
			await this.clearTokens();
			throw new WrongTokenError();
		}
	}

	private async refreshAccessToken() {
		this.logger.debug(`LinkedinClient.refreshAccessToken :: refreshing token`);
		const refreshToken = await this.refreshToken;
		if (!refreshToken) return false;

		this.logger.debug(`LinkedinClient.refreshAccessToken :: refreshToken is present`);
		const response = await fetch(`${this.oauthURL}/accessToken`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
			}),
		});

		const data = accessTokenResponseSchema.parse(await response.json());
		this.logger.info(`LinkedinClient.refreshAccessToken :: refreshed token ${JSON.stringify(data, null, 2)}`);
		await this.saveAccessToken(data);

		return true;
	}

	async matchState(state: string) {
		const nonce = await this.db.get(this.kvKeyBuilder.nonces(state));
		return nonce.value && nonce.value === state;
	}

	private async clearTokens() {
		this.logger.info(`LinkedinClient.clearTokens :: clearing tokens`);
		await this.db.delete(this.kvKeyBuilder.accessToken());
		await this.db.delete(this.kvKeyBuilder.refreshToken());
	}
}
