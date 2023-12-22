import { AppConfig } from '../config.ts';
import { encodeBase64, pkce, z } from '../deps.ts';
import { ExpiredTokenError } from '../domain/errors/ExpiredTokenError.ts';
import { WrongTokenError } from '../domain/errors/WrongTokenError.ts';

const accessTokenResponseSchema = z.object({
	token_type: z.literal('bearer'),
	expires_in: z.number().transform((n) => n * 1000),
	access_token: z.string(),
	refresh_token: z.string().optional(),
	scope: z.string(),
});

export class TwitterClient {
	private readonly config: AppConfig['twitter'];
	private readonly logger: AppConfig['loggers']['default'];
	private readonly oauthCallbackUrl: string;
	private readonly baseUrl = 'https://api.twitter.com/2';

	private get kvKeyBuilder() {
		return {
			nonces: (nonce: string) => ['twitter', 'nonces', nonce],
			codeVerifier: (nonce: string) => ['twitter', 'codeVerifier', nonce],
			accessToken: () => ['twitter', 'accessToken'],
			refreshToken: () => ['twitter', 'refreshToken'],
		};
	}

	constructor(config: AppConfig, private readonly db: Deno.Kv) {
		this.config = config.twitter;
		this.logger = config.loggers.default;
		this.oauthCallbackUrl = `${config.server.oauthCallbackBaseUrl}/twitter/oauth/callback`;
	}

	private get accessToken() {
		return this.db.get<string>(this.kvKeyBuilder.accessToken()).then((maybeToken) => maybeToken.value);
	}

	private get refreshToken() {
		return this.db.get<string>(this.kvKeyBuilder.refreshToken()).then((maybeToken) => maybeToken.value);
	}

	async getAuthorizeUrl() {
		const url = new URL('https://twitter.com/i/oauth2/authorize');
		const nonce = encodeBase64(crypto.getRandomValues(new Uint8Array(32)));

		const codePair = pkce.create();

		url.searchParams.append('response_type', 'code');
		url.searchParams.append('client_id', this.config.clientId);
		url.searchParams.append('redirect_uri', this.oauthCallbackUrl);
		url.searchParams.append('state', nonce);
		url.searchParams.append('code_challenge', codePair.codeChallenge);
		url.searchParams.append('code_challenge_method', 'S256');
		url.searchParams.append('scope', 'tweet.read tweet.write users.read offline.access');

		this.logger.debug(`TwitterClient.loginUrl :: URL ${url.toString()}`);
		this.logger.debug(`TwitterClient.loginUrl :: nonce ${nonce}`);
		this.logger.debug(`TwitterClient.loginUrl :: code verifier ${codePair.codeVerifier}`);

		await this.db.set(this.kvKeyBuilder.nonces(nonce), nonce, { expireIn: 60000 });
		await this.db.set(this.kvKeyBuilder.codeVerifier(nonce), codePair.codeVerifier);
		return url.toString().replaceAll('+', '%20');
	}

	async exchangeAccessToken(code: string, nonce: string) {
		this.logger.debug(`TwitterClient.exchangeAccessToken :: nonce ${nonce}`);
		const codeVerifier = await this.db.get<string>(this.kvKeyBuilder.codeVerifier(nonce));

		if (!codeVerifier.value) {
			this.logger.info(`TwitterClient.exchangeAccessToken :: codeVerifier is not present`);
			throw new Error('Code verifier is not present');
		}

		const response = await fetch(`${this.baseUrl}/oauth2/token`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Authorization: `Basic ${encodeBase64(`${this.config.clientId}:${this.config.clientSecret}`)}`,
			},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: this.oauthCallbackUrl,
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
				code_verifier: codeVerifier.value,
			}),
		});

		const rawData = await response.json();
		this.logger.debug(`TwitterClient.exchangeAccessToken :: data ${JSON.stringify(rawData, null, 2)}`);
		const data = accessTokenResponseSchema.parse(rawData);
		return data;
	}

	async saveAccessToken(data: z.infer<typeof accessTokenResponseSchema>) {
		await this.db.set(this.kvKeyBuilder.accessToken(), data.access_token, { expireIn: data.expires_in });

		if (data.refresh_token) {
			await this.db.set(this.kvKeyBuilder.refreshToken(), data.refresh_token);
		}
	}

	async validateAccessToken(): Promise<void> {
		const accessToken = await this.accessToken;
		if (!accessToken) throw new ExpiredTokenError();
		this.logger.debug(`TwitterClient.validateAccessToken :: accessToken is present`);

		const response = await fetch(`${this.baseUrl}/users/me`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		this.logger.debug(`TwitterClient.validateAccessToken :: response status ${response.status}`);

		if (response.status === 401) {
			this.logger.debug(`TwitterClient.validateAccessToken :: accessToken is expired refreshing...`);
			const success = await this.refreshAccessToken();
			if (!success) {
				this.logger.info(
					`TwitterClient.validateAccessToken :: accessToken is expired and refresh token is not present`,
				);
				await this.clearTokens();
				throw new ExpiredTokenError('Expired token', new Error('Failed to refresh token or no refresh token present'));
			}

			this.logger.info(`TwitterClient.validateAccessToken :: accessToken is expired and refreshed successfully`);
			return await this.validateAccessToken();
		}

		const rawData = await response.text();

		this.logger.debug(`TwitterClient.validateAccessToken :: data ${JSON.stringify(rawData, null, 2)}`);

		const data: { id: string } = JSON.parse(rawData);
		if (this.config.allowedUserId && (!data.id || data.id !== this.config.allowedUserId)) {
			this.logger.info(`TwitterClient.validateAccessToken :: accessToken does not belong to allowed user`);
			await this.clearTokens();
			throw new WrongTokenError();
		}
	}

	private async refreshAccessToken() {
		this.logger.debug(`TwitterClient.refreshAccessToken :: refreshing token`);
		const refreshToken = await this.refreshToken;
		if (!refreshToken) return false;

		this.logger.debug(`TwitterClient.refreshAccessToken :: refreshToken is present`);
		const response = await fetch(`${this.baseUrl}/accessToken`, {
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
		this.logger.info(`TwitterClient.refreshAccessToken :: refreshed token ${JSON.stringify(data, null, 2)}`);
		await this.saveAccessToken(data);

		return true;
	}

	async matchState(state: string) {
		const nonce = await this.db.get(this.kvKeyBuilder.nonces(state));
		return nonce.value && nonce.value === state;
	}

	private async clearTokens() {
		this.logger.info(`TwitterClient.clearTokens :: clearing tokens`);
		await this.db.delete(this.kvKeyBuilder.accessToken());
		await this.db.delete(this.kvKeyBuilder.refreshToken());
	}
}
