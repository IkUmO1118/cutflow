// トースト・キューの純粋リデューサ(React 非依存)。
//
// 通知(error / job)はここに積まれ、右下スタックへ描画される。要対応の継続
// 条件(draftOffer / externalChange / proxyStale)はトーストではなくバナー行で
// 扱う——寿命モデルが違う(通知=消える / 条件=残る)ため 1 機構に寄せない。
//
// 時刻は状態に持たず、追加・更新・期限判定の各操作に now を注入する。これで
// キュー操作を node --test で決定的に固定できる(タイマーは useToasts が持つ)。

export type ToastKind = "info" | "success" | "error" | "progress";

/** 任意アクション(例: 完了トーストの「開く」で出力先を再度開く) */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  /** 自動消滅までのミリ秒。0/undefined = 消えない(error / progress) */
  ttlMs?: number;
  /** 手動クローズ(×)を許すか。既定 true */
  closable?: boolean;
  /** now + ttlMs(add / ttlMs を含む update で確定)。undefined = 自動消滅なし */
  expiresAt?: number;
}

/** addToast の入力(id と expiresAt はストア側が付ける) */
export type ToastInput = Omit<Toast, "id" | "expiresAt">;
/** updateToast のパッチ(id と expiresAt は差し替え対象外) */
export type ToastPatch = Partial<Omit<Toast, "id" | "expiresAt">>;

/** 同時表示の上限。超過は最古(先頭)を落とす */
export const MAX_TOASTS = 5;

export type ToastEvent =
  | { type: "add"; toast: Toast; now: number }
  | { type: "update"; id: string; patch: ToastPatch; now: number }
  | { type: "dismiss"; id: string }
  | { type: "expire"; now: number };

/** ttlMs から expiresAt を確定する(ttlMs 無し = 自動消滅しない) */
function withExpiry(t: Toast, now: number): Toast {
  return { ...t, expiresAt: t.ttlMs ? now + t.ttlMs : undefined };
}

export function toastReducer(state: Toast[], ev: ToastEvent): Toast[] {
  switch (ev.type) {
    case "add": {
      const next = [...state, withExpiry(ev.toast, ev.now)];
      // 超過分は最古(先頭)から落とす
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    }
    case "update":
      return state.map((t) => {
        if (t.id !== ev.id) return t;
        const merged = { ...t, ...ev.patch };
        // patch が ttlMs に触れたときだけ expiresAt を引き直す
        // (progress→success の差し替えで自動消滅タイマーを開始する経路)
        return "ttlMs" in ev.patch ? withExpiry(merged, ev.now) : merged;
      });
    case "dismiss":
      return state.filter((t) => t.id !== ev.id);
    case "expire":
      return state.filter((t) => t.expiresAt == null || t.expiresAt > ev.now);
  }
}
