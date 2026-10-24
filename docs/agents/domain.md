# 领域文档

工程类技能在探索代码时如何使用本仓库的领域文档。布局：single-context（单上下文）。

## 探索前先读

- 仓库根目录的 **`GLOSSARY.md`**：领域词汇（phone wire 协议与架构评审用语）。
- **`docs/adr/`**：读与你要动的区域相关的 ADR（架构决策记录，Architecture Decision Record）。

上述文件缺失时**静默继续**：不提示缺失，也不建议预先创建。术语或决策真正定下来时，由 `/domain-modeling`（经 `/grill-with-docs`、`/improve-codebase-architecture` 进入）按需创建。

## 私有边界

本仓库公开，但 `docs/adr/` 在 `.gitignore` 里，只存在于维护者本地：ADR 含有对私有 iOS 仓库的引用和发布过程细节。

- 新建或修改 ADR 后不要 `git add -f`；`npm pack` 也不得把它打进包。
- 公开文件（README、COMPATIBILITY、PROTOCOL、RELEASE_NOTES、issue、PR、提交说明）可以写「见 `docs/adr/0001-*.md` 第 2 条（本地文档）」这样的指针，但不得把 ADR 里的私有内容抄进去。
- `GLOSSARY.md` 是公开的，只写公开可见的领域概念。

## 文件结构

```
/
├── GLOSSARY.md
├── docs/adr/            ← 被 gitignore，仅本地
│   ├── 0001-dsh-compatibility-policy.md
│   └── 0002-release-0-9-1-scope-and-debug-cleanup.md
└── src/
```

## ADR 写法

- 文件名 `docs/adr/NNNN-<英文短横线 slug>.md`，四位编号顺序递增，不复用、不重排。
- 正文用中文。头部固定写 `状态`、`日期`；每份 ADR 只讲一个主题，主题下的条目按 1、2、3 独立编号。
- 引用写作「ADR-0004 第 2 条」；引用私有 iOS 仓库写作「App 仓库 ADR-0003 第 1 条」。
- 被取代的条目不删除：原地标注「已被第 N 条取代」，新条目写明它取代了谁。
- ADR 0001–0009 迁移自已退役的 `docs/决策记录.md` 第一章至第九章，章内条目编号保持不变；0010 起为从已退役的 `docs/提交历史.md` 里补录的决策与后续新决策。

## 使用词汇表里的说法

输出里提到领域概念时（issue 标题、重构提案、假设、测试名），使用 `GLOSSARY.md` 里定义的说法，不要换成词汇表明确避免的同义词。

需要的概念不在词汇表里，这是一个信号：要么你在发明项目不用的说法（重新考虑），要么确实有缺口（记下来交给 `/domain-modeling`）。

## 标出与 ADR 的冲突

输出与现有 ADR 矛盾时，要明确指出，不要静默推翻：

> _与 ADR-0001（DSH 兼容性策略）矛盾，但值得重新讨论，因为……_
