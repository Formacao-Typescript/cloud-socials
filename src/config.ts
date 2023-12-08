import { z } from "./deps.ts";

export const Config = z.object({
  PORT: z.coerce.number().default(3000),
}).transform((envs) => ({
  server: {
    port: envs.PORT,
  },
}));

export type Config = z.infer<typeof Config>;

export const config = Config.parse(Deno.env.toObject());
