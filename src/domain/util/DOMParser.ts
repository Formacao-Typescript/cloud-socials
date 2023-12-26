import { appConfig } from '../../config.ts'
import { DOMParser, initDomParser } from '../../deps.ts'

export async function fetchDOMFromURL(url: string, timeout = 3000) {
	const response = await Promise.race([
		fetch(url),
		new Promise<{ ok: boolean }>((resolve) => setTimeout(() => resolve({ ok: false }), timeout)),
	])
	appConfig.loggers.default.debug(`Enricher.fetchDOMFromURL :: response from fetch ${response.ok}`)

	if (!response.ok) return false
	const html = await (response as Response).text()

	appConfig.loggers.default.debug(`Enricher.fetchDOMFromURL :: initializing dom parser`)
	await initDomParser()
	const doc = new DOMParser().parseFromString(html, 'text/html')
	appConfig.loggers.default.debug(`Enricher.fetchDOMFromURL :: parsed dom`)
	if (!doc) return false
	return doc
}
