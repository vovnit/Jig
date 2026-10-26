package dev.nitochkin.jig

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteProgram
import org.json.JSONArray
import org.json.JSONObject

/**
 * The SQLite database behind the runtime's `Database` contract (`core/src/bridge.ts`).
 * The schema lives in the runtime; this only runs SQL. Used from the JS thread only.
 *
 * Requests and results cross the bridge as JSON, which keeps numbers, strings and
 * nulls intact: every call returns `{"rows": [...]}` or `{"error": "..."}`.
 */
class SqlDatabase(context: Context) {
    private var openError: String? = null

    /** The device's database, shared by every app. */
    private val db: SQLiteDatabase? = try {
        context.openOrCreateDatabase("jig.sqlite", Context.MODE_PRIVATE, null).apply { enableWriteAheadLogging() }
    } catch (e: Exception) {
        openError = e.message
        null
    }

    /** Runs one read. `paramsJson` is a JSON array of values. */
    fun query(sql: String, paramsJson: String): String = respond { db ->
        val params = JSONArray(paramsJson)
        // The framework binds query arguments as strings only; a cursor factory can bind real types.
        val factory = SQLiteDatabase.CursorFactory { _, driver, table, program ->
            bind(program, params)
            SQLiteCursor(driver, table, program)
        }
        db.rawQueryWithFactory(factory, sql, null, "").use { cursor ->
            val rows = JSONArray()
            while (cursor.moveToNext()) {
                val row = JSONObject()
                for (i in 0 until cursor.columnCount) row.put(cursor.getColumnName(i), column(cursor, i))
                rows.put(row)
            }
            rows
        }
    }

    /** Runs `[[sql, params?], ...]` in one transaction; on error nothing is written. */
    fun exec(statementsJson: String): String = respond { db ->
        val list = JSONArray(statementsJson)
        db.beginTransaction()
        try {
            for (i in 0 until list.length()) {
                val entry = list.getJSONArray(i)
                db.compileStatement(entry.getString(0)).use { statement ->
                    bind(statement, entry.optJSONArray(1))
                    statement.execute()
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        JSONArray()
    }

    private fun respond(body: (SQLiteDatabase) -> JSONArray): String = try {
        val db = db ?: error(openError ?: "Database is not open")
        JSONObject().put("rows", body(db))
    } catch (e: Exception) {
        JSONObject().put("error", e.message ?: e.toString())
    }.toString()

    private fun bind(program: SQLiteProgram, params: JSONArray?) {
        if (params == null) return
        for (i in 0 until params.length()) {
            val index = i + 1
            when (val value = params.get(i)) {
                is String -> program.bindString(index, value)
                is Int, is Long -> program.bindLong(index, (value as Number).toLong())
                is Number -> program.bindDouble(index, value.toDouble())
                is Boolean -> program.bindLong(index, if (value) 1 else 0)
                else -> program.bindNull(index)
            }
        }
    }

    private fun column(cursor: Cursor, i: Int): Any = when (cursor.getType(i)) {
        Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(i)
        Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(i)
        Cursor.FIELD_TYPE_STRING -> cursor.getString(i)
        else -> JSONObject.NULL
    }
}
