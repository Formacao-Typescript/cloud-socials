import { oak, z } from '../deps.ts'

export const linkedin = new oak.Router().prefix('/linkedin')

linkedin.post('/', async (ctx) => {
  try {
  } catch {
    ctx.response.status = 400
    ctx.response.body = { error: 'Invalid request body' }
  }
})
