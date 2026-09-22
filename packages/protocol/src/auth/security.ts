import * as Context from "effect/Context"
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware"
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError"

export class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string; readonly email: string }
>()("@app/protocol/auth/security/CurrentUser") {}

export class CurrentUserMiddleware extends HttpApiMiddleware.Service<
  CurrentUserMiddleware,
  { provides: CurrentUser }
>()("@app/protocol/auth/security/CurrentUserMiddleware", {
  error: [HttpApiError.Unauthorized, HttpApiError.InternalServerError],
}) {}
