import { oak } from "../deps.ts";
import { twitter } from "./twitter.ts";

export const install = (app: oak.Application) => {
  app.use(twitter.routes());
  app.use(twitter.allowedMethods());
};
