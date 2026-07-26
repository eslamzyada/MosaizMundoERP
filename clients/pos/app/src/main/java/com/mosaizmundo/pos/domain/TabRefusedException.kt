package com.mosaizmundo.pos.domain

import okhttp3.ResponseBody
import org.json.JSONObject
import retrofit2.Response

/**
 * A tab operation the server refused, carrying a message fit to show a server
 * mid-service.
 *
 * These refusals are ROUTINE, not exceptional: "the kitchen already has that",
 * "something has not been sent yet", "that is a manager's job". The database
 * words them for the person at the till — "3 item(s) have not been sent to the
 * kitchen; send or remove them before settling" is the entire answer — and
 * collapsing them into a generic HttpException would throw away the only part
 * that tells a server what to actually do next.
 */
class TabRefusedException(
    val httpCode: Int,
    override val message: String,
) : Exception(message)

/**
 * Turns a failed response into a [TabRefusedException].
 *
 * Falls back to a plain Arabic sentence per status code when the body is not
 * the shape we expect — a proxy returning an HTML error page must not surface
 * as a stack trace or a blank toast.
 */
fun refusalFrom(code: Int, errorBody: ResponseBody?): TabRefusedException {
    val fromServer = errorBody?.let { body ->
        runCatching {
            val text = body.string()
            if (text.isBlank()) null else JSONObject(text).optString("error").ifBlank { null }
        }.getOrNull()
    }

    val fallback = when (code) {
        403 -> "هذه العملية ليست من صلاحيات حسابك"
        404 -> "الطلب غير موجود"
        409 -> "لا يمكن تنفيذ العملية على حالة الطلب الحالية"
        else -> "تعذّر تنفيذ العملية"
    }

    // The server's own wording where there is one, because it is more specific
    // than anything that can be written here without knowing the tab.
    return TabRefusedException(code, fromServer ?: fallback)
}

/** Body of a successful call, or a [TabRefusedException] describing the refusal. */
fun <T> Response<T>.bodyOrRefusal(): T? =
    if (isSuccessful) body() else throw refusalFrom(code(), errorBody())
