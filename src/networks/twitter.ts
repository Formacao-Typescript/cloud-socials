import { oak, z } from '../deps.ts'

const CreateTweetSchema = z.object({})
type CreateTweetInput = z.infer<typeof CreateTweetSchema>

export const twitter = new oak.Router().prefix('/twitter')

twitter.post('/', async (ctx) => {
  try {
    ctx.response.body = await ctx.request.body().value
  } catch {
    ctx.response.body = 'Hello :)'
    ctx.response.status = 200
  }
})
