import { appConfig } from './config.ts'
import { log, oak } from './deps.ts'
import * as networks from './networks/install.ts'

const app = new oak.Application()

app.use(async (ctx, next) => {
  log.info(`<- [${ctx.request.method}] ${ctx.request.url} from ${ctx.request.ip}`)
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  log.info(`-> [${ctx.request.method}] ${ctx.request.url} with ${ctx.response.status} took ${ms}ms`)
  if (ctx.response.body && !appConfig.isProduction) log.debug(`\t${JSON.stringify(ctx.response.body, null, 2)}`)
})

await networks.install(app, appConfig)

app.addEventListener('listen', ({ port }) => {
  console.log(`Listening on port ${port}`)
})

app.listen({ port: appConfig.server.port })
