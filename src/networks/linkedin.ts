// import { LinkedinClient, LinkedinMediaTypes } from '../clients/LinkedinClient.ts'
import { appConfig } from '../config.ts'
import { LinkedInController } from '../controllers/LinkedInController.ts'
import { openKv } from '../data/db.ts'
import { LinkedinClient, LinkedinClientOptions, LinkedinMediaTypes, oak, z } from '../deps.ts'
import validateBody from '../middlewares/zodValidationMiddleware.ts'

const LinkedinMediaAssetInputSchema = z.object({
	type: z.enum([LinkedinMediaTypes.IMAGE, LinkedinMediaTypes.DOCUMENT, LinkedinMediaTypes.VIDEO]),
	source: z.string().url(),
	title: z.string().max(100),
})
export type LinkedinMediaAssetInput = z.infer<typeof LinkedinMediaAssetInputSchema>

const LinkedinMediaArticleInputSchema = z.object({
	type: z.literal(LinkedinMediaTypes.ARTICLE),
	source: z.string().url(),
	thumbnail: z.string().url().optional(),
	title: z.string().max(100).optional(),
	description: z.string().max(300).optional(),
})
export type LinkedinMediaArticleInput = z.infer<typeof LinkedinMediaArticleInputSchema>

const LinkedinMediaSchema = z.discriminatedUnion('type', [
	LinkedinMediaArticleInputSchema,
	LinkedinMediaAssetInputSchema,
])
export type LinkedinMediaInput = z.infer<typeof LinkedinMediaSchema>

const LinkedinShareInputSchema = z.object({
	text: z.string().max(3000),
	media: LinkedinMediaSchema.optional(),
	comments: z
		.array(
			z.object({
				text: z.string().max(3000),
			}),
		)
		.optional(),
})
export type LinkedinShareInput = z.infer<typeof LinkedinShareInputSchema>

const linkedin = new oak.Router().prefix('/linkedin')
const db = await openKv()
const linkedinOptions: LinkedinClientOptions = {
	clientId: appConfig.linkedin.clientId,
	clientSecret: appConfig.linkedin.clientSecret,
	oauthScopes: [
		'r_emailaddress',
		'w_member_social',
		'r_basicprofile',
		'w_organization_social',
		'rw_ads',
		'r_organization_social',
	],
	oauthCallbackUrl: `${appConfig.server.oauthCallbackBaseUrl}/linkedin/oauth/callback`,
	customLogger: appConfig.loggers.default,
	defaultDelayBetweenRequestsMs: 2000,
	retryAttempts: 30,
}
const nonAuthClient = new LinkedinClient(linkedinOptions)
const controller = new LinkedInController(appConfig, db, nonAuthClient)
await controller.initialize(linkedinOptions)

linkedin.get('/oauth/login', (ctx) => {
	const loginUrl = nonAuthClient.loginUrl
	ctx.response.body = loginUrl

	if (!ctx.request.url.searchParams.has('urlOnly')) {
		ctx.response.headers.set('Location', loginUrl.url)
		ctx.response.status = 302
	}
	return
})

linkedin.get('/oauth/callback', async (ctx) => {
	const params = ctx.request.url.searchParams

	if (params.has('error')) {
		throw oak.createHttpError(400, 'Error from Linkedin', {
			cause: {
				error: params.get('error'),
				error_description: decodeURIComponent(params.get('error_description')!),
			},
		})
	}

	const code = params.get('code')
	const state = params.get('state')

	if (!code || !state) {
		throw oak.createHttpError(422, 'Missing code or state')
	}

	await controller.exchangeAccessToken(code, state)

	ctx.response.status = 200
	ctx.response.body = {
		status: 'ok',
		message: 'Logged in successfully',
	}
})

linkedin.get('/oauth/tokens', async (ctx) => {
	await controller.validateAccessToken()
	ctx.response.status = 200
	ctx.response.body = {
		status: 'ok',
		message: 'Token is valid',
	}
})

linkedin.post(
	'/',
	validateBody(LinkedinShareInputSchema),
	async (ctx: oak.Context<{ validatedBody: LinkedinShareInput }>) => {
		await controller.validateAccessToken()

		const response = await controller.sharePost(ctx.state.validatedBody)

		ctx.response.status = 201
		ctx.response.body = response
		ctx.response.headers.set('Location', response.postUrl)
		ctx.response.headers.set('X-LinkedIn-Post-URN', response.postUrn)
	},
)

export default linkedin
