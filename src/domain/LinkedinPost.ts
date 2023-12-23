import { LinkedinMedia, LinkedinMediaTypes } from '../clients/Linkedin.ts'

type LinkedinArticleMedia = Omit<LinkedinMedia, 'type'> & { type: 'article' }
type LinkedinMediaGeneral = {
  type: Exclude<LinkedinMedia['type'], 'article'>
  id: string
  title: string
}

export class LinkedinPost {
  media?: LinkedinArticleMedia | LinkedinMediaGeneral

  constructor(readonly text: string, readonly author: string) {}

  get payload() {
    return {
      author: this.author,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: []
      },
      commentary: this.text,
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...this.#parseMedia()
    }
  }

  addArticle(data: Omit<LinkedinMedia, 'type'>) {
    this.media = {
      type: LinkedinMediaTypes.ARTICLE,
      ...data
    }
    return this
  }

  addMedia(type: Exclude<LinkedinMedia['type'], 'article'>, title: string, id: string) {
    this.media = {
      type,
      title,
      id
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
              ...(this.media.thumbnail && { thumbnail: this.media.thumbnail })
            }
          }
        }
      case LinkedinMediaTypes.IMAGE:
      case LinkedinMediaTypes.DOCUMENT:
      case LinkedinMediaTypes.VIDEO:
        return {
          content: {
            media: {
              id: this.media.id,
              title: this.media.title
            }
          }
        }
    }
  }
}
