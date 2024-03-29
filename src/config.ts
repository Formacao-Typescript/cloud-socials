import { dotenv, log, z } from './deps.ts'
await dotenv.load({ export: true })

log.setup({
	handlers: {
		console: new log.handlers.ConsoleHandler('DEBUG', {
			formatter: ({ datetime, levelName, loggerName, msg }) => {
				if (levelName === 'DEBUG' && (!Deno.env.get('DENO_ENV') || Deno.env.get('DENO_ENV') === 'production')) {
					return ''
				}
				return `${loggerName !== 'default' ? loggerName : ''}(${levelName})[${datetime.toISOString()}] ::\t${
					typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)
				}`
			},
		}),
	},
	loggers: {
		default: {
			level: 'DEBUG',
			handlers: ['console'],
		},
		error: {
			level: 'WARNING',
			handlers: ['console'],
		},
	},
})

const Config = z
	.object({
		PORT: z.coerce.number().default(3000),
		DENO_ENV: z.enum(['development', 'production', 'test']).optional().default('production'),
		SERVER_OAUTH_CALLBACK_BASEURL: Deno.env.get('DENO_ENV') === 'production' ? z.string() : z.string().optional(),
		TWITTER_OAUTH_CLIENT_ID: z.string(),
		TWITTER_OAUTH_CLIENT_SECRET: z.string(),
		TWITTER_ALLOWED_USER_ID: z.string().optional().default(''),
		TWITTER_APP_KEY: z.string(),
		TWITTER_APP_SECRET: z.string(),
		TWITTER_ACCESS_TOKEN: z.string().optional(),
		TWITTER_ACCESS_SECRET: z.string().optional(),
		LINKEDIN_CLIENT_ID: z.string(),
		LINKEDIN_CLIENT_SECRET: z.string(),
		LINKEDIN_ALLOWED_USER_ID: z.string().optional().default('fXAGSZErfj'),
	})
	.transform((envs) => ({
		isProduction: envs.DENO_ENV === 'production',
		server: {
			port: envs.PORT,
			oauthCallbackBaseUrl: envs.DENO_ENV === 'production'
				? envs.SERVER_OAUTH_CALLBACK_BASEURL
				: `http://localhost:${envs.PORT}`,
		},
		loggers: {
			default: log.getLogger(),
			error: log.getLogger('error'),
		},
		twitter: {
			allowedUserId: envs.TWITTER_ALLOWED_USER_ID,
			// Oauth 1.0a credentials
			appKey: envs.TWITTER_APP_KEY,
			appSecret: envs.TWITTER_APP_SECRET,
			accessToken: envs.TWITTER_ACCESS_TOKEN,
			accessSecret: envs.TWITTER_ACCESS_SECRET,
			// Oauth 2.0 credentials
			clientId: envs.TWITTER_OAUTH_CLIENT_ID,
			clientSecret: envs.TWITTER_OAUTH_CLIENT_SECRET,
		},
		linkedin: {
			clientId: envs.LINKEDIN_CLIENT_ID,
			clientSecret: envs.LINKEDIN_CLIENT_SECRET,
			allowedUserId: envs.LINKEDIN_ALLOWED_USER_ID,
		},
	}))

export type AppConfig = z.infer<typeof Config>
export const appConfig = Config.parse(Deno.env.toObject())
