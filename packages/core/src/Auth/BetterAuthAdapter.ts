import * as Sql from "@digital-shelf/domain/Sql/index"
import type { BetterAuthOptions } from "better-auth"
import {
  createAdapterFactory,
  type DBAdapterInstance,
  type CleanedWhere,
} from "better-auth/adapters"
import { BetterAuthError } from "better-auth"
import {
  and,
  or,
  asc,
  desc,
  count,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  sql,
  getTableColumns,
  is,
  type SQL,
} from "drizzle-orm"
import { PgTable, type PgColumn } from "drizzle-orm/pg-core"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import * as Context from "effect/Context"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import { Db, type Database } from "../Sql/Db.ts"
import { query } from "../Sql/Errors.ts"

/** Postgres port of the Better Auth 1.7.3 Drizzle adapter. The factory owns
 * field transforms and fallback joins; every SQL builder runs in the captured
 * Effect context, including the connection reserved by a transaction. */
export const makeAdapter = (
  db: Database,
  context: Context.Context<Db>,
  options: { inTransaction: boolean } = { inTransaction: false },
): DBAdapterInstance => {
  const run = <A>(effect: Effect.Effect<A, EffectDrizzleQueryError>) =>
    Effect.runPromiseWith(context)(query(effect))

  let lazyOptions: BetterAuthOptions

  const adapter = createAdapterFactory({
    config: {
      adapterId: "drizzle",
      adapterName: "Drizzle Adapter",
      usePlural: false,
      debugLogs: false,
      supportsUUIDs: true,
      supportsJSON: true,
      supportsArrays: true,
      customTransformOutput: ({ data, fieldAttributes }) => {
        if (
          fieldAttributes.type === "date" &&
          data !== null &&
          data !== undefined
        ) {
          // @effect-diagnostics-next-line globalDate:off
          return new Date(data)
        }

        return data
      },
      transaction: options.inTransaction
        ? false
        : (cb) =>
            Effect.runPromiseWith(context)(
              db.transaction(() =>
                Effect.gen(function* () {
                  const inner = yield* Effect.context<Db>()

                  return yield* Effect.tryPromise({
                    try: () =>
                      cb(
                        makeAdapter(db, inner, { inTransaction: true })(
                          lazyOptions,
                        ),
                      ),
                    catch: (error) =>
                      error instanceof Error
                        ? error
                        : new Error("Better Auth transaction failed", {
                            cause: error,
                          }),
                  })
                }),
              ),
            ),
    },
    adapter: ({ getFieldName }) => {
      const getSchema = (model: string): PgTable => {
        const table = new Map(Object.entries(Sql)).get(model)

        if (!is(table, PgTable))
          throw new BetterAuthError(
            `[# Drizzle Adapter]: The model "${model}" was not found in the schema object. Please pass the schema directly to the adapter options.`,
          )

        return table
      }

      const column = (model: string, field: string): PgColumn => {
        const name = getFieldName({ model, field })
        const col = getTableColumns(getSchema(model))[name]

        if (!col)
          throw new BetterAuthError(
            `The field "${field}" does not exist in the schema for the model "${model}". Please update your schema.`,
          )

        return col
      }

      const condition = (w: CleanedWhere, model: string): SQL => {
        const col = column(model, w.field)

        const insensitive =
          w.mode === "insensitive" &&
          (Schema.is(Schema.String)(w.value) ||
            (Array.isArray(w.value) &&
              w.value.every((v) => Schema.is(Schema.String)(v))))

        const operand = sql`lower(${col})`

        const value =
          insensitive && Schema.is(Schema.String)(w.value)
            ? w.value.toLowerCase()
            : w.value

        if (w.operator === "in" || w.operator === "not_in") {
          if (!Array.isArray(w.value))
            throw new BetterAuthError(
              `The value for the field "${w.field}" must be an array when using the "${w.operator}" operator.`,
            )

          const values = insensitive
            ? w.value.map((v) => String(v).toLowerCase())
            : w.value

          return w.operator === "in"
            ? insensitive
              ? inArray(operand, values)
              : inArray(col, values)
            : insensitive
              ? notInArray(operand, values)
              : notInArray(col, values)
        }

        const insensitiveString =
          insensitive && Schema.is(Schema.String)(w.value)

        if (w.operator === "contains")
          return (insensitiveString ? ilike : like)(col, `%${String(w.value)}%`)

        if (w.operator === "starts_with")
          return (insensitiveString ? ilike : like)(col, `${String(w.value)}%`)

        if (w.operator === "ends_with")
          return (insensitiveString ? ilike : like)(col, `%${String(w.value)}`)

        if (w.operator === "lt") return lt(col, w.value)

        if (w.operator === "lte") return lte(col, w.value)

        if (w.operator === "gt") return gt(col, w.value)

        if (w.operator === "gte") return gte(col, w.value)

        if (w.operator === "ne")
          return w.value === null
            ? isNotNull(col)
            : insensitiveString
              ? ne(operand, value)
              : ne(col, value)

        return w.value === null
          ? isNull(col)
          : insensitiveString
            ? eq(operand, value)
            : eq(col, value)
      }

      const convertWhereClause = (
        where: CleanedWhere[] | undefined,
        model: string,
      ) => {
        if (!where?.length) return undefined

        if (where.length === 1) return condition(where[0]!, model)
        const andGroup = where.filter((w) => w.connector !== "OR")
        const orGroup = where.filter((w) => w.connector === "OR")
        const andClause = and(...andGroup.map((w) => condition(w, model)))
        const orClause = or(...orGroup.map((w) => condition(w, model)))

        return andGroup.length && orGroup.length
          ? and(andClause, orClause)
          : andGroup.length
            ? andClause
            : orClause
      }

      const selection = (model: string, select?: string[]) =>
        select?.length
          ? Object.fromEntries(
              select.map((field) => [
                getFieldName({ model, field }),
                column(model, field),
              ]),
            )
          : getTableColumns(getSchema(model))

      const checkMissingFields = (
        model: string,
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Better Auth's model-generic adapter contract carries field values as unknown; the factory owns transforms.
        values: Record<string, unknown>,
      ) => {
        const columns = getTableColumns(getSchema(model))

        for (const key in values) {
          let field: string

          try {
            field = getFieldName({ model, field: key })
          } catch {
            field = key
          }

          if (!columns[field])
            throw new BetterAuthError(
              `The field "${key}" does not exist in the "${model}" Drizzle schema. Please update your drizzle schema or re-generate using "npx auth@latest generate".`,
            )
        }
      }

      const withReturning = async <T>(builder: {
        returning: () => Effect.Effect<
          // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Better Auth's model-generic adapter contract carries field values as unknown; the factory owns transforms.
          ReadonlyArray<Record<string, unknown>>,
          EffectDrizzleQueryError
        >
      }): Promise<T | null> =>
        // SAFETY: Better Auth chooses T for the model passed to this returning builder; the factory owns field transforms.
        ((await run(builder.returning()))[0] as T) ?? null

      return {
        async create({ model, data }) {
          checkMissingFields(model, data)

          // SAFETY: The same model validates data and supplies the returning row; Better Auth applies its output transforms.
          return (
            await run(db.insert(getSchema(model)).values(data).returning())
          )[0] as typeof data
        },
        async findOne<T>({
          model,
          where,
          select,
        }: {
          model: string
          where: CleanedWhere[]
          select?: string[] | undefined
        }): Promise<T | null> {
          const rows = await run(
            db
              .select(selection(model, select))
              .from(getSchema(model))
              .where(convertWhereClause(where, model)),
          )

          // SAFETY: Better Auth supplies T for this model and projection; selection resolves every requested field against that table.
          return (rows[0] as T) ?? null
        },
        async findMany<T>({
          model,
          where,
          select,
          sortBy,
          limit,
          offset,
        }: {
          model: string
          where?: CleanedWhere[] | undefined
          select?: string[] | undefined
          sortBy?: { field: string; direction: "asc" | "desc" } | undefined
          limit: number
          offset?: number | undefined
        }): Promise<T[]> {
          let builder = db
            .select(selection(model, select))
            .from(getSchema(model))
            .$dynamic()

          if (limit !== undefined) builder = builder.limit(limit)

          if (offset !== undefined) builder = builder.offset(offset)

          if (sortBy)
            builder = builder.orderBy(
              (sortBy.direction === "desc" ? desc : asc)(
                column(model, sortBy.field),
              ),
            )

          // SAFETY: Better Auth supplies T for this model and projection; the query reads precisely that selection.
          return (await run(
            builder.where(convertWhereClause(where, model)),
          )) as T[]
        },
        async count({ model, where }) {
          return (
            await run(
              db
                .select({ count: count() })
                .from(getSchema(model))
                .where(convertWhereClause(where, model)),
            )
          )[0]!.count
        },
        async update<T>({
          model,
          where,
          update,
        }: {
          model: string
          where: CleanedWhere[]
          update: T
        }) {
          // SAFETY: Better Auth supplies update as the selected model's field dictionary; its generic T erases that constraint.
          return withReturning<T>(
            db
              .update(getSchema(model))
              // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Better Auth's model-generic adapter contract carries field values as unknown; the factory owns transforms.
              .set(update as Record<string, unknown>)
              .where(convertWhereClause(where, model)),
          )
        },
        async updateMany({ model, where, update }) {
          const rows = await run(
            db
              .update(getSchema(model))
              .set(update)
              .where(convertWhereClause(where, model))
              .returning(),
          )

          return rows.length
        },
        async delete({ model, where }) {
          await run(
            db.delete(getSchema(model)).where(convertWhereClause(where, model)),
          )
        },
        async deleteMany({ model, where }) {
          const rows = await run(
            db
              .delete(getSchema(model))
              .where(convertWhereClause(where, model))
              .returning(),
          )

          return rows.length
        },
        async consumeOne<T>({
          model,
          where,
        }: {
          model: string
          where: CleanedWhere[]
        }) {
          const table = getSchema(model)
          const id = column(model, "id")

          const target = db
            .select({ id })
            .from(table)
            .where(convertWhereClause(where, model))
            .limit(1)

          return withReturning<T>(db.delete(table).where(inArray(id, target)))
        },
        async incrementOne<T>({
          model,
          where,
          increment,
          set,
        }: {
          model: string
          where: CleanedWhere[]
          increment: Record<string, number>
          // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Better Auth's model-generic adapter contract carries field values as unknown; the factory owns transforms.
          set?: Record<string, unknown> | undefined
        }) {
          const table = getSchema(model)
          const id = column(model, "id")
          // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Better Auth's model-generic adapter contract carries field values as unknown; the factory owns transforms.
          const assignments: Record<string, unknown> = {}

          for (const [field, delta] of Object.entries(increment))
            assignments[getFieldName({ model, field })] =
              sql`${column(model, field)} + ${sql.param(delta)}`

          for (const [field, value] of Object.entries(set ?? {})) {
            column(model, field)
            assignments[getFieldName({ model, field })] = value
          }

          const target = db
            .select({ id })
            .from(table)
            .where(convertWhereClause(where, model))
            .limit(1)

          return withReturning<T>(
            db.update(table).set(assignments).where(inArray(id, target)),
          )
        },
      }
    },
  })

  return (options) => {
    lazyOptions = options

    return adapter(options)
  }
}
