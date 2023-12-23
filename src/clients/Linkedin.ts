import { AppConfig } from '../config.ts'
import { crypto, encodeBase64, z } from '../deps.ts'
import { LinkedinPost } from '../domain/LinkedinPost.ts'
import { ExpiredTokenError } from '../domain/errors/ExpiredTokenError.ts'
import { FailedToShareError } from '../domain/errors/FailedToShareError.ts'
import { WrongTokenError } from '../domain/errors/WrongTokenError.ts'

export enum LinkedinMediaTypes {
	IMAGE = 'image',
	DOCUMENT = 'document',
	ARTICLE = 'article',
	VIDEO = 'video',
}

const accessTokenResponseSchema = z.object({
	access_token: z.string(),
	expires_in: z.number().transform((n) => n * 1000),
	refresh_token: z.string().optional(),
	refresh_token_expires_in: z
		.number()
		.optional()
		.transform((n) => (n ? n * 1000 : n)),
})

const LinkedinMediaSchema = z.object({
	type: z.nativeEnum(LinkedinMediaTypes),
	source: z.string().url(),
	thumbnail: z.string().url().optional(),
	title: z.string().max(100),
	description: z.string().max(300).optional(),
})
export type LinkedinMedia = z.infer<typeof LinkedinMediaSchema>

export const LinkedinShareInputSchema = z.object({
	text: z.string().max(3000),
	media: LinkedinMediaSchema.optional(),
	comments: z.array(
		z.object({
			text: z.string().max(3000),
		}),
	),
})

type LinkedinShareInput = z.infer<typeof LinkedinShareInputSchema>

export class LinkedinClient {
	private readonly config: AppConfig['linkedin']
	private readonly logger: AppConfig['loggers']['default']
	private readonly oauthCallbackUrl: string
	private readonly baseUrl = 'https://api.linkedin.com/v2'
	private readonly oauthURL = 'https://www.linkedin.com/oauth/v2'
	private readonly apiVersion = '202311'
	private readonly restliProtocolVersion = '2.0.0'

	constructor(config: AppConfig, private readonly db: Deno.Kv) {
		this.config = config.linkedin
		this.logger = config.loggers.default
		this.oauthCallbackUrl = `${config.server.oauthCallbackBaseUrl}/linkedin/oauth/callback`
	}

	// #region getters
	private get kvKeyBuilder() {
		const prefix = 'linkedin'
		return {
			nonces: (nonce: string) => [prefix, 'nonces', nonce],
			accessToken: () => [prefix, 'accessToken'],
			refreshToken: () => [prefix, 'refreshToken'],
		}
	}

	private async accessToken() {
		const result = await this.db.get<string>(this.kvKeyBuilder.accessToken())
		if (!result.value) {
			const refreshResult = await this.refreshAccessToken()
			if (!refreshResult) throw new ExpiredTokenError()
		}
		return result.value
	}

	private async refreshToken() {
		const result = await this.db.get<string>(this.kvKeyBuilder.refreshToken())
		if (!result.value) throw new ExpiredTokenError()
		return result.value
	}

	private get authorizedUserURN() {
		return `urn:li:person:${this.config.allowedUserId}`
	}

	get loginUrl() {
		const url = new URL(`${this.oauthURL}/authorization`)
		const nonce = encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
		url.searchParams.append('response_type', 'code')
		url.searchParams.append('client_id', this.config.clientId)
		url.searchParams.append('redirect_uri', this.oauthCallbackUrl)
		url.searchParams.append('state', nonce)
		url.searchParams.append(
			'scope',
			'r_emailaddress w_member_social r_basicprofile w_organization_social rw_ads r_organization_social',
		)

		this.logger.debug(`LinkedinClient.loginUrl :: URL ${url.toString()}`)
		this.logger.debug(`LinkedinClient.loginUrl :: nonce ${nonce}`)

		this.db.set(this.kvKeyBuilder.nonces(nonce), nonce, { expireIn: 60000 })
		return url.toString().replaceAll('+', '%20')
	}

	// 'post' doesn't really exist but it's the only way to share a post
	private getAssetUrl(type: Omit<LinkedinMedia['type'], 'article'>) {
		return `https://api.linkedin.com/rest/${type}s`
	}
	// #endregion

	// #region auth
	async exchangeAccessToken(code: string, nonce: string) {
		this.logger.debug(`LinkedinClient.exchangeAccessToken :: nonce ${nonce}`)

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
		})

		const data = accessTokenResponseSchema.parse(await response.json())
		this.logger.debug(`LinkedinClient.exchangeAccessToken :: data ${JSON.stringify(data, null, 2)}`)
		return data
	}

	async saveAccessToken(data: z.infer<typeof accessTokenResponseSchema>) {
		await this.db.set(this.kvKeyBuilder.accessToken(), data.access_token, { expireIn: data.expires_in })

		if (data.refresh_token) {
			await this.db.set(this.kvKeyBuilder.refreshToken(), data.refresh_token, {
				expireIn: data.refresh_token_expires_in,
			})
		}
	}

	async validateAccessToken(): Promise<void> {
		const accessToken = await this.accessToken()
		this.logger.debug(`LinkedinClient.validateAccessToken :: accessToken is present`)

		const response = await fetch(`${this.baseUrl}/me`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		})

		if (response.status === 401) {
			this.logger.debug(`LinkedinClient.validateAccessToken :: accessToken is expired refreshing...`)
			const success = await this.refreshAccessToken()
			if (!success) {
				this.logger.info(
					`LinkedinClient.validateAccessToken :: accessToken is expired and refresh token is not present`,
				)
				await this.clearTokens()
				throw new ExpiredTokenError('Expired token', new Error('Failed to refresh token or no refresh token present'))
			}

			this.logger.info(`LinkedinClient.validateAccessToken :: accessToken is expired and refreshed successfully`)
			return await this.validateAccessToken()
		}

		const data: { id: string } = await response.json()
		if (!data.id || data.id !== this.config.allowedUserId) {
			this.logger.info(`LinkedinClient.validateAccessToken :: accessToken does not belong to allowed user`)
			await this.clearTokens()
			throw new WrongTokenError()
		}
	}

	private async refreshAccessToken() {
		this.logger.debug(`LinkedinClient.refreshAccessToken :: refreshing token`)
		try {
			const refreshToken = await this.refreshToken()

			this.logger.debug(`LinkedinClient.refreshAccessToken :: refreshToken is present`)
			const URLQueryString = new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
			})
			const response = await fetch(`${this.oauthURL}/accessToken?${URLQueryString.toString()}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			})

			const data = accessTokenResponseSchema.parse(await response.json())
			this.logger.info(`LinkedinClient.refreshAccessToken :: refreshed token ${JSON.stringify(data, null, 2)}`)
			await this.saveAccessToken(data)

			return true
		} catch {
			return false
		}
	}

	async matchState(state: string) {
		const nonce = await this.db.get(this.kvKeyBuilder.nonces(state))
		return nonce.value && nonce.value === state
	}

	private async clearTokens() {
		this.logger.info(`LinkedinClient.clearTokens :: clearing tokens`)
		await this.db.delete(this.kvKeyBuilder.accessToken())
		await this.db.delete(this.kvKeyBuilder.refreshToken())
	}
	// #endregion

	// #region assets
	async initializeUpload(media: LinkedinMedia) {
		const accessToken = await this.accessToken()

		const response = await fetch(`${this.getAssetUrl(media.type)}?action=initializeUpload`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`,
				'LinkedIn-Version': this.apiVersion,
				'X-Restli-Protocol-Version': this.restliProtocolVersion,
			},
			body: JSON.stringify({
				initializeUploadRequest: {
					owner: this.authorizedUserURN,
				},
			}),
		})

		const data = (await response.json()) as { value: { uploadUrlExpiresAt: number; uploadUrl: string; image: string } }
		if (!response.ok) throw new FailedToShareError('Linkedin', data, 'Failed to initialize upload')

		await this.uploadAsset(data.value.uploadUrl, media.source)

		return {
			uploadUrl: data.value.uploadUrl,
			urn: data.value.image,
		}
	}

	async uploadAsset(uploadUrl: string, source: string) {
		this.logger.info(`LinkedinClient.uploadAsset :: uploading ${source} to ${uploadUrl}`)
		const downloadedMedia = await fetch(source)
		const blob = await downloadedMedia.blob()
		this.logger.info(`LinkedinClient.uploadAsset :: got blob from source ${blob.type} ${blob.size}`)

		const uploadResponse = await fetch(uploadUrl, {
			method: 'PUT',
			headers: {
				'Content-Type': blob.type,
				'Content-Length': blob.size.toString(),
				Authorization: `Bearer ${await this.accessToken()}`,
			},
			body: blob.stream(),
		})
		this.logger.info(`LinkedinClient.uploadAsset :: uploaded ${blob.size} bytes -> ${uploadResponse.status}`)

		if (!uploadResponse.ok) {
			const data = await uploadResponse.json()
			this.logger.error(
				`LinkedinClient.uploadAsset :: failed to upload asset ${uploadResponse.status} ${
					JSON.stringify(
						data,
						null,
						2,
					)
				})}`,
			)
			throw new FailedToShareError('Linkedin', data, 'Failed to upload asset')
		}
		return true
	}
	// #endregion

	// #region share
	async sharePost(input: LinkedinShareInput) {
		const accessToken = await this.accessToken()
		const post = new LinkedinPost(input.text, this.authorizedUserURN)

		// Check if the post has any media, such as a link or an image
		if (input.media) {
			if (input.media.type === LinkedinMediaTypes.ARTICLE) {
				// Articles (links) are shared with simple text
				post.addArticle(input.media)
			} else {
				// For all other media types, we need to upload the asset first
				const assetInformation = await this.initializeUpload(input.media)
				post.addMedia(input.media.type, input.media.title, assetInformation.urn)
			}
		}

		// Actually share the post here with the media uploads
		const response = await fetch(this.getAssetUrl('post'), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify(post.payload),
		})

		const data = await response.json()
		if (!response.ok) throw new FailedToShareError('Linkedin', data)

		const postUrn = response.headers.get('x-restli-id')

		// Sanity check, if the response is ok this will always be true
		if (!postUrn) {
			this.logger.error(`LinkedinClient.sharePost :: failed to get post id ${JSON.stringify(data, null, 2)}`)
			throw new FailedToShareError('Linkedin', data, 'Failed to get post id')
		}

		this.logger.info(`LinkedinClient.sharePost :: post ${postUrn} shared ${JSON.stringify(data, null, 2)}`)

		// Post comments
		if (input.comments) {
			this.logger.debug(`LinkedinClient.sharePost :: comments ${JSON.stringify(input.comments, null, 2)}`)
			for (const comment of input.comments) {
				this.postComment(postUrn, comment.text)
					.then((commentURN) => {
						this.logger.info(`LinkedinClient.sharePost :: comment posted on ${postUrn} => ${commentURN}`)
					})
					.catch((err) => {
						this.logger.warning(`LinkedinClient.sharePost :: failed to post comment on ${postUrn} => ${err}`)
					})
			}
		}
		return postUrn
	}

	async postComment(postUrn: string, comment: string) {
		this.logger.info(`LinkedinClient.postComment :: posting comment on ${postUrn}`)
		const accessToken = await this.accessToken()

		const response = await fetch(`${this.baseUrl}/socialActions/${postUrn}/comments`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({
				actor: this.authorizedUserURN,
				object: postUrn,
				message: {
					text: comment,
				},
			}),
		})
		const data: { commentUrn: string } = await response.json()

		this.logger.debug(`LinkedinClient.postComment :: response ${response.status} => ${JSON.stringify(data, null, 2)}`)
		if (response.ok) {
			return data.commentUrn
		}

		this.logger.warning(`LinkedinClient.postComment :: failed to post comment ${JSON.stringify(data, null, 2)}`)
		throw new FailedToShareError('Linkedin', data, 'Failed to post comment')
	}
	// #endregion
}
