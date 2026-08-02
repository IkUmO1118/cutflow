import test from "node:test";
import assert from "node:assert/strict";
import {
  initialCanvasFromSearch,
  isLauncherRoute,
  projectPath,
  projectPrefix,
} from "../editor/client/route.ts";
import { HttpError, decodeProjectRouteName } from "../editor/server.ts";

test("project route: /p/<name>/ のAPIを同じプロジェクトへ束縛する", () => {
  assert.equal(projectPrefix("/p/my%20project/"), "/p/my%20project");
  assert.equal(projectPath("/api/project", "/p/my%20project/"), "/p/my%20project/api/project");
  assert.equal(projectPath("media/raw.mp4", "/p/my%20project/"), "media/raw.mp4");
  assert.equal(isLauncherRoute("/"), true);
  assert.equal(isLauncherRoute("/p/example/"), false);
});

test("project route: 作成URLのcanvasを空projectの初期選択へ保持する", () => {
  assert.equal(initialCanvasFromSearch("?canvas=portrait"), "portrait");
  assert.equal(initialCanvasFromSearch("?canvas=portrait-screen&layout=plain"), "portrait-screen");
  assert.equal(initialCanvasFromSearch("?canvas=unknown"), "landscape");
  assert.equal(initialCanvasFromSearch(""), "landscape");
});

test("project route: 壊れたpercent encodingは400になる", () => {
  assert.throws(
    () => decodeProjectRouteName("%E0%A4%A"),
    (error) => error instanceof HttpError && error.status === 400,
  );
});
