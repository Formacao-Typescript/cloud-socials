import { TwitterClient } from '../../src/clients/Twitter.ts';
import { appConfig } from '../../src/config.ts';
import { assertion, log } from '../../src/deps.ts';
import { instanceDouble, instanceDummy } from '../__utils__/instance_double.ts';

Deno.test('Twitter Client', async (t) => {
	await t.step('getAuthorizeUrl', async () => {
		const kv = instanceDouble(Deno.Kv);
		const dummyLogger = instanceDummy(log.Logger);
		kv.allow('set', Promise.resolve(), 2);

		const client = new TwitterClient(
			{ ...appConfig, loggers: { default: dummyLogger, error: dummyLogger } },
			kv,
		);

		const url = new URL(await client.getAuthorizeUrl());

		console.log(url.toString());

		assertion.assertEquals(url.searchParams.get('response_type'), 'code');
		assertion.assertEquals(url.searchParams.get('response_type'), 'code');
		assertion.assertEquals(url.searchParams.get('client_id'), appConfig.twitter.clientId);
		assertion.assertEquals(
			url.searchParams.get('redirect_uri'),
			`${appConfig.server.oauthCallbackBaseUrl}/twitter/oauth/callback`,
		);
		assertion.assertEquals(url.searchParams.get('scope'), 'tweet.read tweet.write users.read offline.access');
		assertion.assertExists(url.searchParams.get('state'));
		assertion.assertNotEquals(url.searchParams.get('state'), '');
		assertion.assertExists(url.searchParams.get('code_challenge'));
		assertion.assertNotEquals(url.searchParams.get('code_challenge'), '');
		assertion.assertExists(url.searchParams.get('code_challenge_method'));
		assertion.assertNotEquals(url.searchParams.get('code_challenge_method'), '');
	});
});
