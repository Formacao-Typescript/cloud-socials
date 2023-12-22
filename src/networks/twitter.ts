import { TwitterClient } from '../clients/Twitter.ts';
import { appConfig } from '../config.ts';
import { openKv } from '../data/db.ts';
import { oak } from '../deps.ts';

const twitter = new oak.Router().prefix('/twitter');

const db = await openKv();
const client = new TwitterClient(appConfig, db);

twitter.get('/oauth/login', async (ctx) => {
	const loginUrl = await client.getAuthorizeUrl();
	ctx.response.body = loginUrl;

	if (!ctx.request.url.searchParams.has('urlOnly')) {
		ctx.response.headers.set('Location', loginUrl);
		ctx.response.status = 302;
	}
	return;
});

twitter.get('/oauth/callback', async (ctx) => {
	const params = ctx.request.url.searchParams;

	if (params.has('error')) {
		throw oak.createHttpError(400, 'Error from Twitter', {
			cause: {
				error: params.get('error'),
				error_description: decodeURIComponent(params.get('error_description')!),
			},
		});
	}

	const code = params.get('code');
	const state = params.get('state');

	if (!code || !state) {
		throw oak.createHttpError(422, 'Missing code or state');
	}

	const csrfMatch = await client.matchState(state);
	if (!csrfMatch) {
		throw oak.createHttpError(401, 'Invalid state');
	}

	const data = await client.exchangeAccessToken(code, state);
	if (data) {
		await client.saveAccessToken(data);
		await client.validateAccessToken();
	}

	ctx.response.status = 200;
	ctx.response.body = {
		status: 'ok',
		message: 'Logged in successfully',
	};
});

twitter.get('/oauth/tokens', async (ctx) => {
	await client.validateAccessToken();
	ctx.response.status = 200;
	ctx.response.body = {
		status: 'ok',
		message: 'Token is valid',
	};
});

export default twitter;
