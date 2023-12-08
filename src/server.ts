import { config } from "./config.ts";
import { oak } from "./deps.ts";
import * as networks from "./networks/networks.ts";

const app = new oak.Application();

app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const text = `[${ctx.request.method}] ${ctx.request.url} | ${ctx.response.status} | ${ms}ms`;
  await Deno.stdout.write(new TextEncoder().encode(text + "\n"));
});

networks.install(app);

app.addEventListener("listen", ({ port }) => {
  console.log(`Listening on port ${port}`);
});

app.listen({ port: config.server.port });
