# DeepPilot 0.9.19

## 中文

- **模型调用报错直接写入异常通知**：当模型或中转站返回限流、上游异常、超时、鉴权失败或空响应导致本轮停止时，手机通知直接展示中文错误原因，不再引用上一轮的旧回复或空白标题。
- **聊天时间线显示回合错误提示**：因模型错误、进程中断或输出达到上限而中止的轮次，会在对话末尾显示对应的错误说明，重新打开会话同样保留。
- **会话列表与锁屏实时活动准确反映异常停止**：轮次异常结束时会话保持异常状态，锁屏与灵动岛实时活动同步转为红色异常提示，直到下一轮开始才恢复运行中。
- **模型自动重试期间实时显示进度与原因**：当宿主自动等待重试失败的模型请求时，会话状态行与实时活动会显示当前重试次数及失败原因。
- **兼容**：协议仍为 v2，新增内容均为向后兼容扩展；旧版 App 仍可正常收到含错误原因的异常通知，聊天内错误卡片需搭配新版 App 显示。

## English

- **Model call failures appear directly in error notifications**: when a model or relay stops a turn due to rate limits, upstream errors, timeouts, authentication failures, or empty responses, phone notifications now show the failure reason instead of quoting an earlier reply or blank title.
- **Turn failure rows in the conversation timeline**: turns that end due to a model error, process interruption, or output token limit now leave an error row at the end of the conversation, including when the session is reopened later.
- **Session list and Lock Screen Live Activities reflect failed turns**: a failed turn keeps the session in the error state so Lock Screen and Dynamic Island Live Activities show the red failed status until the next turn starts.
- **Live retry progress while waiting on model retries**: while the host backs off to retry a failed model request, the session activity line and Live Activity show the retry attempt and failure reason.
- **Compatibility**: still protocol v2 with all additions backward-compatible; older apps immediately receive error notifications with the failure reason, while inline timeline error cards appear in the updated app.
