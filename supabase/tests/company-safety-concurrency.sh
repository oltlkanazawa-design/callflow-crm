#!/bin/bash
# =========================================================
# 企業安全管理: 同時実行（競合）テスト
#
# organization advisory lock（pg_advisory_xact_lock、トランザクションスコープ）
# による直列化が、実際に別々のDB接続（別プロセス・別トランザクション）の間で
# 機能していることを検証する。
#
# 【重要な設計変更】
# 以前の実装は「RPCを1文だけ実行するpsqlプロセスを起動→sleep 0.3→
# 別プロセスを起動」という方式だったが、この方式では最初のRPCは単一文として
# 即座に自動commitされるため、後発プロセスが起動する時点で既にロックが
# 解放されている可能性があり、「本当にadvisory lockで待たされたか」を
# 証明できていなかった（最終結果だけを見れば偶然にも正しく見えてしまう）。
#
# そこで、ロックを先に取得する側（holder）は明示的トランザクションで
#   BEGIN; 対象RPCを実行; SELECT pg_sleep(2); COMMIT;
# を1つのpsql接続内で実行し、pg_sleep(2)の間、transaction-level advisory lock
# を確実に2秒間保持し続ける。その保持期間中に、後発側（probe）を別のpsql接続
# として起動する。probe側の実行時間（起動直後から完了までの経過時間）を計測し、
# 「WAIT_THRESHOLD秒以上かかった＝実際にロック待ちが発生した」ことを、
# 最終結果の整合性チェックとは別に、プロセスの経過時間そのもので証明する。
#
# （dblink拡張は、Supabase CLIローカルスタックのロール権限・認証方式の
# 差異により安定して使えなかったため、シェルレベルの並列psqlを採用している）
#
# 検証する競合パターン（各シナリオでholder側が先にロックを保持する）:
#   1. block_company_calls(holder) と create_company_checked(probe)
#   2. block_company_calls(holder) と update_company_checked(probe)
#   3. block_company_calls(holder) と create_companies_checked（CSV update）(probe)
#   4. unblock_company_calls(holder) と update_company_checked(probe)
#   5. block_company_calls(holder) と record_call(probe)                … 要件A
#   6. record_call(holder) と block_company_calls(probe)                … 要件B
#   7. unblock_company_calls(holder) と record_call(probe)              … 要件C
#   8. create_company_checked(holder) と create_company_checked(probe)、
#      同一の新規識別子への同時登録                                      … 要件D
#
# 使い方: ./company-safety-concurrency.sh "$DB_URL"
# ローカル／隔離環境専用。本番Supabaseでは絶対に実行しないこと。
# =========================================================
set -euo pipefail

DB_URL="${1:?usage: company-safety-concurrency.sh <DB_URL>}"
FAIL=0
# holderは2秒間ロックを保持する。probe起動までの助走時間（stagger）は0.5秒とし、
# probeが待たされるべき残り時間は理論上およそ1.5秒。閾値は、通常の
# ブロックされないRPC呼び出し（通常0.3秒未満）と明確に区別できる1.2秒とする。
HOLD_SECONDS=2
STAGGER_SECONDS=0.5
WAIT_THRESHOLD=1.2

run_as() {
  # $1 = auth.uid()として使うユーザーID, $2 = 実行するSQL（1文以上）
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -t -A <<SQL
set role authenticated;
set request.jwt.claim.sub = '$1';
$2
SQL
}

run_holder() {
  # ロックを先に取得し、2秒間保持し続ける側。
  # $1=ユーザーID $2=RPC呼び出し文（1文） $3=stdoutログ出力先 $4=stderrログ出力先
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -t -A >"$3" 2>"$4" <<SQL || true
set role authenticated;
set request.jwt.claim.sub = '$1';
begin;
$2
select pg_sleep($HOLD_SECONDS);
commit;
SQL
}

run_probe_timed() {
  # holderのロック保持中に起動する側。実行時間を計測して$5へ書き出す。
  # $1=ユーザーID $2=RPC呼び出し文 $3=stdoutログ出力先 $4=stderrログ出力先 $5=経過秒数の出力先
  local t0 t1
  t0=$(date +%s.%N)
  run_as "$1" "$2" >"$3" 2>"$4" || true
  t1=$(date +%s.%N)
  awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.3f\n", (b-a)}' > "$5"
}

check() {
  # $1 = ラベル, $2 = 条件が真ならFAIL, $3 = メッセージ
  if [ "$2" = "1" ]; then
    echo "FAIL[$1]: $3" >&2
    FAIL=1
  else
    echo "PASS[$1]: $3"
  fi
}

check_waited() {
  # $1=ラベル $2=経過秒数ファイル
  local elapsed
  elapsed=$(cat "$2")
  if awk -v e="$elapsed" -v t="$WAIT_THRESHOLD" 'BEGIN{exit !(e>=t)}'; then
    check "$1-待機証明" 0 "後発プローブの所要時間が${elapsed}秒（閾値${WAIT_THRESHOLD}秒以上）で、holderのadvisory lock保持中は先に進めなかったことを経過時間で確認"
  else
    check "$1-待機証明" 1 "後発プローブの所要時間が${elapsed}秒しかなく、閾値${WAIT_THRESHOLD}秒に達していない＝advisory lockによる待機が発生していない疑いがある"
  fi
}

TMP="${TMPDIR:-/tmp}"

echo "=== seed ==="
psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
insert into public.organizations (id, name) values ('a0000000-0000-0000-0000-00000000000a','テスト組織A');
insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111','admin-a@test.local'),
  ('a2222222-2222-2222-2222-222222222222','member-a@test.local');
insert into public.profiles (id, organization_id, full_name, role, active) values
  ('a1111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-00000000000a','管理者A','admin',true),
  ('a2222222-2222-2222-2222-222222222222','a0000000-0000-0000-0000-00000000000a','メンバーA','member',true);
insert into public.companies (id, organization_id, name, phone, location, owner_id) values
  ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','競合テスト企業1','03-1111-1111','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-00000000000a','競合テスト企業2','03-2222-2222','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-00000000000a','競合テスト企業3','03-3333-3333','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-00000000000a','競合テスト企業4','03-4444-4444','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-00000000000a','競合テスト企業5','03-5555-5555','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000006','a0000000-0000-0000-0000-00000000000a','競合テスト企業6','03-6666-6666','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000007','a0000000-0000-0000-0000-00000000000a','競合テスト企業7','03-7777-7777','東京都','a1111111-1111-1111-1111-111111111111');
SQL

echo "=== 競合1: block_company_calls(holder) と create_company_checked(probe) ==="
run_holder 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000001', p_match_scope:='phone', p_reason:='競合1テスト');" \
  "$TMP/comp1_a.log" "$TMP/comp1_a.err" &
PID_A=$!
sleep "$STAGGER_SECONDS"
run_probe_timed 'a1111111-1111-1111-1111-111111111111' \
  "select public.create_company_checked(p_name:='競合1の新規登録', p_phone:='03-1111-1111', p_website_url:=null, p_location:='東京都');" \
  "$TMP/comp1_b.log" "$TMP/comp1_b.err" "$TMP/comp1_b.time" &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
check_waited "競合1" "$TMP/comp1_b.time"
R1=$(cat "$TMP/comp1_b.log")
case "$R1" in
  *'"status": "blocked"'*) check "競合1" 0 "holderのblock commit後、probeのcreateはblockedと正しく判定された" ;;
  *) check "競合1" 1 "block_company_callsコミット後にもかかわらずcreate_company_checkedがblockedになりませんでした（結果: $R1）" ;;
esac

echo "=== 競合2: block_company_calls(holder) と update_company_checked(probe) ==="
run_holder 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000002', p_match_scope:='phone', p_reason:='競合2テスト');" \
  "$TMP/comp2_a.log" "$TMP/comp2_a.err" &
PID_A=$!
sleep "$STAGGER_SECONDS"
run_probe_timed 'a1111111-1111-1111-1111-111111111111' \
  "select public.update_company_checked('c0000000-0000-0000-0000-000000000002'::uuid, '{\"memo\":\"競合2更新試行\"}'::jsonb, 'skip');" \
  "$TMP/comp2_b.log" "$TMP/comp2_b.err" "$TMP/comp2_b.time" &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
check_waited "競合2" "$TMP/comp2_b.time"
R2=$(cat "$TMP/comp2_b.log")
MEMO2=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select memo from public.companies where id='c0000000-0000-0000-0000-000000000002';")
if [[ "$R2" == *'"status": "blocked"'* && "$MEMO2" != "競合2更新試行" ]]; then
  check "競合2" 0 "holderのblock commit後、probeのupdateはblockedと正しく判定され、実データも更新されていない"
else
  check "競合2" 1 "update_company_checkedの結果またはmemoの状態が期待と異なる（結果: $R2, memo: $MEMO2）"
fi

echo "=== 競合3: block_company_calls(holder) と create_companies_checked（CSV update）(probe) ==="
run_holder 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000003', p_match_scope:='phone', p_reason:='競合3テスト');" \
  "$TMP/comp3_a.log" "$TMP/comp3_a.err" &
PID_A=$!
sleep "$STAGGER_SECONDS"
run_probe_timed 'a1111111-1111-1111-1111-111111111111' \
  "select public.create_companies_checked('[{\"name\":\"競合テスト企業3\",\"phone\":\"03-3333-3333\",\"location\":\"東京都\",\"memo\":\"競合3更新試行\"}]'::jsonb, 'update');" \
  "$TMP/comp3_b.log" "$TMP/comp3_b.err" "$TMP/comp3_b.time" &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
check_waited "競合3" "$TMP/comp3_b.time"
R3=$(cat "$TMP/comp3_b.log")
MEMO3=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select memo from public.companies where id='c0000000-0000-0000-0000-000000000003';")
if [[ "$R3" == *'"status": "blocked"'* && "$MEMO3" != "競合3更新試行" ]]; then
  check "競合3" 0 "holderのblock commit後、probeのCSV一括updateもblockedと正しく判定され、実データも更新されていない"
else
  check "競合3" 1 "CSV一括updateの結果またはmemoの状態が期待と異なる（結果: $R3, memo: $MEMO3）"
fi

echo "=== 競合4: unblock_company_calls(holder) と update_company_checked(probe) ==="
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000004', p_match_scope:='phone', p_reason:='競合4事前禁止');" > /dev/null
BLOCK_ID_4=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select id from public.call_blocklist where company_id='c0000000-0000-0000-0000-000000000004' and active;")
run_holder 'a1111111-1111-1111-1111-111111111111' \
  "select public.unblock_company_calls('$BLOCK_ID_4'::uuid, '競合4解除テスト');" \
  "$TMP/comp4_a.log" "$TMP/comp4_a.err" &
PID_A=$!
sleep "$STAGGER_SECONDS"
run_probe_timed 'a1111111-1111-1111-1111-111111111111' \
  "select public.update_company_checked('c0000000-0000-0000-0000-000000000004'::uuid, '{\"memo\":\"競合4更新試行\"}'::jsonb, 'skip');" \
  "$TMP/comp4_b.log" "$TMP/comp4_b.err" "$TMP/comp4_b.time" &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
check_waited "競合4" "$TMP/comp4_b.time"
R4=$(cat "$TMP/comp4_b.log")
MEMO4=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select memo from public.companies where id='c0000000-0000-0000-0000-000000000004';")
if [[ "$R4" == *'"status": "updated"'* && "$MEMO4" == "競合4更新試行" ]]; then
  check "競合4" 0 "holderのunblock commit後、probeのupdateは正常に成功する"
else
  check "競合4" 1 "unblock後のupdateが期待通り成功していない（結果: $R4, memo: $MEMO4）"
fi

echo "=== 競合5（要件A）: block_company_calls(holder) と record_call(probe) ==="
run_holder 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000005', p_match_scope:='phone', p_reason:='競合5禁止テスト');" \
  "$TMP/comp5_a.log" "$TMP/comp5_a.err" &
PID_A=$!
sleep "$STAGGER_SECONDS"
run_probe_timed 'a2222222-2222-2222-2222-222222222222' \
  "select public.record_call('c0000000-0000-0000-0000-000000000005'::uuid, '再架電', '競合5架電テスト');" \
  "$TMP/comp5_b.log" "$TMP/comp5_b.err" "$TMP/comp5_b.time" &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
check_waited "競合5" "$TMP/comp5_b.time"
LOG_CNT5=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select count(*) from public.call_logs where company_id='c0000000-0000-0000-0000-000000000005' and note='競合5架電テスト';")
PROHIBITED5=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select call_prohibited from public.companies_with_call_status where id='c0000000-0000-0000-0000-000000000005';")
ERR5=$(cat "$TMP/comp5_b.err")
if [ "$LOG_CNT5" = "0" ] && [ "$PROHIBITED5" = "t" ] && [[ "$ERR5" == *"call_prohibited"* ]]; then
  check "競合5" 0 "holderのblock commit後、probeのrecord_callはcall_prohibitedで拒否され、call_logsも増えていない"
else
  check "競合5" 1 "架電記録数(${LOG_CNT5})・call_prohibited(${PROHIBITED5})・エラー内容のいずれかが期待と異なる（stderr: $ERR5）"
fi

echo "=== 競合6（要件B）: record_call(holder) と block_company_calls(probe) ==="
run_holder 'a2222222-2222-2222-2222-222222222222' \
  "select public.record_call('c0000000-0000-0000-0000-000000000006'::uuid, '再架電', '競合6架電テスト');" \
  "$TMP/comp6_a.log" "$TMP/comp6_a.err" &
PID_A=$!
sleep "$STAGGER_SECONDS"
run_probe_timed 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000006', p_match_scope:='phone', p_reason:='競合6禁止テスト');" \
  "$TMP/comp6_b.log" "$TMP/comp6_b.err" "$TMP/comp6_b.time" &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
check_waited "競合6" "$TMP/comp6_b.time"
LOG_CNT6=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select count(*) from public.call_logs where company_id='c0000000-0000-0000-0000-000000000006' and note='競合6架電テスト';")
BLOCK_CNT6=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select count(*) from public.call_blocklist where company_id='c0000000-0000-0000-0000-000000000006' and active;")
if [ "$LOG_CNT6" = "1" ] && [ "$BLOCK_CNT6" = "1" ]; then
  check "競合6" 0 "holderのrecord_call commit後、probeのblockは正常に成功し、架電記録1件とactiveな禁止設定1件が残っている"
else
  check "競合6" 1 "架電記録数(${LOG_CNT6})またはactiveな禁止設定数(${BLOCK_CNT6})が期待と異なる"
fi

echo "=== 競合7（要件C）: unblock_company_calls(holder) と record_call(probe) ==="
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000007', p_match_scope:='phone', p_reason:='競合7事前禁止');" > /dev/null
BLOCK_ID_7=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select id from public.call_blocklist where company_id='c0000000-0000-0000-0000-000000000007' and active;")
run_holder 'a1111111-1111-1111-1111-111111111111' \
  "select public.unblock_company_calls('$BLOCK_ID_7'::uuid, '競合7解除テスト');" \
  "$TMP/comp7_a.log" "$TMP/comp7_a.err" &
PID_A=$!
sleep "$STAGGER_SECONDS"
run_probe_timed 'a2222222-2222-2222-2222-222222222222' \
  "select public.record_call('c0000000-0000-0000-0000-000000000007'::uuid, '再架電', '競合7架電テスト');" \
  "$TMP/comp7_b.log" "$TMP/comp7_b.err" "$TMP/comp7_b.time" &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
check_waited "競合7" "$TMP/comp7_b.time"
LOG_CNT7=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select count(*) from public.call_logs where company_id='c0000000-0000-0000-0000-000000000007' and note='競合7架電テスト';")
if [ "$LOG_CNT7" = "1" ]; then
  check "競合7" 0 "holderのunblock commit後、probeのrecord_callは正常に成功する"
else
  check "競合7" 1 "unblock後のrecord_callが成功していない（架電記録数: ${LOG_CNT7}, stderr: $(cat "$TMP/comp7_b.err")）"
fi

echo "=== 競合8（要件D）: create_company_checked(holder) と create_company_checked(probe)、同一新規識別子への同時登録 ==="
run_holder 'a1111111-1111-1111-1111-111111111111' \
  "select public.create_company_checked(p_name:='同時登録テストA', p_phone:='090-8888-9999', p_website_url:=null, p_location:='東京都');" \
  "$TMP/comp8_a.log" "$TMP/comp8_a.err" &
PID_A=$!
sleep "$STAGGER_SECONDS"
run_probe_timed 'a1111111-1111-1111-1111-111111111111' \
  "select public.create_company_checked(p_name:='同時登録テストB', p_phone:='090-8888-9999', p_website_url:=null, p_location:='東京都');" \
  "$TMP/comp8_b.log" "$TMP/comp8_b.err" "$TMP/comp8_b.time" &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
check_waited "競合8" "$TMP/comp8_b.time"
CNT8=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select count(*) from public.companies where phone='090-8888-9999';")
R8A=$(cat "$TMP/comp8_a.log"); R8B=$(cat "$TMP/comp8_b.log")
if [ "$CNT8" = "1" ] && [[ "$R8A" == *'"status": "inserted"'* ]] && [[ "$R8B" == *'"status": "skipped"'* ]]; then
  check "競合8" 0 "holder(先着)がinsertedになり、probe(後発)はholderがcommitした行を検知してskippedになる（重複防止が機能している）"
else
  check "競合8" 1 "同時登録の結果が期待と異なる（企業数: ${CNT8}、holder結果: $R8A、probe結果: $R8B）"
fi

echo "=== ALL CONCURRENCY ASSERTIONS EXECUTED ==="
exit "$FAIL"
