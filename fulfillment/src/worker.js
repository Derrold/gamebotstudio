import { handleRequest } from "./http.js";

export default {
  async fetch(request, env) {
    return handleRequest(request, env, { fetch: globalThis.fetch, now: () => Date.now() });
  },
};
