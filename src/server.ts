/// <reference lib="deno.unstable" />
import { appConfig } from './config.ts'
import { log, oak, z } from './deps.ts'
import * as networks from './networks/install.ts'

const app = new oak.Application()

app.use(async (ctx, next) => {
	log.info(`<- [${ctx.request.method}] ${ctx.request.url} from ${ctx.request.ip}`)
	const start = performance.now()
	try {
		await next()
	} catch (error) {
		ctx.response.type = 'json'
		ctx.response.body = { error: error.message, cause: error.cause }
		ctx.response.status = 500

		if (oak.isHttpError(error)) {
			ctx.response.status = error.status
		} else if (error instanceof z.ZodError) {
			ctx.response.status = 422;
			ctx.response.body = { ...ctx.response.body, cause: error.issues };
		} else {
			console.error(error);
		}
	} finally {
		log.info(
			`-> [${ctx.request.method}] ${ctx.request.url} with ${ctx.response.status} took ${
				(
					performance.now() - start
				).toFixed(2)
			}ms`,
		)
		if (ctx.response.body && !appConfig.isProduction) log.debug(`\t${JSON.stringify(ctx.response.body, null, 2)}`)
	}
})

await networks.install(app, appConfig)

app.addEventListener('listen', ({ port }) => {
	console.log(`Listening on port ${port}`)
})

app.listen({ port: appConfig.server.port })
