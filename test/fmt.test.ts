// lib/fmt.ts の時刻の表示(fmtT)と解析(parseT)。CLI の frames / describe /
// validate が時刻を人間の m:ss と秒の数値の間で往復させるのに使う純関数。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtT, parseT } from "../src/lib/fmt.ts";

test("fmtT: 秒を m:ss.s 表記に(小数第1位まで)", () => {
  assert.equal(fmtT(0), "0:00.0");
  assert.equal(fmtT(12.3), "0:12.3");
  assert.equal(fmtT(90), "1:30.0");
  assert.equal(fmtT(125.36), "2:05.4"); // 小数第2位以下は丸め
  assert.equal(fmtT(3723), "62:03.0"); // 60 分以上は分がそのまま増える
});

test("fmtT: 負の秒は先頭に符号(スナップ・オフセットの説明用)", () => {
  assert.equal(fmtT(-12.3), "-0:12.3");
});

test("parseT: 秒・m:ss・h:mm:ss を解釈", () => {
  assert.equal(parseT("150"), 150);
  assert.equal(parseT("2:30"), 150);
  assert.equal(parseT("2:30.5"), 150.5);
  assert.equal(parseT("1:02:03"), 3723);
  assert.equal(parseT("0"), 0);
  assert.equal(parseT("  90 "), 90); // 前後の空白は無視
});

test("parseT: 解釈できない入力は null", () => {
  assert.equal(parseT(""), null);
  assert.equal(parseT("abc"), null);
  assert.equal(parseT("1:2:3:4"), null);
  assert.equal(parseT(":30"), null);
});
