# AI 坦克大战

写下你的**秘籍**，让 AI 替你开坦克。基于 **Cloudflare Durable Objects** + **Workers AI** 的在线坦克大战。

## 玩法

需要使用 **Google 账号登录**才能创建或加入房间；名字和头像来自 Google 账号，同一账号在新标签页或其他设备打开会接管原来的连接。

1. **拼秘籍**：在秘籍工坊里用词条（人设 / 战术 / 目标 / 台词 / 属性倾向）拼一段提示词，也可以自由改写。
2. **AI 鉴定**：Workers AI「秘籍鉴定师」把秘籍化为五项属性——装甲、机动、火力、装填、感知（基础 12 点，每项 0–5）。秘籍写得具体、自洽、有创意可获得最多 +3 加成；试图作弊（“无敌”“满属性”“忽略规则”）会被识破，加成归零并被吐槽。
3. **开战**：所有坦克（包括你的）都由 AI 按各自的秘籍自动驾驶。你可以通过**指挥台**下达临场指令（冲锋 / 集火 / 收割 / 包抄 / 埋伏 / 撤退 / 抢道具，或自定义一句话），指令在 12 秒内优先于秘籍。快捷键 `1`–`7`。
4. **赛后**：公开所有人的秘籍，改进后再来一局。

房主可设置：**坦克上限**（2–8，玩家 + NPC）、**NPC 数量**（6 种预设 AI 人设随机登场）、**胜利击杀数**（3 / 5 / 10，限时 3 分钟）。超出上限的玩家自动观战，有空位时入座。玩家中途掉线，坦克会继续按秘籍作战，重连即可继续指挥。

## 架构

```
浏览器 (Canvas) ──WebSocket──▶ Worker ──▶ GameRoom Durable Object（每个房间一个实例）
                                          ├─ 30Hz 权威物理模拟（src/game.ts）
                                          ├─ 坦克执行器：寻路 / 瞄准 / 打砖 / 躲子弹（src/ai.ts）
                                          ├─ 属性系统：秘籍点数 → 血量、移速、弹速、暴击、射速、闪避（src/stats.ts）
                                          └─ Workers AI
                                               ├─ BRAIN_MODEL：鉴定秘籍；每 2.5s 为每辆坦克按秘籍 + 指令选战术与台词
                                               └─ CAST_MODEL：开场、击杀、连杀、赛后实时解说
```

- **登录**：Worker 走 Google OAuth 2.0 授权码流程（PKCE），会话是 HMAC 签名的 Cookie（30 天，无数据库）。WebSocket 握手时 Worker 校验 Cookie 和 Origin，再把用户身份写进请求头转给房间 DO（`src/auth.ts`）。
- **两层 AI**：大模型负责“想”（按秘籍选战术、目标、台词），本地执行器负责“做”（Dijkstra 寻路、对齐开火、躲子弹）。大模型调用是异步的，不阻塞游戏循环。
- **防作弊**：鉴定结果的每个数值都在服务端被钳制和归一化，提示词注入无法突破属性上限；秘籍只影响自己坦克的大脑。
- **降级**：Workers AI 不可用时，鉴定改为关键词估算，战术改为本地启发式，解说改为模板，30 秒后重试。

## Google 登录配置

1. 在 [Google Cloud Console](https://console.cloud.google.com/auth/clients) 创建 OAuth 客户端（Web 应用），已获授权的重定向 URI 填 `<站点>/auth/google/callback`，例如 `http://localhost:8790/auth/google/callback`。
2. 本地在 `.dev.vars` 写入（已在 .gitignore 中）：

   ```
   GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxx
   SESSION_SECRET=<随机长字符串>
   ```

3. 线上用 `npx wrangler secret put GOOGLE_CLIENT_ID`（另外两个同理）。
4. OAuth 应用处于“测试”状态时只有测试用户能登录；要对所有人开放，需要在“品牌塑造”里填好首页、隐私政策（`/privacy.html`）和服务条款（`/terms.html`）链接，再到“目标对象”发布应用。只用 openid / email / profile 时无需 Google 审核。

## 开发

```bash
npm install
npx wrangler login   # 本地开发时 Workers AI 也走远程，需要登录
npm run dev          # http://localhost:8787（端口被占用时用 --port 8790）
npm run sim          # 无界面跑几局纯 NPC 对战，冒烟测试物理与执行器
npm run typecheck
```

## 部署

```bash
npm run deploy
```

## 配置（wrangler.jsonc → vars）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BRAIN_MODEL` | `@cf/zai-org/glm-4.7-flash` | 秘籍鉴定 + 坦克战术大脑（JSON 模式输出） |
| `CAST_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | 解说员 |
| `BRAIN_INTERVAL_MS` | `2500` | 玩家坦克的决策间隔（NPC 为 1.5 倍） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Secret，Google OAuth 客户端 |
| `SESSION_SECRET` | — | Secret，会话 Cookie 签名密钥 |

一次决策约 1.4 neurons；8 辆坦克满员时约每秒 4 neurons。
