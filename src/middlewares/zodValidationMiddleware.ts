import { oak, z } from '../deps.ts'

export default function validateBody<InputSchema extends z.ZodSchema>(
	schema: InputSchema,
): oak.Middleware<{ validatedBody: z.infer<InputSchema> }> {
	return async (ctx, next) => {
		const body = await ctx.request.body().value
		ctx.state.validatedBody = schema.parse(body)
		await next()
	}
}
