# dsh-approve-for-me

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）宿主插件，为 DSH 增加 **approve-for-me** 审批模式。

启用后，每个到达 DSH answerer 链的审批请求都会先交给一个 LLM 安全评审模型，结合**此前的对话摘要**判断是否放行，模型只回答 `ALLOW` 或 `REJECT`。破坏性高危命令——`rm -r`、`rm -rf`、`drop table`、`drop database` 等——会跳过模型，直接走正常的交互式用户审批弹窗。

> 插件**不会**新增 `approve-for-me` 这个审批策略枚举（它硬编码在宿主包 `dsh-user-approval` 里）。它工作在现有 `ask` 审批策略之内：插件启用即代表模式开启，禁用即回到“每次都问用户”。DSH 的审批审计事件（`approval/asked` + `approval/decided`）仍然正常记录。

## 行为

- 以 `prepend: true` 监听 `approval/request`，因此会抢在交互式（用户弹窗）answerer 之前运行。
- 提取本次请求的具体动作文本：
  - bash 工具调用参数里的 `command`，
  - 其他工具的调用参数 JSON，
  - 或退回到请求的 `reason`。
- 如果动作（或请求 reason）命中高危模式 → `next()`，即正常弹窗问用户。
- 否则把以下内容发给大模型：
  - **对话摘要**（最近约 12k 字符的用户消息、助手工具活动、工具调用），
  - **本次请求动作**（工具名、reason、命令/参数）。
- 模型必须只回答一个词：`ALLOW` 或 `REJECT`。
  - `ALLOW` → `allowed-once`
  - `REJECT` → `rejected`
  - 无法解析 / 超时 / 模型错误 / 无模型服务 → `next()`（回退为询问用户；绝不静默放行，也绝不静默拒绝）

## 高危模式

以下模式会对提取出的动作文本做精确匹配（不区分大小写的正则，无 `g` 标志）：

- `rm -r`、`rm -rf`、`rm -fr`、`rm -R`、`rm -rfv` 等（任何带 `r` 标志的 `rm`）
- `rm ... /`（递归/强制删除根目录）
- `drop table`、`drop database`、`drop schema`
- `truncate table ...`
- `delete from ...`
- `mkfs`、`mkfs.ext4` 等
- `dd if=`
- `shred`、`wipefs`
- `git push -f` / `git push --force`
- `git reset --hard`
- `chmod -R 777`、`chown -R`
- fork bomb `:(){ :|:& };:`

## 安装（静态，重启后仍生效）

### 方式 A：`dsh plugin add`（推荐）

本包声明了 `dsh.bundle.patch`，因此 `dsh plugin add` 会安装它，并自动把它加入该 profile 的 `dsh.profile.bundles`——不需要手动改补丁。

克隆仓库，然后在仓库所在目录的上层执行：

```bash
git clone https://github.com/shifan3/dsh-approve-for-me.git
dsh plugin --profile web add ./dsh-approve-for-me
```

或用绝对路径：

```bash
dsh plugin --profile web add /path/to/dsh-approve-for-me
```

发布到 npm 后也可以：

```bash
dsh plugin --profile web add dsh-approve-for-me
```

然后重启 `dsh web`。该命令会在 `~/.dsh/profiles/web/` 内执行 `pnpm add`，然后根据已安装的包对账 `dsh.profile.bundles`。激活插件的行就在本仓库的 `cordis.patch.yml` 里。

### 方式 B：手动 home 补丁层

如果不想用 `dsh plugin`，可以克隆仓库到 DSH home，并手动往 `~/.dsh/cordis.patch.yml` 插入一行（对所有 profile 生效）：

```bash
mkdir -p ~/.dsh/plugins
git clone https://github.com/shifan3/dsh-approve-for-me.git ~/.dsh/plugins/approve-for-me
```

然后创建或扩展 `~/.dsh/cordis.patch.yml`：

```yaml
- insert:
    - id: approve-for-me
      name: '../../plugins/approve-for-me/lib/index.js'
      config:
        enabled: true
        provider: deepseek-official
        model: deepseek-v4-flash
        maxTokens: 512
        summaryMaxChars: 12000
        timeoutMs: 60000
```

然后重启 `dsh web`。相对路径 `name` 会相对于每个 profile 目录（`~/.dsh/profiles/<name>/`）解析，所以 `../../plugins/...` 恰好指向 `~/.dsh/plugins/...`，对自带的 `web`、`tui`、`cc-tui` profile 都成立。

> 如果你之前用方式 B 装过，之后想换成方式 A，请先删掉 `~/.dsh/cordis.patch.yml` 里的 `approve-for-me` insert，避免同一 `id` 出现两次。

### 启用 / 禁用 / 配置

- 禁用：把行配置里的 `enabled` 改为 `false`，然后重启。
  - 方式 A：在 profile 补丁（`~/.dsh/profiles/web/cordis.patch.yml`）里加一个按 id 覆盖的配置：
    ```yaml
    - id: approve-for-me
      config:
        enabled: false
    ```
  - 方式 B：编辑 `~/.dsh/cordis.patch.yml` 里的 insert 块。
- 卸载：
  - 方式 A：`dsh plugin --profile web remove dsh-approve-for-me`，然后重启。
  - 方式 B：删除该 insert 块（或整个补丁文件），然后重启。
- 配置项（都可选）：
  - `enabled`（默认 `true`）
  - `provider`（默认 `deepseek-official`）
  - `model`（默认 `deepseek-v4-flash`）
  - `maxTokens`（默认 `512`）
  - `summaryMaxChars`（默认 `12000`）
  - `timeoutMs`（默认 `60000`）

## 安装（动态，单次运行）

如果不想写 `~/.dsh`，可以把 `host-code.js` 作为动态 Cordis Host 包加载（重启后失效）：

- Web UI：打开 Cordis 面板 → 新建 Plugin（id 前缀如 `afm`）→ 把 `host-code.js` 粘贴为 Host 代码 → 运行。
- 使用 `cordis_define` / `cordis_run`：读取 `host-code.js`，作为 `code.host` 传入。

## 文件

- `lib/index.js` — 静态宿主插件（ESM，无运行时依赖）。
- `host-code.js` — 动态 Cordis Host 包变体（相同逻辑，沙箱安全子集）。
- `cordis.patch.yml` — bundle 补丁（通过 `dsh.bundle.patch` 声明），用于激活插件行。

## 限制

- 动态版运行在 DSH 动态宿主 vm 沙箱里：没有 `setTimeout` / `AbortController`，其超时依赖 LLM adapter 自身的 `streamIdleTimeoutMs`（默认 300s）。静态版使用真实的 `AbortSignal.timeout`。
- 会话的审批策略仍显示为 `ask`；插件是一个前置 answerer，不是新的策略枚举。
- 只应启用一个 approve-for-me answerer：如果同时加载静态版和动态版，后加载（后 prepend）的那个生效。

## License

MIT
