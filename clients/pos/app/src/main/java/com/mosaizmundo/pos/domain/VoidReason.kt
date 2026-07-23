package com.mosaizmundo.pos.domain

/**
 * Why an order was voided (migration 0022).
 *
 * A closed list, not free text: "wrong order", "mistake" and "خطأ" are one
 * event spelled three ways, and a void nobody can total is a void nobody learns
 * from. Twenty voids a week might be a cashier who needs training, a kitchen
 * plating the wrong dish, or two similar burgers next to each other on the
 * button grid — without a cause all three look identical.
 *
 * The declaration order is the order they appear at the till, and it is not
 * alphabetical: the everyday mistakes come first because they are what someone
 * reaches for while a queue waits, and OTHER is last because it should be where
 * you land after the real answers, not before them.
 *
 * [code] must match the backend vocabulary, which is itself checked against the
 * database constraint by voidReasons.drift.test.ts.
 */
enum class VoidReason(
    val code: String,
    val label: String,
    val hint: String,
) {
    WRONG_ITEM("wrong_item", "صنف خاطئ", "سُجِّل صنف أو كمية غير المطلوبة"),
    DUPLICATE("duplicate", "طلب مكرَّر", "نفس الطلب سُجِّل مرتين"),
    CUSTOMER_CANCELLED("customer_cancelled", "العميل ألغى", "غيّر رأيه أو غادر قبل الدفع"),
    KITCHEN_ERROR("kitchen_error", "خطأ في التحضير", "حُضِّر بشكل خاطئ ويُعاد تحضيره"),
    CUSTOMER_COMPLAINT("customer_complaint", "شكوى عميل", "رفض الطعام بعد تقديمه"),
    TEST_ORDER("test_order", "طلب تجريبي", "تدريب أو اختبار"),
    OTHER("other", "سبب آخر", "يتطلّب توضيحًا مكتوبًا");

    /**
     * The escape hatch has to explain itself, or it becomes the path of least
     * resistance for everything and the other six stop meaning anything.
     */
    val requiresNote: Boolean get() = this == OTHER

    companion object {
        const val NOTE_MAX_LENGTH = 500

        /**
         * The label for a stored code, falling back to the code itself.
         *
         * Deliberately not "غير معروف": if a reason ever arrives that this build
         * does not know about, showing it raw is how anyone finds out.
         */
        fun labelFor(code: String?): String {
            if (code.isNullOrBlank()) return ""
            return values().firstOrNull { it.code == code }?.label ?: code
        }
    }
}
