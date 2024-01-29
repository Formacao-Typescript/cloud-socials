import { TwitterClient, TwitterPostObject, TwitterThreadObject } from '../clients/Twitter.ts';
import { appConfig } from '../config.ts';
import { oak } from '../deps.ts';

import { openKv } from '../data/db.ts';

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
	await client.saveAccessToken(data);
	await client.validateAccessToken();

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

twitter.post('/tweet', async (ctx) => {
	const body = TwitterPostObject.parse(await ctx.request.body({ type: 'json' }).value);

	const tweet = await client.createTweet(body);

	ctx.response.status = 200;
	ctx.response.body = {
		status: 'ok',
		message: 'Tweet created',
		tweet,
	};
});

twitter.post('/thread', async (ctx) => {
	const body = TwitterThreadObject.parse(await ctx.request.body({ type: 'json' }).value);

	const threadId = await client.createThread(body);

	ctx.response.status = 200;
	ctx.response.body = {
		status: 'ok',
		message: 'Thread created',
		threadId,
	};
});

export default twitter;
