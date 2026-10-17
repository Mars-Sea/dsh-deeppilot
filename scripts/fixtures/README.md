# 系统指令隔离验收夹具

## 一、用途与边界

1. `command-smoke-host.mjs` 只提供本机固定模型响应和正常单次配对码。指令注册、智能体作用域、目标/计划状态、压缩、持久化、附件及 ZIP 均由官方主机执行。
2. 仅用于独立 `DSH_HOME`。需要显式设置 `DEEPPILOT_COMMAND_SMOKE=1`；不复制个人凭据或历史。模型端口 3188、配对辅助端口 3199 只监听 `127.0.0.1`，不部署到生产主机。
3. 模型输出固定，不能证明供应商响应质量；配对辅助端点调用插件的正式 `beginPairing`，不伪造设备注册表或跳过鉴权。测试目录、配对资料和归档均不提交。

## 二、启动与运行

1. 在公共插件仓库构建并打包本地插件。用已安装的官方 `0.2.1-alpha.4` CLI 为全新的 `.dsh-home-command-smoke` 创建 Web 模板；把包安装到该配置的 `node_modules/dsh-deeppilot`。`--from-default-profile` 会替换已有配置，只在首次准备使用。
2. 在该仓库工作目录运行下列命令。`dsh` 代表已安装的官方 CLI；也可替换成对应 `node .../dsh/lib/bin.js`，无需更新本机正在使用的主机。

```sh
SMOKE_DSH_HOME="$PWD/.dsh-home-command-smoke" node --import tsx scripts/smoke-live.mts register

DSH_HOME="$PWD/.dsh-home-command-smoke" \
DEEPPILOT_COMMAND_SMOKE=1 COMMAND_SMOKE_API_KEY=local-test-only \
dsh --profile commands --patch cordis.patch.yml \
  --patch scripts/fixtures/command-smoke.patch.yml --port 3187 --no-open
```

3. 另一个终端在相同仓库目录运行：

```sh
SMOKE_ISOLATED=1 SMOKE_DSH_HOME="$PWD/.dsh-home-command-smoke" \
SMOKE_ENDPOINT=https://127.0.0.1:3198 \
node --import tsx scripts/smoke-live.mts commands
```

4. 成功应报告 25 项通过；ZIP 写入独立目录的 `command-smoke-export.zip`。辅助端点 `http://127.0.0.1:3199/pair` 只供本机集成测试取得一次性凭据，不把响应输出到日志。测试完成后停止独立主机，夹具监听随主机释放。
