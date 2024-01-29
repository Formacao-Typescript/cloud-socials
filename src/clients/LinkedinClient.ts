import { AppConfig } from '../config.ts'
import { crypto, delay, encodeBase64, z } from '../deps.ts'
import { FailedToShareError } from '../domain/errors/FailedToShareError.ts'
import { LinkedinPost } from '../domain/LinkedinPost.ts'
import { LinkedinMediaInput } from '../networks/linkedin.ts'

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
export type AccessTokenResponse = z.infer<typeof accessTokenResponseSchema>

export type InitializeUploadOptions<T extends LinkedinMediaTypes> = T extends
	| LinkedinMediaTypes.IMAGE
	| LinkedinMediaTypes.DOCUMENT ? {
		owner: string
	}
	: T extends LinkedinMediaTypes.VIDEO ? {
			owner: string
			fileSizeBytes: number
			uploadCaptions?: boolean
			uploadThumbnail?: boolean
		}
	: never

interface InitializedVideoUpload {
	urn: string
	uploadToken: string
	uploadUrl: { uploadUrl: string; lastByte: number; firstByte: number }[]
}

interface InitializedImageOrDocumentUpload {
	urn: string
	uploadUrl: string
}

interface UploadVideoOptions {
	videoBlob: Blob
	videoUrn: string
	urlArray: InitializedVideoUpload['uploadUrl']
	uploadToken: string
}

export class LinkedinClient {
	private readonly config: AppConfig['linkedin']
	private readonly logger: AppConfig['loggers']['default']
	private readonly oauthCallbackUrl: string
	private readonly baseUrl = 'https://api.linkedin.com/v2'
	private readonly oauthURL = 'https://www.linkedin.com/oauth/v2'
	private readonly apiVersion = '202311'
	private readonly restliProtocolVersion = '2.0.0'

	constructor(config: AppConfig) {
		this.config = config.linkedin
		this.logger = config.loggers.default
		this.oauthCallbackUrl = `${config.server.oauthCallbackBaseUrl}/linkedin/oauth/callback`
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

		return { url: url.toString().replaceAll('+', '%20'), nonce }
	}

	private getAssetUrl(type: Omit<LinkedinMediaInput['type'], 'article'>) {
		return `https://api.linkedin.com/rest/${type}s`
	}

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

	async getTokenUserProfile(accessToken: string) {
		const response = await fetch(`${this.baseUrl}/me`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		})
		this.logger.debug(`LinkedinClient.getTokenUserProfile :: response ${response.status}`)

		if (!response.ok) {
			const data = await response.text()
			this.logger.error(`LinkedinClient.getTokenUserProfile :: failed to get user profile ${response.status} - ${data}`)
			return null
		}

		return response.json() as Promise<{ id: string }>
	}

	async refreshAccessToken(refreshToken: string) {
		this.logger.debug(`LinkedinClient.refreshAccessToken :: refreshing token`)
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

		if (!response.ok) {
			const data = await response.text()
			this.logger.error(`LinkedinClient.refreshAccessToken :: failed to refresh token ${data}`)
			return null
		}

		const data = accessTokenResponseSchema.parse(await response.json())
		this.logger.info(`LinkedinClient.refreshAccessToken :: refreshed token ${JSON.stringify(data, null, 2)}`)

		return accessTokenResponseSchema.parse(data)
	}

	// Base function with shared logic
	private async baseInitializeUpload(
		accessToken: string,
		mediaType: LinkedinMediaTypes,
		payload: Omit<InitializeUploadOptions<typeof mediaType>, 'source'>,
	) {
		this.logger.info(
			`LinkedinClient.baseInitializeUpload :: initializing upload for ${mediaType}, payload ${
				JSON.stringify(
					payload,
					null,
					2,
				)
			}`,
		)
		const response = await fetch(`${this.getAssetUrl(mediaType)}?action=initializeUpload`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`,
				'LinkedIn-Version': this.apiVersion,
				'X-Restli-Protocol-Version': this.restliProtocolVersion,
			},
			body: JSON.stringify({ initializeUploadRequest: payload }),
		})

		const data = await response.json()
		this.logger.debug(`LinkedinClient.baseInitializeUpload :: response ${JSON.stringify(data, null, 2)}`)
		if (!response.ok || !data.value) {
			throw new FailedToShareError('Linkedin', data, 'Failed to initialize upload')
		}

		return data
	}

	// Specific function for video uploads
	async initializeVideoUpload(
		accessToken: string,
		options: InitializeUploadOptions<LinkedinMediaTypes.VIDEO>,
	): Promise<InitializedVideoUpload> {
		const payload = {
			...options,
			uploadCaptions: options.uploadCaptions ?? false,
			uploadThumbnail: options.uploadThumbnail ?? false,
		}

		const data = await this.baseInitializeUpload(accessToken, LinkedinMediaTypes.VIDEO, payload)
		return {
			urn: data.value.video,
			uploadUrl: data.value.uploadInstructions,
			uploadToken: data.value.uploadToken,
		}
	}

	// Specific function for image/document uploads
	async initializeImageOrDocumentUpload(
		accessToken: string,
		mediaType: LinkedinMediaTypes.IMAGE | LinkedinMediaTypes.DOCUMENT,
		options: InitializeUploadOptions<LinkedinMediaTypes.IMAGE | LinkedinMediaTypes.DOCUMENT>,
	): Promise<InitializedImageOrDocumentUpload> {
		const payload = {
			owner: options.owner,
		}

		const data = await this.baseInitializeUpload(accessToken, mediaType, payload)
		return {
			uploadUrl: data.value.uploadUrl,
			urn: data.value.image ?? data.value.document,
		}
	}

	async uploadImageOrDocument(uploadUrl: string, source: string, accessToken: string) {
		this.logger.info(`LinkedinClient.uploadAsset :: uploading ${source} to ${uploadUrl}`)
		const downloadedMedia = await fetch(source)
		const blob = await downloadedMedia.blob()
		this.logger.info(`LinkedinClient.uploadAsset :: got blob from source ${blob.type} ${blob.size}`)

		const uploadOptions = {
			method: 'PUT',
			headers: {
				'Content-type': 'application/octet-stream',
				'Content-Length': blob.size.toString(),
				Authorization: `Bearer ${accessToken}`,
				'LinkedIn-Version': this.apiVersion,
				'X-Restli-Protocol-Version': this.restliProtocolVersion,
			},
			body: new Uint8Array(await blob.arrayBuffer()),
		}
		const uploadResponse = await fetch(uploadUrl, uploadOptions)

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

	async uploadVideo(accessToken: string, { videoBlob, videoUrn, urlArray, uploadToken }: UploadVideoOptions) {
		/**
		 * Split the video into 4MB chunks and upload them in parallel (split -b 4194303)
		 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2023-11&tabs=http#upload-the-video
		 * Save ETags
		 * Finalize the upload
		 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2023-11&tabs=http#finalize-video-upload
		 */
		// split the video into 4MB chunks and upload them in parallel (split -b 4194303)
		const promises = []
		this.logger.info(`LinkedinClient.uploadVideo :: uploading ${videoBlob.size} bytes in ${urlArray.length} chunks`)
		for (const { uploadUrl, firstByte, lastByte } of urlArray) {
			const chunk = urlArray.length > 1 ? videoBlob.slice(firstByte, lastByte + 1) : videoBlob
			const headers = {
				'Content-type': 'application/octet-stream',
				'Content-Length': chunk.size.toString(),
				Authorization: `Bearer ${accessToken}`,
				'LinkedIn-Version': this.apiVersion,
				'X-Restli-Protocol-Version': this.restliProtocolVersion,
			}
			const options = {
				method: 'PUT',
				headers,
				body: new Uint8Array(await chunk.arrayBuffer()),
			}
			this.logger.debug(`LinkedinClient.uploadVideo :: uploading ${chunk.size} bytes to ${uploadUrl}`)
			promises.push(fetch(uploadUrl, options))
		}

		const responses = await Promise.all(promises)
		this.logger.debug(`LinkedinClient.uploadVideo :: responses ${JSON.stringify(responses, null, 2)}`)

		// Save ETags
		const ETags = responses.map((res) => res.headers.get('etag')) as string[]
		this.logger.debug(`LinkedinClient.uploadVideo :: ETags ${JSON.stringify(ETags, null, 2)}`)
		await delay(500) // Linkedin needs a bit of time to process the chunks
		return this.finalizeVideoUpload(accessToken, { videoUrn, uploadToken, ETags })
	}

	private async finalizeVideoUpload(
		accessToken: string,
		{ videoUrn, uploadToken, ETags }: Omit<UploadVideoOptions, 'videoBlob' | 'urlArray'> & { ETags: string[] },
		retries = 3,
	): Promise<boolean> {
		const body = JSON.stringify({
			finalizeUploadRequest: {
				uploadToken,
				video: videoUrn,
				uploadedPartIds: ETags,
			},
		})
		const options = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`,
				'LinkedIn-Version': this.apiVersion,
				'X-Restli-Protocol-Version': this.restliProtocolVersion,
			},
			body,
		}

		this.logger.debug(`LinkedinClient.finalizeVideoUpload :: options ${JSON.stringify(options, null, 2)}`)
		const response = await fetch(`${this.getAssetUrl('video')}?action=finalizeUpload`, options)

		const data = await response.text()
		this.logger.debug(`LinkedinClient.finalizeVideoUpload :: response ${JSON.stringify(data, null, 2)}`)
		if (!response.ok) {
			if (retries === 0) {
				throw new FailedToShareError('Linkedin', { data }, 'Failed to finalize video upload')
			}
			this.logger.warning(
				`LinkedinClient.finalizeVideoUpload :: failed to finalize video upload, trying again (${retries}/3)`,
			)
			await delay(500 * retries + 1)
			return this.finalizeVideoUpload(accessToken, { videoUrn, uploadToken, ETags }, retries - 1)
		}

		return true
	}

	async sharePost(post: LinkedinPost, accessToken: string) {
		// Actually share the post here with the media uploads
		const response = await fetch(this.getAssetUrl('post'), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`,
				'LinkedIn-Version': this.apiVersion,
				'X-Restli-Protocol-Version': this.restliProtocolVersion,
			},
			body: JSON.stringify(post.payload),
		})

		this.logger.debug(`LinkedinClient.sharePost :: response ${response.status}`)
		if (!response.ok) {
			const data = await response.json()
			throw new FailedToShareError('Linkedin', data)
		}

		const postUrn = response.headers.get('x-restli-id')
		// Sanity check, if the response is ok this will always be true
		if (!postUrn) {
			this.logger.error(`LinkedinClient.sharePost :: failed to get post id`)
			throw new FailedToShareError('Linkedin', { code: response.status }, 'Failed to get post id')
		}

		this.logger.info(`LinkedinClient.sharePost :: post ${postUrn} shared`)

		return { postUrn, postUrl: `https://www.linkedin.com/feed/update/${postUrn}`, payload: post.payload }
	}

	async postComment(
		postUrn: string,
		comment: string,
		accessToken: string,
		authorUrn: string,
		retries = 10,
	): Promise<string> {
		this.logger.info(`LinkedinClient.postComment :: posting comment on ${postUrn}`)

		const response = await fetch(`${this.baseUrl}/socialActions/${postUrn}/comments`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`,
				'LinkedIn-Version': this.apiVersion,
			},
			body: JSON.stringify({
				actor: authorUrn,
				object: postUrn,
				message: {
					text: comment,
				},
			}),
		})

		if (response.status === 404 && retries > 0) {
			this.logger.warning(`LinkedinClient.postComment :: post ${postUrn} not found, trying again`)
			await delay(500 * retries + 1)
			return this.postComment(postUrn, comment, accessToken, authorUrn, retries - 1)
		}
		const data: { commentUrn: string } = await response.json()

		this.logger.debug(`LinkedinClient.postComment :: response ${response.status} => ${JSON.stringify(data, null, 2)}`)
		if (response.ok) {
			return data.commentUrn
		}

		this.logger.warning(`LinkedinClient.postComment :: failed to post comment ${JSON.stringify(data, null, 2)}`)
		throw new FailedToShareError('Linkedin', data, 'Failed to post comment')
	}
}
