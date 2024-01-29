import { AppConfig } from '../config.ts'
import {
	AccessToken,
	AccessTokenResponse,
	AuthenticatedLinkedinClient,
	LinkedinClient,
	LinkedinClientOptions,
	LinkedinMediaTypes,
} from '../deps.ts'
import { LinkedinPost } from '../domain/LinkedinPost.ts'
import { ExpiredTokenError } from '../domain/errors/ExpiredTokenError.ts'
import { WrongTokenError } from '../domain/errors/WrongTokenError.ts'
import { fetchDOMFromURL } from '../domain/util/DOMParser.ts'
import { SOCIAL_CARD_META_TAGS } from '../domain/util/constants.ts'
import { LinkedinMediaArticleInput, LinkedinShareInput } from '../networks/linkedin.ts'

export class LinkedInController {
	private readonly config: AppConfig['linkedin']
	private readonly logger: AppConfig['loggers']['default']
	#client: AuthenticatedLinkedinClient | null = null

	constructor(config: AppConfig, private readonly db: Deno.Kv, private readonly authClient: LinkedinClient) {
		this.config = config.linkedin
		this.logger = config.loggers.default
	}

	async initialize(clientOptions: LinkedinClientOptions) {
		try {
			const { value: accessToken } = await this.db.get<string>(this.kvKeyBuilder.accessToken())
			if (!accessToken) return

			this.#client = new AuthenticatedLinkedinClient(
				clientOptions,
				{
					access_token: accessToken,
					expires_in: Date.now() + 1000 * 60 * 60 * 24 * 365,
					refresh_token: (await this.db.get<string>(this.kvKeyBuilder.refreshToken())).value ?? undefined,
					refresh_token_expires_in: Date.now() + 1000 * 60 * 60 * 24 * 365,
				},
				this.authClient,
			)
		} catch (error) {
			this.logger.error(`LinkedinController.initialize :: ${error}`)
			return
		}
	}

	private get kvKeyBuilder() {
		const prefix = 'linkedin'
		return {
			nonces: (nonce: string) => [prefix, 'nonces', nonce],
			accessToken: () => [prefix, 'accessToken'],
			refreshToken: () => [prefix, 'refreshToken'],
		}
	}

	get client() {
		if (!this.#client) {
			throw new Error('LinkedinController.client :: client is not initialized yet, please log in first')
		}
		return this.#client
	}

	set client(client: AuthenticatedLinkedinClient) {
		this.#client = client
	}

	private get authorizedUserURN() {
		return `urn:li:person:${this.config.allowedUserId}`
	}

	private async setTokens(data: AccessTokenResponse) {
		await this.db.set(this.kvKeyBuilder.accessToken(), data.access_token, { expireIn: data.expires_in })

		if (data.refresh_token) {
			await this.db.set(this.kvKeyBuilder.refreshToken(), data.refresh_token, {
				expireIn: data.refresh_token_expires_in,
			})
		}
	}

	async exchangeAccessToken(code: string, nonce: string) {
		try {
			this.logger.debug(`LinkedinController.exchangeAccessToken :: nonce ${nonce}`)

			this.client = await this.authClient.exchangeLoginToken(code, nonce)
			await this.validateAccessToken()
			await this.setTokens({
				access_token: this.client.accessToken,
				expires_in: this.client.accessTokenExpiresIn ?? 0,
				refresh_token: this.client.refreshToken,
				refresh_token_expires_in: this.client.refreshTokenExpiresIn,
			})
		} catch (err) {
			throw new WrongTokenError(err.message)
		}
	}

	private async getAccessToken(): Promise<AccessToken> {
		const [{ value: accessToken }, refreshToken] = await Promise.all([
			this.db.get<string>(this.kvKeyBuilder.accessToken()),
			this.getRefreshToken(),
		])

		if (accessToken) {
			this.client.accessToken = accessToken
			return this.client.accessToken
		}
		if (!refreshToken) throw new ExpiredTokenError('Access token is expired and no refresh token was found')

		if (refreshToken) {
			const refreshResult = await this.client.refreshAccessToken()
			if (!refreshResult) {
				await this.clearTokens()
				this.client.clearTokens()
				throw new ExpiredTokenError('Refresh token is expired')
			}

			await this.setTokens(refreshResult)
			this.client.setTokens(refreshResult)
		}

		return await this.getAccessToken()
	}

	private async getRefreshToken() {
		const { value } = await this.db.get<string>(this.kvKeyBuilder.refreshToken())
		if (!value) return ''
		this.client.refreshToken = value
		return this.client.refreshToken
	}

	async validateAccessToken() {
		const accessToken = await this.getAccessToken()
		this.logger.debug(`LinkedinController.validateAccessToken :: accessToken is present`)

		const data = await this.client.getSelfProfile(accessToken)
		if (!data) throw new WrongTokenError('Could not get user profile from Linkedin')

		if (!data.id || data.id !== this.config.allowedUserId) {
			this.logger.info(`LinkedinController.validateAccessToken :: accessToken does not belong to allowed user`)
			await this.clearTokens()
			throw new WrongTokenError()
		}

		return true
	}

	private async clearTokens() {
		this.logger.info(`LinkedinController.clearTokens :: clearing tokens`)
		await this.db.delete(this.kvKeyBuilder.accessToken())
		await this.db.delete(this.kvKeyBuilder.refreshToken())
		this.client.clearTokens()
	}

	async sharePost({ text, media, comments }: LinkedinShareInput) {
		const accessToken = await this.getAccessToken()
		const post = new LinkedinPost(text, this.authorizedUserURN)
		this.logger.debug(`LinkedinClient.sharePost :: post ${JSON.stringify(post.payload, null, 2)}`)

		// Check if the post has any media, such as a link or an image
		if (media) {
			this.logger.info(`LinkedinClient.sharePost :: post has media ${JSON.stringify(media, null, 2)}`)
			switch (media.type) {
				case LinkedinMediaTypes.ARTICLE:
					// Articles (links) are shared with simple text
					post.addArticle(await this.enrichArticle(media))
					break
				case LinkedinMediaTypes.VIDEO: {
					const video: Blob = await fetch(media.source).then((res) => res.blob())
					console.log(Deno.inspect(video))
					// Videos are handled differently
					const {
						uploadUrl: urlArray,
						urn: videoUrn,
						uploadToken,
					} = await this.client.initializeUpload(LinkedinMediaTypes.VIDEO, {
						owner: this.authorizedUserURN,
						fileSizeBytes: video.size,
					})
					post.addMedia(media.type, media.title, videoUrn)
					this.logger.info(`LinkedinClient.sharePost :: videoUrn received ${videoUrn}`)

					await this.client.uploadVideo({ uploadToken, urlArray, videoBlob: video, videoUrn }, accessToken)
					break
				}
				case LinkedinMediaTypes.IMAGE:
				case LinkedinMediaTypes.DOCUMENT: {
					// For all other media types, we need to upload the asset first
					const { uploadUrl, urn: assetUrn } = await this.client.initializeUpload(
						media.type as LinkedinMediaTypes.IMAGE | LinkedinMediaTypes.DOCUMENT,
						{
							owner: this.authorizedUserURN,
						},
						accessToken,
					)
					await this.client.uploadImageOrDocument({ source: media.source, uploadUrl }, accessToken)
					post.addMedia(media.type, media.title, assetUrn)
					break
				}
				default:
					throw new Error(`LinkedinClient.sharePost :: unknown media type ${(media as { type: string }).type}`)
			}
		}

		const { postUrl, postUrn } = await this.client.sharePost(post.payload, accessToken)

		// Post comments
		if (comments) {
			this.logger.debug(`LinkedinClient.sharePost :: comments ${JSON.stringify(comments, null, 2)}`)
			for (const comment of comments) {
				this.client
					.postComment({ authorUrn: this.authorizedUserURN, comment: comment.text, postUrn }, accessToken)
					.then(({ commentUrn }) => {
						this.logger.info(`LinkedinClient.sharePost :: comment posted on ${postUrn} => ${commentUrn}`)
					})
					.catch((err) => {
						this.logger.warn(`LinkedinClient.sharePost :: failed to post comment on ${postUrn} => ${err}`)
					})
			}
		}

		return { postUrl, postUrn, mediaUrn: post.getMediaURN() }
	}

	/**
	 * Adds social card information from opengraph in case there is none
	 */
	private async enrichArticle(media: LinkedinMediaArticleInput) {
		if (media.thumbnail && media.title) return media

		this.logger.info(`LinkedinController.enrichArticle :: enriching ${JSON.stringify(media, null, 2)}`)
		const article: typeof media = structuredClone(media)

		const doc = await fetchDOMFromURL(media.source)
		if (!doc) return media

		for (const property of ['title', 'thumbnail', 'description'] as const) {
			if (!article[property]) {
				this.logger.info(`LinkedinController.enrichArticle :: enriching missing ${property}`)
				const metatags = SOCIAL_CARD_META_TAGS.filter(({ name }) => name === property)
				for (const { selector, value } of metatags) {
					const element = doc.querySelector(selector)
					if (element) {
						this.logger.info(`LinkedinController.enrichArticle :: found ${property} with ${value(element)}`)

						// Here, article[property] will be false due to check in 191
						const validatedProperty = value(element) ?? article[property]

						if (property === 'thumbnail' && validatedProperty) {
							const accessToken = await this.getAccessToken()

							// Linkedin only accepts URNs as images for articles
							// So we need to upload the image first
							const { urn, uploadUrl } = await this.client.initializeUpload(
								LinkedinMediaTypes.IMAGE,
								{
									owner: this.authorizedUserURN,
								},
								accessToken,
							)
							await this.client.uploadImageOrDocument(
								{
									source: validatedProperty,
									uploadUrl,
								},
								accessToken,
							)

							article[property] = urn
						}
						break
					}
				}
			}
			this.logger.debug(`LinkedinController.enrichArticle :: enriched ${property} with ${article[property]}`)
		}

		return article
	}
}
