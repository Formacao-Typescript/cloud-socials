import { AppConfig } from '../config.ts'
import { oak } from '../deps.ts'

export enum NetworkList {
	Twitter = 'twitter',
	LinkedIn = 'linkedin',
	Instagram = 'instagram',
}

export const install = async (app: oak.Application, { loggers }: AppConfig) => {
	loggers.default.debug('Loading networks')
	for (const network of Object.values(NetworkList)) {
		try {
			loggers.default.info(`Installing network ${network}`)
			const networkRouter: oak.Router = (await import(`./${network}.ts`))['default']
			app.use(networkRouter.routes())
			app.use(networkRouter.allowedMethods())
			loggers.default.info(`Installed network ${network}`)
		} catch (err) {
			loggers.error.warning(`Failed to install network ${network}`)
			loggers.error.error((err as Error).message)
		}
	}
}
