# Contributing to slicetest

Bug reports, feature requests, questions and documentation improvements are welcome. You do not need to submit code to contribute. **Japanese and English are both welcome.**

不具合報告、機能提案、質問、ドキュメント改善を歓迎します。コードの提供は必須ではありません。**日本語・英語どちらでも投稿できます。**

## Open an issue / Issueを投稿する

1. Search [open and closed issues](https://github.com/revo1290/slicetest/issues?q=is%3Aissue) for the same topic. 同じ内容のIssueがないか、完了済みも含めて確認してください。
2. Choose a form on [New issue](https://github.com/revo1290/slicetest/issues/new/choose):
   - **Bug report / 不具合報告**: actual vs. expected behavior, installed version, environment and reproduction steps.
   - **Feature request / 機能提案**: the use case, problem and desired outcome.
   - **Question or docs / 質問・ドキュメント**: usage questions, unclear explanations or missing examples.
3. Keep one topic per issue. A blank issue is also available if none of the forms fits. 1つのIssueにつき1つの話題を扱ってください。分類に迷う場合は空のIssueも利用できます。

For bugs, a small configuration and scenario are often enough to start. A public reproduction repository is helpful but not mandatory. If the issue is intermittent, include the frequency and conditions instead of guessing its cause.

不具合報告では、最小限の設定・シナリオがあると調査しやすくなります。公開再現リポジトリは必須ではありません。再現が不安定な場合は、原因を推測せず頻度・発生条件を記載してください。

## Before sharing / 共有前の確認

Issues and attachments are public. Remove API keys, tokens, database credentials, personal data and private URLs from configurations, logs, recordings and screenshots. Use synthetic data and placeholders. Do not post exploitable vulnerability details in a public issue.

Issueと添付資料は公開されます。設定・ログ・録画データ・画像からAPIキー、トークン、DB認証情報、個人情報、非公開URLを除去し、ダミーデータに置き換えてください。悪用可能な脆弱性の詳細は公開Issueに記載しないでください。

## Expectations / 対応について

Please keep discussions respectful and focused on reproducible behavior or concrete use cases. An issue is a starting point for discussion, not a promise of implementation or a response deadline. Maintainers may ask for more information or close duplicates with a link to the existing issue.

相手を尊重し、再現可能な動作や具体的な利用場面を中心に議論してください。Issueの受付は実装や回答期限の保証ではありません。調査のための追加情報をお願いしたり、重複Issueを既存Issueへのリンクとともに閉じたりする場合があります。

## Contributing code / コードの貢献

For a substantial change, open an issue first to discuss scope. For development commands, tests and repository conventions, read [AGENTS.md](AGENTS.md). Keep changes focused, update relevant documentation, and include tests for behavior changes. Open a pull request against `main` describing the problem, solution and validation.

大きな変更は先にIssueで範囲をご相談ください。開発コマンド、テスト、規約は[AGENTS.md](AGENTS.md)をご確認ください。動作変更にはテストと関連ドキュメントの更新を含め、`main`向けのPRに課題・変更内容・検証結果を記載してください。
