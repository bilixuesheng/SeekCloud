#!/bin/bash
# 通用镜像的自检（#17 的验收）：在用这个镜像建的沙箱里跑，每一项不过就整体失败。
# .github/workflows/sandbox-image.yml 在测试机上用 Sysbox 建一个沙箱跑它。
# 输出会进公开的日志：只打印版本号和通过与否，不打印地址。
set -uo pipefail
failed=0
pass() { echo "✓ $1"; }
fail() { echo "✗ $1"; failed=1; }
check() {
  local name="$1"
  shift
  local out
  if out="$("$@" 2>&1)"; then pass "$name"; else fail "$name：$(echo "$out" | tail -n 3)"; fi
}

work="$(mktemp -d)"
cd "$work" || exit 1

echo "== 版本"
cat /etc/seekcloud/versions

echo "== 工具链"
check "Node" node -e 'process.exit(0)'
check "npm" npm --version
check "pnpm（corepack）" sh -c 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version'
check "Python" python3 -c 'import ssl, sqlite3, venv'
check "pip 和 venv" sh -c 'python3 -m venv v && v/bin/pip --version'
check "uv" uv --version
printf 'package main\nimport "fmt"\nfunc main() { fmt.Println("go ok") }\n' > main.go
check "Go 编译运行" sh -c 'go run main.go | grep -q "go ok"'
printf 'fn main() { println!("rust ok"); }\n' > main.rs
check "Rust 编译运行" sh -c 'rustc -o main-rs main.rs && ./main-rs | grep -q "rust ok"'
check "cargo、rustfmt、clippy" sh -c 'cargo --version && rustfmt --version && cargo clippy --version'
printf 'public class Main { public static void main(String[] a) { System.out.println("java ok"); } }\n' > Main.java
check "Java 编译运行" sh -c 'javac Main.java && java Main | grep -q "java ok"'
check "Maven" mvn --version
check "git、Git LFS" sh -c 'git --version && git lfs version'
check "gh" gh --version
check "常用命令行工具" sh -c 'for c in curl wget jq rg fd tree file unzip zip xz zstd rsync sqlite3 make cmake gcc g++ nc dig ssh less; do command -v "$c" >/dev/null || { echo "没有 $c"; exit 1; }; done'

echo "== 沙箱里的 Docker"
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
check "docker run hello-world" sh -c 'docker run --rm hello-world | grep -q "Hello from Docker"'
check "docker compose、buildx" sh -c 'docker compose version && docker buildx version'

echo "== Chromium 和 Playwright"
check "任何目录里都能 require('playwright')，Chromium 能打开页面" node -e '
  const { chromium } = require("playwright");
  (async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent("<title>seekcloud</title><p>ok</p>");
    if ((await page.title()) !== "seekcloud") process.exit(1);
    await browser.close();
  })().catch((e) => { console.error(e); process.exit(1); });
'

echo "== dsh 和它自己的 Node"
check "系统的 Node 和 dsh 的 Node 是两份" sh -c '
  test "$(command -v node)" = /usr/local/bin/node &&
  test "$(node -p process.execPath)" != "$(/opt/seekcloud/node/bin/node -p process.execPath)"'
check "dsh 的 Node 不低于 24.9" /opt/seekcloud/node/bin/node -e '
  const [a, b] = process.versions.node.split(".").map(Number);
  process.exit(a > 24 || (a === 24 && b >= 9) ? 0 : 1);'
mkdir -p fake-bin
printf '#!/bin/sh\necho "这不是真的 node" >&2\nexit 1\n' > fake-bin/node
chmod +x fake-bin/node
check "PATH 里换成别的 node，dsh 照样能跑" env PATH="$work/fake-bin:$PATH" dsh --version
check "PATH 里没有 node，dsh 照样能跑" env PATH=/usr/bin:/bin /usr/local/bin/dsh --version
check "dsh 叠上基线配置能合成配置" sh -c \
  'dsh --profile sdk --patch /usr/local/share/seekcloud/dsh/baseline.patch.yml --dump-config >/dev/null'
check "dsh 的遥测关着" test "${DSH_TELEMETRY_MODE:-}" = DISABLED

echo "== dsh 叠上基线配置跑一个回合（假的模型服务）"
cat > fake-model.mjs <<'JS'
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    appendFileSync("requests.log", JSON.stringify({ path: req.url, body }) + "\n");
    if (req.method !== "POST" || !req.url.endsWith("/v1/messages")) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    send("message_start", { message: { id: "m", type: "message", role: "assistant", model: "deepseek-chat", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "好的" } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    send("message_stop", {});
    res.end();
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync("port", String(server.address().port)));
JS
node fake-model.mjs &
fake_pid=$!
for _ in $(seq 1 50); do [ -s port ] && break; sleep 0.1; done
mkdir -p skills-repo/.claude/skills/deploy-check skills-repo/.claude/commands skills-repo/sub dsh-home
printf -- '---\nname: deploy-check\ndescription: 发布前检查清单\n---\n先跑测试。\n' > skills-repo/.claude/skills/deploy-check/SKILL.md
printf -- '---\ndescription: Review the current diff\n---\nReview $ARGUMENTS.\n' > skills-repo/.claude/commands/review.md
git init -q skills-repo
check "回合跑完，回复是假模型说的" sh -c "cd skills-repo/sub &&
  HOME=$work/dsh-home DSH_HOME=$work/dsh-home/.dsh DEEPSEEK_API_KEY=fake DEEPSEEK_BASE_URL=http://127.0.0.1:\$(cat $work/port) \
  dsh --profile headless --patch /usr/local/share/seekcloud/dsh/baseline.patch.yml 你好 | grep -qx 好的"
check "请求里没有会话日志和插件清单" sh -c '! grep -q "dsh_session_log\|dsh_plugin_packages" requests.log'
check "模型看得到 .claude/skills 和 .claude/commands 的技能" sh -c \
  'grep -q "deploy-check\`: 发布前检查清单" requests.log && grep -q "review\`: Review the current diff" requests.log'
kill "$fake_pid" 2>/dev/null

echo "== 运行器"
check "运行器在跑，连得上" sh -c 'for _ in $(seq 1 50); do [ -S /run/seekcloud/runner.sock ] && break; sleep 0.2; done
  printf "{\"op\":\"hello\",\"since\":0}\n" | timeout 5 /opt/seekcloud/node/bin/node /usr/local/lib/seekcloud/seekcloud-runner.mjs connect | head -n 1 | grep -q "\"op\":\"welcome\""'

echo "== SeekCloud 的文件"
check "签名助手" test -x /usr/local/bin/seekcloud-sign
check "git 钩子是链接到 _dispatch 的" sh -c \
  'test -L /usr/local/share/seekcloud/git-hooks/commit-msg && test -x /usr/local/share/seekcloud/git-hooks/_dispatch'
check "提交时加上 AI 尾注" sh -c '
  git init -q hooks-repo && cd hooks-repo &&
  git -c user.name=t -c user.email=t@example.com -c core.hooksPath=/usr/local/share/seekcloud/git-hooks \
    commit -q --allow-empty -m 测试 &&
  git log -1 --format=%B | grep -qx "Generated-by: SeekCloud (AI)"'

cd /
rm -rf "$work"
if [ "$failed" -ne 0 ]; then
  echo "有检查没过"
  exit 1
fi
echo "全部通过"
