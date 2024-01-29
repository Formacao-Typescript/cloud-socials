import { AccessTokenResponse, LinkedinClient, LinkedinMediaTypes } from '../clients/LinkedinClient.ts'
import { AppConfig } from '../config.ts'
import { LinkedinPost } from '../domain/LinkedinPost.ts'
import { ExpiredTokenError } from '../domain/errors/ExpiredTokenError.ts'
import { WrongTokenError } from '../domain/errors/WrongTokenError.ts'
import { fetchDOMFromURL } from '../domain/util/DOMParser.ts'
import { SOCIAL_CARD_META_TAGS } from '../domain/util/constants.ts'
import { LinkedinMediaArticleInput, LinkedinShareInput } from '../networks/linkedin.ts'

export class LinkedInController {
	private readonly config: AppConfig['linkedin']
	private readonly logger: AppConfig['loggers']['default']

	constructor(config: AppConfig, private readonly db: Deno.Kv, private readonly client: LinkedinClient) {
		this.config = config.linkedin
		this.logger = config.loggers.default
	}

	private get kvKeyBuilder() {
		const prefix = 'linkedin'
		return {
			nonces: (nonce: string) => [prefix, 'nonces', nonce],
			accessToken: () => [prefix, 'accessToken'],
			refreshToken: () => [prefix, 'refreshToken'],
		}
	}

	private get authorizedUserURN() {
		return `urn:li:person:${this.config.allowedUserId}`
	}

	get loginUrl() {
		const { url, nonce } = this.client.loginUrl
		this.db.set(this.kvKeyBuilder.nonces(nonce), nonce, { expireIn: 60000 })
		return url
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
		this.logger.debug(`LinkedinController.exchangeAccessToken :: nonce ${nonce}`)

		const data = await this.client.exchangeAccessToken(code, nonce)
		if (data) {
			await this.setTokens(data)
			await this.validateAccessToken()
			return data
		}

		throw new WrongTokenError('Could not exchange access token')
	}

	private async getAccessToken(): Promise<string> {
		const [{ value: accessToken }, { value: refreshToken }] = await Promise.all([
			this.db.get<string>(this.kvKeyBuilder.accessToken()),
			this.getRefreshToken(),
		])

		if (accessToken) return accessToken
		if (!refreshToken) throw new ExpiredTokenError('Access token is expired and no refresh token was found')

		if (refreshToken) {
			const refreshResult = await this.client.refreshAccessToken(refreshToken)
			if (!refreshResult) {
				await this.clearTokens()
				throw new ExpiredTokenError('Refresh token is expired')
			}

			await this.setTokens(refreshResult)
		}

		return await this.getAccessToken()
	}

	private async getRefreshToken() {
		const refreshToken = await this.db.get<string>(this.kvKeyBuilder.refreshToken())
		return refreshToken
	}

	async validateAccessToken() {
		const accessToken = await this.getAccessToken()
		this.logger.debug(`LinkedinController.validateAccessToken :: accessToken is present`)

		const data = await this.client.getTokenUserProfile(accessToken)
		if (!data) throw new WrongTokenError('Could not get user profile from Linkedin')

		if (!data.id || data.id !== this.config.allowedUserId) {
			this.logger.info(`LinkedinController.validateAccessToken :: accessToken does not belong to allowed user`)
			await this.clearTokens()
			throw new WrongTokenError()
		}

		return true
	}

	async validateNonce(state: string) {
		const nonce = await this.db.get(this.kvKeyBuilder.nonces(state))
		return nonce.value && nonce.value === state
	}

	private async clearTokens() {
		this.logger.info(`LinkedinController.clearTokens :: clearing tokens`)
		await this.db.delete(this.kvKeyBuilder.accessToken())
		await this.db.delete(this.kvKeyBuilder.refreshToken())
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
					// Videos are handled differently
					const {
						uploadUrl: urlArray,
						urn: videoUrn,
						uploadToken,
					} = await this.client.initializeVideoUpload(accessToken, {
						owner: this.authorizedUserURN,
						fileSizeBytes: video.size,
					})
					post.addMedia(media.type, media.title, videoUrn)
					this.logger.info(`LinkedinClient.sharePost :: videoUrn received ${videoUrn}`)

					// NOTE: This can probably be done in parallel since we will have to split it into 4MB chunks anyway
					await this.client.uploadVideo(accessToken, { urlArray, videoBlob: video, videoUrn, uploadToken })
					break
				}
				case LinkedinMediaTypes.IMAGE:
				case LinkedinMediaTypes.DOCUMENT: {
					// For all other media types, we need to upload the asset first
					const { uploadUrl, urn: assetUrn } = await this.client.initializeImageOrDocumentUpload(
						accessToken,
						media.type as LinkedinMediaTypes.IMAGE | LinkedinMediaTypes.DOCUMENT,
						{
							owner: this.authorizedUserURN,
						},
					)
					await this.client.uploadImageOrDocument(uploadUrl, media.source, accessToken)
					post.addMedia(media.type, media.title, assetUrn)
					break
				}
				default:
					throw new Error(`LinkedinClient.sharePost :: unknown media type ${(media as { type: string }).type}`)
			}
		}

		const { postUrl, postUrn } = await this.client.sharePost(post, accessToken)

		// Post comments
		if (comments) {
			this.logger.debug(`LinkedinClient.sharePost :: comments ${JSON.stringify(comments, null, 2)}`)
			for (const comment of comments) {
				this.client
					.postComment(postUrn, comment.text, accessToken, this.authorizedUserURN)
					.then((commentURN) => {
						this.logger.info(`LinkedinClient.sharePost :: comment posted on ${postUrn} => ${commentURN}`)
					})
					.catch((err) => {
						this.logger.warning(`LinkedinClient.sharePost :: failed to post comment on ${postUrn} => ${err}`)
					})
			}
		}

		return { postUrl, postUrn }
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
							const { urn } = await this.client.initializeImageOrDocumentUpload(accessToken, LinkedinMediaTypes.IMAGE, {
								owner: this.authorizedUserURN,
							})
							await this.client.uploadImageOrDocument(urn, validatedProperty, accessToken)

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
