import { log, z, dotenv } from './deps.ts'
await dotenv.load({ export: true })

log.setup({
  handlers: {
    console: new log.handlers.ConsoleHandler('DEBUG', {
      formatter: ({ datetime, levelName, loggerName, msg }) => {
        if (levelName === 'DEBUG' && (!Deno.env.get('DENO_ENV') || Deno.env.get('DENO_ENV') === 'production')) return ''
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
    TWITTER_OAUTH_CONSUMER_KEY: z.string(),
    TWITTER_OAUTH_CONSUMER_SECRET: z.string(),
    TWITTER_OAUTH_USER_TOKEN: z.string(),
    TWITTER_OAUTH_USER_SECRET: z.string(),
  })
  .transform((envs) => ({
    isProduction: envs.DENO_ENV === 'production',
    server: {
      port: envs.PORT,
    },
    loggers: {
      default: log.getLogger(),
      error: log.getLogger('error'),
    },
    twitter: {
      consumerKey: envs.TWITTER_OAUTH_CONSUMER_KEY,
      consumerSecret: envs.TWITTER_OAUTH_CONSUMER_SECRET,
      userToken: envs.TWITTER_OAUTH_USER_TOKEN,
      userSecret: envs.TWITTER_OAUTH_USER_SECRET,
    },
  }))

export type AppConfig = z.infer<typeof Config>
export const appConfig = Config.parse(Deno.env.toObject())
