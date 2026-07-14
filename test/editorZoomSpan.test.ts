/** GUI エディタのズーム区間の重なり回避(editor/client/model.ts の fitZoomSpan)。
 *
 * ズームは重なれない(validate が「ズーム区間が重なっています」でエラーにする)。
 * GUI が重なる区間を作れてしまうと、その編集はもう保存できず、しかもカットの中へ
 * 落ちた区間はタイムラインにクリップが出ないので削除もできない=詰む。ここでは
 * 「重なる編集は隣の手前で止まるか、採られない」ことを固定する */
import { test } from "node:test";
import assert from "node:assert/strict";

import { fitZoomSpan } from "../editor/client/model.ts";

const MIN = 0.01;

test("重なりが無ければそのまま通る", () => {
  const others = [{ start: 10, end: 20 }];
  assert.deepEqual(fitZoomSpan(others, { start: 30, end: 40 }, "create", MIN), {
    start: 30,
    end: 40,
  });
});

test("新規作成: 既存ズームへ食い込む末尾は手前で切られる", () => {
  const others = [{ start: 20, end: 30 }];
  assert.deepEqual(fitZoomSpan(others, { start: 12, end: 25 }, "create", MIN), {
    start: 12,
    end: 20,
  });
});

test("新規作成: 既存ズームの内側は作れない(null)", () => {
  const others = [{ start: 20, end: 30 }];
  assert.equal(fitZoomSpan(others, { start: 22, end: 28 }, "create", MIN), null);
});

test("トリム: 固定端の側の隙間へクランプされる(始端トリム)", () => {
  const others = [{ start: 0, end: 10 }];
  // 12–20 の始端を 5 まで引っ張る → 直前のズームの末尾(10)で止まる
  assert.deepEqual(fitZoomSpan(others, { start: 5, end: 20 }, "trim-start", MIN), {
    start: 10,
    end: 20,
  });
});

test("トリム: 隣のズームを越える終端は手前で止まる(終端トリム)", () => {
  const others = [{ start: 30, end: 40 }];
  assert.deepEqual(fitZoomSpan(others, { start: 10, end: 35 }, "trim-end", MIN), {
    start: 10,
    end: 30,
  });
});

test("移動: 尺を保ったまま隣のズームの手前で止まる", () => {
  const others = [{ start: 30, end: 40 }];
  // 10–20(尺10)を右へ 25–35 まで動かす → 隣(30)の手前 20–30 で止まる
  assert.deepEqual(fitZoomSpan(others, { start: 25, end: 35 }, "move", MIN), {
    start: 20,
    end: 30,
  });
});

test("移動: 隙間が尺より狭ければ動かさない(null)", () => {
  const others = [
    { start: 0, end: 10 },
    { start: 15, end: 30 },
  ];
  // 尺10の区間を 10–15 の隙間(5秒)へは入れられない
  assert.equal(fitZoomSpan(others, { start: 11, end: 21 }, "move", MIN), null);
});

test("移動: 中点が既存ズームの内側なら動かさない(null)", () => {
  const others = [{ start: 20, end: 30 }];
  assert.equal(fitZoomSpan(others, { start: 23, end: 27 }, "move", MIN), null);
});

test("自分自身は others に含めない(その場のトリムが自分と重なって落ちない)", () => {
  // 呼び出し側は自分を除いた配列を渡す契約。除けば端の伸縮は素通しされる
  assert.deepEqual(fitZoomSpan([], { start: 10, end: 12 }, "trim-end", MIN), {
    start: 10,
    end: 12,
  });
});

test("最小幅を割る編集は採らない(null)", () => {
  assert.equal(fitZoomSpan([], { start: 10, end: 10.005 }, "trim-end", MIN), null);
});

test("隙間が最小幅未満なら作れない(null)", () => {
  const others = [
    { start: 0, end: 10 },
    { start: 10.005, end: 20 },
  ];
  assert.equal(fitZoomSpan(others, { start: 10, end: 10.005 }, "create", MIN), null);
});

test("返す秒は round2(呼び出し側の量子と揃う)", () => {
  const others = [{ start: 30.004, end: 40 }];
  const fit = fitZoomSpan(others, { start: 10, end: 35.006 }, "create", MIN);
  assert.deepEqual(fit, { start: 10, end: 30 });
});
