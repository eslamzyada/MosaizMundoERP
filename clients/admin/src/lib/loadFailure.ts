import axios from 'axios';

/**
 * What actually went wrong when a page could not load.
 *
 * Every page used to say the same thing — "تعذّر تحميل البيانات. تأكّد من تسجيل
 * الدخول ومن تشغيل الخادم" — for four unrelated situations, which asks somebody
 * to check two things when the software already knows which one it is. Worse,
 * two of the four cannot be fixed by the person reading it, and one of them
 * ("there is simply nothing here yet") is not a failure at all.
 *
 * The kinds are separated by WHAT THE READER SHOULD DO, not by HTTP status:
 * that is the only distinction a message has to earn its place.
 */
export type LoadFailureKind =
  /** The server could not be reached at all. Retrying may work by itself. */
  | 'offline'
  /** The session is over. Retrying cannot help; signing in again can. */
  | 'unauthenticated'
  /** Signed in, but this account may not see this. Nothing to retry. */
  | 'forbidden'
  /** The server answered, and broke. Not the reader's fault; retry is fair. */
  | 'server'
  /** Something unclassified. Retry is offered because it might be transient. */
  | 'unknown';

export interface LoadFailure {
  kind: LoadFailureKind;
  /** Arabic, addressed to whoever is looking at the screen. */
  message: string;
  /**
   * Whether to offer a retry button.
   *
   * False for the two cases retrying cannot fix. A button that always fails
   * teaches people the button does nothing, which is worse than no button.
   */
  canRetry: boolean;
  /** The HTTP status when there was one, for a bug report. */
  status?: number;
}

/**
 * Turns whatever a failed request threw into something worth showing.
 *
 * NOTE on 401: the axios interceptor already signs the user out, which swaps
 * the app to the login screen. This message is what they see in the instant
 * before that happens, or if a page renders its own error first — so it says
 * to sign in rather than offering a retry that will 401 again.
 */
export function classifyLoadFailure(error: unknown): LoadFailure {
  if (axios.isAxiosError(error)) {
    // No response at all: the server is down, the tunnel is dead, or the
    // network dropped. Indistinguishable from here, and identical in what to
    // do about it — which is why they share a message.
    if (!error.response) {
      return {
        kind: 'offline',
        message: 'تعذّر الوصول إلى الخادم. تحقّق من الاتصال ثم أعد المحاولة.',
        canRetry: true,
      };
    }

    const status = error.response.status;

    if (status === 401) {
      return {
        kind: 'unauthenticated',
        message: 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى للمتابعة.',
        canRetry: false,
        status,
      };
    }

    if (status === 403) {
      return {
        kind: 'forbidden',
        message: 'هذا القسم ليس ضمن صلاحيات حسابك.',
        canRetry: false,
        status,
      };
    }

    if (status >= 500) {
      return {
        kind: 'server',
        message: `حدث خطأ في الخادم (${status}). حاول مرة أخرى بعد قليل.`,
        canRetry: true,
        status,
      };
    }

    return {
      kind: 'unknown',
      message: `تعذّر تحميل البيانات (${status}).`,
      canRetry: true,
      status,
    };
  }

  return {
    kind: 'unknown',
    message: 'تعذّر تحميل البيانات.',
    canRetry: true,
  };
}
