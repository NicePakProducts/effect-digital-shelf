import * as Context from "effect/Context"
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware"
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError"

export class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string; readonly email: string }
>()("@digital-shelf/api/Auth/CurrentUser") {}

export class CurrentUserMiddleware extends HttpApiMiddleware.Service<
  CurrentUserMiddleware,
  { provides: CurrentUser }
>()("@digital-shelf/api/Auth/CurrentUserMiddleware", {
  error: [HttpApiError.Unauthorized, HttpApiError.InternalServerError],
}) {}
