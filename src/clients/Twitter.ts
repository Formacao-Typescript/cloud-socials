import { AppConfig } from '../config.ts';
import { Buffer, twitter, z } from '../deps.ts';
import { ExpiredTokenError } from '../domain/errors/ExpiredTokenError.ts';
import { MaxMediaCountError } from '../domain/errors/MaxMediaCountError.ts';
import { MaxTextSizeError } from '../domain/errors/MaxTextSizeError.ts';

const accessTokenResponseSchema = z.object({
	token_type: z.literal('bearer'),
	expires_in: z.number().transform((n) => n * 1000),
	access_token: z.string(),
	refresh_token: z.string().optional(),
	scope: z.string(),
});

const SCOPE = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

export const MAX_TWEET_LENGTH = 280;

export const TwitterMediaObject = z.object({
	source: z.string().url(),
	mimeType: z.string().regex(/.+\/.+/),
});

export type TwitterMediaObject = z.infer<typeof TwitterMediaObject>;

export const TwitterPostObject = z.object({
	text: z.string(),
	media: z.array(TwitterMediaObject).min(1).max(4).optional(),
	// Tries to send the text even if it exceeds 280 characters.
	// Usefull for when there's a link in the tweet that you know will be shortened by twitter.
	ignoreCharacterLimit: z.boolean().optional().default(false),
});

export type TwitterPostObject = z.infer<typeof TwitterPostObject>;

export const TwitterThreadObject = TwitterPostObject
	.omit({ text: true })
	.extend({ tweets: z.array(z.string()) });

export type TwitterThreadObject = z.infer<typeof TwitterThreadObject>;

export class TwitterClient {
	private readonly config: AppConfig['twitter'];
	private readonly logger: AppConfig['loggers']['default'];
	private readonly oauthCallbackUrl: string;
	private readonly client: twitter.TwitterApi;
	private authenticatedClient: twitter.TwitterApi | null = null;

	constructor(config: AppConfig, private readonly db: Deno.Kv) {
		this.config = config.twitter;
		this.logger = config.loggers.default;
		this.oauthCallbackUrl = `${config.server.oauthCallbackBaseUrl}/twitter/oauth/callback`;
		this.client = new twitter.TwitterApi({
			appKey: this.config.appKey,
			appSecret: this.config.appSecret,
			accessToken: this.config.accessToken,
			accessSecret: this.config.accessSecret,
		});
	}

	get kvKeyBuilder() {
		return {
			nonces: (nonce: string) => ['twitter', 'nonces', nonce],
			codeVerifier: (nonce: string) => ['twitter', 'codeVerifier', nonce],
			codeChallenge: (nonce: string) => ['twitter', 'codeChallenge', nonce],
			accessToken: () => ['twitter', 'accessToken'],
			refreshToken: () => ['twitter', 'refreshToken'],
		};
	}

	private get accessToken() {
		return this.db.get<string>(this.kvKeyBuilder.accessToken()).then((maybeToken) => maybeToken.value);
	}

	private get refreshToken() {
		return this.db.get<string>(this.kvKeyBuilder.refreshToken()).then((maybeToken) => maybeToken.value);
	}

	async getAuthorizeUrl() {
		const client = new twitter.TwitterApi({
			clientId: this.config.clientId,
			clientSecret: this.config.clientSecret,
		});

		const { codeVerifier, state: nonce, url } = client.generateOAuth2AuthLink(
			this.oauthCallbackUrl,
			{ scope: SCOPE },
		);

		this.logger.debug(`TwitterClient.loginUrl :: URL ${url}`);
		this.logger.debug(`TwitterClient.loginUrl :: nonce ${nonce}`);

		await this.db.set(this.kvKeyBuilder.nonces(nonce), nonce, { expireIn: 60000 });
		await this.db.set(this.kvKeyBuilder.codeVerifier(nonce), codeVerifier, { expireIn: 60000 });
		return url;
	}

	async exchangeAccessToken(code: string, nonce: string): Promise<z.infer<typeof accessTokenResponseSchema>> {
		this.logger.debug(`TwitterClient.exchangeAccessToken :: nonce ${nonce}`);
		const codeVerifier = await this.db.get<string>(this.kvKeyBuilder.codeVerifier(nonce))
			.then((entry) => entry.value);

		if (!codeVerifier) {
			this.logger.debug(`TwitterClient.exchangeAccessToken :: codeVerifier not found for nonce ${nonce}`);
			throw new Error(`Code verifier not found for nonce ${nonce}`);
		}

		const client = new twitter.TwitterApi({
			clientId: this.config.clientId,
			clientSecret: this.config.clientSecret,
		});

		const { accessToken, expiresIn, refreshToken, scope } = await client.loginWithOAuth2({
			code,
			codeVerifier,
			redirectUri: this.oauthCallbackUrl,
		});

		return {
			token_type: 'bearer',
			access_token: accessToken,
			expires_in: expiresIn,
			refresh_token: refreshToken,
			scope: scope.join(' '),
		};
	}

	async saveAccessToken(data: z.infer<typeof accessTokenResponseSchema>) {
		this.logger.debug(`TwitterClient.saveAccessToken :: parsing accessTokenData ${JSON.stringify(data)}`);
		const accessTokenData = accessTokenResponseSchema.parse(data);
		this.logger.debug(
			`TwitterClient.saveAccessToken :: saving accessToken. it expires in ${accessTokenData.expires_in}ms`,
		);
		await this.db.set(this.kvKeyBuilder.accessToken(), accessTokenData.access_token, {
			expireIn: accessTokenData.expires_in,
		});
		this.logger.debug(`TwitterClient.saveAccessToken :: accessToken saved`);

		if (accessTokenData.refresh_token) {
			this.logger.debug(`TwitterClient.saveAccessToken :: saving refreshToken`);
			await this.db.set(this.kvKeyBuilder.refreshToken(), accessTokenData.refresh_token);
			this.logger.debug(`TwitterClient.saveAccessToken :: refreshToken saved`);
		}
	}

	async validateAccessToken(): Promise<void> {
		this.logger.debug(`TwitterClient.validateAccessToken :: validating accessToken`);
		const accessToken = await this.accessToken;

		if (accessToken) {
			this.logger.info(`TwitterClient.validateAccessToken :: accessToken present`);
			return;
		}

		this.logger.debug(`TwitterClient.validateAccessToken :: no accessToken present. trying to refresh`);

		const success = await this.refreshAccessToken();

		if (!success) {
			this.logger.info(
				`TwitterClient.validateAccessToken :: could not refresh token`,
			);
			await this.clearTokens();
			throw new ExpiredTokenError('Expired token', new Error('Failed to refresh token or no refresh token present'));
		}

		this.logger.info(`TwitterClient.validateAccessToken :: accessToken refreshed successfully`);
	}

	private async refreshAccessToken() {
		this.logger.debug(`TwitterClient.refreshAccessToken :: refreshing token`);
		const refreshToken = await this.refreshToken;
		if (!refreshToken) return false;

		this.logger.debug(`TwitterClient.refreshAccessToken :: refreshToken is present`);

		const client = new twitter.TwitterApi({
			clientId: this.config.clientId,
			clientSecret: this.config.clientSecret,
		});

		try {
			const {
				accessToken,
				expiresIn,
				scope,
				refreshToken: newRefreshToken,
				client: authenticatedClient,
			} = await client.refreshOAuth2Token(refreshToken);

			this.authenticatedClient = authenticatedClient;

			const tokenObject = {
				token_type: 'bearer' as const,
				access_token: accessToken,
				expires_in: expiresIn,
				scope: scope.join(' '),
				refreshToken: newRefreshToken,
			};

			this.logger.info(`TwitterClient.refreshAccessToken :: refreshed token ${JSON.stringify(tokenObject, null, 2)}`);
			await this.saveAccessToken(tokenObject);

			return true;
		} catch (err) {
			console.log(err);
			this.logger.error(`TwitterClient.refreshAccessToken :: error refreshing token: ${err}`);
			return false;
		}
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

	private async getAuthenticatedClient() {
		if (this.authenticatedClient) {
			await this.validateAccessToken();
			return this.authenticatedClient;
		}

		const accessToken = await this.accessToken;

		if (!accessToken) {
			this.logger.error(`TwitterClient.getAuthenticatedClient :: no accessToken present`);
			throw new Error('No access token present');
		}

		this.authenticatedClient = new twitter.TwitterApi(accessToken);
		return this.authenticatedClient;
	}

	private async uploadMediaFromUrl({ source: url, mimeType }: TwitterMediaObject) {
		const client = new twitter.TwitterApi({
			appKey: this.config.appKey,
			appSecret: this.config.appSecret,
			accessToken: this.config.accessToken,
			accessSecret: this.config.accessSecret,
		});

		this.logger.debug(`TwitterClient.uploadMediaFromUrl :: fetching media from url ${url}`);

		const media = await fetch(url, { method: 'GET' })
			.then((response) => response.arrayBuffer())
			.then((arrayBuffer) => Buffer.from(arrayBuffer))
			.catch((err) => {
				this.logger.error(`TwitterClient.uploadMediaFromUrl :: error fetching media from url ${url}: ${err}`);
				throw err;
			});

		this.logger.debug(`TwitterClient.uploadMediaFromUrl :: uploading media`);

		const mediaId = await client.v1.uploadMedia(media, { mimeType });

		this.logger.info(`TwitterClient.uploadMediaFromUrl :: uploaded media ${mediaId} from url ${url}`);

		return mediaId;
	}

	async createTweet({ text, media = [], ignoreCharacterLimit }: TwitterPostObject, inReplyTo?: string) {
		this.logger.debug(`TwitterClient.createTweet :: creating tweet`);

		if (!ignoreCharacterLimit && text.length > MAX_TWEET_LENGTH) throw new MaxTextSizeError(MAX_TWEET_LENGTH);
		if (media.length > 4) throw new MaxMediaCountError(4);

		const client = await this.getAuthenticatedClient();

		const mediaIds = await Promise.all(
			media.map(this.uploadMediaFromUrl.bind(this)),
		);

		const options: Partial<twitter.SendTweetV2Params> = {
			...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
			...(inReplyTo ? { reply: { in_reply_to_tweet_id: inReplyTo } } : {}),
		};

		const { data, errors } = await client.v2.tweet(text, options);

		if (errors || !data) {
			this.logger.error(`TwitterClient.createTweet :: error creating tweet: ${JSON.stringify(errors)}`);
			throw new Error(`Error creating tweet: ${JSON.stringify(errors)}`);
		}

		this.logger.info(`TwitterClient.createTweet :: created tweet ${data.id}`);
		return data;
	}

	async createThread({ tweets, media = [], ignoreCharacterLimit }: TwitterThreadObject) {
		this.logger.debug(`TwitterClient.createThread :: creating thread`);

		if (!ignoreCharacterLimit && tweets.some((tweet) => tweet.length > MAX_TWEET_LENGTH)) {
			throw new MaxTextSizeError(MAX_TWEET_LENGTH);
		}
		if (media.length > 4) throw new MaxMediaCountError(4);

		const [firstText, ...otherTexts] = tweets;

		try {
			const { id: headId } = await this.createTweet({
				text: firstText,
				ignoreCharacterLimit,
				media,
			});

			let inReplyTo = headId;

			for (const text of otherTexts) {
				const { id } = await this.createTweet({ text, ignoreCharacterLimit }, inReplyTo);
				inReplyTo = id;
			}

			this.logger.info(`TwitterClient.createThread :: created thread with head ID ${headId}`);

			return headId;
		} catch (err) {
			this.logger.error(`TwitterClient.createThread :: error creating thread: ${err}`);
			throw err;
		}
	}
}
