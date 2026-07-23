# CallFlow Companion Phase 3B — トラブルシューティング

作成日: 2026-07-22

| 状況 | 案内 |
|---|---|
| 「文字起こしを開始」が表示されない | Companion連携（`NEXT_PUBLIC_CALL_COMPANION_ENABLED`）が有効か確認。まず録音済みの音声が必要 |
| `queue_full`（現在処理中のジョブが多い） | Companionは1台のMacで同時に1件のみ処理する設計。前のジョブの完了・キャンセルを待つか、少し時間をおいて再試行 |
| `audio_too_long`（音声が60分を超えている） | Phase 3Bでは60分超の音声は非対応。録音を分割するか、この制限が緩和されるバージョンを待つ |
| `conversion_failed` / `conversion_timeout`（音声の変換に失敗） | ffmpegが正しくインストールされているか`npm run transcription:check`で確認。録音データ自体が壊れている場合は録音をやり直す |
| `transcription_failed` / `transcription_timeout`（文字起こしに失敗） | whisper-cli・モデルファイルが正しく配置されているか`npm run transcription:check`で確認（モデル未配置の場合は`npm run transcription:setup`を再実行） |
| ジョブが`404`になる（存在しないはずのjobIdでもない） | Companionを再起動していないか確認。ジョブはメモリ上のみで保持され、Companion再起動・完了から10分経過（TTL）で失効する |
| キャンセルしたのに少し反応が遅い | `DELETE`はプロセスへ`SIGTERM`を送った直後に応答するが、プロセスの実終了（最大3秒後の`SIGKILL`まで）は非同期に進む。UI上は即座に「キャンセル済み」表示になり、待つ必要はない |
| 文字起こし結果が保存されない・ページ再読み込みで消える | Phase 3Bの仕様どおり。文字起こし結果はメモリ上のみで保持し、Supabaseには一切保存しない（意図的な設計） |
| 文字起こしがおかしい・精度が低い | Phase 3Aのベンチマークで選定した`small`モデルの既知の限界（雑音・専門用語・早口等）。`CALLFLOW_TRANSCRIPTION_MODEL=base`は逆に精度が下がる方向のため推奨しない。将来的な`medium`モデル対応は本Phaseの対象外 |
| `npm run companion:test`がなかなか終わらない/固まる | Phase 3B開発中に実際に踏んだ既知の問題（後述の付録参照）。現行コードでは修正済みで、通常は数秒で完了する。それでも固まる場合は`pgrep -f "node --test companion"`で残存プロセスを確認し、`kill -TERM <pid>`で終了させてから再実行 |

---

## 付録: `job.finished`まわりの既知の問題と修正（開発時に発見）

Phase 3B開発中、`transcription-jobs.ts`のテスト実行時に「テストは全て成功しているのに`node --test`プロセスが終了しない」という問題が実際に発生した。原因は、ffmpeg/whisper-cli実行中のジョブに対して`process()`（自然完了）と`cancelJob()`/`shutdown()`（明示キャンセル）が競合すると、同じジョブに対して内部の後片付け処理（`finishJob`）が二重に呼ばれ、完了ジョブ用のTTLタイマー（既定10分）が二重登録されてしまうことだった。一方は正しくクリアされるが、もう一方（後から解決する側）のタイマーは誰にもクリアされず、Node.jsのイベントループを最大10分間握ったままになっていた。

修正は2段階:
1. `job.finished`フラグを追加し、`finishJob`の実行を「最初の1回だけ」に制限（二重登録そのものを防ぐ）
2. 上記1だけでは`cancelJob()`が同期的に返答する必要がある関係で理論上すり抜けが起こりうるため、TTLタイマー自体を`.unref()`し、「このタイマーが唯一の生存理由でNode.jsプロセスが終了できない」状態が起こらないようにした（ハウスキーピング専用タイマーはプロセスの生存を左右すべきではない、という一般原則の適用）

この問題は独立した信頼性レビュー（Opus）で「BLOCK」判定を受けて発覚・修正し、再レビューで解消を確認した。詳細は[callflow-transcription-phase3-review.md](./callflow-transcription-phase3-review.md)を参照。
