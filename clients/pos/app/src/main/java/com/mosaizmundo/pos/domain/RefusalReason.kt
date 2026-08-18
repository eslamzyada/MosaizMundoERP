package com.mosaizmundo.pos.domain

/**
 * Why the server refused a sale, in terms of who can fix it.
 *
 * The screen could say WHICH sales had not arrived and not why, so a cashier
 * could not tell "this dish no longer exists" from "your account lost
 * permission" — different problems, different people to fetch, and only one of
 * them worth pressing retry on before anybody does anything.
 *
 * Grouped by the ACTION, not by the status code. A cashier does not care that
 * it was a 403; they care that somebody with a manager's account has to be
 * standing next to them.
 */
enum class RefusalReason(
    /** What happened, addressed to whoever is holding the tablet. */
    val message: String,
    /**
     * Whether pressing retry NOW could plausibly work.
     *
     * False does not mean the sale is lost — it means something has to change
     * first, and retrying before it does will only produce the same refusal.
     * The button is offered either way, because a retry costs one idempotent
     * request and being wrong about this must not strand a sale.
     */
    val retryLikelyToHelp: Boolean,
) {
    PERMISSION(
        "الحساب لم يعد يملك صلاحية إتمام هذا البيع. اطلب من المدير إعادة الصلاحية ثم أعد المحاولة.",
        retryLikelyToHelp = false,
    ),
    MISSING_ITEM(
        "صنف في هذه الفاتورة لم يعد موجودًا على النظام. أعد الصنف ثم أعد المحاولة.",
        retryLikelyToHelp = false,
    ),
    REJECTED_DATA(
        "الخادم رفض بيانات هذا الطلب. أبلغ الإدارة بالرقم المرجعي أدناه.",
        retryLikelyToHelp = false,
    ),
    UNREADABLE(
        "تعذّرت قراءة تفاصيل هذا الطلب على الجهاز. أبلغ الإدارة بالرقم المرجعي أدناه.",
        retryLikelyToHelp = false,
    ),
    UNKNOWN(
        "لم تصل هذه العملية إلى الخادم. أعد المحاولة، وإن تكرر الرفض أبلغ الإدارة.",
        retryLikelyToHelp = true,
    ),
}

/**
 * Maps what was recorded to what to tell somebody.
 *
 * `null` is UNKNOWN rather than an error: rows queued before the column existed
 * carry no reason at all, and they are exactly the oldest and most stranded
 * sales in the queue — the ones most in need of being shown.
 */
fun refusalReasonFor(code: Int?): RefusalReason = when (code) {
    null -> RefusalReason.UNKNOWN
    -1 -> RefusalReason.UNREADABLE          // SyncOrdersWorker.UNREADABLE_PAYLOAD
    401, 403 -> RefusalReason.PERMISSION
    404, 410 -> RefusalReason.MISSING_ITEM
    400, 409, 413, 415, 422 -> RefusalReason.REJECTED_DATA
    else -> RefusalReason.UNKNOWN
}
