import { LinkedinClient, LinkedinShareInputSchema } from '../clients/Linkedin.ts'
import { appConfig } from '../config.ts'
import { openKv } from '../data/db.ts'
import { oak, z } from '../deps.ts'
import validateBody from '../middlewares/zodValidationMiddleware.ts'

const linkedin = new oak.Router().prefix('/linkedin')

const db = await openKv()
const client = new LinkedinClient(appConfig, db)

linkedin.get('/oauth/login', (ctx) => {
	const loginUrl = client.loginUrl
	ctx.response.body = loginUrl

	if (!ctx.request.url.searchParams.has('urlOnly')) {
		ctx.response.headers.set('Location', loginUrl)
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

	const csrfMatch = await client.matchState(state)
	if (!csrfMatch) {
		throw oak.createHttpError(401, 'Invalid state')
	}

	const data = await client.exchangeAccessToken(code, state)
	if (data) {
		await client.saveAccessToken(data)
		await client.validateAccessToken()
	}

	ctx.response.status = 200
	ctx.response.body = {
		status: 'ok',
		message: 'Logged in successfully',
	}
})

linkedin.get('/oauth/tokens', async (ctx) => {
	await client.validateAccessToken()
	ctx.response.status = 200
	ctx.response.body = {
		status: 'ok',
		message: 'Token is valid',
	}
})

linkedin.post(
	'/',
	validateBody(LinkedinShareInputSchema),
	async (ctx: oak.Context<{ validatedBody: z.infer<typeof LinkedinShareInputSchema> }>) => {
		await client.validateAccessToken()

		const response = await client.sharePost(ctx.state.validatedBody)

		ctx.response.status = 201
		ctx.response.body = response
		ctx.response.headers.set('Location', `https://www.linkedin.com/feed/update/${response.postUrn}`)
		ctx.response.headers.set('X-LinkedIn-Post-URN', response.postUrn)
	},
)

export default linkedin
