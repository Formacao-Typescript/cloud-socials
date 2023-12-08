export class HTTPError extends Error {
  constructor(public status: number, public message: string, err?: Error) {
    super(message)
    this.name = 'HTTPError'
    this.stack = new Error().stack
    this.cause = err
  }
}
