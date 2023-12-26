import { LinkedinMediaTypes } from '../clients/LinkedinClient.ts'
import { LinkedinMediaArticleInput, LinkedinMediaAssetInput, LinkedinMediaInput } from '../networks/linkedin.ts'

export class LinkedinPost {
	media?: LinkedinMediaArticleInput | Omit<LinkedinMediaAssetInput & { id: string }, 'source'>

	constructor(readonly text: string, readonly author: string) {}

	get payload() {
		return {
			author: this.author,
			visibility: 'PUBLIC',
			distribution: {
				feedDistribution: 'MAIN_FEED',
				targetEntities: [],
				thirdPartyDistributionChannels: [],
			},
			commentary: this.text,
			lifecycleState: 'PUBLISHED',
			isReshareDisabledByAuthor: false,
			...this.#parseMedia(),
		}
	}

	addArticle(data: Omit<LinkedinMediaInput, 'type'>) {
		this.media = {
			type: LinkedinMediaTypes.ARTICLE,
			...data,
		}
		return this
	}

	addMedia(type: Exclude<LinkedinMediaInput['type'], 'article'>, title: string, id: string) {
		this.media = {
			type,
			title,
			id,
		}
		return this
	}

	#parseMedia() {
		if (!this.media) return {}

		switch (this.media.type) {
			case LinkedinMediaTypes.ARTICLE:
				return {
					content: {
						article: {
							source: this.media.source,
							title: this.media.title,
							...(this.media.description && { description: this.media.description }),
							...(this.media.thumbnail && { thumbnail: this.media.thumbnail }),
						},
					},
				}
			case LinkedinMediaTypes.IMAGE:
			case LinkedinMediaTypes.DOCUMENT:
			case LinkedinMediaTypes.VIDEO:
				return {
					content: {
						media: {
							id: this.media.id,
							title: this.media.title,
						},
					},
				}
		}
	}
}
