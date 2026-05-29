import type { FastifyRequest } from "fastify";

import type { AppConfig } from "../config/env.js";

export function appBaseUrl(request: FastifyRequest, config: AppConfig): string {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    return origin;
  }

  const referer = request.headers.referer;
  if (typeof referer === "string" && referer.length > 0) {
    try {
      const url = new URL(referer);
      return `${url.protocol}//${url.host}`;
    } catch {
      // Ignore invalid referer values.
    }
  }

  return config.APP_BASE_URL;
}
