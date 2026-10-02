import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export interface ErrorDetail {
  readonly field: string;
  readonly issue: string;
}

/** An error a client can branch on. `code` is part of the contract; `message` is for people. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly ErrorDetail[] | undefined;

  constructor(status: number, code: string, message: string, details?: readonly ErrorDetail[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(what: "project" | "environment" | "flag" | "key"): ApiError {
  return new ApiError(404, `${what}_not_found`, `No ${what} with that key exists here.`);
}

export function forbidden(message: string): ApiError {
  return new ApiError(403, "forbidden", message);
}

interface Envelope {
  code: string;
  message: string;
  details?: readonly ErrorDetail[];
  traceId: string;
}

function send(reply: FastifyReply, request: FastifyRequest, status: number, body: Omit<Envelope, "traceId">) {
  return reply.status(status).send({ ...body, traceId: request.id });
}

const FRAMEWORK_CODES: Record<string, [number, string]> = {
  FST_ERR_CTP_BODY_TOO_LARGE: [413, "body_too_large"],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, "unsupported_media_type"],
  FST_ERR_CTP_EMPTY_JSON_BODY: [400, "invalid_json"],
  FST_ERR_CTP_INVALID_JSON_BODY: [400, "invalid_json"],
};

export function handleError(error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiError) {
    return send(reply, request, error.status, {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  if (error.validation !== undefined) {
    const details = error.validation.map((issue) => ({
      field: `${error.validationContext ?? "request"}${issue.instancePath}`,
      issue: issue.keyword,
    }));
    return send(reply, request, 400, { code: "invalid_request", message: error.message, details });
  }
  const known = FRAMEWORK_CODES[error.code];
  if (known !== undefined) {
    return send(reply, request, known[0], { code: known[1], message: error.message });
  }
  if (error.statusCode !== undefined && error.statusCode < 500) {
    return send(reply, request, error.statusCode, { code: "bad_request", message: error.message });
  }
  request.log.error({ err: error }, "unhandled error");
  return send(reply, request, 500, { code: "internal_error", message: "Something went wrong on our side." });
}

export function handleNotFound(request: FastifyRequest, reply: FastifyReply) {
  return send(reply, request, 404, {
    code: "route_not_found",
    message: `No route ${request.method} ${request.url}.`,
  });
}
