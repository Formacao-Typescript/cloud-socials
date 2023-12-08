import { AppConfig } from '../config.ts'
import { baseClient } from './baseClient.ts'
import { crypto } from '../deps.ts'

export interface AuthorizationHeaderOptions {
  url: string
  method: string
  body: string
  headers: Record<string, string>
  query: Record<string, string>
}

// WIP: Twitter client
export class TwitterClient {
  #twitterConfig: AppConfig['twitter']
  #baseUrl = 'https://api.twitter.com'
  #client
  constructor(config: AppConfig) {
    this.#twitterConfig = config.twitter
    this.#getBaseClient()
  }

  #getBaseClient() {
    // this.#client =
  }

  private async generateAuthorizationHeader(options: AuthorizationHeaderOptions) {
    return {
      Authorization: `OAuth oauth_consumer_key="${this.#twitterConfig.consumerKey}",
      oauth_nonce="${this.#getNonce()}",
      oauth_signature="${await this.#getSignature(options)}",
      oauth_signature_method="HMAC-SHA1",
      oauth_timestamp="${Date.now() / 1000}",
      oauth_token="${this.#twitterConfig.userToken}",
      oauth_version="1.0"`,
    }
  }

  #getNonce() {
    const nonce = crypto.getRandomValues(new Uint8Array(32))
    return btoa(nonce.toString())
  }

  async #getSignature(options: AuthorizationHeaderOptions) {}

  async createTweet() {}
}
