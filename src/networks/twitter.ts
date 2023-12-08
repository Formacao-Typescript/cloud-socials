import { oak } from "../deps.ts";

export const twitter = new oak.Router().prefix("/twitter");

twitter.post("/", async (ctx) => {
  try {
    ctx.response.body = await ctx.request.body().value;
  } catch {
    ctx.response.body = "Hello :)";
    ctx.response.status = 200;
  }
});
