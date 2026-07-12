#!/usr/bin/env node
// A3: Node バージョンガード。型ストリッピング(unflagged)が効く Node >= 23.6 を
// 要求する。このファイルは素の JS なので古い Node でもパースでき、cli.ts の
// パースエラーが出る前に人間可読なメッセージで停止できる。
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 23 || (major === 23 && minor < 6)) {
  process.stderr.write(
    `cutflow は Node >= 23.6 が必要です(現在: v${process.versions.node})。\n` +
      `TypeScript を直接実行するため型ストリッピング(Node 23.6 で既定有効)を使います。\n` +
      `nvm/fnm を使っているなら \`nvm use\`(.nvmrc = 23.6.0)で切り替えてください。\n`,
  );
  process.exit(1);
}
await import("../src/cli.ts");
